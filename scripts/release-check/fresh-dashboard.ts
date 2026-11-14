/** CDP UI driver for the real, already signed-in canary Chromium. Never fills authentication fields. */
import { sourceCard, sourceConnected } from './source-cards.ts';
import type { Machine, Tunnel } from './machine.ts';
import { connectBrowser, startOwnerBridge, type BrowserSession } from './web-clients.ts';
import type { LiveSourceSpec } from './live-accounts.ts';
import { consentBlock, FRESH_BRIDGE_PID, FreshInconclusive, type ConsentSnapshot } from './fresh-install.ts';
import { PRIVATE_ANSWER_OPTIONS } from '../../src/core/privacy-language.ts';
import { ON_DEMAND_FOLDER, type SeedFolder } from './on-demand-seeds.ts';
import type { FolderMode, TimingDashboard } from './on-demand-timing.ts';

/** The Add a source tile for a source, by its provider id (gmail.email, google_drive.docs, dropbox.files). */
const sourcePick = (s: LiveSourceSpec) => `[data-source-pick^="${s.id}."]`;

export interface FreshDashboard {
  privacyChoice(): Promise<string>;
  connection?(source: LiveSourceSpec): Promise<'connected' | 'web' | 'unavailable'>;
  connect(source: LiveSourceSpec): Promise<void>;
  consent(source: LiveSourceSpec): Promise<void>;
  callback(source: LiveSourceSpec): Promise<void>;
  scope(source: LiveSourceSpec): Promise<void>;
  indexed(source: LiveSourceSpec): Promise<number>;
  /**
   * Saves an answer model on Privacy settings (?keys) through the page's own form, as the owner does: the given one, or another
   * option of the first picker that has two. Says which picker and models; the save itself restarts the engine.
   */
  saveAnswerModel?(want?: { provider: string; model: string }): Promise<{ provider: string; from: string; to: string }>;
  close(): Promise<void>;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const visible = `e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility!=='hidden'; }`;

export function parseCdpEndpoint(endpoint: string): { host: string; port: number } {
  const match = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(endpoint);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('--cdp must be host:port');
  return { host: match[1]!, port: Number(match[2]) };
}

// The persisted source cards, as machine-agent.ts reads them. /dashboard.json takes only the worker
// bearer or the dash_ query token, never the page's session cookie (src/workers/http.ts), and the
// page URL carries no token once the harness has navigated, so the fetch from the page answered 401.
// The bearer goes in on stdin so it never shows in the process list.
export const DASHBOARD_JSON = `curl -sS --max-time 10 -w '\\n%{http_code}' --unix-socket "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/olympus/worker.sock" -H @- http://127.0.0.1:8010/dashboard.json <<EOF
Authorization: Bearer $("$HOME/.local/bin/olympus" dashboard token)
EOF`;

export async function openFreshDashboard(machine: Machine, endpoint: string, timings: { timeoutMs?: number; pollMs?: number; modelWaitMs?: number; modelStallMs?: number;
  bridge?: { agentPath: string; pidFile: string; logTemplate: string } } = {}): Promise<FreshDashboard & TimingDashboard> {
  const { host, port } = parseCdpEndpoint(endpoint);
  let tunnel: Tunnel | undefined;
  let browser: BrowserSession | undefined;
  let stopBridge: (() => Promise<void>) | undefined;
  const owned = new Set<string>();
  const sessions = new Map<string, string>();
  const contexts = new Map<string, Set<number>>();
  let dash = '';
  const frameSessions = new Set<string>();
  const baseline = new Set<string>();
  const callbacks = new Set<string>();
  const navigated = new Map<string, string>();
  let windowOffered = false;
  const observeCallback = (url: string) => {
    const m = /^http:\/\/(?:127\.0\.0\.1|localhost):8010\/oauth\/callback\/([a-z-]+)\/done(?:[?#]|$)/.exec(url);
    if (m) callbacks.add(m[1]!);
  };
  const cleanup = async () => {
    if (browser) for (const id of owned) await browser.send('Target.closeTarget', { targetId: id }).catch(() => {});
    browser?.close(); tunnel?.close();
    const stop = stopBridge; stopBridge = undefined;
    await stop?.();
  };
  try {
    // ssh-driver forwards remote loopback. A non-loopback endpoint is directly reachable from this runner.
    if (host === '127.0.0.1' || host === 'localhost') {
      if (!machine.tunnel) throw new Error('driver needs a CDP tunnel');
      tunnel = await machine.tunnel(port);
    }
    const address = tunnel ? `127.0.0.1:${tunnel.port}` : `${host}:${port}`;
    let version: { webSocketDebuggerUrl?: string };
    try { version = await (await fetch(`http://${address}/json/version`, { signal: AbortSignal.timeout(10_000) })).json() as typeof version; }
    catch { throw new FreshInconclusive('renew Google and Dropbox sign-in in zig’s canary Chromium (CDP unavailable)'); }
    if (!version.webSocketDebuggerUrl) throw new Error('CDP returned no browser address');
    browser = await connectBrowser(version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${address}`));
    const send = browser.send;
    browser.send = async (...args) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([send(...args), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CDP request timed out')), 30_000); })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    browser.on('Runtime.executionContextCreated', (p, session) => {
      if (session && p.context.auxData?.isDefault) {
        const list = contexts.get(session) ?? new Set<number>(); list.add(p.context.id); contexts.set(session, list);
      }
    });
    browser.on('Runtime.executionContextDestroyed', (p, session) => { if (session) contexts.get(session)?.delete(p.executionContextId); });
    browser.on('Runtime.executionContextsCleared', (_, session) => { if (session) contexts.set(session, new Set()); });
    browser.on('Page.windowOpen', () => { windowOffered = true; });
    browser.on('Page.frameNavigated', (p, sid) => { observeCallback(p.frame.url); if (sid && !p.frame.parentId) navigated.set(sid, p.frame.loaderId); });
    browser.on('Target.attachedToTarget', (p, parent) => {
      if (parent && (sessions.get(dash) === parent || frameSessions.has(parent))) {
        frameSessions.add(p.sessionId);
        void browser!.send('Runtime.enable', {}, p.sessionId).catch(() => {});
        void browser!.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
      }
    });
    const attach = async (id: string): Promise<string> => {
      if (sessions.has(id)) return sessions.get(id)!;
      const { sessionId } = await browser!.send('Target.attachToTarget', { targetId: id, flatten: true });
      sessions.set(id, sessionId);
      await browser!.send('Runtime.enable', {}, sessionId);
      await browser!.send('Page.enable', {}, sessionId);
      await browser!.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
      return sessionId;
    };
    const evalIn = async <T>(session: string, expression: string, contextId?: number): Promise<T> => {
      const out = await browser!.send('Runtime.evaluate', { expression, userGesture: true, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, session);
      if (out.exceptionDetails) throw new Error('dashboard page evaluation failed');
      return out.result?.value as T;
    };
    // Evaluate the visible panel's default world as well as the host. The product intentionally sandboxes its iframe.
    const panel = async <T>(expression: string, accept: (value: T) => boolean): Promise<T | undefined> => {
      const session = await attach(dash);
      for (const sid of [session, ...frameSessions]) for (const id of contexts.get(sid) ?? []) {
        const value = await evalIn<T>(sid, expression, id).catch(() => undefined);
        if (value !== undefined && accept(value)) return value;
      }
      return undefined;
    };
    /** Every frame's answer, for diagnostics: which frames see a control and what each one says. */
    const panelAll = async <T>(expression: string, accept: (value: T) => boolean): Promise<T[]> => {
      const session = await attach(dash);
      const out: T[] = [];
      for (const sid of [session, ...frameSessions]) for (const id of contexts.get(sid) ?? []) {
        const value = await evalIn<T>(sid, expression, id).catch(() => undefined);
        if (value !== undefined && accept(value)) out.push(value);
      }
      return out;
    };
    const until = async (read: () => Promise<boolean>, detail: string, ms = timings.timeoutMs ?? 90_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        if (await read()) return;
        if (Date.now() >= deadline) throw new Error(detail);
        await sleep(timings.pollMs ?? 1000);
      }
    };
    // On a timeout the error names the control and whether it was absent, disabled or hidden, plus what `seen` reads
    // from the page (the controls that were there instead), so a moved control is named in the report (olympus-ops#222).
    const click = async (expression: string, what = 'dashboard control', seen?: string) => {
      try {
        await until(async () => !!await panel<boolean>(`(() => { const e=${expression}; if(!e || e.disabled || !(${visible})(e)) return false; e.click(); return true; })()`, Boolean), `${what} did not appear`);
      } catch (error) {
        // The host document answers too, and has none of the panel's controls: prefer a frame that has the control or the row.
        const read = async (expression: string, found: (value: string) => boolean) => await panel<string>(expression, (value) => typeof value === 'string' && found(value)).catch(() => undefined)
          ?? await panel<string>(expression, (value) => typeof value === 'string').catch(() => undefined);
        const state = await read(`(() => { const e=${expression}; return !e ? 'absent' : e.disabled ? 'disabled' : !(${visible})(e) ? 'hidden' : 'present'; })()`, (value) => value !== 'absent');
        const there = seen ? await read(seen, (value) => !value.startsWith('no ') && !value.endsWith(': ')) : undefined;
        throw new Error(`${what} did not appear${state ? ` (${state})` : ''}${there ? `; ${there}` : ''}`, { cause: error });
      }
    };
    const byKey = (key: string) => `[...document.querySelectorAll('[data-key]')].find(e=>e.getAttribute('data-key')===${JSON.stringify(key)})`;
    const clickKey = (key: string) => click(byKey(key), `control ${key}`, `'controls with keys: ' + [...new Set([...document.querySelectorAll('[data-key]')].map(e=>e.getAttribute('data-key').replace(/:[^:]*$/, ':…')))].slice(0, 20).join(', ')`);
    const sourceAction = async (s: LiveSourceSpec, pattern: string) => {
      const row = `[...document.querySelectorAll('.source')].find(e=>e.querySelector('.source-name')?.textContent?.trim()===${JSON.stringify(s.label)})`;
      // Sources lists a connected source as a short row whose Details opens its full row (with Choose mail or
      // Choose folders, Sync now) on Home; Home lists no sources otherwise (#1085). Go there when this page has no such row.
      if (!await panel<boolean>(`!!${row}`, Boolean)) {
        const details = `document.querySelector('[data-source-row^=${JSON.stringify(`${s.id}.`)}] a[data-source-details]')?.getAttribute('href')`;
        let href = await panel<string>(details, v => typeof v === 'string' && v.length > 0);
        // Best effort: if Sources or the landing does not load, the press below fails naming what the page showed.
        if (!href) {
          await reload('/dashboard?connect', `!!document.querySelector('.srcrows')`).catch(() => undefined);
          href = await panel<string>(details, v => typeof v === 'string' && v.length > 0);
        }
        if (href) await reload(href, `!!${row}`).catch(() => undefined);
      }
      try {
        await click(`(()=>{const row=${row}; if(!row)return null; const e=[...row.querySelectorAll('button')].find(e=>/${pattern}/i.test(e.textContent.trim())); const menu=row.querySelector('details');if(e && menu && menu.contains(e) && !menu.open)menu.querySelector('summary').click();return e;})()`);
      } catch (error) {
        // Say what the page showed instead: the rows' names, and this row's buttons with their state and reason.
        // A document without source rows (the sandbox host page) is skipped, so the panel frame is the one described.
        const seen = await panel<string>(`(()=>{if(!document.querySelector('.source'))return null; const row=${row}; if(!row) return 'no row named ${s.label.replace(/'/g, '')}; rows: '+[...document.querySelectorAll('.source .source-name')].map(e=>e.textContent.trim()).join(', ');
          const buttons=[...row.querySelectorAll('button')].map(b=>b.textContent.trim()+(b.disabled?' (disabled)':'')).join(', ');
          const reason=[...row.querySelectorAll('.row-reason, .reason, .muted')].map(e=>e.textContent.trim()).filter(Boolean).join(' / ');
          return 'buttons: '+(buttons||'none')+(reason?'; row says: '+reason:'');})()`, v => typeof v === 'string');
        throw new Error(`${s.label} control /${pattern}/ did not appear${seen ? ` (${seen.slice(0, 240)})` : ''}`, { cause: error });
      }
    };
    // Sources not yet connected are offered as tiles in the Add a source sheet: pick the tile, then press
    // that source's Connect. A build that still lists unconnected sources as rows uses the row's Connect.
    const startConnect = async (s: LiveSourceSpec) => {
      const tile = sourcePick(s);
      const pick = () => panel<boolean>(`(() => {const tile=document.querySelector(${JSON.stringify(tile)}); if(!tile)return false; const d=tile.closest('dialog'); if(d && !d.open) document.querySelector('[data-dialog-open="add-source"]')?.click(); tile.click(); return true;})()`, Boolean);
      if (!await pick()) return sourceAction(s, '^Connect$');
      const setup = `[...document.querySelectorAll('[data-source-setup]')].find(e=>e.getAttribute('data-source-setup').startsWith(${JSON.stringify(`${s.id}.`)}))`;
      const press = () => panel<boolean>(`(() => { const setup=${setup}; const e=setup ? [...setup.querySelectorAll('button')].find(e=>/^Connect$/.test(e.textContent.trim())) : null; if(!e || e.disabled || !(${visible})(e)) return false; e.click(); return true; })()`, Boolean);
      // The sheet's own lock line, plus the page's blocker banner, which names the model in the way.
      const heldBy = () => panel<string>(`(()=>{const setup=${setup}; const own=setup?.querySelector('.blocked')?.textContent?.trim() || ''; const page=document.querySelector('[data-blocker] .name')?.textContent?.trim() || ''; return [own, page && page !== own ? 'page says: ' + page : ''].filter(Boolean).join('; ');})()`, value => typeof value === 'string' && value.length > 0).catch(() => undefined);
      // A fresh install locks Connect until its private models are ready (a multi-GB download). Wait while the
      // product's own progress text keeps changing; fail with that text once it stops moving or the bound passes.
      const deadline = Date.now() + (timings.modelWaitMs ?? 30 * 60_000);
      const stallMs = timings.modelStallMs ?? 5 * 60_000;
      let held: string | undefined;
      let movedAt = Date.now();
      let reloadedAt = Date.now();
      for (;;) {
        if (await press()) return;
        const now = await heldBy();
        if (now !== held) { held = now; movedAt = Date.now(); }
        if (!held && Date.now() - movedAt > (timings.timeoutMs ?? 90_000)) throw new Error(`${s.label} Connect did not appear in the Add a source sheet`);
        if (held && Date.now() - movedAt > stallMs) throw new Error(`${s.label} Connect is held with no progress for ${Math.round(stallMs / 60_000)} min: ${held}`);
        if (Date.now() >= deadline) throw new Error(`${s.label} Connect is still held: ${held ?? 'no reason shown'}`);
        await sleep(timings.pollMs ?? 1000);
        // Reopen the sheet now and then so the held text is the dashboard's latest.
        if (Date.now() - reloadedAt > 60_000) { reloadedAt = Date.now(); await reload('/dashboard?connect', `!!document.querySelector('.srcrows')`); await pick(); }
      }
    };
    const folderRow = (name: string) => `(()=>{
      const row=[...document.querySelectorAll('.frow:not(.jump)')].find(e=>e.querySelector('.fname-text')?.textContent===${JSON.stringify(name)});
      if(!row){ const more=[...document.querySelectorAll('[data-key^="picker:more:"]')].find(e=>!e.disabled&&(${visible})(e));if(more)more.click(); }
      return row;
    })()`;
    const minted = await machine.exec('"$HOME/.local/bin/olympus" dashboard --no-open', { timeoutMs: 60_000 });
    const url = /http:\/\/(?:127\.0\.0\.1|localhost):8010\/[^\s"<>]*/.exec(minted.stdout)?.[0];
    if (minted.code !== 0 || !url) throw new Error('CLI dashboard link unavailable');
    // The browser and OAuth callbacks run on the canary host. CDP alone only forwards browser control.
    if (machine.os === 'linux') stopBridge = await startOwnerBridge(machine, Number(new URL(url).port), timings.bridge?.pidFile ?? FRESH_BRIDGE_PID, timings.bridge ?? {});
    dash = (await browser.send('Target.createTarget', { url: 'about:blank' })).targetId;
    owned.add(dash);
    const session = await attach(dash);
    await browser.send('Page.navigate', { url }, session);
    await until(async () => !!await panel<boolean>(`!!document.querySelector('.source-name, [data-home-status]')`, Boolean), 'dashboard did not open from the CLI link');
    const dashboardView = async (): Promise<{ status: number; view: any }> => {
      const read = await machine.exec(DASHBOARD_JSON, { timeoutMs: 30_000 });
      const lines = read.stdout.trimEnd().split('\n');
      const status = Number(lines.pop()) || 0;
      if (read.code !== 0 || status !== 200) return { status, view: null };
      try { return { status, view: JSON.parse(lines.join('\n')) }; } catch { return { status, view: null }; }
    };
    const card = async (s: LiveSourceSpec): Promise<any> => sourceCard((await dashboardView()).view, s.id);
    const connected = sourceConnected;
    let navigationError = '';
    const navigate = async (path: string): Promise<boolean> => {
      frameSessions.clear();
      const navigation = await browser!.send('Page.navigate', { url: new URL(path, url).href }, session);
      navigationError = navigation.errorText ?? '';
      if (navigation.errorText) return false;
      await until(async () => navigated.get(session) === navigation.loaderId, 'dashboard navigation did not commit');
      return true;
    };
    // Home with no source yet shows only its status card, so either marker means the page drew.
    const reload = async (path = '/dashboard', ready = `!!document.querySelector('.source-name, [data-home-status]')`) => {
      // No retry: a first-run save that takes the page down is a product fault a person would see, so it fails here.
      if (!await navigate(path)) throw new Error(`dashboard navigation to ${path} failed: ${navigationError}`);
      await until(async () => !!await panel<boolean>(ready, Boolean), `dashboard reload of ${path} failed`);
    };
    const timingSource = (folder: SeedFolder): LiveSourceSpec => ({ id: folder.source, label: folder.source === 'dropbox' ? 'Dropbox' : 'Google Drive' });
    const openTimingFolder = async (folder: SeedFolder) => {
      // The seed folder can be minutes old; a picker opened before the provider lists it is opened again.
      for (let attempt = 1; ; attempt++) {
        await reload('/dashboard?connect', `!!document.querySelector('.srcrows')`);
        await sourceAction(timingSource(folder), 'Choose folders|Scope|Edit scope');
        try {
          await until(async () => !!await panel<boolean>(`!!${folderRow(ON_DEMAND_FOLDER)}`, Boolean), 'seed folder did not appear in the dashboard picker');
          return;
        } catch (error) {
          if (attempt < 3) continue;
          const shown = await panel<string[]>(`[...document.querySelectorAll('.frow .fname-text')].map(e=>e.textContent||'').slice(0,20)`, (v: string[]) => Array.isArray(v) && v.length > 0).catch(() => undefined);
          throw new Error(`${timingSource(folder).label}: seed folder did not appear in the dashboard picker after ${attempt} opens${shown ? ` (picker showed ${JSON.stringify(shown)})` : ' (picker showed no folders)'}`, { cause: error });
        }
      }
    };
    /** Every picker row named like the seed folder, with its segments (* pressed, (disabled)). */
    const rowSegments = () => panel<string[][]>(`[...document.querySelectorAll('.frow')].filter(e=>e.querySelector('.fname-text')?.textContent===${JSON.stringify(ON_DEMAND_FOLDER)}).map(row=>[(row.className||'')+'', ...[...row.querySelectorAll('[data-key^="picker:seg:"]')].map(e=>(e.getAttribute('data-key')||'').split(':').pop()+(e.getAttribute('aria-pressed')==='true'?'*':'')+(e.disabled||e.getAttribute('aria-disabled')==='true'?'(disabled)':''))])`, (v: string[][]) => Array.isArray(v) && v.length > 0).catch(() => undefined);
    /** The Save control and any reason line the picker shows, from every frame that has the picker. */
    const saveState = () => panelAll<string>(`(() => {const b=document.querySelector('[data-key="picker:save"]'); if(!b) return undefined; const why=[...document.querySelectorAll('.reason, [role=alert]')].map(e=>(e.textContent||'').trim().slice(0,160)).filter(Boolean).slice(0,3); return (b.disabled?'disabled ':'enabled ')+JSON.stringify((b.textContent||'').trim())+(why.length?' '+JSON.stringify(why):'');})()`, (v) => typeof v === 'string').catch(() => [] as string[]);
    const pressedMode = async (): Promise<FolderMode> => {
      const mode = await panel<string>(`(() => {const row=${folderRow(ON_DEMAND_FOLDER)}; return row ? (row.querySelector('[aria-pressed=true][data-key^="picker:seg:"]')?.getAttribute('data-key')?.split(':').pop() || '') : null;})()`, value => typeof value === 'string');
      if (mode === undefined) throw new Error('folder mode could not be read');
      return mode as FolderMode;
    };
    return {
      folderMode: async folder => {
        await openTimingFolder(folder);
        const mode = await pressedMode();
        await clickKey('picker:cancel');
        return mode;
      },
      setFolderMode: async (folder, mode) => {
        await openTimingFolder(folder);
        const before = await pressedMode();
        if (before === mode) { await clickKey('picker:cancel'); return; }
        // The selected segment toggles off to restore an inherited choice exactly.
        await click(`${folderRow(ON_DEMAND_FOLDER)}?.querySelector('[data-key$=":${mode || before}"]')`);
        // The tap must take before Save, or a refused choice (a disabled segment) reads as "did not persist".
        try {
          await until(async () => (await pressedMode()) === mode, `folder mode ${mode || 'inherited'} was not taken in the picker`, 15_000);
        } catch (error) {
          throw new Error(`folder mode ${mode || 'inherited'} was not taken in the picker (was ${before || 'inherited'}; segments ${JSON.stringify(await rowSegments())})`, { cause: error });
        }
        const beforeSave = await saveState();
        await clickKey('picker:save');
        let unlocked = 0;
        await until(async () => {
          if (await panel<boolean>(`(() => {const e=document.querySelector('[data-unlock-here]'); if(e && !e.disabled && (${visible})(e)){e.click();return true;}return false;})()`, Boolean)) unlocked += 1;
          return !!await panel<boolean>(`!document.querySelector('[data-key="picker:save"]') && !!document.querySelector('.srcrows, .source')`, Boolean);
        }, 'folder mode was not saved');
        // What the page said once the picker closed (the saved line, or a refusal), UI words only.
        const said = await panel<string[]>(`[...document.querySelectorAll('[role=status],[role=alert],.notice,.toast')].filter(${visible}).map(e=>(e.textContent||'').trim().slice(0,160)).filter(Boolean).slice(0,4)`, (v: string[]) => Array.isArray(v) && v.length > 0).catch(() => undefined);
        await openTimingFolder(folder);
        const saved = await pressedMode();
        const shown = saved !== mode ? await rowSegments() : undefined;
        const everyFrame = saved !== mode ? await panelAll<string>(`(() => {const row=[...document.querySelectorAll('.frow:not(.jump)')].find(e=>e.querySelector('.fname-text')?.textContent===${JSON.stringify(ON_DEMAND_FOLDER)}); return row ? (row.querySelector('[aria-pressed=true][data-key^="picker:seg:"]')?.getAttribute('data-key') || 'none') : undefined;})()`, (v) => typeof v === 'string') : [];
        await clickKey('picker:cancel');
        // What the engine stored for the seed folder (test machine, test account: the folder's saved rule only).
        const stored = saved !== mode ? await machine.exec(`for f in $(find "$HOME" -name file-source-scopes.json 2>/dev/null | head -3); do echo "$f"; grep -i -B1 -A3 ${JSON.stringify(JSON.stringify(ON_DEMAND_FOLDER.toLowerCase()).slice(1, -1))} "$f" | tr -s ' \n' ' ' | cut -c1-600; echo; done`, { timeoutMs: 30_000 }).then(r => r.stdout.trim().slice(0, 1500)).catch((e: unknown) => `unread: ${String(e).slice(0, 120)}`) : '';
        if (saved !== mode) throw new Error(`folder mode did not persist: expected ${mode || 'inherited'}, saw ${saved || 'inherited'} (rows ${JSON.stringify(shown)}; after save the page said ${JSON.stringify(said)}; unlock pressed ${unlocked}x; save before click ${JSON.stringify(beforeSave)}; pressed per frame ${JSON.stringify(everyFrame)}; stored ${JSON.stringify(stored)})`);
      },
      sync: async folder => {
        await reload('/dashboard?connect', `!!document.querySelector('.srcrows')`);
        await sourceAction(timingSource(folder), '^Sync now$');
        // Sync now acknowledges immediately. Wait for its disabled Checking control to settle before timing archive reads.
        await until(async () => !!await panel<boolean>(`(() => {const row=[...document.querySelectorAll('.source')].find(e=>e.querySelector('.source-name')?.textContent?.trim()===${JSON.stringify(timingSource(folder).label)});return !!row && !row.querySelector('button[aria-busy=true]') && [...row.querySelectorAll('button')].some(e=>/^Sync now$/.test(e.textContent.trim()));})()`, Boolean), 'seed metadata sync did not finish');
      },
      prepareRead: async (name, requireUnread = true) => {
        await reload('/dashboard?privacy-items', `!!document.querySelector('[data-privacy-items]')`);
        await until(async () => {
          if (await panel<boolean>(`!!document.querySelector('[data-pi-search]')`, Boolean)) return true;
          await panel<boolean>(`(() => {const e=document.querySelector('form[data-pi-unlock] button'); if(e && !e.disabled){e.click();return true;}return false;})()`, Boolean);
          return false;
        }, 'Your items did not unlock');
        await until(async () => !!await panel<boolean>(`(() => {
          const row=[...document.querySelectorAll('[data-pi-item]')].find(e=>e.querySelector('.pititle')?.textContent?.trim()===${JSON.stringify(name)});
          if(row){row.click();return true;}
          const e=document.querySelector('[data-pi-search]'); if(e){e.value=${JSON.stringify(name)}; e.dispatchEvent(new Event('input',{bubbles:true}));}return false;
        })()`, Boolean), 'seed file did not appear in Your items');
        if (requireUnread) await until(async () => !!await panel<boolean>(`!!document.querySelector('[data-pi-detail] [data-pi-read]:not(:disabled)')`, Boolean), 'file is not names-only (Read this file unavailable)');
        return async () => {
          await click(`document.querySelector('[data-pi-detail] [data-pi-read]')`);
          let said = '';
          await until(async () => {
            said = await panel<string>(`document.querySelector('[data-pi-detail] [data-pi-read]')?.textContent || ''`, value => typeof value === 'string' && value !== 'Read this file') ?? '';
            return !!said;
          }, 'Read this file returned no message');
          return said;
        };
      },
      privacyChoice: async () => {
        const recommended = PRIVATE_ANSWER_OPTIONS.find(option => option.recommended)!;
        await reload('/dashboard?keys', `!!document.querySelector('form[data-first-run-privacy]')`);
        await click(`(()=>{const e=document.querySelector('form[data-first-run-privacy] input[value="${recommended.id}"]');return e?.closest('label')?.textContent.includes('Recommended')?e:null;})()`);
        await click(`document.querySelector('button[form="first-run-privacy-choice"]')`);
        // The normal form handler disables the answered choice only after the engine saves it.
        try {
          // A dashboard opened from the CLI link is not yet a local session: the product offers
          // "Unlock on this computer" and resends the form after it, as a person would press it.
          await until(async () => {
            if (await panel<boolean>(`!!document.querySelector('form[data-first-run-privacy] input:checked:disabled')`, Boolean)) return true;
            await panel<boolean>(`(() => { const e=document.querySelector('form[data-first-run-privacy] [data-unlock-here], [data-first-run-sheet] [data-unlock-here]'); if(!e || e.disabled || !(${visible})(e)) return false; e.click(); return true; })()`, Boolean);
            return false;
          }, 'first-run privacy choice was not saved');
        } catch (error) {
          // The form's status line is the product's own copy, which is what a person would read.
          // The form lives in the panel frame; the host document answers '' and must not end the search.
          const said = await panel<string>(`document.querySelector('form[data-first-run-privacy] [data-action-message]')?.textContent?.trim() ?? ''`, value => typeof value === 'string' && value.length > 0).catch(() => undefined);
          throw new Error(said ? `first-run privacy choice was not saved: the dashboard said "${said}"` : `${(error as Error).message} (the dashboard showed no message)`);
        }
        // Stay in the walkthrough for the separate, explicit judge approval.
        // A local-first answer choice alone never approves Venice judging.
        await click(`document.querySelector('[data-first-run-sheet] [data-setup-next]')`);
        const judgeShown = !!await panel<boolean>(`(() => { const sheet=document.querySelector('[data-first-run-sheet]'); if(!sheet) return null; const e=sheet.querySelector('form[data-first-run-judge]'); return !!e && !e.closest('[data-setup-panel]').hidden; })()`, value => typeof value === 'boolean');
        // Venice when this install can use it; a machine without a Venice key gets the dashboard's
        // own refusal, and the leg then saves "This computer", naming both in the detail.
        let judgeChoice = 'not shown';
        const saveJudge = async (choice: 'venice' | 'local') => {
          await click(`document.querySelector('form[data-first-run-judge] input[value="${choice}"]')`);
          await click(`document.querySelector('button[form="first-run-judge-form"]')`);
          try {
            await until(async () => !!await panel<boolean>(`(() => { const e=document.querySelector('[data-first-run-sheet] [data-model-check]'); return !!e && !e.closest('[data-setup-panel]').hidden; })()`, Boolean), 'first-run privacy check choice was not saved');
            return undefined;
          } catch (error) {
            const said = await panel<string>(`document.querySelector('form[data-first-run-judge] [data-action-message]')?.textContent?.trim() ?? ''`, value => typeof value === 'string' && value.length > 0).catch(() => undefined);
            return said ? `the dashboard said "${said}"` : (error as Error).message;
          }
        };
        if (judgeShown) {
          const refused = await saveJudge('venice');
          if (refused === undefined) judgeChoice = 'Venice (venice) saved';
          else {
            const local = await saveJudge('local');
            if (local !== undefined) throw new Error(`first-run privacy check choice was not saved: Venice: ${refused}; this computer: ${local}`);
            judgeChoice = `This computer (local) saved after Venice was refused: ${refused}`;
          }
        }
        // Saving restarts the worker. Retry fresh documents across that handoff;
        // only the applied policy, never the submitted radio's state, proves persistence:
        // the engine's own setup status must no longer report the choice pending (every
        // release renders it), and a build that shows the answer mode must show this one.
        await until(async () => await navigate('/dashboard?keys') && !!await panel<boolean>(`(() => { const s=document.querySelector('[data-model-setup-status]'); if(!s || document.querySelector('form[data-first-run-privacy]')) return false; let view; try { view=JSON.parse(s.dataset.modelSetupStatus); } catch { return false; } if(view.privacy_choice_pending) return false; const shown=document.querySelector('[data-answer-mode]'); return !shown || shown.getAttribute('data-answer-mode')===${JSON.stringify(recommended.id)}; })()`, Boolean), 'first-run privacy choice did not persist after reload');
        await reload();
        return `${recommended.label} (${recommended.id}, Recommended) saved and verified after reload; privacy check: ${judgeChoice}`;
      },
      connection: async s => {
        await reload('/dashboard?connect', `!!document.querySelector('.srcrows')`);
        const { status, view } = await dashboardView();
        if (!view) throw new Error(`source cards unreadable: HTTP ${status}`);
        const c = sourceCard(view, s.id);
        if (connected(c)) return 'connected';
        // An unconnected source is offered as a tile in the Add a source sheet (older builds: a row with Connect).
        return await panel<boolean>(`(() => {if(document.querySelector(${JSON.stringify(sourcePick(s))}))return true;const row=[...document.querySelectorAll('.source')].find(e=>e.querySelector('.source-name')?.textContent?.trim()===${JSON.stringify(s.label)});if(!row)return null;return [...row.querySelectorAll('button')].some(e=>/^Connect$/.test(e.textContent.trim()));})()`, value => typeof value === 'boolean') ? 'web' : 'unavailable';
      },
      connect: async s => {
        // Say which precondition failed, from the dashboard's own JSON: provider names and states only.
        const { status, view } = await dashboardView();
        const before = sourceCard(view, s.id);
        if (!view) throw new Error(`fresh source card unreadable: /dashboard.json answered ${status || 'nothing'}`);
        if (!before) throw new Error(`no ${s.id} source card; the dashboard lists: ${(view.sources ?? []).map((c: any) => String(c.provider)).join(', ') || 'none'}`);
        if (connected(before)) throw new Error(`${s.id} is already connected (${String(before.connection?.state)}) on a fresh install`);
        await reload('/dashboard?connect', `!!document.querySelector('.srcrows')`);
        baseline.clear();
        for (const t of (await browser!.send('Target.getTargets')).targetInfos) baseline.add(t.targetId);
        windowOffered = false;
        await startConnect(s);
        // A remembered grant can redirect at once and finish between polls; the callback check verifies completion.
        await until(async () => { const c = await card(s); return c?.connection?.state === 'awaiting_consent' || (!!c && connected(c)); }, 'source card did not enter awaiting_consent or connect');
      },
      consent: async s => {
        const deadline = Date.now() + 180_000;
        let providerSeen = false;
        let openedOffer = false;
        while (Date.now() < deadline) {
          const { targetInfos } = await browser!.send('Target.getTargets');
          // Only tabs descended from this run's dashboard belong to this consent flow.
          for (const t of targetInfos) {
            // Chromium strips openerId for the product's noopener OAuth window. Only new consent windows
            // after this dashboard's windowOpen offer are eligible; existing account tabs are untouched.
            if (t.openerId && owned.has(t.openerId) || windowOffered && !baseline.has(t.targetId) && /^https?:\/\/(accounts\.google\.com|(?:www\.)?dropbox\.com|auth\.olympusplugin\.ai|127\.0\.0\.1:8010|localhost:8010)\//.test(t.url)) owned.add(t.targetId);
            if (owned.has(t.targetId)) observeCallback(t.url);
          }
          if (!openedOffer && !providerSeen && !targetInfos.some((t: any) => owned.has(t.targetId) && !baseline.has(t.targetId))) {
            openedOffer = !!await panel<boolean>(`(()=>{const e=document.querySelector('a[data-open-offer-link]'); if(!e || !(${visible})(e))return false; e.click();return true;})()`, Boolean);
          }
          for (const t of targetInfos.filter((t: any) => owned.has(t.targetId) && t.type === 'page')) {
            if (!/^https:\/\/(accounts\.google\.com|(?:www\.)?dropbox\.com)\//.test(t.url)) continue;
            providerSeen = true;
            const sid = await attach(t.targetId);
            const snap = await evalIn<ConsentSnapshot>(sid, `(()=>{const v=${visible}; const text=document.body?.innerText||''; return {url:location.href,text,password:[...document.querySelectorAll('input[type=password]')].some(v),accounts:[...document.querySelectorAll('[data-identifier]')].filter(v).length,signedOut:[...document.querySelectorAll('input[type=email],input[name=login_email]')].some(v)};})()`).catch(() => undefined);
            if (!snap) continue;
            const blocked = consentBlock(snap);
            if (blocked) throw new FreshInconclusive(`renew ${s.id === 'gmail' || s.id === 'google_drive' ? 'Google' : 'Dropbox'} sign-in in zig’s canary Chromium: ${blocked}`);
            await evalIn(sid, `(()=>{const v=${visible};const controls=[...document.querySelectorAll('button,a,[role=button]')].filter(v);const e=controls.find(e=>/^(Advanced|Go to .+\\(unsafe\\)|Continue|Allow|Agree|Accept)$/i.test(e.textContent.trim())) || ( ${snap.accounts === 1} ? document.querySelector('[data-identifier]') : null); if(e&&!e.disabled)e.click();})()`).catch(() => {});
          }
          if (providerSeen && connected(await card(s).catch(() => null))) return;
          // Some providers remember consent and immediately redirect. A connected persisted card proves that path too.
          if (connected(await card(s).catch(() => null))) return;
          await sleep(1000);
        }
        throw new Error('provider consent did not complete within the bound');
      },
      callback: async s => {
        await until(async () => {
          const { targetInfos } = await browser!.send('Target.getTargets');
          for (const t of targetInfos) if (owned.has(t.targetId)) observeCallback(t.url);
          return (callbacks.has(s.id) || s.id === 'google_drive' && callbacks.has('google-drive') || ['gmail', 'google_drive'].includes(s.id) && callbacks.has('google')) && connected(await card(s));
        }, 'OAuth callback did not land and leave a connected source card');
      },
      scope: async s => {
        await reload();
        await sourceAction(s, 'Choose (mail|folders)|Scope|Edit scope');
        if (s.id === 'gmail') {
          // Gmail's mail picker uses exclusion labels: retain the named label and deselect all other listed labels.
          const choose = `(()=>{const labels=[...document.querySelectorAll('input[data-key^="picker:label:"]')]; const chosen=labels.find(e=>e.closest('label')?.querySelector('.opt-text > span')?.textContent===${JSON.stringify(s.fresh!.scope)}); if(!chosen)return false; for(const e of labels){const want=e===chosen;if(e.checked!==want){e.click();return false;}} return true;})()`;
          await until(async () => !!await panel<boolean>(choose, Boolean), 'Gmail scope label unavailable');
        } else {
          // Folder names may be paths: descend by the picker's own folder controls.
          const parts = s.fresh!.scope.split('/').filter(Boolean);
          for (let i = 0; i < parts.length; i++) {
            const row = folderRow(parts[i]!);
            await click(i === parts.length - 1 ? `${row}?.querySelector('[data-key$=":ingest"]')` : `${row}?.querySelector('[data-key^="picker:open:"]')`);
          }
        }
        await clickKey('picker:save');
        await until(async () => (await card(s))?.scope_selection?.status === 'approved', 'scope was not saved');
        await reload();
        await sourceAction(s, 'Choose (mail|folders)|Scope|Edit scope');
        // Reopening the picker after a full reload reads saved scope from the engine.
        if (s.id === 'gmail') {
          await until(async () => !!await panel<boolean>(`(()=>{const a=[...document.querySelectorAll('input[data-key^="picker:label:"]')];return a.length>0&&a.filter(e=>e.checked).length===1&&a.some(e=>e.checked&&e.closest('label')?.querySelector('.opt-text > span')?.textContent===${JSON.stringify(s.fresh!.scope)});})()`, Boolean), 'Gmail scope changed after reload');
        } else {
          // Saved selections also appear in the picker's rule summary, including nested paths.
          const parts = s.fresh!.scope.split('/').filter(Boolean);
          await until(async () => !!await panel<boolean>(`!!document.querySelector('[data-key="picker:seg:@account:ingest"][aria-pressed=false]')`, Boolean), 'Dropbox scope unexpectedly includes the whole account');
          for (const part of parts.slice(0, -1)) await click(`${folderRow(part)}?.querySelector('[data-key^="picker:open:"]')`);
          const leaf = parts.at(-1)!;
          await until(async () => !!await panel<boolean>(`!!${folderRow(leaf)}?.querySelector('[data-key$=":ingest"][aria-pressed=true]')`, Boolean), 'Dropbox scope changed after reload');
        }
        await clickKey('picker:cancel');
      },
      indexed: async s => { const c = await card(s); return connected(c) ? Number(c.coverage?.indexed_items ?? 0) : 0; },
      saveAnswerModel: async want => {
        await reload('/dashboard?keys', `!!document.querySelector('form[data-model-choice]')`);
        const pick = `(() => {
          const want=${JSON.stringify(want ?? null)};
          const forms=[...document.querySelectorAll('form[data-model-choice]')].filter(f=>f.querySelectorAll('input[name=model][type=radio]').length>0);
          for (const form of forms) {
            const provider=form.querySelector('input[name=provider]')?.value||'';
            if (want && provider!==want.provider) continue;
            const radios=[...form.querySelectorAll('input[name=model][type=radio]')];
            const current=radios.find(r=>r.checked);
            const next=want ? radios.find(r=>r.value===want.model) : radios.find(r=>!r.checked);
            if (!next || next.disabled) continue;
            next.checked=true;
            form.requestSubmit();
            return JSON.stringify({provider, from: current?.value||'', to: next.value});
          }
          return 'no picker with another model: ' + forms.map(f=>(f.querySelector('input[name=provider]')?.value||'?')+' '+f.querySelectorAll('input[name=model][type=radio]').length).join(', ');
        })()`;
        const said = await panel<string>(pick, (value) => typeof value === 'string' && value.startsWith('{'))
          ?? await panel<string>(pick, (value) => typeof value === 'string');
        if (!said?.startsWith('{')) throw new Error(`answer model could not be changed: ${said ?? 'no Privacy settings page'}`);
        return JSON.parse(said) as { provider: string; from: string; to: string };
      },
      close: cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}
