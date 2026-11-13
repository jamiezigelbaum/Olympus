/** Fresh-user canary. All lifecycle commands run on the machine; no provider credentials leave it. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';
import { openEngineMcp, runLiveAccounts, type EngineMcp, type LiveSourceSpec } from './live-accounts.ts';
import { openFreshDashboard, type FreshDashboard } from './fresh-dashboard.ts';
import { runFreshOnDemand, type FreshTimingOptions } from './fresh-on-demand.ts';
import type { OnDemandTimingResult } from './on-demand-timing.ts';
import { runFreshLimits, type FreshLimitsOptions, type LimitsResult } from './fresh-limits.ts';
import { ANSWER_MODEL_REQUIRED_TEXT } from '../../src/workers/answer-model-required.ts';
import { FIRST_RUN_PRIVACY_REQUIRED_TEXT } from '../../src/workers/first-run-privacy-gate.ts';
import localFirst from '../../config/sovereignty/presets/local-first.json';

export const FRESH_LEG = 'canary-test-omarchy-fresh';
export const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
// sudo keeps the caller's cwd; zig's 0700 home makes every olyfresh child spawn fail with EACCES.
export const asFresh = (script: string): string => `sudo -n -u olyfresh env HOME=/home/olyfresh XDG_CONFIG_HOME=/home/olyfresh/.config XDG_DATA_HOME=/home/olyfresh/.local/share XDG_STATE_HOME=/home/olyfresh/.local/state XDG_RUNTIME_DIR=/run/user/$(id -u olyfresh) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u olyfresh)/bus bash -c ${quote(`cd "$HOME" || exit 1\n${script}`)}`;
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
  return scopeAbsenceProblem(spec, answer, search) === undefined;
}

/** Why the outside-scope check did not pass, never quoting the answer: a leak, or which part could not be read. */
export function scopeAbsenceProblem(spec: LiveSourceSpec, answer: { ok: boolean; structured: unknown }, search: { ok: boolean; structured: unknown }): string | undefined {
  const a = answer.structured as any;
  const s = search.structured as any;
  if (!answer.ok) return 'the answer call failed';
  if (!search.ok) return 'the search call failed';
  if (typeof a?.answer !== 'string' || !a.answer.trim() || a.status !== 'answered' || !Array.isArray(a.citations)) return `the answer could not be verified (status ${String(a?.status ?? 'none')})`;
  if (!Array.isArray(s?.evidence)) return 'the search returned no evidence list';
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const fold = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const where = [['the answer', [a.answer]], ['its citations', a.citations], ['search evidence', s.evidence]] as const;
  const leaked = where.filter(([, value]) => spec.fresh!.outside.expect.some((needle) => fold(strings(value).join(' ')).includes(fold(needle)))).map(([name]) => name);
  return leaked.length ? `outside-scope item leaked into ${leaked.join(', ')}` : undefined;
}

export const redactFreshDetail = (text: string): string => text.replace(/https?:\/\/[^\s]+/gi, '[URL redacted]').replace(/(?:Bearer\s+|(?:token|code|state|cookie|password)[=:]\s*)[^\s,;]+/gi, '[credential redacted]').slice(0, 300);

/** A timeline or log excerpt keeps its lines, with links and credentials taken out like any detail; past 30,000 characters it keeps the first and last 10,000. */
export const redactFreshTimeline = (text: string): string => text.replace(/https?:\/\/[^\s]+/gi, '[URL redacted]').replace(/(?:Bearer\s+|(?:token|code|state|cookie|password|key)[=:]\s*)[^\s,;]+/gi, '[credential redacted]').replace(/^([\s\S]{10000})[\s\S]{10000,}([\s\S]{10000})$/, '$1\n[middle cut]\n$2');
/** Load, CPU count and the four busiest processes of the fresh user; never fails the sample. */
export const FRESH_MACHINE_SAMPLE = `{ printf 'load %s of %s cpus | ' "$(cut -d' ' -f1 /proc/loadavg)" "$(nproc)"; ps -u "$(id -un)" -o pcpu=,rss=,args= --sort=-pcpu | head -n 4 | awk '{ n=split($3, a, "/"); m=split($4, b, "/"); printf "%s%% %sMB %s %s %s; ", $1, int($2/1024), a[n], b[m], $5 }'; } 2>/dev/null || true`;
/** The engine's log lines about judging, embedding and the privacy check: counts and the last 60 lines. */
export const FRESH_ENGINE_LOG = `{ out=$(systemctl --user show -p StandardOutput --value olympus-engine.service 2>/dev/null | sed 's/^append://'); log=$(cat "$out" "\${out%.log}.err" 2>/dev/null | grep -iE 'embed|judg|sniffer|classif|privacy check|tier' || true); printf 'log %s: matching lines %s (embed %s, judge %s)\\n' "\${out:-not found}" "$(printf '%s\\n' "$log" | grep -c . || true)" "$(printf '%s\\n' "$log" | grep -ic embed || true)" "$(printf '%s\\n' "$log" | grep -icE 'judg|sniffer|classif' || true)"; printf '%s\\n' "$log" | tail -n 80 | cut -c1-220; } || true`;

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

/**
 * The ports of the model servers the recommended preset expects a person to run. The built-in model covers for one only when
 * nothing listens there, so a leftover server on such a port keeps a fresh install's sources locked (olympus-ops#221).
 */
export const LOCAL_FIRST_PORTS: readonly number[] = Object.values(localFirst.modelProfiles as Record<string, { provider: string; baseUrl?: string }>)
  .filter((profile) => profile.provider === 'local-openai-compatible' && profile.baseUrl)
  .map((profile) => new URL(profile.baseUrl!))
  .filter((url) => url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  .map((url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80)));

/** Each held port, with the program and user holding it, from `ss -Hltnp` lines; empty when every port is free. */
export function heldPorts(ssOutput: string, ports: readonly number[]): string[] {
  const held: string[] = [];
  for (const port of ports) {
    const line = ssOutput.split('\n').find((row) => new RegExp(`[:\\]]${port}\\s`).test(row));
    if (!line) continue;
    const program = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    held.push(`127.0.0.1:${port} is held by ${program ? `${program[1]} (pid ${program[2]})` : 'a process ss could not name'}`);
  }
  return held;
}

const ROOT = '"$HOME/.olympus-canary/fresh-run"';
export const FRESH_BRIDGE_PID = '/home/olyfresh/.olympus-canary/owner-bridge.pid';
// The engine's health, read as the fresh user. Only its reranker counts and install state reach the report.
const HEALTH_READ = 'curl -fsS --max-time 5 --unix-socket "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/olympus/worker.sock" http://127.0.0.1:8010/v1/health';
export const SOCKET_READY = 'curl -fsS --max-time 2 --unix-socket "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/olympus/worker.sock" http://127.0.0.1:8010/v1/health > /dev/null';
/** A machine-side lease survives runner disconnects. EXIT/HUP/INT/TERM and expiry all restore zig. */
export const GUARD = `set -euo pipefail
restore() {
  trap '' HUP INT TERM
  ${asFresh('systemctl --user stop olympus-engine.service')} >/dev/null 2>&1 || true
  ${asFresh(`if [ -f ${FRESH_BRIDGE_PID} ]; then
    pid=$(cat ${FRESH_BRIDGE_PID})
    case "$pid" in ''|*[!0-9]*) exit 1;; esac
    kill "$pid" 2>/dev/null || true
    rm -f ${FRESH_BRIDGE_PID}
  fi`)} >/dev/null 2>&1 || true
  rc=0
  systemctl --user start olympus-engine.service || rc=1
  for i in $(seq 1 90); do
    if systemctl --user is-active --quiet olympus-engine.service && ${SOCKET_READY}; then echo "$rc" > ${ROOT}/restored.tmp; mv ${ROOT}/restored.tmp ${ROOT}/restored; exit "$rc"; fi
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
  onDemandTiming?: FreshTimingOptions;
  limits?: FreshLimitsOptions;
  /** Unit-test seam. Every production fresh install runs limits. */
  limitsStage?: typeof runFreshLimits;
  /** The test Venice key (olympus-ops#211), given to the install on stdin before the walkthrough; never logged or reported. */
  veniceKey?: string;
  /** Current harness bundle, copied to the fresh user's home for the existing owner-bridge command. */
  bridgeAgent?: string;
  /** Test seam: real implementation uses only dashboard controls and persisted reads. */
  dashboard?: (machine: Machine, cdp: string) => Promise<FreshDashboard>;
  engine?: (machine: Machine) => Promise<EngineMcp>;
  sleep?: (ms: number) => Promise<void>;
}

export async function runFreshInstall(machine: Machine, options: FreshOptions): Promise<{ checks: CheckResult[]; screens: []; onDemandTiming?: OnDemandTimingResult; limits?: LimitsResult }> {
  const sources = validateFreshSources(options.sources);
  if (machine.os !== 'linux') throw new Error('fresh install requires Linux');
  if (!options.dashboard && !options.bridgeAgent) throw new Error('fresh install needs the machine-agent bundle');
  const checks: CheckResult[] = [];
  let onDemandTiming: OnDemandTimingResult | undefined;
  let limits: LimitsResult | undefined;
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
  // A check whose failure is recorded without ending the leg, because nothing after it depends on it.
  const recorded = async (id: string, action: () => Promise<void | string>): Promise<void> => {
    try { await checked(id, action); } catch (error) {
      if (interrupted) throw error;
      checks.push({ id: `fresh.${id}`, title: id, status: 'fail', detail: `check failed: ${error instanceof Error ? redactFreshDetail(error.message) : 'unexpected failure'}` });
    }
  };
  const exec = async (script: string, timeoutMs = 120_000): Promise<string> => {
    if (interrupted && current !== 'restore-zig') throw new Error('run interrupted');
    const result = await machine.exec(`set -euo pipefail\n${script}`, { timeoutMs });
    // Never forward command output: CLI links and installer diagnostics may carry credentials.
    if (result.code !== 0) throw new Error(`machine command failed (exit ${result.code})`);
    return result.stdout;
  };
  try {
    // A fresh machine has nothing on the ports the recommended preset reaches for; a leftover there is the machine's fault, said at once.
    await checked('machine-clear', async () => {
      const result = await machine.exec(`sudo -n ss -Hltnp 2>/dev/null || ss -Hltnp`, { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error(`could not list listening ports (exit ${result.code})`);
      let held = heldPorts(result.stdout, LOCAL_FIRST_PORTS);
      // Name the unit that keeps it running, so the owner knows what to move (a test unit, olympus-ops#221).
      held = await Promise.all(held.map(async (line) => {
        const pid = /\(pid (\d+)\)/.exec(line)?.[1];
        const unit = pid ? (await machine.exec(`ps -o unit= -p ${pid}`, { timeoutMs: 10_000 }).catch(() => undefined))?.stdout.trim() : undefined;
        return unit && /^[\w@.-]+$/.test(unit) ? `${line}, unit ${unit}` : line;
      }));
      if (held.length > 0) throw new Error(`${held.join('; ')}: the local-first preset's model server port must be free on a fresh machine, or the built-in model never covers for it`);
      return `${LOCAL_FIRST_PORTS.map((port) => `127.0.0.1:${port}`).join(', ')} free`;
    });
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
      if (options.bridgeAgent) {
        await machine.put(options.bridgeAgent, '/home/zig/.olympus-canary/fresh-run/agent.js');
        await exec(`sudo -n install -d -o olyfresh -g "$(id -gn olyfresh)" -m 700 /home/olyfresh/rc
sudo -n install -o olyfresh -g "$(id -gn olyfresh)" -m 600 ${ROOT}/agent.js /home/olyfresh/rc/agent.js`);
      }
    });
    const fresh = freshMachine(machine);
    await checked('engine-up', async () => {
      await exec(asFresh(`systemctl --user start olympus-engine.service
for i in $(seq 1 180); do
 if systemctl --user is-active --quiet olympus-engine.service && ${SOCKET_READY}; then exit 0; fi
 sleep 1
done; exit 1`), 200_000);
      try { engine = await (options.engine ?? openEngineMcp)(fresh); } catch { throw new Error('engine MCP connection failed'); }
    });
    // The reranker turns itself on once its own ONNX pack and model land; a LiteRT install never ships that pack (#1583).
    // It downloads from boot, so wait for it first: this holds even when a later step stops the leg, and the answers
    // then show whether it ranks. Off below 16 GiB RAM, where health leaves it out.
    let rerankerOn = false;
    current = 'reranker-ready';
    const rerankStart = Date.now();
    const rerankHealth = async () => JSON.parse(await exec(asFresh(HEALTH_READ), 30_000)) as {
      rerank_outcomes?: { applied?: number; failed?: number; timed_out?: number };
      reranker_install?: { state?: string; reason?: string; percent?: number };
    };
    let health = await rerankHealth();
    if (!health.rerank_outcomes) {
      checks.push({ id: 'fresh.reranker-ready', title: 'reranker-ready', status: 'skip', detail: 'reranker off on this machine (below 16 GiB RAM, or turned off)', ms: Date.now() - rerankStart });
    } else {
      await checked('reranker-ready', async () => {
        const deadline = Date.now() + 900_000;
        while (health.reranker_install?.state !== 'ready') {
          const install = health.reranker_install;
          if (install?.state === 'failed') throw new Error(`reranker install failed: ${install.reason ?? 'no reason'}`);
          if (Date.now() >= deadline) throw new Error(`reranker install not ready within 15 minutes (${install?.state ?? 'no state'}, ${install?.percent ?? 0}%)`);
          if (interrupted) throw new Error('run interrupted');
          await sleep(5000);
          health = await rerankHealth();
        }
        rerankerOn = true;
        return 'runtime pack and model installed';
      });
    }
    // Nothing has chosen an answer model yet, so Ask must stay callable and explain setup instead of answering (#1370).
    // A failure here is recorded without stopping the leg: nothing after it depends on it.
    await recorded('ask-without-model', async () => {
        // Listing is checked on its own: the call returns the setup text before dispatch, so a call alone can't prove it.
        const listed = await engine!.listTools?.();
        if (!listed) throw new Error('the engine connection cannot list tools');
        if (!listed.includes('source_answer')) throw new Error('source_answer is not in tools/list');
        const result = await engine!.call('source_answer', { question: 'Is an answer model set up?' });
        // Before the privacy choice, every outside surface explains that step first; that is setup text too.
        if (!result.ok && result.error?.trim() === FIRST_RUN_PRIVACY_REQUIRED_TEXT) return 'source_answer listed; privacy-choice setup text returned, no answer run';
        if (!result.ok) throw new Error(`source_answer failed instead of explaining setup: ${result.error ?? 'no detail'}`);
        if (result.text.trim() !== ANSWER_MODEL_REQUIRED_TEXT) throw new Error('source_answer did not return the setup text');
        return 'source_answer listed; setup text returned, no answer run';
    });
    // With the test Venice key, the walkthrough's "Who checks privacy?" step can save Venice (#1634); without it, it saves this computer.
    if (options.veniceKey !== undefined) {
      await checked('venice-key', async () => {
        if (!options.veniceKey) throw new Error('the Venice key command returned nothing');
        // The driver carries only the script on stdin, so the key travels as a file through put: 0600 here, on the machine
        // and in the fresh user's home, read by olympus connect venice --api-key-stdin and removed at once on every side.
        const local = mkdtempSync(join(tmpdir(), 'rc-venice-'));
        try {
          writeFileSync(join(local, 'key'), `${options.veniceKey}\n`, { mode: 0o600 });
          await machine.put(join(local, 'key'), '/home/zig/.olympus-canary/fresh-run/venice-key');
        } finally { rmSync(local, { recursive: true, force: true }); }
        try {
          await exec(`chmod 600 ${ROOT}/venice-key
sudo -n install -o olyfresh -g "$(id -gn olyfresh)" -m 600 ${ROOT}/venice-key /home/olyfresh/.olympus-canary/venice-key
rm -f ${ROOT}/venice-key
${asFresh('"$HOME/.local/bin/olympus" connect venice --api-key-stdin < "$HOME/.olympus-canary/venice-key" > /dev/null 2>&1; rc=$?; rm -f "$HOME/.olympus-canary/venice-key"; exit $rc')}`, 60_000);
        } catch (error) {
          await machine.exec(`rm -f ${ROOT}/venice-key; sudo -n rm -f /home/olyfresh/.olympus-canary/venice-key`, { timeoutMs: 30_000 }).catch(() => undefined);
          throw new Error(`the test Venice key was not saved: ${error instanceof Error ? error.message : 'unexpected failure'}`);
        }
        return 'test Venice key saved through olympus connect venice --api-key-stdin';
      });
    }
    await checked('dashboard-opens', async () => { dashboard = await (options.dashboard ?? openFreshDashboard)(fresh, options.cdp ?? '127.0.0.1:9334'); });
    // Includes the explicit Venice judge choice when first run offers it.
    await checked('privacy-choice', () => dashboard!.privacyChoice());
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
    // A pass keeps the matched item's title out of the report; a failure or skip keeps its reason (counts, refresh
    // times, source labels), which run 6 needed and the old one-line summary threw away.
    // Each poll of the new-item wait also records load and the busiest processes, beside the engine's counts (live.timeline).
    const sampleMachine = async () => (await exec(asFresh(FRESH_MACHINE_SAMPLE), 30_000)).trim();
    checks.push(...(await runLiveAccounts(engine!, { sources, sampleMachine, ...(options.sleep ? { sleep, pollMs: 1 } : {}) })).map(c => ({ ...c, detail: c.id === 'live.timeline' ? redactFreshTimeline(c.detail ?? '') : c.status === 'pass' ? 'engine status/search verified' : redactFreshDetail(c.detail ?? 'no detail') })));
    // The engine's own log lines about judging and embedding since the install, for the same diagnosis.
    await recorded('engine-log', async () => redactFreshTimeline((await exec(asFresh(FRESH_ENGINE_LOG), 60_000)).trim()) || 'no matching log lines');
    // Answer and scope checks are recorded without ending the leg: the read-on-demand timing after them needs neither.
    for (const source of sources) {
      await recorded(`${source.id}.answer`, async () => {
        const answer = await ask(engine!, source.known!.question, sleep);
        const a = answer.structured as any;
        const text = typeof a?.answer === 'string' ? a.answer.toLowerCase() : '';
        const missing = source.known!.expect.filter(n => !text.includes(n.toLowerCase())).length;
        const cited = Array.isArray(a?.citations) ? [...new Set<string>(a.citations.map((c: any) => String(c.label ?? c.source)))] : [];
        if (!answer.ok || a?.status !== 'answered' || typeof a.answer !== 'string' || missing > 0 || !cited.some(label => label.toLowerCase() === source.label.toLowerCase())) {
          // Never the answer text: only its status, how many expected facts it lacked and which sources it cited.
          const why = !answer.ok ? `the call failed: ${(answer as { error?: string }).error ?? 'no answer'}` : `status ${String(a?.status ?? 'none')}, ${missing} of ${source.known!.expect.length} expected fact(s) missing, cited ${cited.join(', ') || 'nothing'}`;
          throw new Error(`known question was not answered with expected facts and a source citation (${why})`);
        }
      });
      await recorded(`${source.id}.scope-absence`, async () => {
        const answer = await ask(engine!, source.fresh!.outside.question, sleep);
        const search = await engine!.call('olympus_search', { question: source.fresh!.outside.question, limit: 48 });
        const problem = scopeAbsenceProblem(source, answer, search);
        if (problem) throw new Error(problem);
      });
    }
    // What the privacy check spent against its limit, from the engine's own settings (never a key).
    await recorded('judge-spend', async () => {
      const out = await exec(asFresh('"$HOME/.local/bin/olympus" settings show'));
      const judge = (JSON.parse(out) as { privacy_judge?: { choice?: string; spending_limit_dollars?: number | null; spent_dollars?: number; stopped?: string | null } | null }).privacy_judge;
      if (!judge) throw new Error('the settings show no privacy check');
      const cap = judge.spending_limit_dollars;
      const spent = judge.spent_dollars ?? 0;
      const detail = `privacy check ${judge.choice ?? 'unknown'}: $${spent.toFixed(4)} spent of ${typeof cap === 'number' ? `a $${cap.toFixed(2)} limit` : 'no limit'}${judge.stopped ? `, stopped (${judge.stopped})` : ''}`;
      if (typeof cap === 'number' && spent > cap) throw new Error(`spent past the limit: ${detail}`);
      return detail;
    });
    if (rerankerOn) {
      await checked('reranker-applied', async () => {
        const counts = (await rerankHealth()).rerank_outcomes ?? {};
        const summary = `applied ${counts.applied ?? 0}, failed ${counts.failed ?? 0}, timed out ${counts.timed_out ?? 0}`;
        if (!((counts.applied ?? 0) > 0) || (counts.failed ?? 0) > 0) throw new Error(`reranker did not rank the answers cleanly (${summary})`);
        return summary;
      });
    }
    if (options.onDemandTiming) {
      current = 'on-demand-timing';
      onDemandTiming = await runFreshOnDemand(fresh, options.cdp ?? '127.0.0.1:9334', engine!, dashboard!, options.onDemandTiming,
        async ms => { if (interrupted) throw new Error('run interrupted'); await sleep(ms); }, machine);
      checks.push(...onDemandTiming.checks);
    }
    current = 'limits';
    limits = await (options.limitsStage ?? runFreshLimits)(fresh, options.limits ?? {}, machine);
    checks.push(...limits.checks);
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
 if [ -e ${ROOT}/restored ]; then [ "$(cat ${ROOT}/restored)" = 0 ] && systemctl --user is-active --quiet olympus-engine.service && ${SOCKET_READY}; exit $?; fi
 sleep 1
done; exit 1`, 130_000);
          await exec(`rm -rf ${ROOT}`);
        });
      } catch { checks.push({ id: 'fresh.restore-zig', title: 'Restore zig engine', status: 'fail', detail: 'zig engine restoration could not be verified; inspect the machine guard log' }); }
    }
  }
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  return { checks, screens: [], ...(onDemandTiming ? { onDemandTiming } : {}), ...(limits ? { limits } : {}) };
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
