/**
 * Option C (owner decision, 2026-10-09): olympus:// links open Olympus on the
 * computer with no Terminal step. docs/OPEN_ON_COMPUTER.md is the design and
 * threat model; these tests hold its claims: a closed target list, no state
 * change from a link, a handler that installs and uninstalls cleanly, and
 * static /open/ pages with the by-hand fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { runOpenCommand } from '../src/cli.ts';
import { DASHBOARD_LAUNCH_PAGE_HTML } from '../src/core/dashboard-launch.ts';
import { runEngineCommand } from '../src/core/engine-cli.ts';
import { formatSpaceToFree, modelInstallSpaceToFree } from '../src/core/model-install-failure.ts';
import {
  LSREGISTER_PATH,
  OPEN_HANDLER_BUNDLE_ID,
  OPEN_HANDLER_DESKTOP_ID,
  OPEN_HANDLER_MARK,
  forgetLinuxDefault,
  installOpenHandler,
  openHandlerStatus,
  renderLinuxDesktopEntry,
  renderMacOpenHandlerScript,
  uninstallOpenHandler,
  type OpenHandlerExec,
  type OpenHandlerOptions,
} from '../src/core/open-handler.ts';
import {
  OPEN_CONNECT_SOURCES,
  allOpenTargets,
  olympusOpenUrl,
  openPageUrl,
  openTargetPath,
  openTargetToken,
  parseOlympusOpenUrl,
} from '../src/core/open-targets.ts';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { connectSetupSheet, setupRow } from '../src/workers/dashboard/components.ts';
import { expectedOpenPages } from '../scripts/build-open-pages.ts';

const REPO = join(import.meta.dir, '..');
const TICKET = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE';
const PROGRAM = { runtimePath: '/Users/a/Library/Application Support/Olympus/runtime/bun', entryPath: '/Users/a/Library/Application Support/Olympus/app/dist/cli.js' };

describe('olympus:// targets', () => {
  test('every allowlisted link reads as its own target, with or without a trailing slash', () => {
    const paths = allOpenTargets().map(openTargetPath);
    expect(paths).toEqual([
      'dashboard',
      'connect/x', 'connect/readwise', 'connect/telegram', 'connect/whatsapp',
      'fix/connect', 'fix/reconnect', 'fix/answers', 'fix/search', 'fix/models',
    ]);
    for (const target of allOpenTargets()) {
      expect(parseOlympusOpenUrl(olympusOpenUrl(target))).toEqual(target);
      expect(parseOlympusOpenUrl(`${olympusOpenUrl(target)}/`)).toEqual(target);
    }
    expect(OPEN_CONNECT_SOURCES.x.sourceId).toBe('x.bookmarks');
  });

  test('an unknown or malformed olympus: link opens only the plain dashboard', () => {
    for (const link of [
      'olympus://open/connect/gmail',
      'olympus://open/connect/x/extra',
      'olympus://open/connect/x?then=delete',
      'olympus://open/connect/x#frag',
      'olympus://open/../dashboard',
      'olympus://open/fix/models;rm',
      'olympus://open/connect/%78',
      'olympus://disconnect/x',
      'olympus://open/Connect/X',
      'OLYMPUS://open/dashboard',
      'olympus:open/dashboard',
      'olympus://open/connect/x&olympus_open=fix.models',
    ]) {
      expect(parseOlympusOpenUrl(link)).toEqual({ kind: 'dashboard', fallback: true });
    }
  });

  test('anything that is not a short printable olympus: link opens nothing', () => {
    for (const link of [
      undefined, null, 42, '', 'https://olympusplugin.ai/open/dashboard/', 'javascript:alert(1)',
      'olympus://open/dashboard\n--help', 'olympus://open/dash board', "olympus://open/x'$(touch /tmp/p)'",
      'olympus://open/"x"', 'olympus://open/`id`', 'olympus://open/x\\y', 'olympus://open/dashboard\u0000',
      `olympus://open/${'a'.repeat(200)}`, 'olympus://open/dashbоard',
    ]) {
      expect(parseOlympusOpenUrl(link)).toBeUndefined();
    }
  });

  test('the ChatGPT panel opens the olympusplugin.ai page for each target', () => {
    expect(openPageUrl({ kind: 'connect', source: 'readwise' })).toBe('https://olympusplugin.ai/open/connect/readwise/');
    expect(openPageUrl({ kind: 'fix', section: 'models' })).toBe('https://olympusplugin.ai/open/fix/models/');
    expect(openTargetToken({ kind: 'dashboard' })).toBeUndefined();
  });
});

describe('olympus open: no state change from a link', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'olympus-open-'));
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    writeFileSync(envPath, 'OLYMPUS_WORKER_AUTH_TOKEN=open-test-token\n');
    chmodSync(envPath, 0o600);
    for (const [key, value] of Object.entries({
      HOME: home,
      OLYMPUS_CONFIG: join(home, 'missing-config.json'),
      OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010/v1',
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function recorder() {
    const sent: Array<{ url: string; method: string }> = [];
    const opened: string[] = [];
    return {
      sent,
      opened,
      deps: {
        fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.push({ url: String(input), method: init?.method ?? 'GET' });
          return new Response(JSON.stringify({ ok: true, ticket: TICKET }), { status: 200 });
        },
        openImpl: (url: string) => { opened.push(url); return true; },
      },
    };
  }

  test('a connect link mints one opening ticket and opens the launch page for that source', async () => {
    const r = recorder();
    const result = await runOpenCommand(['olympus://open/connect/x'], r.deps);
    expect(result).toEqual({ opened: true, target: 'connect/x' });
    // The only request is the same ticket mint `olympus dashboard` makes: no control route.
    expect(r.sent).toEqual([{ url: 'http://127.0.0.1:8010/dashboard/control/launch', method: 'POST' }]);
    expect(r.opened).toEqual([`http://127.0.0.1:8010/dashboard/launch#olympus_launch_ticket=${TICKET}&olympus_open=connect.x`]);
  });

  test('the plain dashboard and an unknown link carry no target', async () => {
    for (const link of ['olympus://open/dashboard', 'olympus://open/connect/gmail']) {
      const r = recorder();
      await runOpenCommand([link], r.deps);
      expect(r.opened).toEqual([`http://127.0.0.1:8010/dashboard/launch#olympus_launch_ticket=${TICKET}`]);
    }
  });

  test('a link that is not an olympus: link sends nothing and opens nothing', async () => {
    const r = recorder();
    expect(await runOpenCommand(['https://evil.example/'], r.deps)).toEqual({ opened: false, reason: 'not_an_olympus_link' });
    expect(r.sent).toEqual([]);
    expect(r.opened).toEqual([]);
    await expect(runOpenCommand([], r.deps)).rejects.toThrow('exactly one');
    await expect(runOpenCommand(['olympus://open/dashboard', '--read-only'], r.deps)).rejects.toThrow('exactly one');
  });
});

describe('the opening page carries only an allowlisted target', () => {
  function run(hash: string): string[] {
    const navigated: string[] = [];
    const script = DASHBOARD_LAUNCH_PAGE_HTML.split('<script>')[1]!.split('</script>')[0]!;
    const window = {
      location: { hash, pathname: '/dashboard/launch', search: '', replace: (to: string) => navigated.push(to) },
      history: { replaceState: () => { window.location.hash = ''; } },
    };
    const document = { getElementById: () => ({ textContent: '' }) };
    const fetch = async () => new Response('{}');
    new Function('window', 'document', 'fetch', 'URLSearchParams', script)(window, document, fetch, URLSearchParams);
    return navigated;
  }

  test('a known target lands on Setup with the target in the fragment; anything else on the dashboard', async () => {
    const ticket = 'A'.repeat(43);
    const landed = run(`#olympus_launch_ticket=${ticket}&olympus_open=connect.whatsapp`);
    const plain = run(`#olympus_launch_ticket=${ticket}`);
    const hostile = [
      run(`#olympus_launch_ticket=${ticket}&olympus_open=connect.gmail`),
      run(`#olympus_launch_ticket=${ticket}&olympus_open=${encodeURIComponent('fix.models#x')}`),
      run(`#olympus_launch_ticket=${ticket}&olympus_open=${encodeURIComponent('//evil.example')}`),
      run(`#olympus_launch_ticket=${ticket}&olympus_open=connectXx`),
    ];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(landed).toEqual(['/dashboard?setup#olympus-open=connect.whatsapp']);
    expect(plain).toEqual(['/dashboard']);
    for (const navigated of hostile) expect(navigated).toEqual(['/dashboard']);
  });
});

describe('the dashboard opens the named panel and submits nothing', () => {
  const GLOBALS = ['window', 'document', 'HTMLElement', 'HTMLFormElement', 'Event', 'MouseEvent', 'FormData'] as const;
  let happy: Window;
  const previous = new Map<string, PropertyDescriptor | undefined>();

  function mount(url: string): { root: HTMLElement; calls: unknown[]; dispose: () => void } {
    happy = new Window({ url });
    const values: Record<string, unknown> = {
      window: happy, document: happy.document, HTMLElement: happy.HTMLElement, HTMLFormElement: happy.HTMLFormElement,
      Event: happy.Event, MouseEvent: happy.MouseEvent, FormData: happy.FormData,
    };
    for (const name of GLOBALS) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
    }
    const root = happy.document.createElement('div') as unknown as HTMLElement;
    const sheet = connectSetupSheet({
      id: 'connect-x-bookmarks', heading: 'Connect X bookmarks', intro: 'Use your own X app', promptText: 'Help connect X',
      source: 'x', fields: [{ name: 'client_id', label: 'Client ID', required: true, secret: false }],
      // The publisher panel starts its sign-in on a real click; a link must not.
      publisher: { intro: 'Connect X', byoSummary: 'Use my own app' },
    });
    root.innerHTML = setupRow({ label: 'X bookmarks', href: '/dashboard?source=x.bookmarks', blurb: '', action: { label: 'Connect', kind: 'none', sheet: 'connect-x-bookmarks' } })
      + sheet
      + '<section id="models"><details class="models"><summary>Models</summary><p>body</p></details></section>';
    happy.document.body.append(root as never);
    const calls: unknown[] = [];
    const controller = mountDashboardController({
      root, transport: { control: async (params) => { calls.push(params); return { status: 200, body: { ok: true } }; } },
      navigate() {}, async refresh() { return undefined; },
      returnUrl: url, canWrite: true, csrfToken: 'csrf', signal: new AbortController().signal, pollIntervalMs: 0,
    });
    return { root, calls, dispose: () => controller.dispose() };
  }

  afterEach(() => {
    for (const name of GLOBALS) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    previous.clear();
    happy.close();
  });

  test('connect.x opens the X panel, clears the fragment and starts no sign-in', async () => {
    const page = mount('http://127.0.0.1:8010/dashboard?setup#olympus-open=connect.x');
    expect(page.root.querySelector('#connect-x-bookmarks')!.classList.contains('on')).toBe(true);
    expect(happy.location.hash).toBe('');
    expect(happy.location.search).toBe('?setup');
    await happy.happyDOM.waitUntilComplete();
    expect(page.calls).toEqual([]);
    page.dispose();
  });

  test('fix.models opens Models', () => {
    const models = mount('http://127.0.0.1:8010/dashboard?setup#olympus-open=fix.models');
    expect(models.root.querySelector<HTMLDetailsElement>('details.models')!.open).toBe(true);
    expect(models.root.querySelector('.sheet.on')).toBeNull();
    models.dispose();
  });

  test('an unknown target opens nothing and is cleared too', async () => {
    const other = mount('http://127.0.0.1:8010/dashboard?setup#olympus-open=connect.gmail');
    expect(other.root.querySelector('.sheet.on')).toBeNull();
    expect(other.root.querySelector<HTMLDetailsElement>('details.models')!.open).toBe(false);
    expect(happy.location.hash).toBe('');
    expect(other.calls).toEqual([]);
    other.dispose();
  });
});

/** A fake macOS toolchain: osacompile makes a bundle, plutil records keys into its Info.plist. */
function macExec(calls: string[][]): OpenHandlerExec {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === '/usr/bin/osacompile') {
      const out = args[1]!;
      mkdirSync(join(out, 'Contents'), { recursive: true });
      writeFileSync(join(out, 'Contents', 'Info.plist'), '<plist><dict></dict></plist>\n');
      writeFileSync(join(out, 'Contents', 'script.applescript'), readFileSync(args[2]!, 'utf8'));
    }
    if (command === '/usr/bin/plutil') {
      const plist = args[args.length - 1]!;
      writeFileSync(plist, `${readFileSync(plist, 'utf8')}${args[1]}=${args[3]}\n`);
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

describe('the macOS link handler', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'olympus-open-mac-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test('the applet hands the link to olympus open only as a quoted argument', () => {
    const script = renderMacOpenHandlerScript({ runtimePath: '/Users/a "b"/bun', entryPath: '/Users/a\\b/cli.js' });
    expect(script).toContain(OPEN_HANDLER_MARK);
    expect(script).toContain('on open location theURL');
    expect(script).toContain('set runtimePath to "/Users/a \\"b\\"/bun"');
    expect(script).toContain('set cliPath to "/Users/a\\\\b/cli.js"');
    expect(script).toContain('" open " & quoted form of theURL');
    expect(script).toContain('if (length of theURL) > 128 then return');
    expect(() => renderMacOpenHandlerScript({ runtimePath: 'bun', entryPath: '/x/cli.js' })).toThrow();
    expect(() => renderMacOpenHandlerScript({ runtimePath: '/x/bun\n', entryPath: '/x/cli.js' })).toThrow();
  });

  test('install builds, claims olympus:, signs and registers the applet; uninstall removes it', () => {
    const calls: string[][] = [];
    const options: OpenHandlerOptions = { platform: 'darwin', homeDir: home, exec: macExec(calls), program: PROGRAM };
    const installed = installOpenHandler(options);
    const bundle = join(home, 'Library', 'Application Support', 'Olympus', 'Olympus.app');
    expect(installed).toEqual({ ok: true, platform: 'darwin', action: 'installed', path: bundle, registered: true });
    const plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toContain(`CFBundleIdentifier=${OPEN_HANDLER_BUNDLE_ID}`);
    expect(plist).toContain('CFBundleURLTypes=[{"CFBundleURLName":"ai.olympusplugin.open","CFBundleURLSchemes":["olympus"]}]');
    expect(plist).toContain('LSUIElement=YES');
    expect(readFileSync(join(bundle, 'Contents', 'script.applescript'), 'utf8')).toBe(renderMacOpenHandlerScript(PROGRAM));
    expect(calls.map((call) => call[0])).toEqual([
      '/usr/bin/osacompile', '/usr/bin/plutil', '/usr/bin/plutil', '/usr/bin/plutil', '/usr/bin/plutil', '/usr/bin/codesign', LSREGISTER_PATH,
    ]);
    expect(calls.at(-1)).toEqual([LSREGISTER_PATH, '-f', bundle]);
    // The script source is not left behind; neither is the staging bundle.
    expect(existsSync(join(home, 'Library', 'Application Support', 'Olympus', '.open-handler.applescript'))).toBe(false);
    expect(existsSync(join(home, 'Library', 'Application Support', 'Olympus', '.Olympus-next.app'))).toBe(false);
    expect(openHandlerStatus(options).action).toBe('present');

    // Reinstalling replaces it in place (unregistering the old one first).
    calls.length = 0;
    expect(installOpenHandler(options).ok).toBe(true);
    expect(calls).toContainEqual([LSREGISTER_PATH, '-u', bundle]);

    calls.length = 0;
    expect(uninstallOpenHandler(options)).toEqual({ ok: true, platform: 'darwin', action: 'removed', path: bundle });
    expect(calls).toEqual([[LSREGISTER_PATH, '-u', bundle]]);
    expect(existsSync(bundle)).toBe(false);
    expect(openHandlerStatus(options).action).toBe('absent');
    expect(uninstallOpenHandler(options).action).toBe('absent');
  });

  test('a failed build is reported, never thrown, and an Olympus.app that is not ours is left alone', () => {
    const failing: OpenHandlerExec = (command) => ({ status: command === '/usr/bin/osacompile' ? 1 : 0, stdout: '', stderr: 'osacompile: nope' });
    const failed = installOpenHandler({ platform: 'darwin', homeDir: home, exec: failing, program: PROGRAM });
    expect(failed.ok).toBe(false);
    expect(failed.action).toBe('failed');
    expect(failed.detail).toContain('osacompile: nope');

    const bundle = join(home, 'Library', 'Application Support', 'Olympus', 'Olympus.app');
    mkdirSync(join(bundle, 'Contents'), { recursive: true });
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist>com.example.other</plist>');
    const calls: string[][] = [];
    const refused = uninstallOpenHandler({ platform: 'darwin', homeDir: home, exec: macExec(calls) });
    expect(refused.ok).toBe(false);
    expect(existsSync(bundle)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('the Linux link handler', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'olympus-open-linux-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const program = { runtimePath: '/home/a/.bun/bin/bun', entryPath: '/home/a/olympus/dist/cli.js' };

  test('the desktop entry passes the link as %u, hidden from menus', () => {
    const entry = renderLinuxDesktopEntry(program);
    expect(entry).toContain('Exec="/home/a/.bun/bin/bun" "/home/a/olympus/dist/cli.js" open %u');
    expect(entry).toContain('MimeType=x-scheme-handler/olympus;');
    expect(entry).toContain('NoDisplay=true');
    for (const bad of ['/home/a$HOME/bun', '/home/a"/bun', '/home/`id`/bun', '/home/a%u/bun', '/home/a\\/bun']) {
      expect(() => renderLinuxDesktopEntry({ ...program, runtimePath: bad })).toThrow();
    }
  });

  test('install writes the entry and makes it the default; uninstall removes both and keeps the rest', () => {
    const calls: string[][] = [];
    const exec: OpenHandlerExec = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    const env = { XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') };
    const options: OpenHandlerOptions = { platform: 'linux', homeDir: home, env, exec, program };
    const entryPath = join(home, 'data', 'applications', OPEN_HANDLER_DESKTOP_ID);
    expect(installOpenHandler(options)).toEqual({ ok: true, platform: 'linux', action: 'installed', path: entryPath, registered: true });
    expect(readFileSync(entryPath, 'utf8')).toBe(renderLinuxDesktopEntry(program));
    expect(calls[0]).toEqual(['xdg-mime', 'default', OPEN_HANDLER_DESKTOP_ID, 'x-scheme-handler/olympus']);

    // What xdg-mime wrote, beside the owner's own defaults.
    mkdirSync(join(home, 'config'), { recursive: true });
    const mimeapps = join(home, 'config', 'mimeapps.list');
    writeFileSync(mimeapps, [
      '[Default Applications]',
      'text/html=firefox.desktop',
      `x-scheme-handler/olympus=${OPEN_HANDLER_DESKTOP_ID}`,
      '[Added Associations]',
      `x-scheme-handler/olympus=other.desktop;${OPEN_HANDLER_DESKTOP_ID};`,
      '',
    ].join('\n'));
    expect(uninstallOpenHandler(options)).toEqual({ ok: true, platform: 'linux', action: 'removed', path: entryPath });
    expect(existsSync(entryPath)).toBe(false);
    expect(readFileSync(mimeapps, 'utf8')).toBe([
      '[Default Applications]',
      'text/html=firefox.desktop',
      '[Added Associations]',
      'x-scheme-handler/olympus=other.desktop;',
      '',
    ].join('\n'));
    expect(forgetLinuxDefault(mimeapps)).toBe(false);
    expect(uninstallOpenHandler(options).action).toBe('absent');
  });

  test('without xdg-mime the entry is written but not claimed, and a foreign entry is never touched', () => {
    const env = { XDG_DATA_HOME: join(home, 'data') };
    const missing: OpenHandlerExec = (command) => ({ status: command === 'xdg-mime' ? null : 0, stdout: '', stderr: 'xdg-mime: not found' });
    const result = installOpenHandler({ platform: 'linux', homeDir: home, env, exec: missing, program });
    expect(result.ok).toBe(false);
    expect(result.registered).toBe(false);

    const entryPath = join(home, 'data', 'applications', OPEN_HANDLER_DESKTOP_ID);
    writeFileSync(entryPath, '[Desktop Entry]\nName=Someone else\n');
    expect(installOpenHandler({ platform: 'linux', homeDir: home, env, exec: missing, program }).ok).toBe(false);
    expect(uninstallOpenHandler({ platform: 'linux', homeDir: home, env, exec: missing }).ok).toBe(false);
    expect(readFileSync(entryPath, 'utf8')).toBe('[Desktop Entry]\nName=Someone else\n');
  });

  test('other platforms have no handler', () => {
    expect(installOpenHandler({ platform: 'win32', homeDir: home }).action).toBe('unsupported');
  });
});

describe('engine install and uninstall carry the handler', () => {
  test('uninstall removes the handler; a test exec without a handler seam builds none', async () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-open-engine-'));
    try {
      const handled: string[] = [];
      const exec = () => ({ status: 113, stdout: '', stderr: '' });
      const result = await runEngineCommand(['uninstall'], {
        homeDir: home, platform: 'darwin', uid: 501, exec,
        openHandler: {
          install: () => { handled.push('install'); return { ok: true, platform: 'darwin', action: 'installed' }; },
          uninstall: (options) => { handled.push(`uninstall:${options.homeDir}`); return { ok: true, platform: 'darwin', action: 'removed' }; },
        },
      }) as { open_handler?: unknown };
      expect(handled).toEqual([`uninstall:${home}`]);
      expect(result.open_handler).toEqual({ ok: true, platform: 'darwin', action: 'removed' });
      const bare = await runEngineCommand(['uninstall'], { homeDir: home, platform: 'darwin', uid: 501, exec }) as { open_handler?: unknown };
      expect(bare.open_handler).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('disk-full wording', () => {
  test('the shortfall the installer recorded wins; otherwise what is left to download', () => {
    expect(modelInstallSpaceToFree({ bytesDone: 0, bytesTotal: 5e9, failure: { bytesNeeded: 4.5e9, bytesFree: 1.7e9 } })).toBe(2.8e9);
    expect(modelInstallSpaceToFree({ bytesDone: 1e8, bytesTotal: 3e8 })).toBe(2e8);
    expect(modelInstallSpaceToFree({})).toBeUndefined();
    expect(formatSpaceToFree(2.8e9)).toBe('3 GB');
    expect(formatSpaceToFree(2.3e8)).toBe('300 MB');
    expect(formatSpaceToFree(1)).toBe('100 MB');
  });
});

describe('olympusplugin.ai /open/ pages', () => {
  const pages = expectedOpenPages();

  test('site/open/ is generated and current (bun scripts/build-open-pages.ts)', () => {
    for (const [path, html] of pages) {
      expect(readFileSync(join(REPO, 'site', 'open', path), 'utf8')).toBe(html);
    }
    expect(pages.size).toBe(allOpenTargets().length + 1);
  });

  test('each page tries its own link, offers it as a button, and always shows the steps by hand', () => {
    for (const target of allOpenTargets()) {
      const html = pages.get(join(openTargetPath(target), 'index.html'))!;
      const link = olympusOpenUrl(target);
      expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${link}">`);
      expect(html).toContain(`<a class="button" href="${link}">Open Olympus</a>`);
      expect(html).toContain('Opening Olympus on your computer…');
      expect(html).toContain('<code>olympus dashboard</code>');
      expect(html).toContain('href="/help/on-your-computer/#');
      if (target.kind === 'connect') expect(html).toContain(`<strong>${OPEN_CONNECT_SOURCES[target.source].label}</strong>`);
      // Plain: no script, nothing from another site, no Mac-only wording.
      expect(html).not.toMatch(/<script|<iframe|<img/i);
      expect(html.match(/(?:src|href)="https?:\/\/[^"]*"/g) ?? []).toEqual([]);
      expect(html).not.toMatch(/\bMac\b/);
    }
  });
});
