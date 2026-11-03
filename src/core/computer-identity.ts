import { spawnSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';

/** The machine serving the dashboard, never the browser's machine or account. */
export function dashboardComputerIdentity(): string {
  let name = hostname();
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1_000 });
    if (result.status === 0 && result.stdout.trim()) name = result.stdout.trim();
  }
  let account = 'unknown account';
  try { account = userInfo().username; } catch { /* Still show the computer name. */ }
  return `${name} · ${account}`;
}
