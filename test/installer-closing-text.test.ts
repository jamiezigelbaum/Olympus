import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

for (const platform of ['macos', 'linux']) {
  test(`${platform}: closing text opens the dashboard before offering assistants, with no status command`, () => {
    const script = readFileSync(join(import.meta.dir, '..', 'scripts', `install-${platform}.sh`), 'utf8');
    const closing = platform === 'macos'
      ? script.slice(script.indexOf('finish() {'), script.lastIndexOf('\nmain "$@"')) + '\nfinish'
      : script.slice(script.indexOf("  say 'Installed for your user"), script.indexOf('\nACTIVATE', script.indexOf("  say 'Installed for your user")));
    const result = spawnSync('/bin/sh', [], { input: 'say() { printf "%s\\n" "$*"; }\ninstall_command() { :; }\nUNINSTALL_COMMAND="remove Olympus"\n' + closing, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = result.stdout;
    expect(output).toContain('browser on this computer');
    expect(output).toContain('dashboard');
    expect(output).toContain('Agents page');
    expect(output).toContain('ChatGPT, Claude or other agents');
    expect(output.indexOf('dashboard')).toBeLessThan(output.indexOf('ChatGPT'));
    expect(output).toContain('To uninstall:');
    expect(output).not.toContain('engine status');
    expect(output).not.toContain('Terminal');
  }, 30_000);
}
