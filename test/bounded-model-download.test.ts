import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBuiltInReasoning } from '../src/workers/source-index/built-in-reasoning/install.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { downloadPinnedFile } from '../src/workers/source-index/pinned-download.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const CHUNK = 256 * 1024 ** 2; // Product limit, independent of the implementation.
const block = Buffer.alloc(64 * 1024, 37);
function digest(size: number): string {
  const hash = createHash('sha256');
  for (let left = size; left > 0; left -= block.length) hash.update(block.subarray(0, Math.min(left, block.length)));
  return hash.digest('hex');
}
function fixture(size = 64, sha = digest(size)) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-bounded-download-'));
  roots.push(root);
  const target = join(root, 'test', 'model.gguf');
  const ranges: string[] = [];
  const run = (serve: (start: number, end: number, init: RequestInit) => Response | Promise<Response>) => installBuiltInReasoning({
    env: { OLYMPUS_BUILT_IN_REASONING_DIR: root }, platform: 'linux-x64',
    model: { ...QWEN35_4B, modelId: 'test', file: { name: 'model.gguf', url: 'https://test/model', bytes: size, sha256: sha } },
    runtime: { release: 'test', license: 'MIT', archives: [{ platform: 'linux-x64', name: 'runtime.tgz', url: 'https://test/runtime', bytes: 1, sha256: digest(1), gpu: false }] },
    extractArchive: (_path, dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'llama-server'), '#!/bin/sh\n'); },
    freeBytes: () => 20 * 1024 ** 3, log: () => {},
    fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith('/runtime')) return new Response(block.subarray(0, 1));
      const range = new Headers(init.headers).get('range');
      ranges.push(range ?? 'missing');
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : size - 1;
      return serve(start, end, init);
    }) as typeof fetch,
  });
  function response(start: number, end: number, options: { fail?: boolean; status?: number; contentRange?: string; truncate?: boolean } = {}) {
    const status = options.status ?? 206;
    let left = options.fail ? 1 : end - start + 1 - (options.truncate ? 1 : 0);
    return new Response(new ReadableStream({
      pull(controller) {
        if (left > 0) {
          const count = Math.min(left, block.length);
          left -= count;
          controller.enqueue(block.subarray(0, count));
        } else if (options.fail) controller.error(new Error('Out of memory'));
        else controller.close();
      },
    }), { status, headers: status === 206 ? { 'Content-Range': options.contentRange ?? `bytes ${start}-${end}/${size}` } : {} });
  }
  return { run, response, target, ranges };
}

test('a model larger than 256 MiB uses several bounded 206 requests and verifies the assembled hash', async () => {
  const size = CHUNK + 31;
  const f = fixture(size);
  await f.run((start, end) => f.response(start, end));
  expect(f.ranges).toEqual([`bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${size - 1}`]);
  expect(statSync(f.target).size).toBe(size);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(f.target)) hash.update(bytes);
  expect(hash.digest('hex')).toBe(digest(size));
}, 30_000);

test('reader interruption resumes automatically from the bytes already written', async () => {
  const f = fixture();
  await f.run((start, end) => f.response(start, end, { fail: f.ranges.length === 1 }));
  expect(f.ranges).toEqual(['bytes=0-63', 'bytes=1-63']);
  expect(readFileSync(f.target)).toEqual(block.subarray(0, 64));
});

test('four reader interruptions exhaust the retry budget and keep the resumable partial', async () => {
  const f = fixture();
  await expect(f.run((start, end) => f.response(start, end, { fail: true }))).rejects.toMatchObject({ reason: 'download_failed' });
  expect(f.ranges).toEqual(['bytes=0-63', 'bytes=1-63', 'bytes=2-63', 'bytes=3-63']);
  expect(existsSync(f.target)).toBe(false);
  expect(statSync(`${f.target}.partial`).size).toBe(4);
});

test('a server ignoring Range replaces a saved partial with its full 200 body', async () => {
  const f = fixture();
  mkdirSync(join(f.target, '..'), { recursive: true });
  writeFileSync(`${f.target}.partial`, block.subarray(0, 17));
  await f.run(() => f.response(0, 63, { status: 200 }));
  expect(f.ranges).toEqual(['bytes=17-63']);
  expect(readFileSync(f.target)).toEqual(block.subarray(0, 64));
});

test('a checksum mismatch removes the partial without retrying', async () => {
  const f = fixture(64, '0'.repeat(64));
  await expect(f.run((start, end) => f.response(start, end))).rejects.toMatchObject({ reason: 'checksum_mismatch' });
  expect(f.ranges).toHaveLength(1);
  expect(existsSync(f.target)).toBe(false);
  expect(existsSync(`${f.target}.partial`)).toBe(false);
});

test('a normally ended short body is a size mismatch, not an interrupted-read retry', async () => {
  const f = fixture();
  await expect(f.run((start, end) => f.response(start, end, { truncate: true }))).rejects.toMatchObject({ reason: 'checksum_mismatch' });
  expect(f.ranges).toHaveLength(1);
  expect(existsSync(`${f.target}.partial`)).toBe(false);
});

for (const contentRange of ['bytes 1-63/64', 'bytes 0-64/64', 'bytes 0-63/65', 'garbage']) {
  test(`rejects invalid Content-Range (${contentRange}) before appending`, async () => {
    const f = fixture();
    await expect(f.run((start, end) => f.response(start, end, { contentRange }))).rejects.toThrow('Content-Range');
    expect(f.ranges).toHaveLength(1);
    expect(existsSync(f.target)).toBe(false);
    expect(existsSync(`${f.target}.partial`) ? statSync(`${f.target}.partial`).size : 0).toBe(0);
  });
}

test('a chunk already written can be freed while the next read is still pending', async () => {
  // Racing each read against one long-lived abort promise kept every chunk
  // reachable until the range ended: 6.2 GB resident for a 1.5 GB download.
  const root = mkdtempSync(join(tmpdir(), 'olympus-bounded-download-'));
  roots.push(root);
  const size = 2 * block.length;
  let first: WeakRef<Uint8Array> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let written!: () => void;
  const firstWritten = new Promise<void>((resolve) => { written = resolve; });
  let pulls = 0;
  const target = join(root, 'model');
  const done = downloadPinnedFile({
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          const chunk = new Uint8Array(block);
          first = new WeakRef(chunk);
          controller.enqueue(chunk);
          return;
        }
        await gate;
        controller.enqueue(new Uint8Array(block));
        controller.close();
      },
    }), { status: 206, headers: { 'Content-Range': `bytes 0-${size - 1}/${size}` } })) as unknown as typeof fetch,
    url: 'https://test/model', target, partial: `${target}.partial`, expectedBytes: size,
    algorithm: 'sha256', digest: digest(size), encoding: 'hex', noun: 'test model',
    stallMs: 60_000, verifyTimeoutMs: 60_000, keepPartial: false,
    error: (_reason, message) => new Error(message),
    onStart: () => {}, onProgress: (bytes) => { if (bytes > 0) written(); },
  });
  await firstWritten;
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  const retained = first?.deref() !== undefined;
  release();
  await done;
  expect(retained).toBe(false);
  expect(statSync(target).size).toBe(size);
});
