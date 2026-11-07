/** Fresh-user canary. All lifecycle commands run on the machine; no provider credentials leave it. */
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';
import { openEngineMcp, runLiveAccounts, type EngineMcp, type LiveSourceSpec } from './live-accounts.ts';
import { openFreshDashboard, type FreshDashboard } from './fresh-dashboard.ts';

export const FRESH_LEG = 'canary-test-omarchy-fresh';
export const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
export const asFresh = (script: string): string => `sudo -n -u olyfresh env HOME=/home/olyfresh XDG_CONFIG_HOME=/home/olyfresh/.config XDG_DATA_HOME=/home/olyfresh/.local/share XDG_STATE_HOME=/home/olyfresh/.local/state XDG_RUNTIME_DIR=/run/user/$(id -u olyfresh) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u olyfresh)/bus bash -c ${quote(script)}`;
export const freshMachine = (machine: Machine): Machine => ({ ...machine, exec: (script, options) => machine.exec(asFresh(script), options) });

export interface ConsentSnapshot { url: string; text: string; password: boolean; accounts: number; signedOut: boolean }
/** Only consent may be automated. No password, account switching or authentication challenge is answered. */
export function consentBlock(s: ConsentSnapshot): string | undefined {
  if (s.password || /enter (your )?password|forgot password/i.test(s.text)) return 'password';
  if (/2.step|two.step|two.factor|enter (the |a )?(security |verification )?code|verify it.s you|verification code|check your phone|security key|passkey|authenticator|captcha|verify you are human/i.test(s.text)) return '2FA or verification';
  if (s.accounts > 1 || /use another account|choose an account/i.test(s.text) && s.accounts !== 1) return 'account choice';
  if (s.signedOut || /\/signin\/(identifier|v2\/identifier)|\/login(?:[/?#]|$)/i.test(s.url)) return 'signed out';
  return undefined;
}

/** Fail closed on unreadable results. Check answer and search independently, including titles and citations. */
export function scopeAbsent(spec: LiveSourceSpec, answer: { ok: boolean; structured: unknown }, search: { ok: boolean; structured: unknown }): boolean {
  const a = answer.structured as any;
  const s = search.structured as any;
  if (!answer.ok || !search.ok || typeof a?.answer !== 'string' || !a.answer.trim() || a.status !== 'answered' || !Array.isArray(a.citations) || !Array.isArray(s?.evidence)) return false;
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const fold = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const hay = fold(strings([a.answer, a.citations, s.evidence]).join(' '));
  return spec.fresh!.outside.expect.every((needle) => !hay.includes(fold(needle)));
}

export const redactFreshDetail = (text: string): string => text.replace(/https?:\/\/[^\s]+/gi, '[URL redacted]').replace(/(?:Bearer\s+|(?:token|code|state|cookie|password)[=:]\s*)[^\s,;]+/gi, '[credential redacted]').slice(0, 300);

export class FreshInconclusive extends Error {}
export function validateFreshSources(sources: LiveSourceSpec[]): LiveSourceSpec[] {
  const nonempty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
  const needles = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  return ['gmail', 'dropbox'].map((id) => {
    const matches = sources.filter(s => s.id === id);
    const source = matches[0];
    const known = source?.known;
    const fresh = source?.fresh;
    if (matches.length !== 1 || !source || !known || !fresh || !nonempty(known.question) || !needles(known.expect)
      || !nonempty(fresh.scope) || fresh.scope === '/' || !nonempty(fresh.outside?.question) || !needles(fresh.outside?.expect)
      || (fresh.withinS !== undefined && (!Number.isFinite(fresh.withinS) || fresh.withinS <= 0))) {
      throw new Error(`${id} needs known and fresh.scope, fresh.outside.question/expect (nonempty strings)`);
    }
    return source;
  });
}

const ROOT = '"$HOME/.olympus-canary/fresh-run"';
/** A machine-side lease survives runner disconnects. EXIT/HUP/INT/TERM and expiry all restore zig. */
export const GUARD = `set -euo pipefail
restore() {
  trap '' HUP INT TERM
  ${asFresh('systemctl --user stop olympus-engine.service')} >/dev/null 2>&1 || true
  rc=0
  systemctl --user start olympus-engine.service || rc=1
  for i in $(seq 1 90); do
    if systemctl --user is-active --quiet olympus-engine.service && (echo > /dev/tcp/127.0.0.1/8010) 2>/dev/null; then echo "$rc" > ${ROOT}/restored.tmp; mv ${ROOT}/restored.tmp ${ROOT}/restored; exit "$rc"; fi
    sleep 1
  done
  echo 1 > ${ROOT}/restored.tmp
  mv ${ROOT}/restored.tmp ${ROOT}/restored
}
trap restore EXIT
trap 'exit 1' HUP INT TERM
systemctl --user stop olympus-engine.service
touch ${ROOT}/ready
for i in $(seq 1 7200); do [ -e ${ROOT}/lease ] || exit 0; sleep 1; done
exit 1`;

export interface FreshOptions {
  sources: LiveSourceSpec[];
  /** Local installer/tarball prepared by the site's Linux bundle builder; absent uses the published installer. */
  bundle?: { installer: string; tarball: string };
  cdp?: string;
  /** Test seam: real implementation uses only dashboard controls and persisted reads. */
  dashboard?: (machine: Machine, cdp: string) => Promise<FreshDashboard>;
  engine?: (machine: Machine) => Promise<EngineMcp>;
  sleep?: (ms: number) => Promise<void>;
}

export async function runFreshInstall(machine: Machine, options: FreshOptions): Promise<{ checks: CheckResult[]; screens: [] }> {
  const sources = validateFreshSources(options.sources);
  if (machine.os !== 'linux') throw new Error('fresh install requires Linux');
  const checks: CheckResult[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let current = 'install';
  let interrupted = false;
  // Wait for an in-flight installer mutation before unwinding; racing it would let it restart after restoration.
  const onInterrupt = () => { interrupted = true; };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  let armed = false;
  let dashboard: FreshDashboard | undefined;
  let engine: EngineMcp | undefined;
  const checked = async (id: string, action: () => Promise<void | string>): Promise<void> => {
    current = id;
    const start = Date.now();
    if (interrupted && id !== 'restore-zig') throw new Error('run interrupted');
    const detail = await action();
    if (interrupted && id !== 'restore-zig') throw new Error('run interrupted');
    checks.push({ id: `fresh.${id}`, title: id, status: 'pass', detail: detail ?? 'persisted effect verified', ms: Date.now() - start });
  };
  const exec = async (script: string, timeoutMs = 120_000): Promise<string> => {
    if (interrupted && current !== 'restore-zig') throw new Error('run interrupted');
    const result = await machine.exec(`set -euo pipefail\n${script}`, { timeoutMs });
    // Never forward command output: CLI links and installer diagnostics may carry credentials.
    if (result.code !== 0) throw new Error(`machine command failed (exit ${result.code})`);
    return result.stdout;
  };
  try {
    await checked('install', async () => {
      await exec(`umask 077
[ "$(id -un)" = zig ]
mkdir -p "$HOME/.olympus-canary"
mkdir ${ROOT} || { echo 'fresh run already active or left over'; exit 1; }
if ! id olyfresh >/dev/null 2>&1; then sudo -n useradd -m olyfresh; fi
[ "$(getent passwd olyfresh | cut -d: -f6)" = /home/olyfresh ]
sudo -n loginctl enable-linger olyfresh
sudo -n systemctl start user@$(id -u olyfresh).service`);
      // Write the guard with a quoted heredoc; neither it nor its output contains tokens.
      if (interrupted) throw new Error('run interrupted');
      armed = true;
      await exec(`cat > ${ROOT}/guard.sh <<'OLYMPUS_FRESH_GUARD'\n${GUARD}\nOLYMPUS_FRESH_GUARD
 touch ${ROOT}/lease
nohup setsid bash ${ROOT}/guard.sh > ${ROOT}/guard.log 2>&1 < /dev/null &`);
      await exec(`for i in $(seq 1 30); do [ ! -e ${ROOT}/restored ] || exit 1; [ ! -e ${ROOT}/ready ] || exit 0; sleep 1; done; exit 1`);
      await exec(`${asFresh('if systemctl --user cat olympus-engine.service >/dev/null 2>&1; then systemctl --user stop olympus-engine.service; fi')}
sudo -n find /home/olyfresh -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo -n install -d -o olyfresh -g "$(id -gn olyfresh)" -m 700 /home/olyfresh/.olympus-canary`);
      if (options.bundle) {
        await machine.put(options.bundle.installer, '/home/zig/.olympus-canary/fresh-run/install-linux.sh');
        await machine.put(options.bundle.tarball, '/home/zig/.olympus-canary/fresh-run/candidate.tgz');
        await exec(`sudo -n cp ${ROOT}/install-linux.sh ${ROOT}/candidate.tgz /home/olyfresh/.olympus-canary/
sudo -n chown -R olyfresh: /home/olyfresh/.olympus-canary
${asFresh('sh "$HOME/.olympus-canary/install-linux.sh" --tarball "$HOME/.olympus-canary/candidate.tgz" < /dev/null > "$HOME/.olympus-canary/install.log" 2>&1')}`, 25 * 60_000);
      } else {
        await exec(asFresh(`set -euo pipefail
curl -fsSL --proto '=https' --tlsv1.2 https://olympusplugin.ai/install-linux.sh -o "$HOME/.olympus-canary/install-linux.sh"
sh "$HOME/.olympus-canary/install-linux.sh" < /dev/null > "$HOME/.olympus-canary/install.log" 2>&1`), 25 * 60_000);
      }
    });
    const fresh = freshMachine(machine);
    await checked('engine-up', async () => {
      await exec(asFresh(`systemctl --user start olympus-engine.service
for i in $(seq 1 180); do
 if systemctl --user is-active --quiet olympus-engine.service && (echo > /dev/tcp/127.0.0.1/8010) 2>/dev/null; then exit 0; fi
 sleep 1
done; exit 1`), 200_000);
      try { engine = await (options.engine ?? openEngineMcp)(fresh); } catch { throw new Error('engine MCP connection failed'); }
    });
    await checked('dashboard-opens', async () => { dashboard = await (options.dashboard ?? openFreshDashboard)(fresh, options.cdp ?? '127.0.0.1:9333'); });
    for (const source of sources) {
      await checked(`${source.id}.connect`, () => dashboard!.connect(source));
      await checked(`${source.id}.consent`, () => dashboard!.consent(source));
      await checked(`${source.id}.callback`, () => dashboard!.callback(source));
      await checked(`${source.id}.scope`, () => dashboard!.scope(source));
      await checked(`${source.id}.first-items`, async () => {
        const deadline = Date.now() + (source.fresh!.withinS ?? 900) * 1000;
        let count = await dashboard!.indexed(source);
        while (!(Number.isFinite(count) && count > 0)) {
          if (Date.now() >= deadline) throw new Error('no first items indexed within the bound');
          if (interrupted) throw new Error('run interrupted');
          await sleep(3000);
          count = await dashboard!.indexed(source);
        }
        return `${count} item(s) indexed`;
      });
    }
    // Reuse existing status, known-search and optional fresh-item plant checks.
    current = 'live-accounts';
    checks.push(...(await runLiveAccounts(engine!, { sources, ...(options.sleep ? { sleep, pollMs: 1 } : {}) })).map(c => ({ ...c, detail: c.status === 'pass' ? 'engine status/search verified' : c.status === 'skip' ? 'Inconclusive: fresh item plant needs attention' : 'engine status/search or fresh item check did not pass' })));
    for (const source of sources) {
      await checked(`${source.id}.answer`, async () => {
        const answer = await ask(engine!, source.known!.question, sleep);
        const a = answer.structured as any;
        if (!answer.ok || a?.status !== 'answered' || typeof a.answer !== 'string' || !source.known!.expect.every(n => a.answer.toLowerCase().includes(n.toLowerCase())) || !Array.isArray(a.citations) || !a.citations.some((c: any) => String(c.label ?? c.source).toLowerCase() === source.label.toLowerCase())) throw new Error('known question was not answered with expected facts and a source citation');
      });
      await checked(`${source.id}.scope-absence`, async () => {
        const answer = await ask(engine!, source.fresh!.outside.question, sleep);
        const search = await engine!.call('olympus_search', { question: source.fresh!.outside.question, limit: 100 });
        if (!scopeAbsent(source, answer, search)) throw new Error('outside-scope item leaked, or answer/search could not be verified');
      });
    }
  } catch (error) {
    checks.push({ id: `fresh.${current}`, title: current, status: error instanceof FreshInconclusive ? 'skip' : 'fail', detail: error instanceof FreshInconclusive ? `Inconclusive: ${error.message}` : `check failed: ${error instanceof Error ? redactFreshDetail(error.message) : 'unexpected failure'}` });
  } finally {
    // Cleanup errors must not prevent service restoration or the report.
    await engine?.close().catch(() => {});
    await dashboard?.close().catch(() => {});
    if (armed) {
      try {
        await checked('restore-zig', async () => {
          await exec(`rm -f ${ROOT}/lease
for i in $(seq 1 120); do
 if [ -e ${ROOT}/restored ]; then [ "$(cat ${ROOT}/restored)" = 0 ] && systemctl --user is-active --quiet olympus-engine.service && (echo > /dev/tcp/127.0.0.1/8010) 2>/dev/null; exit $?; fi
 sleep 1
done; exit 1`, 130_000);
          await exec(`rm -rf ${ROOT}`);
        });
      } catch { checks.push({ id: 'fresh.restore-zig', title: 'Restore zig engine', status: 'fail', detail: 'zig engine restoration could not be verified; inspect the machine guard log' }); }
    }
  }
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  return { checks, screens: [] };
}

async function ask(engine: EngineMcp, question: string, sleep: (ms: number) => Promise<void>) {
  let result = await engine.call('source_answer', { question });
  const deadline = Date.now() + 180_000;
  while (result.ok && (result.structured as any)?.status === 'working' && Date.now() < deadline) {
    await sleep(1500);
    result = await engine.call('source_answer_result', { job_id: (result.structured as any).job_id });
  }
  return result;
}
