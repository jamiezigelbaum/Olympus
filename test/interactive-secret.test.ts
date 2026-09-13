import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  SecretInput,
  SecretInputError,
  formatArgumentError,
  readSecretFromTerminal,
} from '../src/core/interactive-secret.ts';

const feed = (chunks: readonly (string | Buffer)[]): string => {
  const input = new SecretInput();
  let result: string | undefined;
  for (const chunk of chunks) {
    result = input.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  }
  if (result === undefined) throw new Error('input did not submit');
  return result;
};

describe('masked secret input state machine', () => {
  test('submits a typed key and strips the trailing newline', () => {
    expect(feed(['sk-test-value\r'])).toBe('sk-test-value');
    expect(feed(['sk-test-value\n'])).toBe('sk-test-value');
    expect(feed(['sk-test-value\r\n'])).toBe('sk-test-value');
  });

  test('treats a bracketed paste with an optional trailing newline as the value', () => {
    // The paste frame carries the value; the caller's Enter submits it.
    const pasted = new SecretInput();
    expect(pasted.feed(Buffer.from('\x1b[200~sk-pasted\x1b[201~'))).toBeUndefined();
    expect(pasted.feed(Buffer.from('\r'))).toBe('sk-pasted');
    expect(feed(['\x1b[200~sk-pasted\x1b[201~\r'])).toBe('sk-pasted');
    expect(feed(['\x1b[200~sk-pasted\n\x1b[201~', '\r'])).toBe('sk-pasted');
  });

  test('handles paste markers split across chunks and leading submit keystrokes', () => {
    expect(feed(['\x1b', '[20', '0~key', '\x1b[201', '~', '\r'])).toBe('key');
    expect(feed(['\r', 'key', '\r'])).toBe('key');
    expect(feed(['\r\rkey\r'])).toBe('key');
  });

  test('applies backspace and delete without dropping neighbouring characters', () => {
    expect(feed(['secretx\x7f', '\r'])).toBe('secret');
    // Delete removes the character before the cursor: 'secre' -> 'secr'.
    expect(feed(['secre\x1b[3~t\r'])).toBe('secrt');
    expect(feed(['\x7f', 'key\r'])).toBe('key');
  });

  test('rejects an empty submit by re-prompting rather than accepting blank input', () => {
    const input = new SecretInput();
    // Blank Enter is always ignored (empty sentinel), not submitted as the secret.
    expect(input.feed(Buffer.from('\r'))).toBe('');
    expect(input.feed(Buffer.from('\r'))).toBe('');
    expect(input.feed(Buffer.from('key\r'))).toBe('key');
  });

  test('caps the secret at 4096 bytes', () => {
    expect(feed([`${'A'.repeat(4096)}\r`])).toHaveLength(4096);
    expect(() => feed([`${'A'.repeat(4097)}\r`])).toThrow(SecretInputError);
    expect(() => feed([`${'A'.repeat(4097)}\r`])).toThrow(/4096 bytes/);
  });

  test('rejects multi-line pastes and stray line breaks', () => {
    expect(() => feed(['\x1b[200~line1\nline2\x1b[201~\r'])).toThrow(SecretInputError);
    expect(() => feed(['\x1b[200~line1\nline2\n\x1b[201~\r'])).toThrow(SecretInputError);
    // A submit keystroke completes the entry instead of being swallowed.
    expect(feed(['key\n'])).toBe('key');
    expect(() => feed(['key\nsecond line\n'])).toThrow(SecretInputError);
    expect(() => feed(['\x1b[200~key\n\n\x1b[201~\r'])).toThrow(SecretInputError);
  });

  test('rejects malformed control bytes and unknown escape sequences', () => {
    const malformedInputs = [
      'key\x1b[A\r', // arrow key: no cursor editing in a masked field
      'key\x1b[2~\r', // unknown escape sequence
      'key\x1b[201~\r', // paste end without a paste start
      'key\x1b[200~nested\x1b[200~\r', // nested paste start
      'key\x07\r', // bell
      'key\x00\r', // nul
      'key\x1b[A\x1b[B\r', // two unknown cursor sequences in one read
    ];
    for (const input of malformedInputs) {
      let thrown: unknown;
      try {
        new SecretInput().feed(Buffer.from(input, 'utf8'));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SecretInputError);
      expect((thrown as SecretInputError).code).toBe('malformed_input');
    }
  });

  test('reports cancellation and end of input as distinct fixed failures', () => {
    const cancelled = (() => {
      try {
        feed(['key\x03']);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(cancelled).toBeInstanceOf(SecretInputError);
    expect((cancelled as SecretInputError).code).toBe('cancelled');

    const eof = (() => {
      try {
        feed(['key\x04']);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect((eof as SecretInputError).code).toBe('eof');
  });

  test('keeps multi-byte utf-8 sequences intact across chunk boundaries', () => {
    // 'é' is two bytes; split it across two reads.
    const multi = Buffer.from('key-é', 'utf8');
    expect(feed([multi.subarray(0, 5), multi.subarray(5), '\r'])).toBe('key-é');
    expect(feed(['key-🔐\r'])).toBe('key-🔐');
    expect(() => feed([Buffer.from([0xff, 0xfe]), '\r'])).toThrow(SecretInputError);
  });

  test('never includes secret material in an error message', () => {
    const secret = 'super-secret-do-not-echo';
    for (const bad of [`${secret}\x07\r`, `${secret}${'B'.repeat(4096)}\r`]) {
      try {
        feed([bad]);
        throw new Error('expected rejection');
      } catch (error) {
        expect(formatArgumentError(error)).not.toContain(secret);
      }
    }
  });
});

describe('readSecretFromTerminal terminal requirements', () => {
  test('fails closed without a controlling terminal', () => {
    if (!pythonDriverAvailable()) {
      throw new Error('python3 stdlib session driver unavailable');
    }
    const childSource = `
      import { readSecretFromTerminal } from "./src/core/interactive-secret.ts";
      try {
        await readSecretFromTerminal("secret> ");
        process.exit(3);
      } catch (error) {
        process.exit(error?.code === "no_terminal" ? 0 : 4);
      }
    `;
    const driver = spawnSync(
      'python3',
      [
        '-c',
        'import os, sys; os.chdir(sys.argv[1]); os.setsid(); os.execve(sys.argv[2], [sys.argv[2], "-e", sys.argv[3]], dict(os.environ))',
        process.cwd(),
        process.execPath,
        childSource,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(driver.error).toBeUndefined();
    expect(driver.status).toBe(0);
  });

  test('formats entry failures for CLI output', () => {
    expect(formatArgumentError(new SecretInputError('cancelled', 'secret entry cancelled'))).toBe(
      '[olympus] secret entry cancelled',
    );
    expect(formatArgumentError(new Error('boom'))).toBe('boom');
  });
});

const PYTHON_DRIVER = `
import base64, os, pty, select, signal, subprocess, sys, time
workspace, runtime, child_src, action, prompt = sys.argv[1:6]
pid, master = pty.fork()
if pid == 0:
    os.chdir(workspace)
    os.execve(runtime, [runtime, "-e", child_src], dict(os.environ))
seen = b""
step = 0
status = 0
deadline = time.monotonic() + 15
while True:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            data = os.read(master, 4096)
        except OSError:
            data = b""
        if data:
            seen += data
    prompts = seen.count(prompt.encode())
    if action == "success" and step == 0 and prompts >= 1:
        os.write(master, bytes([13]))
        step = 1
    elif action == "success" and step == 1 and prompts >= 2:
        os.write(master, bytes([13]))
        step = 2
    elif action == "success" and step == 2 and prompts >= 3:
        secret = bytes([115, 121, 110, 116, 104, 101, 116, 105, 99, 45, 112, 116, 121, 45, 107, 101, 121])
        os.write(master, secret + bytes([13]))
        step = 3
    elif action == "cancel" and step == 0 and prompts >= 1:
        os.write(master, bytes([3]))
        step = 1
    elif action == "eof" and step == 0 and prompts >= 1:
        os.write(master, bytes([4]))
        step = 1
    elif action == "malformed" and step == 0 and prompts >= 1:
        os.write(master, bytes([27, 91, 65]))
        step = 1
    elif action == "sigint" and step == 0 and prompts >= 1:
        os.kill(pid, signal.SIGINT)
        step = 1
    elif action == "sigterm" and step == 0 and prompts >= 1:
        os.kill(pid, signal.SIGTERM)
        step = 1
    done, wait_status = os.waitpid(pid, os.WNOHANG)
    if done:
        status = wait_status
        # Drain the child's final output before closing the master.
        for _ in range(50):
            ready, _, _ = select.select([master], [], [], 0.02)
            if not ready:
                break
            try:
                tail = os.read(master, 4096)
            except OSError:
                break
            if not tail:
                break
            seen += tail
        break
    if time.monotonic() >= deadline:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
        break
after_run = subprocess.run(["/bin/stty", "-g"], stdin=master, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
after = after_run.stdout.strip() if after_run.returncode == 0 else "unavailable"
os.close(master)
sys.stdout.write("EXIT:%d" % os.waitstatus_to_exitcode(status) + chr(10))
sys.stdout.write("STATE_AFTER:" + after + chr(10))
sys.stdout.write("SESSION_B64:" + base64.b64encode(seen).decode("ascii") + chr(10))
`;

// Executed by the pty child runtime through `runtime -e`, so the pty test
// exercises the shipped module rather than a copy of the logic.
const CHILD_SOURCE = `
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { readSecretFromTerminal } from "./src/core/interactive-secret.ts";
try {
  const probeFd = openSync("/dev/tty", "r+");
  closeSync(probeFd);
} catch (error) {
  process.stdout.write("ENV_BLOCKED:" + String(error?.code ?? "unknown") + "\\n");
  process.exit(77);
}
const snapshot = spawnSync("/bin/stty", ["-g"], { encoding: "utf8", stdio: [0, "pipe", "ignore"] });
process.stdout.write("STATE_BEFORE:" + String(snapshot.stdout).trim() + "\\n");
try {
  const value = await readSecretFromTerminal("secret> ");
  process.stdout.write("VALUE_SHA256:" + createHash("sha256").update(value).digest("hex") + "\\n");
  process.exitCode = 0;
} catch (error) {
  process.stdout.write("ERROR_CODE:" + String(error?.code ?? "unknown") + "\\n");
  process.exitCode = 4;
}
`;

const pythonDriverAvailable = (): boolean => {
  const probe = spawnSync("python3", ["-c", "import pty, select"], { stdio: "ignore" });
  return probe.status === 0;
};

describe("readSecretFromTerminal on a real pty", () => {
  const runPty = (action: string): { exit: number; session: string; before: string; after: string } => {
    if (!pythonDriverAvailable()) {
      throw new Error('python3 stdlib pty driver unavailable');
    }
    const driver = spawnSync(
      "python3",
      [
        "-c",
        PYTHON_DRIVER,
        process.cwd(),
        process.execPath,
        CHILD_SOURCE,
        action,
        "secret> ",
      ],
      {
        encoding: "utf8",
        timeout: 30000,
      },
    );
    expect(driver.error).toBeUndefined();
    expect(driver.stderr).toBe("");
    const exit = Number(driver.stdout.match(/^EXIT:(-?\d+)$/m)?.[1]);
    const after = driver.stdout.match(/^STATE_AFTER:(.+)$/m)?.[1] ?? '';
    const encoded = driver.stdout.match(/^SESSION_B64:(.*)$/m)?.[1] ?? '';
    const session = Buffer.from(encoded, 'base64').toString('utf8');
    const before = session.match(/^STATE_BEFORE:(.+)$/m)?.[1]?.trim() ?? '';
    return { exit, session, before, after };
  };

  const expectRestored = (run: { before: string; after: string }): void => {
    expect(run.before.length).toBeGreaterThan(0);
    expect(run.after).toBe(run.before);
  };

  const blockedBySandbox = (run: { exit: number; session: string }): boolean => {
    const blocked = run.exit === 77 && /ENV_BLOCKED:(?:EPERM|EACCES)/.test(run.session);
    if (blocked) console.warn('skipping real pty assertions: sandbox denied read-write /dev/tty');
    return blocked;
  };

  test("captures a synthetic secret with echo off and restores the exact tty state", () => {
    const run = runPty('success');
    if (blockedBySandbox(run)) return;
    expect(run.exit).toBe(0);
    expect(run.session.match(/secret> /g)).toHaveLength(3);
    expect(run.session).not.toContain('synthetic-pty-key');
    expect(run.session).toContain(
      `VALUE_SHA256:${createHash('sha256').update('synthetic-pty-key').digest('hex')}`,
    );
    expectRestored(run);
  }, 90000);

  test.each([
    ['cancel', 'cancelled'],
    ['eof', 'eof'],
    ['malformed', 'malformed_input'],
  ])("restores the exact tty state after %s input", (action, code) => {
    const run = runPty(action);
    if (blockedBySandbox(run)) return;
    expect(run.exit).toBe(4);
    expect(run.session).toContain(`ERROR_CODE:${code}`);
    expectRestored(run);
  }, 90000);

  test.each([
    ['sigint', -2],
    ['sigterm', -15],
  ])("restores the exact tty state before re-raising %s", (action, exit) => {
    const run = runPty(action);
    if (blockedBySandbox(run)) return;
    expect(run.exit).toBe(exit);
    expectRestored(run);
  }, 90000);
});
