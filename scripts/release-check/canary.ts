/**
 * The canary on a real machine (release testing design, layer 5): the short check a closet test machine runs after it updates
 * in place, the way its owner updates. The release check's throwaway machines cover the product in depth; this covers what only
 * a real desktop shows, with a real browser, launcher and window manager:
 *
 *   bun scripts/release-check/canary.ts --config <file> --machine <handle> --os linux|macos --out <reports dir>
 *       [--candidate <installer bundle dir> | --published <site base URL>] [--label <text>] [--sha <commit>] [--harness-commit <commit>]
 *
 * `--candidate` updates the install with the bundle's own installer through the driver's `upgrade` verb (machine.ts);
 * `--published` runs the site's install command on the machine, exactly as its owner would; with neither, the canary checks
 * what is installed. The config is the release check's own shape ({"driver": [...]}); the driver reaches an existing machine
 * (exec, put, get, upgrade). Nothing is provisioned or destroyed, and the install stays: the next canary updates over it.
 *
 * Checks, in order: the update; the installed version; the bar widget's one-line read (`olympus engine status --brief`,
 * running within three minutes); the engine's own status (nothing missing); the launcher (Linux: the desktop entry, its icon
 * and the olympus:// handler; macOS: the olympus:// handler app); then the dashboard twice, once the way the launcher opens it
 * (Linux: the desktop entry, as the app launcher runs it; macOS, which has no launcher icon: `olympus dashboard`) and once
 * through an olympus:// link handed to the system. Each time a new window titled Olympus must appear within 45 s, and a
 * picture of the screen goes in the report. A system prompt in a new window (a keyring or permission dialog) fails the check
 * with what it asked: it needs a person at the machine, which is a machine-setup finding, not a product one. Every window the
 * canary opened is closed again.
 *
 * With `--accounts <file>` the live accounts (live-accounts.ts) and the web clients (web-clients.ts) are checked after the
 * desktop; `--accounts-only` leaves out the update and the desktop checks. `--web-sign-in` only opens the canary browser on
 * the machine at each web app, for a person to sign the test accounts in and connect Olympus (over Screen Sharing).
 *
 * Writes <out>/<run id>/report.json, report.html and screens/. Exit status: 0 pass, 1 fail, 2 could not start, 3 inconclusive
 * (nothing failed, but a sign-in to renew or a bot check kept a check from being made; the report lists what to renew).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CommandDriver, type Machine } from './machine.ts';
import { escapeHtml, type CheckResult, type CheckStatus } from './report.ts';
import { openEngineMcp, runLiveAccounts, type LiveSourceSpec } from './live-accounts.ts';
import { isInconclusive, openForSignIn, parseClientQuestions, runWebClients, WEB_CLIENT_IDS, type ClientQuestion, type WebClientId } from './web-clients.ts';

export type CanaryOs = 'linux' | 'macos';

export interface DesktopWindow { id: string; app: string; title: string }

export interface CanaryScreen { label: string; path: string }

export interface CanaryReport {
  schema: 'olympus.release-check.canary.v1';
  runId: string;
  machine: { handle: string; os: CanaryOs };
  candidate: { label: string; sha?: string; version?: string; source: 'candidate' | 'published' | 'installed' };
  harnessCommit?: string;
  startedAt: string;
  finishedAt: string;
  verdict: CanaryVerdict;
  counts: Record<CheckStatus, number>;
  checks: CheckResult[];
  screens: CanaryScreen[];
}

export interface CanaryOptions {
  os: CanaryOs;
  /** How the install is brought up to date first. */
  update: { kind: 'candidate'; dir: string } | { kind: 'published'; site: string } | { kind: 'installed' };
  /** The version the update should leave installed (the bundle's or the site's pins); unchecked when absent. */
  expectVersion?: string;
  /** Where screen pictures are written (screens/ under the run folder). */
  screensDir: string;
  /** The live accounts and web clients (live-accounts.ts, web-clients.ts), checked after the desktop. */
  accounts?: CanaryAccounts;
  /** Leave out the update and the desktop checks: only the accounts and web clients. */
  accountsOnly?: boolean;
  /** Poll timing; tests shorten it. */
  pollMs?: number;
  windowTimeoutMs?: number;
  engineTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const OLYMPUS = '"$HOME/.local/bin/olympus"';
const DASHBOARD_LINK = 'olympus://open/dashboard';
const LINUX_DESKTOP_ID = 'ai.olympusplugin.Olympus';
/** The window a dashboard opens in: the page's own title. */
const DASHBOARD_TITLE = /\bOlympus\b/;
/** Windows that ask a person something before anything else can happen. */
const SYSTEM_PROMPT_APPS = /^(gcr-prompter|polkit-.*|pinentry.*|hyprpolkitagent|UserNotificationCenter|SecurityAgent|CoreServicesUIAgent)$/i;

/** On macOS the window list comes from Core Graphics; window titles need the screen-recording permission the machine's setup grants. */
const MAC_WINDOWS = String.raw`osascript -l JavaScript <<'EOF'
ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
JSON.stringify(list.filter((w) => w.kCGWindowLayer === 0).map((w) => ({ id: String(w.kCGWindowNumber), app: w.kCGWindowOwnerName || "", title: w.kCGWindowName || "" })));
EOF`;

/** A key press with Command held, posted the way the keyboard posts it (the machine's setup grants SSH the accessibility permission). */
const macCommandKey = (keyCode: number): string => String.raw`osascript -l JavaScript <<'EOF'
ObjC.import("CoreGraphics");
for (const down of [true, false]) { const ev = $.CGEventCreateKeyboardEvent($(), ${keyCode}, down); $.CGEventSetFlags(ev, $.kCGEventFlagMaskCommand); $.CGEventPost($.kCGHIDEventTap, ev); }
"sent";
EOF`;
const MAC_KEY_Q = 12;
const MAC_KEY_W = 13;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function windowsScript(os: CanaryOs): string {
  return os === 'linux' ? 'hyprctl clients -j' : MAC_WINDOWS;
}

/** The machine's top-level windows, from `hyprctl clients -j` (Linux) or the Core Graphics list (macOS). */
export function parseWindows(os: CanaryOs, stdout: string): DesktopWindow[] {
  const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
  if (!Array.isArray(parsed)) throw new Error('the window list is not a list');
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    if (os === 'linux') return { id: String(record.address ?? ''), app: String(record.class ?? record.initialClass ?? ''), title: String(record.title ?? '') };
    return { id: String(record.id ?? ''), app: String(record.app ?? ''), title: String(record.title ?? '') };
  }).filter((window) => window.id !== '');
}

/** The site's install command for each platform (the install page's own). */
export const SITE_INSTALLER: Record<CanaryOs, string> = { linux: 'install-linux.sh', macos: 'install.sh' };

/** Windows the open produced: new ones, and existing ones whose title changed (a browser that opened a tab in a window it had). */
export function openedWindows(before: readonly DesktopWindow[], after: readonly DesktopWindow[]): Array<DesktopWindow & { reused: boolean }> {
  const earlier = new Map(before.map((window) => [window.id, window]));
  return after.flatMap((window): Array<DesktopWindow & { reused: boolean }> => {
    const was = earlier.get(window.id);
    if (!was) return [{ ...window, reused: false }];
    return was.title !== window.title ? [{ ...window, reused: true }] : [];
  });
}

export const isSystemPrompt = (window: DesktopWindow): boolean => SYSTEM_PROMPT_APPS.test(window.app);
export const isDashboard = (window: DesktopWindow): boolean => !isSystemPrompt(window) && DASHBOARD_TITLE.test(window.title);

/** The version an installer bundle's install.sh pins (OLYMPUS_VERSION=...). */
export function pinnedVersion(installScript: string): string | undefined {
  return /^OLYMPUS_VERSION=([0-9A-Za-z.+-]+)\s*$/m.exec(installScript)?.[1];
}

const describe = (window: DesktopWindow): string => `${window.app}${window.title ? ` "${window.title}"` : ''}`;

/**
 * The accounts file (olympus-ops config/canary-accounts.json): the sources the machine's Olympus is connected to with test
 * accounts, the web apps signed in with test accounts in the canary browser, and the questions asked there.
 */
export interface CanaryAccounts {
  sources: LiveSourceSpec[];
  clients: WebClientId[];
  questions: ClientQuestion[];
}

export function parseCanaryAccounts(raw: unknown, readQuestions: (path: string) => unknown): CanaryAccounts {
  const record = (raw ?? {}) as { sources?: unknown; clients?: unknown; questions?: unknown };
  const sources = Array.isArray(record.sources) ? record.sources as LiveSourceSpec[] : [];
  for (const source of sources) {
    if (typeof source?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(source.id) || typeof source.label !== 'string') throw new Error('each source needs an id (lowercase) and a label');
    if (source.known && (typeof source.known.question !== 'string' || !Array.isArray(source.known.expect))) throw new Error(`source ${source.id}: known needs a question and an expect list`);
    if (source.plant && (!Array.isArray(source.plant.argv) || source.plant.argv.length === 0)) throw new Error(`source ${source.id}: plant needs an argv list`);
  }
  const clients = Array.isArray(record.clients) ? record.clients : [];
  for (const client of clients) if (!WEB_CLIENT_IDS.includes(client as WebClientId)) throw new Error(`clients are ${WEB_CLIENT_IDS.join(', ')}`);
  const questions = typeof record.questions === 'string' ? parseClientQuestions(readQuestions(record.questions)) : [];
  if (clients.length > 0 && questions.length === 0) throw new Error('web clients are listed but no questions file is named');
  return { sources, clients: clients as WebClientId[], questions };
}

/** Runs the canary's checks on one machine. Never throws for a product problem: every failure is a check. */
export async function runCanary(machine: Machine, options: CanaryOptions): Promise<{ checks: CheckResult[]; screens: CanaryScreen[] }> {
  const desktop = options.accountsOnly ? { checks: [], screens: [] } : await runDesktopChecks(machine, options);
  const accounts = options.accounts;
  // A failed update leaves nothing worth asking.
  if (!accounts || desktop.checks.some((check) => check.id === 'canary.update' && check.status === 'fail')) return desktop;
  const checks = [...desktop.checks];
  const screens = [...desktop.screens];
  if (accounts.sources.length > 0) {
    const started = Date.now();
    let engine;
    try { engine = await openEngineMcp(machine); } catch (error) {
      checks.push({ id: 'live.connection', title: 'A connection to the machine\'s Olympus for the account checks', status: 'fail', detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    }
    if (engine) {
      try { checks.push(...await runLiveAccounts(engine, { sources: accounts.sources, ...(options.sleep ? { sleep: options.sleep, pollMs: options.pollMs ?? 1 } : {}) })); } finally { await engine.close(); }
    }
  }
  if (accounts.clients.length > 0) {
    const web = await runWebClients(machine, { clients: accounts.clients, questions: accounts.questions, os: options.os, screensDir: options.screensDir });
    checks.push(...web.checks);
    screens.push(...web.screens);
  }
  return { checks, screens };
}

async function runDesktopChecks(machine: Machine, options: CanaryOptions): Promise<{ checks: CheckResult[]; screens: CanaryScreen[] }> {
  const checks: CheckResult[] = [];
  const screens: CanaryScreen[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pollMs = options.pollMs ?? 1_500;
  const record = (id: string, title: string, status: CheckStatus, detail: string, started: number): void => {
    checks.push({ id, title, status, detail, ms: Date.now() - started });
  };
  const sh = (script: string, timeoutMs = 60_000) => machine.exec(script, { timeoutMs });

  // 1. The update, the way the owner runs it.
  let started = Date.now();
  if (options.update.kind === 'candidate') {
    try {
      await machine.upgrade(options.update.dir);
      record('canary.update', 'Update with the candidate\'s installer', 'pass', 'the installer reported a usable install', started);
    } catch (error) {
      record('canary.update', 'Update with the candidate\'s installer', 'fail', error instanceof Error ? error.message : String(error), started);
      return { checks, screens };
    }
  } else if (options.update.kind === 'published') {
    // pipefail: a failed download must fail the update, not hand `sh` an empty script that exits 0.
    const result = await sh(`set -o pipefail; curl -fsSL --proto '=https' --tlsv1.2 ${shellQuote(`${options.update.site.replace(/\/$/, '')}/${SITE_INSTALLER[options.os]}`)} | sh`, 25 * 60_000);
    const last = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-3).join(' / ');
    record('canary.update', 'Update with the site\'s install command', result.code === 0 ? 'pass' : 'fail', result.code === 0 ? last.slice(0, 300) : `exit ${result.code}: ${last.slice(0, 600)}`, started);
    if (result.code !== 0) return { checks, screens };
  }

  // 2. The version that is now installed.
  started = Date.now();
  const version = await sh(`${OLYMPUS} --version`);
  const installed = version.stdout.trim();
  if (version.code !== 0) record('canary.version', 'Installed version', 'fail', `olympus --version failed (exit ${version.code}): ${version.stderr.trim().slice(0, 300)}`, started);
  else if (options.expectVersion && !installed.split(/\s+/).includes(options.expectVersion)) record('canary.version', 'Installed version', 'fail', `${installed}; the update should have installed ${options.expectVersion}`, started);
  else record('canary.version', 'Installed version', 'pass', installed, started);

  // 3. The bar widget's read: running within the engine's own start-up grace.
  started = Date.now();
  let brief: { state?: string; detail?: string; schema?: string } | undefined;
  const engineDeadline = Date.now() + (options.engineTimeoutMs ?? 180_000);
  for (;;) {
    const result = await sh(`${OLYMPUS} engine status --brief`);
    try { brief = JSON.parse(result.stdout) as typeof brief; } catch { brief = undefined; }
    if (brief?.state === 'running' || Date.now() >= engineDeadline) break;
    await sleep(Math.max(pollMs, 5_000));
  }
  if (brief?.schema !== 'olympus.engine.brief.v1') record('canary.bar', 'Bar widget status line', 'fail', 'olympus engine status --brief printed no status line', started);
  else record('canary.bar', 'Bar widget status line', brief.state === 'running' ? 'pass' : 'fail', `${brief.state}${brief.detail ? `: ${brief.detail}` : ''}`, started);

  // 4. The engine's own account of itself.
  started = Date.now();
  const status = await sh(`${OLYMPUS} engine status`);
  let missing: string[] | undefined;
  try { missing = (JSON.parse(status.stdout) as { missing?: string[] }).missing; } catch { missing = undefined; }
  if (!Array.isArray(missing)) record('canary.engine', 'Engine status', 'fail', `olympus engine status printed no report (exit ${status.code})`, started);
  else record('canary.engine', 'Engine status', missing.length === 0 ? 'pass' : 'fail', missing.length === 0 ? 'nothing missing' : missing.join(' '), started);

  // 5. The launcher and the link handler the dashboard is opened through.
  started = Date.now();
  const launcher = await sh(options.os === 'linux' ? LINUX_LAUNCHER : MAC_LAUNCHER);
  record('canary.launcher', options.os === 'linux' ? 'Launcher entry, icon and olympus:// handler' : 'olympus:// handler app', launcher.code === 0 ? 'pass' : 'fail', (launcher.stdout.trim() || launcher.stderr.trim()).slice(0, 400), started);

  // 6. The dashboard window, through the launcher and through a link.
  const opens: Array<{ id: string; title: string; script: string }> = options.os === 'linux'
    ? [
      { id: 'canary.window.launcher', title: 'Dashboard window from the launcher', script: `gtk-launch ${LINUX_DESKTOP_ID}` },
      // Bounded on the machine: an xdg-open that cannot run the handler falls back to a browser and can stay in the foreground.
      { id: 'canary.window.link', title: 'Dashboard window from an olympus:// link', script: `timeout -k 5 40 xdg-open ${shellQuote(DASHBOARD_LINK)}` },
    ]
    : [
      { id: 'canary.window.launcher', title: 'Dashboard window from olympus dashboard', script: `${OLYMPUS} dashboard >/dev/null` },
      { id: 'canary.window.link', title: 'Dashboard window from an olympus:// link', script: `open ${shellQuote(DASHBOARD_LINK)}` },
    ];
  for (const open of opens) {
    started = Date.now();
    const listed = async (): Promise<DesktopWindow[] | string> => {
      const result = await sh(windowsScript(options.os));
      if (result.code !== 0) return `the window list could not be read (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`;
      try { return parseWindows(options.os, result.stdout); } catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    const before = await listed();
    if (typeof before === 'string') { record(open.id, open.title, 'fail', before, started); continue; }
    // A dashboard already on screen hides the next one: a browser may open it as a tab behind that window's title.
    const already = before.find(isDashboard);
    if (already) { record(open.id, open.title, 'fail', `a dashboard window was already open before this check (${describe(already)}), so a new one could not be told from it; close it and run the canary again`, started); continue; }
    const launched = await sh(open.script);
    let opened: Array<DesktopWindow & { reused: boolean }> = [];
    let outcome: { status: CheckStatus; detail: string } | undefined;
    if (launched.code !== 0) {
      outcome = { status: 'fail', detail: `the command failed (exit ${launched.code}): ${(launched.stderr.trim() || launched.stdout.trim()).slice(0, 300)}` };
      // What a failed command still opened (a browser it fell back to) is closed like any other window the check opened.
      const after = await listed();
      if (typeof after !== 'string') opened = openedWindows(before, after);
    }
    const deadline = Date.now() + (options.windowTimeoutMs ?? 45_000);
    while (!outcome) {
      const after = await listed();
      if (typeof after === 'string') { outcome = { status: 'fail', detail: after }; break; }
      opened = openedWindows(before, after);
      const prompt = opened.find(isSystemPrompt);
      const dashboard = opened.find(isDashboard);
      if (prompt) outcome = { status: 'fail', detail: `a system prompt opened instead and needs a person at the machine: ${describe(prompt)}` };
      else if (dashboard) outcome = { status: 'pass', detail: `${describe(dashboard)} after ${Math.round((Date.now() - started) / 1000)} s` };
      else if (Date.now() >= deadline) outcome = { status: 'fail', detail: opened.length === 0 ? 'no new window opened' : `no window titled Olympus; new: ${opened.map(describe).join(', ')}` };
      else await sleep(pollMs);
    }
    const picture = await capture(machine, options, open.id.replace(/^canary\./, ''));
    if (picture) screens.push({ label: open.title, path: picture });
    record(open.id, open.title, outcome.status, outcome.detail, started);
    const left = await closeWindows(machine, options, before, opened, sleep);
    if (left) checks.push({ id: `${open.id}.closed`, title: `${open.title}: closed again`, status: 'warn', detail: left });
  }
  return { checks, screens };
}

const LINUX_LAUNCHER = String.raw`d="${'$'}{XDG_DATA_HOME:-$HOME/.local/share}"
entry="$d/applications/${LINUX_DESKTOP_ID}.desktop"
icon="$d/icons/hicolor/512x512/apps/${LINUX_DESKTOP_ID}.png"
[ -f "$entry" ] || { echo "no launcher entry at $entry"; exit 1; }
grep -qx 'X-Olympus-Managed=true' "$entry" || { echo "the launcher entry at $entry is not the one Olympus installs"; exit 1; }
[ -s "$icon" ] || { echo "no launcher icon at $icon"; exit 1; }
handler="$(xdg-mime query default x-scheme-handler/olympus 2>/dev/null)"
[ -n "$handler" ] || { echo "nothing opens olympus:// links"; exit 1; }
echo "launcher entry and icon present; olympus:// opens with $handler"`;

const MAC_LAUNCHER = String.raw`app="$HOME/Library/Application Support/Olympus/Olympus.app"
[ -d "$app" ] || { echo "no Olympus.app at $app"; exit 1; }
handler="$(osascript -l JavaScript -e 'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("${DASHBOARD_LINK}")); u.isNil() ? "" : u.path.js')"
[ "$handler" = "$app" ] || { echo "olympus:// links open with '${'$'}{handler:-nothing}', not $app"; exit 1; }
echo "olympus:// opens with $app"`;

/** A picture of the whole screen, copied off the machine; undefined when it could not be taken. */
async function capture(machine: Machine, options: CanaryOptions, name: string): Promise<string | undefined> {
  const remote = `/tmp/olympus-canary-${name}-${process.pid}.png`;
  const shot = await machine.exec(`${options.os === 'linux' ? 'grim' : 'screencapture -x'} ${remote}`, { timeoutMs: 30_000 });
  if (shot.code !== 0) return undefined;
  mkdirSync(options.screensDir, { recursive: true });
  const local = join(options.screensDir, `${name}.png`);
  try { await machine.get(remote, local); } catch { return undefined; } finally { await machine.exec(`rm -f ${remote}`, { timeoutMs: 15_000 }); }
  return local;
}

/**
 * Closes what the check opened. Linux: each new window by its address, and the tab it opened in a window that was already
 * there with Control-W sent to that window. macOS: an app that had no window before is quit (with the keyboard, so it reopens
 * nothing next time); in an app that had, each window or tab the check opened is closed with Command-W. Returns what is still
 * open, if anything.
 */
async function closeWindows(machine: Machine, options: CanaryOptions, before: readonly DesktopWindow[], opened: ReadonlyArray<DesktopWindow & { reused: boolean }>, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  if (opened.length === 0) return undefined;
  if (options.os === 'linux') {
    await machine.exec(opened.map((window) => window.reused
      ? hyprDispatch(`sendshortcut ${shellQuote(`CTRL, W, address:${window.id}`)}`, `hl.dsp.send_shortcut({ mods = "CTRL", key = "W", window = ${JSON.stringify(`address:${window.id}`)} })`)
      : hyprDispatch(`closewindow address:${shellQuote(window.id)}`, `hl.dsp.window.close({ window = ${JSON.stringify(`address:${window.id}`)} })`)).join('\n'), { timeoutMs: 30_000 });
  } else {
    for (const app of new Set(opened.map((window) => window.app))) {
      const hadWindows = before.some((window) => window.app === app);
      const count = hadWindows ? opened.filter((window) => window.app === app).length : 1;
      for (let index = 0; index < count; index += 1) {
        await machine.exec(`open -a ${shellQuote(app)} && sleep 1 && ${macCommandKey(hadWindows ? MAC_KEY_W : MAC_KEY_Q)}`, { timeoutMs: 30_000 });
      }
    }
  }
  await sleep(2_000);
  const result = await machine.exec(windowsScript(options.os), { timeoutMs: 30_000 });
  let after: DesktopWindow[];
  try { after = parseWindows(options.os, result.stdout); } catch { return 'the window list could not be read afterwards'; }
  const left = opened.filter((window) => after.some((other) => other.id === window.id && (!window.reused || other.title === window.title)));
  return left.length === 0 ? undefined : `still open: ${left.map(describe).join(', ')}`;
}

/**
 * A Hyprland dispatch for both config languages. The classic form goes first; a Hyprland with a Lua config (0.56 on
 * test-omarchy, 2026-10-25) answers it with an error instead of "ok", and then the same dispatch goes as Lua.
 */
export function hyprDispatch(classic: string, lua: string): string {
  return `[ "$(hyprctl dispatch ${classic} 2>&1)" = ok ] || hyprctl dispatch ${shellQuote(lua)} >/dev/null`;
}

/** Inconclusive: nothing failed, but a check could not be made (a sign-in to renew, a bot check): not a pass. */
export type CanaryVerdict = 'pass' | 'fail' | 'inconclusive';

export function canaryVerdict(checks: readonly CheckResult[]): CanaryVerdict {
  if (checks.length === 0 || checks.some((check) => check.status === 'fail')) return 'fail';
  return checks.some(isInconclusive) ? 'inconclusive' : 'pass';
}

/** What a person must renew before the next run: each inconclusive check's reason, once. */
export function renewals(checks: readonly CheckResult[]): string[] {
  return [...new Set(checks.filter(isInconclusive).map((check) => (check.detail ?? '').replace(/^Inconclusive:\s*/, '')))];
}

export function renderCanaryHtml(report: CanaryReport, relative: (path: string) => string): string {
  const rows = report.checks.map((check) => `<tr class="${check.status}"><td>${check.status.toUpperCase()}</td><td>${escapeHtml(check.title)}</td><td>${escapeHtml(check.detail ?? '')}</td></tr>`).join('\n');
  const pictures = report.screens.map((screen) => `<figure><img src="${escapeHtml(relative(screen.path))}" alt="${escapeHtml(screen.label)}"><figcaption>${escapeHtml(screen.label)}</figcaption></figure>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Canary ${escapeHtml(report.machine.handle)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;max-width:1100px}td{padding:4px 8px;vertical-align:top;border-bottom:1px solid #ddd}tr.fail td:first-child{color:#b00020;font-weight:600}tr.pass td:first-child{color:#1b7f3b}tr.warn td:first-child{color:#a15c00}tr.skip td:first-child{color:#555}img{max-width:100%;border:1px solid #ccc}figure{margin:16px 0}</style></head><body>
<h1>Canary on ${escapeHtml(report.machine.handle)}: ${report.verdict.toUpperCase()}</h1>
<p>${escapeHtml(report.candidate.label)}${report.candidate.version ? ` (${escapeHtml(report.candidate.version)})` : ''}, ${escapeHtml(report.candidate.source)} &middot; ${escapeHtml(report.startedAt)} to ${escapeHtml(report.finishedAt)}</p>
${renewals(report.checks).length > 0 ? `<h2>To renew before the next run</h2><ul>${renewals(report.checks).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
<table>${rows}</table>
${pictures}
</body></html>
`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const option = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const usage = 'usage: bun scripts/release-check/canary.ts --config <file> --machine <handle> --os linux|macos --out <reports dir> [--candidate <bundle dir> | --published <site base URL>] [--accounts <file> [--accounts-only]] [--label <text>] [--sha <commit>] [--harness-commit <commit>]\n       bun scripts/release-check/canary.ts --config <file> --machine <handle> --os linux|macos --accounts <file> --web-sign-in';
  const configPath = option('--config');
  const handle = option('--machine');
  const os = option('--os');
  const out = option('--out');
  const candidate = option('--candidate');
  const published = option('--published');
  if (!configPath || !handle || (!out && !argv.includes('--web-sign-in')) || (os !== 'linux' && os !== 'macos') || (candidate && published)) {
    console.error(usage);
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { driver?: string[] };
  if (!Array.isArray(config.driver) || config.driver.length === 0) {
    console.error('the config needs a "driver" argv array');
    process.exit(2);
  }
  const accountsPath = option('--accounts');
  let accounts: CanaryAccounts | undefined;
  if (accountsPath) {
    try {
      // The questions file is named relative to the accounts file.
      accounts = parseCanaryAccounts(JSON.parse(readFileSync(accountsPath, 'utf8')), (path) => JSON.parse(readFileSync(resolve(dirname(accountsPath), path), 'utf8')));
    } catch (error) {
      console.error(`the accounts file ${accountsPath} is not usable: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  }
  if ((argv.includes('--accounts-only') || argv.includes('--web-sign-in')) && !accounts) {
    console.error(usage);
    process.exit(2);
  }
  if (argv.includes('--web-sign-in')) {
    // A person signs each app in and connects Olympus there, in the canary's own browser on the machine (Screen Sharing).
    const signInDriver = new CommandDriver({ argv: config.driver, onLog: (line) => console.error(`driver: ${line}`) });
    const target = signInDriver.machineFor({ handle, label: handle, os, driver: 'driver' });
    console.log(await openForSignIn(target, os, accounts!.clients.length > 0 ? accounts!.clients : WEB_CLIENT_IDS));
    process.exit(0);
  }
  let expectVersion: string | undefined;
  // The bundle's installer has the site's name for the platform (publish-release-to-site.ts --linux-local / --mac-local).
  if (candidate) expectVersion = pinnedVersion(readFileSync(join(candidate, SITE_INSTALLER[os]), 'utf8'));
  if (published) {
    const response = await fetch(`${published.replace(/\/$/, '')}/${SITE_INSTALLER[os]}`);
    expectVersion = response.ok ? pinnedVersion(await response.text()) : undefined;
  }
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomBytes(2).toString('hex')}`.toLowerCase();
  const runDir = resolve(out!, runId);
  mkdirSync(runDir, { recursive: true });
  const driver = new CommandDriver({ argv: config.driver, onLog: (line) => console.error(`driver: ${line}`) });
  const machine = driver.machineFor({ handle, label: handle, os, driver: 'driver' });
  const startedAt = new Date().toISOString();
  const { checks, screens } = await runCanary(machine, {
    os,
    update: candidate ? { kind: 'candidate', dir: resolve(candidate) } : published ? { kind: 'published', site: published } : { kind: 'installed' },
    ...(expectVersion ? { expectVersion } : {}),
    ...(accounts ? { accounts } : {}),
    accountsOnly: argv.includes('--accounts-only'),
    screensDir: join(runDir, 'screens'),
  });
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const check of checks) counts[check.status] += 1;
  const sha = option('--sha');
  const harnessCommit = option('--harness-commit');
  const report: CanaryReport = {
    schema: 'olympus.release-check.canary.v1', runId, machine: { handle, os },
    candidate: { label: option('--label') ?? (candidate ? 'local build' : published ? published : 'installed'), ...(sha ? { sha } : {}), ...(expectVersion ? { version: expectVersion } : {}), source: candidate ? 'candidate' : published ? 'published' : 'installed' },
    ...(harnessCommit ? { harnessCommit } : {}),
    startedAt, finishedAt: new Date().toISOString(), verdict: canaryVerdict(checks), counts, checks, screens,
  };
  const relative = (path: string): string => path.startsWith(`${runDir}/`) ? path.slice(runDir.length + 1) : path;
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify({ ...report, screens: screens.map((screen) => ({ ...screen, path: relative(screen.path) })) }, null, 2)}\n`);
  writeFileSync(join(runDir, 'report.html'), renderCanaryHtml(report, relative));
  for (const check of checks) console.error(`check ${check.status.toUpperCase()} ${check.id} - ${check.detail ?? ''}`);
  for (const line of renewals(checks)) console.error(`renew: ${line}`);
  console.log(JSON.stringify({ verdict: report.verdict, counts, report: join(runDir, 'report.html') }));
  // 3: inconclusive (nothing failed, but a sign-in or bot check kept a check from being made).
  process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'inconclusive' ? 3 : 1);
}
