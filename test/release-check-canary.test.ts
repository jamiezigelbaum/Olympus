import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canaryVerdict, isDashboard, macCloseCommand, isSystemPrompt, openedWindows, parseCanaryAccounts, parseWindows, pinnedVersion, renderCanaryHtml, renewals, runCanary,
  SITE_INSTALLER, type CanaryOptions, type CanaryReport,
} from '../scripts/release-check/canary.ts';
import type { ExecResult, Machine } from '../scripts/release-check/machine.ts';

interface FakeWindow { id: string; app: string; title: string }

/** A desktop that answers the canary's scripts: what each launch opens is up to the test. */
function fakeDesktop(os: 'linux' | 'macos', opts: {
  version?: string; brief?: string; missing?: string[]; launcherOk?: boolean; upgradeFails?: boolean; linkFails?: boolean;
  windows?: FakeWindow[]; onLauncher?: (windows: FakeWindow[]) => void; onLink?: (windows: FakeWindow[]) => void;
  /** Windows that ignore every close (a page that asks before it leaves). */
  stuck?: string[];
} = {}) {
  const windows: FakeWindow[] = [...(opts.windows ?? [])];
  const initial = new Set(windows.map((w) => w.id));
  const scripts: string[] = [];
  const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: '', timedOut: false, ms: 1 });
  const machine: Machine = {
    handle: 'test-box', label: 'test-box', os, driver: 'fake',
    upgrade: async () => { if (opts.upgradeFails) throw new Error('driver upgrade failed (exit 1)'); },
    put: async () => {},
    get: async (_from, to) => { writeFileSync(to, 'png'); },
    exec: async (script) => {
      scripts.push(script);
      if (script.endsWith('--version')) return ok(`olympus ${opts.version ?? '1.1.0'}\n`);
      if (script.endsWith('engine status --brief')) return ok(JSON.stringify({ schema: 'olympus.engine.brief.v1', state: opts.brief ?? 'running', progress: null, blocker: null, needsYou: null }));
      if (script.endsWith('engine status')) return ok(JSON.stringify({ missing: opts.missing ?? [] }));
      if (script.includes('xdg-mime query') || script.includes('URLForApplicationToOpenURL')) return ok('olympus:// opens\n', opts.launcherOk === false ? 1 : 0);
      if (script === 'hyprctl clients -j') return ok(JSON.stringify(windows.map((w) => ({ address: w.id, class: w.app, title: w.title }))));
      if (script.includes('CGWindowListCopyWindowInfo')) return ok(JSON.stringify(windows));
      if (script.startsWith('gtk-launch') || script.includes(' dashboard >/dev/null')) { opts.onLauncher?.(windows); return ok(''); }
      if (script.includes('xdg-open \'olympus://') || script.startsWith('open \'olympus://')) { opts.onLink?.(windows); return opts.linkFails ? { ...ok(''), code: 124, stderr: 'xdg-open: x-www-browser: command not found' } : ok(''); }
      const closed = /closewindow address:'([^']+)'/g;
      for (const match of script.matchAll(closed)) windows.splice(windows.findIndex((w) => w.id === match[1]), 1);
      const tab = /sendshortcut 'CTRL, W, address:([^']+)'/.exec(script);
      if (tab) { const w = windows.find((x) => x.id === tab[1]); if (w && !opts.stuck?.includes(w.id)) w.title = 'New Tab'; }
      if (script.startsWith('open -a ')) {
        const app = /open -a '([^']+)'/.exec(script)![1];
        if (/CGEventCreateKeyboardEvent\(\$\(\), 12,/.test(script)) for (let i = windows.length - 1; i >= 0; i -= 1) { if (windows[i]!.app === app) windows.splice(i, 1); }
        if (/CGEventCreateKeyboardEvent\(\$\(\), 13,/.test(script)) {
          // Command-W closes a window the check opened, or the tab it opened in a window that was already there.
          // A raise names the window by its title first; without one, the app's first Olympus window is the front one.
          const raised = /whose\(\{ name: ("[^"]*") \}\)/.exec(script);
          const at = windows.findIndex((x) => x.app === app && (raised ? x.title === JSON.parse(raised[1]!) : /Olympus/.test(x.title)) && !opts.stuck?.includes(x.id));
          if (at >= 0 && initial.has(windows[at]!.id)) windows[at]!.title = 'Start Page'; else if (at >= 0) windows.splice(at, 1);
        }
      }
      return ok('');
    },
  };
  return { machine, windows, scripts };
}

const options = (os: 'linux' | 'macos', extra: Partial<CanaryOptions> = {}): CanaryOptions => ({
  os, update: { kind: 'installed' }, screensDir: mkdtempSync(join(tmpdir(), 'canary-test-')),
  pollMs: 1, windowTimeoutMs: 50, engineTimeoutMs: 0, sleep: async () => {}, ...extra,
});
const statusOf = (checks: Array<{ id: string; status: string }>) => Object.fromEntries(checks.map((check) => [check.id, check.status]));

describe('release-check canary', () => {
  test('Linux: the launcher opens the dashboard, a keyring prompt on the link is a failure that names it, and both are closed again', async () => {
    const desktop = fakeDesktop('linux', {
      onLauncher: (w) => w.push({ id: '0xa1', app: 'chrome-127.0.0.1__-Default', title: 'Olympus' }),
      onLink: (w) => w.push({ id: '0xb2', app: 'gcr-prompter', title: '' }),
    });
    const result = await runCanary(desktop.machine, options('linux', { expectVersion: '1.1.0' }));
    expect(statusOf(result.checks)).toEqual({
      'canary.version': 'pass', 'canary.bar': 'pass', 'canary.engine': 'pass', 'canary.launcher': 'pass',
      'canary.window.launcher': 'pass', 'canary.window.link': 'fail',
    });
    expect(result.checks.find((c) => c.id === 'canary.window.link')!.detail).toContain('needs a person at the machine: gcr-prompter');
    expect(result.screens.map((s) => s.label)).toEqual(['Dashboard window from the launcher', 'Dashboard window from an olympus:// link']);
    expect(desktop.windows).toEqual([]);
  });

  test('no window at all, a stopped engine, something missing and the wrong version all fail', async () => {
    const desktop = fakeDesktop('linux', { version: '1.0.9', brief: 'stopped', missing: ['The engine agent is not installed: run olympus engine install.'], launcherOk: false });
    const result = await runCanary(desktop.machine, options('linux', { expectVersion: '1.1.0' }));
    const statuses = statusOf(result.checks);
    for (const id of ['canary.version', 'canary.bar', 'canary.engine', 'canary.launcher', 'canary.window.launcher', 'canary.window.link']) expect(statuses[id]).toBe('fail');
    expect(result.checks.find((c) => c.id === 'canary.window.launcher')!.detail).toBe('no new window opened');
    expect(result.checks.find((c) => c.id === 'canary.version')!.detail).toContain('should have installed 1.1.0');
  });

  test('a failed update stops the canary there', async () => {
    const desktop = fakeDesktop('linux', { upgradeFails: true });
    const result = await runCanary(desktop.machine, options('linux', { update: { kind: 'candidate', dir: '/nowhere' } }));
    expect(statusOf(result.checks)).toEqual({ 'canary.update': 'fail' });
    expect(desktop.scripts).toEqual([]);
  });

  test('the published update runs the site install command for the platform', async () => {
    const desktop = fakeDesktop('macos');
    await runCanary(desktop.machine, options('macos', { update: { kind: 'published', site: 'https://example.test/' } }));
    expect(desktop.scripts[0]).toBe("set -o pipefail; curl -fsSL --proto '=https' --tlsv1.2 'https://example.test/install.sh' | sh");
    expect(SITE_INSTALLER.linux).toBe('install-linux.sh');
  });

  test('macOS: a tab in a browser window that was already open counts, and only that tab is closed', async () => {
    const desktop = fakeDesktop('macos', {
      windows: [{ id: '7', app: 'Safari', title: 'Start Page' }],
      onLauncher: (w) => { w[0]!.title = 'Olympus'; },
      onLink: (w) => w.push({ id: '9', app: 'Safari', title: 'Olympus' }),
    });
    const result = await runCanary(desktop.machine, options('macos'));
    expect(statusOf(result.checks)['canary.window.launcher']).toBe('pass');
    expect(statusOf(result.checks)['canary.window.link']).toBe('pass');
    // The window that was there before stays; the dashboard tab in it was closed with Command-W.
    expect(desktop.windows.find((w) => w.id === '7')!.title).toBe('Start Page');
    expect(desktop.scripts.some((s) => s.startsWith("open -a 'Safari'") && s.includes('CGEventCreateKeyboardEvent($(), 13,'))).toBe(true);
    expect(desktop.scripts.some((s) => s.includes('CGEventCreateKeyboardEvent($(), 12,'))).toBe(false);
    expect(desktop.windows.map((w) => w.id)).toEqual(['7']);
    expect(result.checks.some((c) => c.id.endsWith('.closed'))).toBe(false);
  });

  test('macOS: a browser that had no window is quit with the keyboard after the check', async () => {
    const desktop = fakeDesktop('macos', { onLauncher: (w) => w.push({ id: '3', app: 'Safari', title: 'Olympus' }) });
    const result = await runCanary(desktop.machine, options('macos'));
    expect(statusOf(result.checks)['canary.window.launcher']).toBe('pass');
    expect(desktop.scripts.some((s) => s.startsWith("open -a 'Safari'") && s.includes('CGEventCreateKeyboardEvent($(), 12,'))).toBe(true);
    expect(result.checks.some((c) => c.id.endsWith('.closed'))).toBe(false);
  });

  test('a dashboard that cannot be closed fails the check instead of hiding a tab opened behind it', async () => {
    const desktop = fakeDesktop('macos', { windows: [{ id: '5', app: 'Safari', title: 'Olympus' }], stuck: ['5'], onLauncher: () => {} });
    const result = await runCanary(desktop.machine, options('macos'));
    const check = result.checks.find((c) => c.id === 'canary.window.launcher')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('already open before this check and could not be closed');
    expect(result.checks.find((c) => c.id === 'canary.window.leftover')!.detail).toContain('still open: Safari "Olympus"');
    expect(desktop.scripts.some((s) => s.includes(' dashboard >/dev/null'))).toBe(false);
  });

  test('macOS: a dashboard window a default browser kept from an earlier run is closed first, by its title, and both window checks pass', async () => {
    const desktop = fakeDesktop('macos', {
      // A Safari window on another page comes first; the leftover dashboard window behind it is the one closed.
      windows: [{ id: '4', app: 'Safari', title: 'Start Page' }, { id: '5', app: 'Safari', title: 'Olympus / Keys' }],
      onLauncher: (w) => w.push({ id: '8', app: 'Olympus', title: 'Olympus' }),
      onLink: (w) => w.push({ id: '9', app: 'Olympus', title: 'Olympus' }),
    });
    const result = await runCanary(desktop.machine, options('macos'));
    expect(statusOf(result.checks)).toMatchObject({ 'canary.window.leftover': 'warn', 'canary.window.launcher': 'pass', 'canary.window.link': 'pass' });
    expect(result.checks.find((c) => c.id === 'canary.window.leftover')!.detail).toBe('closed Safari "Olympus / Keys"');
    expect(desktop.scripts.some((s) => s.startsWith("open -a 'Safari'") && s.includes('whose({ name: "Olympus / Keys" })') && s.includes('CGEventCreateKeyboardEvent($(), 13,'))).toBe(true);
    expect(desktop.windows.find((w) => w.id === '4')!.title).toBe('Start Page');
    expect(canaryVerdict(result.checks)).toBe('pass');
  });

  test('Linux: an Ask Olympus tab in the web clients\' Chrome from an earlier run is closed first, and both window checks pass', async () => {
    const desktop = fakeDesktop('linux', {
      windows: [{ id: '0xc3', app: 'google-chrome', title: 'Ask Olympus – Google Chrome' }, { id: '0xd4', app: 'kitty', title: 'olympus logs' }],
      onLauncher: (w) => w.push({ id: '0xa1', app: 'chrome-127.0.0.1__-Default', title: 'Olympus' }),
      onLink: (w) => w.push({ id: '0xb2', app: 'chrome-127.0.0.1__-Default', title: 'Olympus' }),
    });
    const result = await runCanary(desktop.machine, options('linux'));
    expect(statusOf(result.checks)).toMatchObject({ 'canary.window.leftover': 'warn', 'canary.window.launcher': 'pass', 'canary.window.link': 'pass' });
    expect(desktop.scripts.some((s) => s.includes("sendshortcut 'CTRL, W, address:0xc3'"))).toBe(true);
    // Only the dashboard's tab was closed; the terminal, whose title merely says olympus, was left alone.
    expect(desktop.scripts.some((s) => s.includes('0xd4'))).toBe(false);
    expect(desktop.windows.map((w) => w.id)).toEqual(['0xc3', '0xd4']);
  });

  test('Linux: a leftover dashboard app window that ignores Control-W is closed by its address, and both window checks pass', async () => {
    const stray = { id: '0xe5', app: 'brave-__run_user_1000_olympus_owner-ticket-x.html-Default', title: 'Olympus' };
    const desktop = fakeDesktop('linux', {
      windows: [stray, { id: '0xd4', app: 'kitty', title: 'olympus logs' }],
      stuck: ['0xe5'],
      onLauncher: (w) => w.push({ id: '0xa1', app: 'chrome-127.0.0.1__-Default', title: 'Olympus' }),
      onLink: (w) => w.push({ id: '0xb2', app: 'chrome-127.0.0.1__-Default', title: 'Olympus' }),
    });
    const result = await runCanary(desktop.machine, options('linux'));
    expect(statusOf(result.checks)).toMatchObject({ 'canary.window.leftover': 'warn', 'canary.window.launcher': 'pass', 'canary.window.link': 'pass' });
    expect(desktop.scripts.some((s) => s.includes("closewindow address:'0xe5'"))).toBe(true);
    expect(result.checks.find((c) => c.id === 'canary.window.leftover')!.detail).not.toContain('still open');
    expect(desktop.windows.map((w) => w.id)).toEqual(['0xd4']);
  });

  test('Linux: windows and tabs close on a Hyprland with a classic config and on one with a Lua config', async () => {
    const desktop = fakeDesktop('linux', {
      windows: [{ id: '0xc3', app: 'brave-browser', title: '1Password - Brave' }],
      onLauncher: (w) => w.push({ id: '0xa1', app: 'brave-olympus-Default', title: 'Olympus' }),
      onLink: (w) => { w[0]!.title = 'Olympus'; },
    });
    await runCanary(desktop.machine, options('linux'));
    const closes = desktop.scripts.filter((s) => s.includes('hyprctl dispatch'));
    expect(closes).toHaveLength(2);
    // A stand-in hyprctl that accepts only one config language and logs every dispatch it is given.
    const bin = mkdtempSync(join(tmpdir(), 'canary-hyprctl-'));
    writeFileSync(join(bin, 'hyprctl'), '#!/bin/sh\nprintf \'%s\\n\' "$2" >> "$LOG"\ncase "$2" in hl.*) [ "$MODE" = lua ] && echo ok || echo "Invalid dispatcher" ;; *) [ "$MODE" = classic ] && echo ok || echo "error: hl.dispatch: expected a dispatcher" ;; esac\n', { mode: 0o755 });
    const run = (mode: string) => {
      const log = join(bin, `${mode}.log`);
      writeFileSync(log, '');
      for (const script of closes) Bun.spawnSync(['sh', '-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MODE: mode, LOG: log } });
      return readFileSync(log, 'utf8').trim().split('\n');
    };
    expect(run('classic')).toEqual(['closewindow', 'sendshortcut']);
    expect(run('lua')).toEqual([
      'closewindow', 'hl.dsp.window.close({ window = "address:0xa1" })',
      'sendshortcut', 'hl.dsp.send_shortcut({ mods = "CTRL", key = "W", window = "address:0xc3" })',
    ]);
  }, 30_000);

  test('Linux: a link command that fails still has what it opened closed, and is bounded on the machine', async () => {
    const desktop = fakeDesktop('linux', {
      linkFails: true,
      onLauncher: (w) => w.push({ id: '0xa1', app: 'brave-olympus-Default', title: 'Olympus' }),
      onLink: (w) => w.push({ id: '0xb2', app: 'chromium', title: 'New Tab - Chromium' }),
    });
    const result = await runCanary(desktop.machine, options('linux'));
    expect(statusOf(result.checks)['canary.window.link']).toBe('fail');
    expect(result.checks.find((c) => c.id === 'canary.window.link')!.detail).toContain('exit 124');
    expect(desktop.scripts.find((s) => s.includes('xdg-open'))).toStartWith('timeout -k 5 40 xdg-open ');
    expect(desktop.windows).toEqual([]);
  });

  test('window lists parse on both platforms; prompts and dashboards are told apart', () => {
    expect(parseWindows('linux', '[{"address":"0x1","class":"chromium","title":"Olympus"},{"address":"","class":"x","title":""}]')).toEqual([{ id: '0x1', app: 'chromium', title: 'Olympus' }]);
    expect(parseWindows('macos', '[{"id":"12","app":"Safari","title":"Olympus"}]')).toEqual([{ id: '12', app: 'Safari', title: 'Olympus' }]);
    expect(() => parseWindows('linux', '{}')).toThrow('not a list');
    expect(openedWindows([{ id: '1', app: 'a', title: 'x' }, { id: '2', app: 'a', title: 'y' }], [{ id: '1', app: 'a', title: 'x' }, { id: '2', app: 'a', title: 'Olympus' }, { id: '3', app: 'b', title: '' }]))
      .toEqual([{ id: '2', app: 'a', title: 'Olympus', reused: true }, { id: '3', app: 'b', title: '', reused: false }]);
    expect(isSystemPrompt({ id: '1', app: 'gcr-prompter', title: '' })).toBe(true);
    expect(isDashboard({ id: '1', app: 'gcr-prompter', title: 'Olympus' })).toBe(false);
    expect(isDashboard({ id: '1', app: 'Safari', title: 'Olympus' })).toBe(true);
    expect(isDashboard({ id: '1', app: 'Safari', title: 'Olympusish' })).toBe(false);
  });

  test('the bundle pins its version; a canary with no checks never passes; the page escapes what it shows', () => {
    expect(pinnedVersion('#!/bin/sh\nOLYMPUS_VERSION=1.1.0\nOLYMPUS_SHA256=ab\n')).toBe('1.1.0');
    expect(pinnedVersion('OLYMPUS_VERSION=@OLYMPUS_VERSION@\n')).toBeUndefined();
    expect(canaryVerdict([])).toBe('fail');
    expect(canaryVerdict([{ id: 'a', title: 'a', status: 'warn' }])).toBe('pass');
    const report: CanaryReport = {
      schema: 'olympus.release-check.canary.v1', runId: 'r', machine: { handle: 'test-box', os: 'linux' },
      candidate: { label: 'main', source: 'candidate' }, startedAt: 's', finishedAt: 'f', verdict: 'fail',
      counts: { pass: 0, fail: 1, warn: 0, skip: 0 }, checks: [{ id: 'x', title: '<b>', status: 'fail', detail: '"q"' }], screens: [{ label: 'shot', path: '/run/screens/a.png' }],
    };
    const html = renderCanaryHtml(report, (path) => path.replace('/run/', ''));
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('src="screens/a.png"');
  });

  test('inconclusive: nothing failed but a check could not be made, and the page says what to renew', () => {
    const skipped = { id: 'web.grok.a', title: 'Grok: a', status: 'skip' as const, detail: 'Inconclusive: Grok is signed out; sign the test account in again in the canary browser' };
    expect(canaryVerdict([{ id: 'a', title: 'a', status: 'pass' }, skipped, { ...skipped, id: 'web.grok.b' }])).toBe('inconclusive');
    expect(canaryVerdict([{ id: 'a', title: 'a', status: 'fail' }, skipped])).toBe('fail');
    expect(renewals([skipped, { ...skipped, id: 'web.grok.b' }])).toEqual(['Grok is signed out; sign the test account in again in the canary browser']);
    const report: CanaryReport = {
      schema: 'olympus.release-check.canary.v1', runId: 'r', machine: { handle: 'test-mac', os: 'macos' },
      candidate: { label: 'main', source: 'installed' }, startedAt: 's', finishedAt: 'f', verdict: 'inconclusive',
      counts: { pass: 0, fail: 0, warn: 0, skip: 1 }, checks: [skipped], screens: [],
    };
    expect(renderCanaryHtml(report, (path) => path)).toContain('<h2>To renew before the next run</h2><ul><li>Grok is signed out;');
  });

  test('the accounts file: sources, clients and the questions file it names; a broken one says what is wrong', () => {
    const questions = { questions: [{ id: 'flight-time', prompt: 'Ask Olympus what time our flight leaves.', kind: 'personal', expect: ['7:05'] }] };
    const read: string[] = [];
    const accounts = parseCanaryAccounts({
      sources: [{ id: 'gmail', label: 'Gmail', known: { question: 'flight to Santa Fe', expect: ['K7Q2ZX'] } }],
      clients: ['chatgpt', 'claude'], questions: 'client-questions.json',
    }, (path) => { read.push(path); return questions; });
    expect(read).toEqual(['client-questions.json']);
    expect(accounts.clients).toEqual(['chatgpt', 'claude']);
    expect(accounts.questions.map((q) => q.id)).toEqual(['flight-time']);
    expect(() => parseCanaryAccounts({ clients: ['chatgpt'] }, () => questions)).toThrow('no questions file');
    expect(() => parseCanaryAccounts({ clients: ['bard'], questions: 'q.json' }, () => questions)).toThrow('clients are chatgpt, claude, grok');
    expect(() => parseCanaryAccounts({ sources: [{ id: 'Gmail!', label: 'Gmail' }] }, () => questions)).toThrow('each source needs an id');
    const chatgptOnly = { questions: [{ ...questions.questions[0], clients: ['chatgpt'] }] };
    expect(() => parseCanaryAccounts({ clients: ['chatgpt', 'grok'], questions: 'q.json' }, () => chatgptOnly)).toThrow('no question applies to grok');
  });

  test('accounts only: the run\'s connection is made, the sources are asked over MCP, and the connection is revoked', async () => {
    const desktop = fakeDesktop('macos');
    const exec = desktop.machine.exec;
    desktop.machine.exec = async (script, opts) => {
      if (script.includes('connections add release-canary')) return { code: 0, stdout: 'conn_1\n', stderr: '', timedOut: false, ms: 1 };
      if (script.includes('http://127.0.0.1:8010/mcp')) {
        const body = script.includes('source_index_status')
          ? { result: { structuredContent: { kind: 'source_index_status', corpora: [{ corpus_id: 'gmail.mail', label: 'Gmail', configured: true, counts: { indexed_items: 12 }, last_refresh: { status: 'completed', completed_at: new Date().toISOString() } }] } } }
          : { result: { structuredContent: { evidence: [{ source: 'Gmail', title: 'Your trip to Santa Fe is booked', excerpt: 'K7Q2ZX' }] } } };
        desktop.scripts.push(script);
        return { code: 0, stdout: JSON.stringify({ jsonrpc: '2.0', id: 2, ...body }), stderr: '', timedOut: false, ms: 1 };
      }
      return exec(script, opts);
    };
    const result = await runCanary(desktop.machine, options('macos', {
      accountsOnly: true,
      accounts: { sources: [{ id: 'gmail', label: 'Gmail', known: { question: 'flight to Santa Fe', expect: ['K7Q2ZX'] } }], clients: [], questions: [] },
    }));
    expect(statusOf(result.checks)).toEqual({ 'live.gmail.status': 'pass', 'live.gmail.known': 'pass' });
    expect(desktop.scripts.some((script) => script.includes('connections revoke conn_1'))).toBe(true);
    // The token stays on the machine: no script carries it, each reads it from the machine's own file.
    expect(desktop.scripts.filter((script) => script.includes('8010/mcp')).every((script) => script.includes('token="$(cat "$HOME/.olympus-canary/mcp-token")"'))).toBe(true);
  });
});

describe('closing a leftover macOS dashboard window', () => {
  test('the raise and the Command-W each get their own script when the command runs in a shell', () => {
    const bin = mkdtempSync(join(tmpdir(), 'canary-osascript-'));
    const log = join(bin, 'scripts.log');
    // A stand-in osascript and open record what they were given; sleep is stubbed so the test never waits.
    writeFileSync(join(bin, 'osascript'), `#!/bin/sh\n{ cat; echo "--- end"; } >> "${log}"\n`);
    writeFileSync(join(bin, 'open'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    for (const name of ['osascript', 'open', 'sleep']) chmodSync(join(bin, name), 0o755);
    const command = macCloseCommand({ id: '1', app: 'Safari', title: 'Olympus / Keys' });
    const run = spawnSync('/bin/sh', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const scripts = readFileSync(log, 'utf8').split('--- end\n').filter(Boolean);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('AXRaise');
    expect(scripts[1]).toContain('CGEventCreateKeyboardEvent');
    // No heredoc swallowed the shell commands that follow it.
    expect(scripts.join('')).not.toContain('EOF');
    expect(scripts.join('')).not.toContain('&&');
  }, 15_000);
});
