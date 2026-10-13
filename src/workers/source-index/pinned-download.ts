import { createHash } from 'node:crypto';
import { untilAborted } from '../../core/http-timeout.ts';
import { closeSync, createReadStream, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';

/** Bound fetch's read-ahead even when the runtime does not backpressure it. */
const REQUEST_BYTES = 256 * 1024 ** 2;
const READ_RETRIES = 3;
const RETRY_DELAY_MS = 250;
type Failure = 'download_failed' | 'checksum_mismatch' | 'disk_write_failed';

interface PinnedDownloadOptions {
  fetchImpl: typeof fetch;
  url: string;
  target: string;
  partial: string;
  expectedBytes: number;
  algorithm: string;
  digest: string;
  encoding: 'hex' | 'base64';
  noun: string;
  stallMs: number;
  verifyTimeoutMs: number;
  /** Persistent model partials survive exhaustion; temporary runtime assets need not. */
  keepPartial: boolean;
  error: (reason: Failure, message: string) => Error;
  diskError?: (error: unknown) => Error;
  write?: (fd: number, bytes: Uint8Array) => void;
  onStart: () => void;
  onProgress: (delta: number) => void;
}

class InterruptedRead extends Error {}

/** The caller holds the install lock. Only a verified file is renamed into place. */
export async function downloadPinnedFile(options: PinnedDownloadOptions): Promise<void> {
  const { fetchImpl, url, target, partial, expectedBytes, algorithm, encoding, noun, stallMs, error } = options;
  let hash = createHash(algorithm);
  let received = 0;
  let fd: number | undefined;
  let discard = false;
  const close = (): void => {
    if (fd !== undefined) { const open = fd; fd = undefined; closeSync(open); }
  };
  const mismatch = (message: string): Error => {
    discard = true;
    return error('checksum_mismatch', message);
  };
  const disk = (cause: unknown): Error => {
    // A failed write can have written only part of a buffer. Never resume it
    // with a hash/offset that describes different bytes; also give disk space back.
    discard = true;
    close();
    rmSync(partial, { force: true });
    return options.diskError?.(cause) ?? error('disk_write_failed', `Could not write the download: ${String(cause)}`);
  };
  try {
    if (existsSync(partial)) {
      const size = statSync(partial).size;
      if (size > 0 && size < expectedBytes) {
        await hashPartial(partial, hash, options.verifyTimeoutMs);
        received = size;
        options.onProgress(size);
      } else rmSync(partial, { force: true });
    }
    let retries = 0;
    while (received < expectedBytes) {
      const start = received;
      const end = Math.min(expectedBytes - 1, start + REQUEST_BYTES - 1);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const armStall = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(stallMs / 1000)} s`)), stallMs);
      };
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let retry = false;
      try {
        armStall();
        try {
          response = await untilAborted(fetchImpl(url, {
            redirect: 'follow', signal: controller.signal,
            headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
          }), controller.signal);
        } catch (cause) {
          throw error('download_failed', `Could not reach the download server for the ${noun} (${message(cause)}).`);
        }
        if ((response.status !== 200 && response.status !== 206) || !response.body) {
          throw error('download_failed', `The ${noun} download failed (HTTP ${response.status}).`);
        }
        let responseEnd = expectedBytes - 1;
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
          if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== expectedBytes) {
            throw error('download_failed', `The ${noun} download returned an invalid Content-Range.`);
          }
          responseEnd = end;
        } else if (received > 0) {
          // Range was ignored. Consume this full response from zero with the
          // same reader; appending it would duplicate the saved prefix.
          try { close(); fd = openSync(partial, 'w', 0o644); } catch (cause) { throw disk(cause); }
          hash = createHash(algorithm);
          options.onProgress(-received);
          received = 0;
        }
        options.onStart();
        if (fd === undefined) {
          try { fd = openSync(partial, received > 0 ? 'a' : 'w', 0o644); } catch (cause) { throw disk(cause); }
        }
        reader = response.body.getReader();
        for (;;) {
          armStall();
          let part: Awaited<ReturnType<typeof reader.read>>;
          try { part = await untilAborted(reader.read(), controller.signal); }
          catch (cause) { throw new InterruptedRead(message(cause)); }
          if (part.done) break;
          if (received + part.value.byteLength > responseEnd + 1) {
            throw mismatch(`${url} is larger than its pinned size or requested range.`);
          }
          try { (options.write ?? writeDownloadChunk)(fd, part.value); } catch (cause) { throw disk(cause); }
          hash.update(part.value);
          received += part.value.byteLength;
          options.onProgress(part.value.byteLength);
        }
        if (received !== responseEnd + 1) throw mismatch(`${url} did not match its pinned size; nothing was installed.`);
      } catch (cause) {
        if (!(cause instanceof InterruptedRead)) throw cause;
        // Even a stream that errors after delivering the final byte must be
        // observed as a failure once the retry budget has been spent.
        if (retries >= READ_RETRIES) {
          throw error('download_failed', `The ${noun} download was interrupted (${cause.message}).`);
        }
        retries += 1;
        retry = true;
      } finally {
        clearTimeout(timer);
        // Do not await cancellation: a wedged underlying source can itself
        // stall forever. Abort the transport as well and release its reader.
        if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
        else if (response?.body) void response.body.cancel().catch(() => undefined);
        controller.abort();
      }
      if (retry) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (retries - 1)));
    }
    close();
    if (received !== expectedBytes || hash.digest(encoding) !== options.digest) {
      throw mismatch(`${url} did not match its pinned checksum; nothing was installed.`);
    }
    renameSync(partial, target);
  } catch (cause) {
    close();
    if (discard || !options.keepPartial) rmSync(partial, { force: true });
    throw cause;
  }
}

/** Regular files can accept less than the buffer even without throwing. */
export function writeDownloadChunk(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw new Error('The disk stopped accepting data.');
    offset += written;
  }
}

async function hashPartial(path: string, hash: ReturnType<typeof createHash>, timeoutMs: number): Promise<void> {
  const stream = createReadStream(path);
  const timer = setTimeout(() => stream.destroy(new Error(`Checking ${path} did not finish in time.`)), timeoutMs);
  try { for await (const bytes of stream) hash.update(bytes); }
  finally { clearTimeout(timer); stream.destroy(); }
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
