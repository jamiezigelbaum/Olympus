import { spawnSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { TextDecoder } from 'node:util';

/**
 * Masked single-command secret entry for the Olympus CLI.
 *
 * The secret is read from a controlling terminal only (never stdin, never a
 * chat transcript), with echo disabled. It is returned once to the caller's
 * memory and is never logged, persisted, placed in argv/env, or included in an
 * error message. Supported on macOS and Linux; other platforms fail closed.
 */

export type SecretInputErrorCode =
  | 'no_terminal'
  | 'unsupported_platform'
  | 'eof'
  | 'cancelled'
  | 'too_large'
  | 'malformed_input';

/** Thrown for secret-entry failures. Messages never contain the secret. */
export class SecretInputError extends Error {
  readonly code: SecretInputErrorCode;
  constructor(code: SecretInputErrorCode, message: string) {
    super(message);
    this.name = 'SecretInputError';
    this.code = code;
  }
}

export const SECRET_MAX_BYTES = 4096;

const TTY_PATH = '/dev/tty';
const PASTE_START = Buffer.from('\x1b[200~');
const PASTE_END = Buffer.from('\x1b[201~');
const DELETE_SEQ = Buffer.from('\x1b[3~');
const ESCAPE_SEQUENCES = [PASTE_START, PASTE_END, DELETE_SEQ] as const;
const lineBreak = (byte: number): boolean => byte === 0x0a || byte === 0x0d;

function malformed(): SecretInputError {
  return new SecretInputError('malformed_input', 'malformed control character in secret input');
}

/**
 * Deterministic masked-input state machine. `feed` consumes raw terminal bytes
 * and returns `undefined` while more input is required. Injecting bytes here is
 * how the behavior is tested without a terminal; `readSecretFromTerminal`
 * feeds it from the controlling tty.
 */
export class SecretInput {
  private buf: Buffer = Buffer.alloc(0);
  private secret = '';
  private bytes = 0;
  private inPaste = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * Consume terminal bytes. Returns the secret once a line is completed, an
   * empty string when a blank line was ignored (the caller re-prompts), and
   * `undefined` when more input is required. Throws `SecretInputError` on
   * cancellation, end of input, oversize, or malformed input.
   */
  feed(chunk: Buffer): string | undefined {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length > 0) {
      const b = this.buf[0]!;
      if (b === 0x03) throw new SecretInputError('cancelled', 'secret entry cancelled');
      if (b === 0x04) throw new SecretInputError('eof', 'no secret was entered');
      if (b === 0x1b) {
        const startsWith = (seq: Buffer): boolean =>
          this.buf.subarray(0, seq.length).equals(seq);
        if (startsWith(PASTE_START)) {
          if (this.inPaste) throw malformed();
          this.inPaste = true;
          this.buf = this.buf.subarray(PASTE_START.length);
          continue;
        }
        if (startsWith(PASTE_END)) {
          if (!this.inPaste) throw malformed();
          this.inPaste = false;
          this.buf = this.buf.subarray(PASTE_END.length);
          continue;
        }
        if (startsWith(DELETE_SEQ)) {
          this.backspace();
          this.buf = this.buf.subarray(DELETE_SEQ.length);
          continue;
        }
        // Not a complete marker: wait while it is still a prefix of one.
        if (ESCAPE_SEQUENCES.some((seq) => prefixOf(this.buf, seq))) {
          return undefined;
        }
        throw malformed();
      }
      if (b === 0x7f || b === 0x08) {
        this.backspace();
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (lineBreak(b)) {
        // Inside a bracketed paste the break is content: a single trailing
        // break is stripped, embedded ones are rejected when the paste closes.
        if (this.inPaste) {
          this.emitChar(b === 0x0d ? '\r' : '\n');
          this.buf = this.buf.subarray(1);
          continue;
        }
        // Drop the submitting keystroke and its optional CRLF/LFCR partner.
        this.buf = this.buf.subarray(1);
        if (this.buf.length > 0 && lineBreak(this.buf[0]!) && this.buf[0] !== b) {
          this.buf = this.buf.subarray(1);
        }
        if (this.secret.length === 0 && this.buf.length > 0) continue;
        // A complete extra line in the same raw read is an unframed multiline
        // paste, not part of a single-line secret.
        if (this.buf.length > 0) throw malformed();
        return this.complete();
      }
      if (b < 0x20) throw malformed();
      const width = utf8SequenceWidth(b);
      if (width === 0) throw malformed();
      if (width === 1) {
        this.emitChar(String.fromCharCode(b));
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < width) return undefined;
      const slice = this.buf.subarray(0, width);
      let text: string;
      try {
        text = this.decoder.decode(slice);
      } catch {
        throw malformed();
      }
      if (Array.from(text).length !== 1) throw malformed();
      this.emitChar(text);
      this.buf = this.buf.subarray(width);
    }
    return undefined;
  }

  private emitChar(char: string): void {
    const size = Buffer.byteLength(char, 'utf8');
    if (this.bytes + size > SECRET_MAX_BYTES) {
      throw new SecretInputError('too_large', `secret exceeds ${SECRET_MAX_BYTES} bytes`);
    }
    this.bytes += size;
    this.secret += char;
  }

  private backspace(): void {
    const chars = Array.from(this.secret);
    if (chars.length === 0) return;
    this.secret = chars.slice(0, -1).join('');
    this.bytes -= Buffer.byteLength(chars[chars.length - 1]!, 'utf8');
  }

  private collect(): string {
    // A pasted value commonly arrives with one trailing line break; strip one
    // logical CRLF/LFCR/CR/LF break and reject any remaining line breaks.
    let value = this.secret;
    if (value.endsWith('\r\n') || value.endsWith('\n\r')) value = value.slice(0, -2);
    else if (/[\r\n]$/.test(value)) value = value.slice(0, -1);
    this.secret = '';
    this.bytes = 0;
    return value;
  }

  private complete(): string | undefined {
    if (this.secret.length === 0) {
      return '';
    }
    const value = this.collect();
    if (value.length === 0) return '';
    if (/[\r\n]/.test(value)) throw malformed();
    if (Buffer.byteLength(value, 'utf8') > SECRET_MAX_BYTES) {
      throw new SecretInputError('too_large', `secret exceeds ${SECRET_MAX_BYTES} bytes`);
    }
    return value;
  }
}

function terminalState(fd: number): string | undefined {
  const result = spawnSync('/bin/stty', ['-g'], {
    encoding: 'utf8',
    stdio: [fd, 'pipe', 'ignore'],
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const state = result.stdout.trim();
  return state.length > 0 ? state : undefined;
}

function restoreTerminal(fd: number, state: string): boolean {
  const result = spawnSync('/bin/stty', [state], {
    stdio: [fd, 'ignore', 'ignore'],
  });
  return result.status === 0;
}

function safeClose(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
}

function utf8SequenceWidth(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** True when the buffered bytes are a strict, still-incomplete prefix of `seq`. */
function prefixOf(buffered: Buffer, seq: Buffer): boolean {
  return buffered.length < seq.length && buffered.equals(seq.subarray(0, buffered.length));
}

/**
 * Prompt on the controlling terminal and return the entered secret with echo
 * masked. Rejects with `SecretInputError` (see `formatArgumentError`) when no
 * terminal is available or the entry cannot be completed.
 */
export async function readSecretFromTerminal(prompt: string): Promise<string> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new SecretInputError(
      'unsupported_platform',
      `masked secret entry is only supported on macOS and Linux, not ${platform}`,
    );
  }
  let controlFd: number | undefined;
  let inputFd: number | undefined;
  try {
    controlFd = openSync(TTY_PATH, 'r+');
    inputFd = openSync(TTY_PATH, 'r+');
  } catch {
    safeClose(inputFd);
    safeClose(controlFd);
    throw new SecretInputError('no_terminal', 'a terminal is required for masked secret entry');
  }

  const originalState = terminalState(controlFd);
  if (originalState === undefined) {
    safeClose(inputFd);
    safeClose(controlFd);
    throw new SecretInputError('no_terminal', 'could not capture the terminal state for masked input');
  }

  let stream: ReadStream | undefined;
  try {
    stream = new ReadStream(inputFd);
    stream.setRawMode(true);
  } catch {
    restoreTerminal(controlFd, originalState);
    if (stream === undefined) safeClose(inputFd);
    else stream.destroy();
    safeClose(controlFd);
    throw new SecretInputError('no_terminal', 'could not enable masked terminal input');
  }

  const writeTerminal = (text: string): boolean => {
    try {
      writeSync(controlFd, text);
      return true;
    } catch {
      return false;
    }
  };
  const state = new SecretInput();
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: string): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      stream.removeListener('data', onData);
      stream.removeListener('error', onStreamError);
      stream.removeListener('end', onEnd);
      const restored = restoreTerminal(controlFd, originalState);
      try {
        stream.destroy();
      } catch {
        // Already destroyed.
      }
      try {
        writeSync(controlFd, '\n');
      } catch {
        // The descriptor may have failed with the terminal.
      }
      safeClose(controlFd);
      if (!restored) {
        reject(new SecretInputError('no_terminal', 'could not restore the terminal after masked input'));
      } else if (error !== undefined) reject(error);
      else resolve(value as string);
    };
    const onData = (chunk: Buffer): void => {
      try {
        const line = state.feed(chunk);
        if (line === undefined) return;
        if (line === '') {
          // Blank line: the caller re-prompts rather than accepting nothing.
          if (!writeTerminal(`\n${prompt}`)) {
            finish(new SecretInputError('no_terminal', 'could not write the terminal prompt'));
          }
          return;
        }
        finish(undefined, line);
      } catch (error) {
        finish(error);
      }
    };
    const onStreamError = (): void =>
      finish(new SecretInputError('no_terminal', 'could not read the terminal'));
    const onEnd = (): void => finish(new SecretInputError('eof', 'no secret was entered'));
    // A signal still restores the terminal, then re-raises so the process
    // keeps its normal signal disposition.
    const onSignal = (signal: NodeJS.Signals): void => {
      finish(new SecretInputError('cancelled', 'secret entry cancelled'));
      process.kill(process.pid, signal);
    };
    const onSigint = (): void => onSignal('SIGINT');
    const onSigterm = (): void => onSignal('SIGTERM');
    stream.on('data', onData);
    stream.on('error', onStreamError);
    stream.on('end', onEnd);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    if (!writeTerminal(prompt)) {
      finish(new SecretInputError('no_terminal', 'could not write the terminal prompt'));
    }
  });
}

/** Render a secret-entry failure for CLI output without echoing secret material. */
export function formatArgumentError(error: unknown): string {
  if (error instanceof SecretInputError) return `[olympus] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
