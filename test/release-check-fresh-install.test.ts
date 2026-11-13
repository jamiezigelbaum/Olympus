import { sourceCard, sourceConnected } from '../scripts/release-check/source-cards.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { canaryVerdict } from '../scripts/release-check/canary.ts';
import { asFresh, consentBlock, FRESH_LEG, FreshInconclusive, GUARD, heldPorts, LOCAL_FIRST_PORTS, SOCKET_READY, redactFreshDetail, runFreshInstall, scopeAbsent, validateFreshSources, type ConsentSnapshot } from '../scripts/release-check/fresh-install.ts';
import { parseCdpEndpoint, type FreshDashboard } from '../scripts/release-check/fresh-dashboard.ts';
import type { LiveSourceSpec, EngineMcp } from '../scripts/release-check/live-accounts.ts';
import type { Machine } from '../scripts/release-check/machine.ts';
import { ANSWER_MODEL_REQUIRED_TEXT } from '../src/workers/answer-model-required.ts';
import { FIRST_RUN_PRIVACY_REQUIRED_TEXT } from '../src/workers/first-run-privacy-gate.ts';

const sources: LiveSourceSpec[] = ['gmail', 'dropbox'].map(id => ({ id, label: id === 'gmail' ? 'Gmail' : 'Dropbox', known: { question: `${id} inside?`, expect: ['inside fact'] }, fresh: { scope: 'Canary', outside: { question: `${id} outside?`, expect: ['outside-unique-fact', 'outside-unique-title'] } } }));
const snapshot = (extra: Partial<ConsentSnapshot> = {}): ConsentSnapshot => ({ url: 'https://accounts.google.com/consent', text: 'Advanced Go to Olympus (unsafe) Continue', password: false, accounts: 0, signedOut: false, ...extra });
const response = (structured: unknown, ok = true) => ({ ok, structured, text: '' });

function rig(failAt?: string, inconclusive = false, listening = '', health: () => object = () => ({ ok: true })) {
  const events: string[] = [];
  // Like a fresh install: no answer model until the privacy choice sets one.
  let modelSet = false;
  const commands: string[] = [];
  const step = async (name: string) => {
    events.push(name);
    if (name === failAt) throw inconclusive ? new FreshInconclusive('renew Google sign-in: password') : new Error('test failure https://example.com/?code=secret&state=secret');
  };
  const machine: Machine = {
    handle: 'test-omarchy', label: 'test', os: 'linux', driver: 'fake',
    exec: async script => {
      commands.push(script);
      if (script.includes('ss -Hltnp')) return { code: 0, stdout: listening, stderr: '', ms: 0, timedOut: false };
      if (script.startsWith('ps -o unit=')) return { code: 0, stdout: 'olympus-test-answer-llama.service\n', stderr: '', ms: 0, timedOut: false };
      if (script.includes('rm -f ') && script.includes('/lease')) await step('restore');
      if (script.includes('sh "$HOME/.olympus-canary/install-linux.sh"')) await step('install');
      if (script.includes('/v1/health') && !script.includes('/dev/null')) return { code: 0, stdout: JSON.stringify(health()), stderr: '', ms: 0, timedOut: false };
      if (script.includes('olympus" settings show')) return { code: 0, stdout: JSON.stringify({ kind: 'olympus_settings', privacy_judge: { choice: 'venice', spending_limit_dollars: 1, spent_dollars: 0.0123, stopped: null } }), stderr: '', ms: 0, timedOut: false };
      return { code: 0, stdout: '', stderr: '', ms: 0, timedOut: false };
    },
    put: async () => {}, get: async () => {}, upgrade: async () => {},
  };
  const dashboard: FreshDashboard = {
    privacyChoice: async () => { await step('privacy-choice'); modelSet = true; return 'Local models with Venice fallback (local-first, Recommended) saved and verified after reload; privacy check: Venice (venice) saved'; },
    connect: s => step(`${s.id}.connect`), consent: s => step(`${s.id}.consent`), callback: s => step(`${s.id}.callback`), scope: s => step(`${s.id}.scope`),
    indexed: async s => { await step(`${s.id}.first-items`); return 2; },
    close: () => step('dashboard.close'),
  };
  const engine: EngineMcp = {
    call: async (tool, args) => {
      if (tool === 'source_answer' && !modelSet) return { ok: true, structured: null, text: ANSWER_MODEL_REQUIRED_TEXT };
      if (tool === 'source_index_status') return response({ corpora: sources.map(s => ({ corpus_id: s.id, label: s.label, configured: true, last_refresh: { status: 'completed', completed_at: new Date().toISOString() }, counts: { indexed_items: 2 } })) });
      const outside = String(args.question).includes('outside');
      const source = sources.find(s => String(args.question).includes(s.id))!;
      if (tool === 'olympus_search') return response({ evidence: outside ? [] : [{ source: source.label, title: 'inside', excerpt: 'inside fact' }] });
      return response({ status: 'answered', answer: outside ? 'I could not find that information.' : 'inside fact', citations: outside ? [] : [{ label: source.label, title: 'inside' }] });
    },
    listTools: async () => ['olympus_search', 'source_answer', 'source_answer_result', 'source_index_status'],
    close: () => step('engine.close'),
  };
  return { events, commands, machine, dashboard, engine, options: { sources, dashboard: async () => dashboard, engine: async () => engine, sleep: async () => {}, limitsStage: async () => ({ rows: [], checks: [] }) } };
}

describe('fresh install canary', () => {
  test('the test Venice key reaches the install as a file through put before the walkthrough, never in a command or a check', async () => {
    const r = rig();
    const put: Array<{ to: string; body: string }> = [];
    r.machine.put = async (from, to) => { put.push({ to, body: readFileSync(from, 'utf8') }); };
    const key = 'vk-test-not-a-real-key';
    const { checks } = await runFreshInstall(r.machine, { ...r.options, veniceKey: key });
    const ids = checks.map(c => c.id);
    expect(checks.find(c => c.id === 'fresh.venice-key')?.status).toBe('pass');
    expect(ids.indexOf('fresh.venice-key')).toBeGreaterThan(ids.indexOf('fresh.engine-up'));
    expect(ids.indexOf('fresh.venice-key')).toBeLessThan(ids.indexOf('fresh.privacy-choice'));
    expect(put).toEqual([{ to: '/home/zig/.olympus-canary/fresh-run/venice-key', body: `${key}\n` }]);
    const saved = r.commands.find(c => c.includes('connect venice --api-key-stdin'))!;
    expect(saved).toContain('venice-key');
    expect(saved).toContain('rm -f');
    expect(r.commands.some(c => c.includes(key))).toBe(false);
    expect(JSON.stringify(checks)).not.toContain(key);
    const empty = rig();
    const none = await runFreshInstall(empty.machine, { ...empty.options, veniceKey: '' });
    expect(none.checks.find(c => c.id === 'fresh.venice-key')?.status).toBe('fail');
  }, 30_000);

  test('a server left on the local-first model port fails the leg before anything is installed, naming it and its unit (olympus-ops#221)', async () => {
    expect(LOCAL_FIRST_PORTS).toEqual([28090]);
    const line = 'LISTEN 0 512 127.0.0.1:28090 0.0.0.0:* users:(("llama-server",pid=885816,fd=3))';
    expect(heldPorts(`LISTEN 0 4096 127.0.0.1:280900 0.0.0.0:*\n${line}\n`, [28090])).toEqual(['127.0.0.1:28090 is held by llama-server (pid 885816)']);
    expect(heldPorts('LISTEN 0 4096 127.0.0.1:8010 0.0.0.0:*\n', [28090])).toEqual([]);
    const r = rig(undefined, false, `${line}\n`);
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'fresh.machine-clear', status: 'fail' });
    expect(checks[0]!.detail).toContain('127.0.0.1:28090 is held by llama-server (pid 885816), unit olympus-test-answer-llama.service');
    expect(r.commands.some(c => c.includes('install-linux.sh'))).toBe(false);
  });

  test('limits always runs after usable install and reports failures before restoring the engine', async () => {
    const r = rig();
    const result = await runFreshInstall(r.machine, { ...r.options, limitsStage: async (target, _options, transport) => {
      expect(transport).toBe(r.machine);
      await target.exec('limits-test');
      r.events.push('limits');
      return { rows: [], checks: [{ id: 'limits.judge.daily_calls', title: 'limits', status: 'fail', detail: 'Raise did not resume judge calls' }] };
    } });
    expect(r.events.indexOf('limits')).toBeGreaterThan(r.events.indexOf('dropbox.first-items'));
    expect(r.events.indexOf('limits')).toBeLessThan(r.events.lastIndexOf('restore'));
    expect(r.commands.find(c => c.includes('limits-test'))).toContain('sudo -n -u olyfresh');
    expect(result.limits?.checks[0]?.status).toBe('fail');
    expect(result.checks.at(-2)?.id).toBe('limits.judge.daily_calls');
    expect(result.checks.at(-1)).toMatchObject({ id: 'fresh.restore-zig', status: 'pass' });
  }, 30_000);
  test('named persisted checks run in order, reuse account searches, then restore', async () => {
    const r = rig();
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(canaryVerdict(checks)).toBe('pass');
    expect(FRESH_LEG).toBe('canary-test-omarchy-fresh');
    expect(checks.map(c => c.id)).toEqual([
      'fresh.machine-clear', 'fresh.install', 'fresh.engine-up', 'fresh.reranker-ready', 'fresh.ask-without-model', 'fresh.dashboard-opens', 'fresh.privacy-choice',
      ...sources.flatMap(s => ['connect', 'consent', 'callback', 'scope', 'first-items'].map(step => `fresh.${s.id}.${step}`)),
      'live.gmail.status', 'live.dropbox.status', 'live.gmail.known', 'live.dropbox.known', 'fresh.engine-log',
      'fresh.gmail.answer', 'fresh.gmail.scope-absence', 'fresh.dropbox.answer', 'fresh.dropbox.scope-absence', 'fresh.judge-spend', 'fresh.restore-zig',
    ]);
    expect(r.events.slice(-3)).toEqual(['engine.close', 'dashboard.close', 'restore']);
    expect(checks.find(c => c.id === 'fresh.gmail.first-items')?.detail).toBe('2 item(s) indexed');
    expect(checks.find(c => c.id === 'fresh.privacy-choice')?.detail).toContain('Local models with Venice fallback (local-first, Recommended)');
    expect(checks.find(c => c.id === 'fresh.privacy-choice')?.detail).toContain('privacy check: Venice (venice) saved');
    expect(r.events.indexOf('privacy-choice')).toBeLessThan(r.events.indexOf('gmail.connect'));
    expect(r.commands.find(c => c.includes('seq 1 180'))).toContain(SOCKET_READY);
    expect(r.commands.find(c => c.includes('seq 1 120'))).toContain(SOCKET_READY);
    expect(r.commands.some(c => c.includes('OLYMPUS_EMAIL_SOURCE_PORT'))).toBe(false);
    expect(r.commands.some(c => c.includes('loginctl enable-linger olyfresh'))).toBe(true);
    for (const script of [...r.commands, GUARD]) {
      const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      expect(syntax.stderr).toBe('');
      expect(syntax.status).toBe(0);
    }
  }, 30_000);
  test('a machine with the reranker off reports it skipped and asks nothing more of it', async () => {
    const r = rig();
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(checks.find(c => c.id === 'fresh.reranker-ready')).toMatchObject({ status: 'skip' });
    expect(checks.some(c => c.id === 'fresh.reranker-applied')).toBe(false);
  });
  test('waits for the reranker install, then requires rerank applied above 0 and failed 0 after the answers', async () => {
    let polls = 0;
    let asked = 0;
    const r = rig(undefined, false, '', () => ({
      ok: true,
      rerank_outcomes: { applied: asked, failed: 0, timed_out: 0 },
      reranker_install: { state: ++polls < 3 ? 'downloading' : 'ready', percent: polls < 3 ? 40 : 100, label: '' },
    }));
    const call = r.engine.call;
    r.engine.call = async (tool, args) => { if (tool === 'source_answer') asked++; return call(tool, args); };
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(checks.find(c => c.id === 'fresh.reranker-ready')).toMatchObject({ status: 'pass' });
    expect(checks.find(c => c.id === 'fresh.reranker-applied')).toMatchObject({ status: 'pass' });
    expect(checks.findIndex(c => c.id === 'fresh.reranker-applied')).toBeGreaterThan(checks.findIndex(c => c.id === 'fresh.dropbox.scope-absence'));
  });
  for (const [name, health, detail] of [
    ['a failed install', { rerank_outcomes: { applied: 0, failed: 0, timed_out: 0 }, reranker_install: { state: 'failed', reason: 'download_failed', percent: 10, label: '' } }, 'download_failed'],
    ['a failed rerank', { rerank_outcomes: { applied: 3, failed: 1, timed_out: 0 }, reranker_install: { state: 'ready', percent: 100, label: '' } }, 'failed 1'],
  ] as const) test(`${name} fails the reranker check`, async () => {
    const r = rig(undefined, false, '', () => health);
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(canaryVerdict(checks)).toBe('fail');
    expect(checks.find(c => c.id.startsWith('fresh.reranker') && c.status === 'fail')?.detail).toContain(detail);
  });
  for (const splitFails of [false, true]) test(`fresh timing is wired after connect and restores zig (split failure: ${splitFails})`, async () => {
    const r = rig();
    const { browserSeedPlan } = await import('../scripts/release-check/on-demand-seeds.ts');
    const file = browserSeedPlan('dropbox')[0]!;
    let atTiming = false;
    Object.assign(r.dashboard, {
      connection: async () => 'connected', folderMode: async () => '',
      setFolderMode: async () => {}, sync: async () => {}, prepareRead: async () => async () => 'Reading.',
    });
    const call = r.engine.call;
    r.engine.call = async (...args) => atTiming ? response({ answer: file.fact, citations: [{ title: file.name }] }) : call(...args);
    const result = await runFreshInstall(r.machine, { ...r.options, onDemandTiming: {
      diagnostics: async target => {
        await target.exec('timing-probe-test');
        return {
          enableSplit: async () => { atTiming = true; r.events.push('split'); if (splitFails) throw new Error('restart failed'); },
          preflight: async () => 'engine split on; healthy front and background',
          resolve: async f => ({ ...f, providerItemId: 'provider-id', version: 'source-version' }), begin: async () => {},
          finish: async () => ({ indexed: true, jobIds: ['job'], attribution: 'single read in log interval', log: ['fetch', 'extract', 'judge', 'embed'].map(step => `[olympus:on-demand] step=${step} count=1 ms=1`).join('\n') }),
          close: async () => { r.events.push('probe.close'); },
        };
      },
      seeds: async (target, endpoint) => {
        expect(target).toBe(r.machine); // Upload files belong to zig's signed-in browser, while the probe runs as olyfresh.
        expect(endpoint).toBe('127.0.0.1:9334');
        return { folders: async () => [{ source: 'dropbox', id: 'seed' }], upload: async () => [file] };
      },
    } });
    expect(result.onDemandTiming?.rows).toHaveLength(splitFails ? 0 : 1);
    expect(result.onDemandTiming?.preflight?.includes('split on') ?? false).toBe(!splitFails);
    expect(result.checks.findIndex(c => c.id === 'fresh.dropbox.scope-absence')).toBeLessThan(result.checks.findIndex(c => c.id.startsWith('ondemand.')));
    expect(r.commands.find(c => c.includes('timing-probe-test'))).toContain('sudo -n -u olyfresh');
    expect(r.events.indexOf('split')).toBeGreaterThan(r.events.indexOf('dropbox.first-items'));
    expect(r.events.indexOf('probe.close')).toBeLessThan(r.events.lastIndexOf('restore'));
    expect(result.checks.at(-1)).toMatchObject({ id: 'fresh.restore-zig', status: 'pass' });
    expect(canaryVerdict(result.checks)).toBe(splitFails ? 'fail' : 'pass');
  });
  test('Ask without a model must explain setup; a real answer fails that check without stopping the leg', async () => {
    const r = rig();
    const { checks } = await runFreshInstall(r.machine, { ...r.options, engine: async () => ({
      call: async () => response({ status: 'answered', answer: 'private words', citations: [] }),
      listTools: async () => ['source_answer'],
      close: async () => {},
    }) });
    const check = checks.find(c => c.id === 'fresh.ask-without-model');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('did not return the setup text');
    expect(JSON.stringify(checks)).not.toContain('private words');
    expect(checks.map(c => c.id)).toContain('fresh.dropbox.first-items');
    expect(checks.at(-1)?.id).toBe('fresh.restore-zig');
  });
  test('before the privacy choice, Ask explaining that step counts as setup text; any other refusal fails', async () => {
    for (const [error, status] of [[FIRST_RUN_PRIVACY_REQUIRED_TEXT, 'pass'], ['engine unavailable', 'fail']] as const) {
      const r = rig();
      const { checks } = await runFreshInstall(r.machine, { ...r.options, engine: async () => ({
        call: async () => ({ ok: false, structured: null, text: '', error }),
        listTools: async () => ['source_answer'],
        close: async () => {},
      }) });
      expect(checks.find(c => c.id === 'fresh.ask-without-model')?.status).toBe(status);
    }
  });
  test('Ask without a model must also be listed, not only callable', async () => {
    const r = rig();
    const { checks } = await runFreshInstall(r.machine, { ...r.options, engine: async () => ({
      call: async () => ({ ok: true, structured: null, text: ANSWER_MODEL_REQUIRED_TEXT }),
      listTools: async () => ['olympus_search', 'source_index_status'],
      close: async () => {},
    }) });
    const check = checks.find(c => c.id === 'fresh.ask-without-model');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('source_answer is not in tools/list');
  });
  test('a failing live check and a failed answer say why, without the answer text', async () => {
    const r = rig();
    const engine = await r.options.engine();
    const { checks } = await runFreshInstall(r.machine, { ...r.options, engine: async () => ({
      call: async (tool, args) => {
        if (tool === 'source_index_status') return response({ corpora: sources.map(s => ({ corpus_id: s.id, label: s.label, configured: true, counts: { indexed_items: 0 } })) });
        if (tool === 'source_answer') return response({ status: 'needs_setup', answer: 'private words', citations: [{ label: 'Dropbox' }] });
        return await engine.call(tool, args);
      },
      close: engine.close,
    }) });
    expect(checks.find(c => c.id === 'live.gmail.status')?.detail).toBe('1 corpus(es), 0 item(s) indexed: nothing indexed yet');
    const answer = checks.find(c => c.id === 'fresh.gmail.answer')?.detail ?? '';
    expect(answer).toContain('status needs_setup, 1 of 1 expected fact(s) missing, cited Dropbox');
    expect(answer).not.toContain('private words');
    expect(checks.find(c => c.id === 'fresh.restore-zig')?.status).toBe('pass');
  }, 30_000);

  test('candidate uses the non-interactive site installer as olyfresh', async () => {
    const r = rig();
    const puts: Array<[string, string]> = [];
    r.machine.put = async (from, to) => { puts.push([from, to]); };
    const { checks } = await runFreshInstall(r.machine, { ...r.options, bridgeAgent: '/job/agent.js', bundle: { installer: '/job/install-linux.sh', tarball: '/job/candidate.tgz' } });
    expect(canaryVerdict(checks)).toBe('pass');
    expect(puts).toEqual([
      ['/job/install-linux.sh', '/home/zig/.olympus-canary/fresh-run/install-linux.sh'],
      ['/job/candidate.tgz', '/home/zig/.olympus-canary/fresh-run/candidate.tgz'],
      ['/job/agent.js', '/home/zig/.olympus-canary/fresh-run/agent.js'],
    ]);
    const install = r.commands.find(c => c.includes('sh "$HOME/.olympus-canary/install-linux.sh"'))!;
    expect(install).toContain('sudo -n -u olyfresh');
    expect(install).toContain('--tarball');
    expect(install).toContain('< /dev/null');
    expect(r.events.at(-1)).toBe('restore');
  });
  for (const failure of ['install', 'privacy-choice', 'gmail.connect', 'gmail.consent', 'gmail.scope', 'dropbox.first-items']) {
    test(`restores zig when ${failure} fails and stops dependent checks`, async () => {
      const r = rig(failure);
      const { checks } = await runFreshInstall(r.machine, r.options);
      expect(canaryVerdict(checks)).toBe('fail');
      expect(checks.filter(c => c.status === 'fail')).toHaveLength(1);
      expect(r.events.at(-1)).toBe('restore');
      expect(checks.at(-1)?.id).toBe('fresh.restore-zig');
      expect(JSON.stringify(checks)).not.toContain('secret');
      if (failure === 'privacy-choice') expect(r.events).not.toContain('gmail.connect');
    });
  }
  test('consent authentication is inconclusive and still restores', async () => {
    const r = rig('gmail.consent', true);
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(canaryVerdict(checks)).toBe('inconclusive');
    expect(checks.find(c => c.status === 'skip' && c.id !== 'fresh.reranker-ready')?.detail).toContain('renew Google');
    expect(r.events.at(-1)).toBe('restore');
    expect(r.events).not.toContain('gmail.scope');
  });
  test('handled interrupt unwinds after installation and restores zig', async () => {
    const r = rig();
    const exec = r.machine.exec;
    r.machine.exec = async (script, options) => {
      const result = await exec(script, options);
      if (script.includes('sh "$HOME/.olympus-canary/install-linux.sh"')) process.emit('SIGTERM', 'SIGTERM');
      return result;
    };
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(checks.find(c => c.status === 'fail')?.id).toBe('fresh.install');
    expect(r.events.at(-1)).toBe('restore');
    expect(r.events).not.toContain('gmail.connect');
  });
  test('fresh-user commands start in the fresh home, not the caller\'s unreadable cwd', () => {
    const home = mkdtempSync(join(tmpdir(), 'olyfresh-home-'));
    const callerCwd = mkdtempSync(join(tmpdir(), 'zig-cwd-'));
    const command = asFresh('pwd');
    expect(command.startsWith('sudo -n -u olyfresh env HOME=/home/olyfresh ')).toBe(true);
    const local = command.replace('sudo -n -u olyfresh env HOME=/home/olyfresh ', `env HOME=${home} `);
    const run = spawnSync('bash', ['-c', local], { cwd: callerCwd, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(realpathSync(run.stdout.trim())).toBe(realpathSync(home));
  }, 30_000);

  test('shared source cards preserve every disconnected state', () => {
    const view = { sources: [{ provider: 'gmail', connection: { state: 'synced' } }] };
    expect(sourceConnected(sourceCard(view, 'gmail'))).toBe(true);
    expect(sourceConnected(sourceCard(view, 'dropbox'))).toBe(false);
    for (const state of ['not_connected', 'needs_setup', 'awaiting_consent', 'reauth_required']) expect(sourceConnected({ connection: { state } })).toBe(false);
  });
  test('restore failure overrides inconclusive', async () => {
    const r = rig('restore');
    const { checks } = await runFreshInstall(r.machine, r.options);
    expect(checks.at(-1)?.status).toBe('fail');
    expect(canaryVerdict(checks)).toBe('fail');
  });
  test('guard traps runner loss and expiry; installation cannot change the port', () => {
    expect(GUARD).toContain('trap restore EXIT');
    expect(GUARD).toContain("trap 'exit 1' HUP INT TERM");
    expect(GUARD).toContain('systemctl --user start olympus-engine.service');
    expect(GUARD).toContain(SOCKET_READY);
    expect(GUARD).not.toContain('/dev/tcp/');
    expect(GUARD).toContain('owner-bridge.pid');
  });
  test('accepts consent and one signed-in account, blocks authentication and ambiguity', () => {
    expect(consentBlock(snapshot())).toBeUndefined();
    expect(consentBlock(snapshot({ text: 'Choose an account', accounts: 1 }))).toBeUndefined();
    for (const s of [snapshot({ password: true }), snapshot({ text: '2-Step Verification' }), snapshot({ text: 'Two-step verification' }), snapshot({ text: 'Enter the code' }), snapshot({ text: 'Check your phone' }), snapshot({ signedOut: true }), snapshot({ text: 'Choose an account', accounts: 2 }), snapshot({ text: 'Choose an account', accounts: 0 })]) expect(consentBlock(s)).toBeDefined();
    expect(consentBlock(snapshot({ url: 'https://www.dropbox.com/login' }))).toBe('signed out');
  });
  test('outside item must be absent from both answer and search; unreadable results fail', () => {
    const good = response({ status: 'answered', answer: 'No information found', citations: [] });
    const empty = response({ evidence: [] });
    expect(scopeAbsent(sources[0]!, good, empty)).toBe(true);
    expect(scopeAbsent(sources[0]!, response({ status: 'answered', answer: 'OUTSIDE-UNIQUE-FACT', citations: [] }), empty)).toBe(false);
    expect(scopeAbsent(sources[0]!, good, response({ evidence: [{ title: 'outside-unique-title' }] }))).toBe(false);
    expect(scopeAbsent(sources[0]!, response({ status: 'answered', answer: '', citations: [{ title: 'outside-unique-title' }] }), empty)).toBe(false);
    expect(scopeAbsent(sources[0]!, response(null, false), empty)).toBe(false);
    expect(scopeAbsent(sources[0]!, good, response(null))).toBe(false);
  });
  test('requires both sources with nonempty positive and outside fixtures', () => {
    expect(validateFreshSources(sources)).toEqual(sources);
    expect(() => validateFreshSources([])).toThrow('gmail');
    expect(() => validateFreshSources([{ ...sources[0]!, fresh: { scope: 'x', outside: { question: 'x', expect: [] } } }])).toThrow();
    expect(parseCdpEndpoint('127.0.0.1:9333')).toEqual({ host: '127.0.0.1', port: 9333 });
    expect(() => parseCdpEndpoint('x:70000')).toThrow();
    expect(redactFreshDetail('https://a/?code=SECRET&state=SECRET token=OTHER')).not.toMatch(/SECRET|OTHER/);
  });
});
