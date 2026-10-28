import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'telegram-pair.py');

// Runs the shipped helper's controlling_terminal() and prompt() inside a real
// pty, so the test fails if the helper cannot open /dev/tty the way pairing does.
const PYTHON_DRIVER = String.raw`
import os, pty, sys
script = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    import importlib.util
    spec = importlib.util.spec_from_file_location("telegram_pair", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        with module.controlling_terminal() as terminal:
            value = module.prompt(terminal, "api_id: ")
        print("VALUE:" + value, flush=True)
        os._exit(0)
    except module.SafePairingError as error:
        print("ERROR:" + error.code, flush=True)
        os._exit(3)
out = b""
sent = False
while True:
    try:
        chunk = os.read(fd, 1024)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not sent and b"api_id: " in out:
        os.write(fd, b"12345\n")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.stdout.write("\nEXIT:%d\n" % os.waitstatus_to_exitcode(status))
`;

describe('telegram-pair.py controlling terminal', () => {
  test('opens /dev/tty and reads a prompt answer on a real pty', () => {
    const driver = spawnSync('python3', ['-c', PYTHON_DRIVER, SCRIPT], { encoding: 'utf8', timeout: 30000 });
    expect(driver.error).toBeUndefined();
    expect(driver.stderr).toBe('');
    expect(driver.stdout).not.toContain('ERROR:controlling_terminal_required');
    expect(driver.stdout).toContain('VALUE:12345');
    expect(driver.stdout).toMatch(/^EXIT:0$/m);
  }, 40_000);
});
