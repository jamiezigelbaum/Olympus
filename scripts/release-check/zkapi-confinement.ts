import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

/** Exercise the commands printed by the installed product on the disposable machine. */
export async function checkZkapiConfinement(machine: Machine): Promise<CheckResult> {
  const id = 'zkapi.confinement';
  const title = 'Anonymous-answer network confinement is ready';
  const result = (status: CheckResult['status'], detail: string): CheckResult => ({ id, title, status, detail });
  if (machine.os !== 'linux') return result('skip', 'Linux confinement does not apply on macOS.');
  try {
    const sysctl = await machine.exec('if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns; else echo absent; fi\n');
    if (sysctl.code !== 0 || !['0', '1', 'absent'].includes(sysctl.stdout.trim())) return result('fail', 'Could not read the AppArmor user namespace restriction.');
    const install = await machine.exec('"$HOME/.local/bin/olympus" zkapi install-tools\n', { timeoutMs: 600_000 });
    if (install.code !== 0) return result('fail', `install-tools failed (exit ${install.code}).`);
    const check = () => machine.exec('"$HOME/.local/bin/olympus" zkapi check-confinement\n', { timeoutMs: 60_000 });
    const first = await check();
    if (sysctl.stdout.trim() !== '1') {
      return first.code === 0 && first.stdout.startsWith('network confinement: ready (') && !first.stdout.includes('sudo ')
        ? result('pass', 'Confinement is ready without an administrator step.')
        : result('fail', `Expected ready without an administrator step: ${first.stdout.trim()}`);
    }
    const match = first.stdout.match(/\n\n(sudo install -D -m 0755 -o root -g root [^\n]+\nsudo tee \/etc\/apparmor\.d\/olympus-zkapi-confine >\/dev\/null <<'EOF'\n[\s\S]*?\nEOF\nsudo apparmor_parser -r \/etc\/apparmor\.d\/olympus-zkapi-confine)\n\nThen ask Olympus again\./);
    if (first.code === 0 || !first.stdout.startsWith('network confinement: unavailable:') || !match) return result('fail', 'Expected a refusal with the complete administrator step.');
    const applied = await machine.exec(`set -e\n${match[1]}\n`, { timeoutMs: 60_000 });
    if (applied.code !== 0) return result('fail', `The printed administrator step failed (exit ${applied.code}): ${applied.stderr.trim()}`);
    const after = await check();
    return after.code === 0 && after.stdout.startsWith('network confinement: ready (')
      ? result('pass', 'Confinement is ready after running the printed administrator step.')
      : result('fail', `Confinement was not ready after the administrator step: ${after.stdout.trim()}`);
  } catch (error) {
    return result('fail', `Confinement check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
