/**
 * The headless browser the in-machine agent drives over the Chrome DevTools Protocol (no browser-automation library: the machine has
 * Chrome and the Bun runtime the engine ships, nothing else). Shared by the dashboard screenshots, the Inbox leg and the journeys.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const WORKDIR = join(homedir(), 'rc');

export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  /** Calls `handler` with the parameters of each event of this method the browser sends. */
  on(method: string, handler: (params: any) => void): void;
  close(): void;
}

export async function cdpConnect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('cdp connect failed')); });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const listeners = new Map<string, Array<(params: any) => void>>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: { message: string }; method?: string; params?: any };
    if (message.id === undefined) {
      if (message.method) for (const handler of listeners.get(message.method) ?? []) handler(message.params);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    on: (method, handler) => { listeners.set(method, [...(listeners.get(method) ?? []), handler]); },
    close: () => ws.close(),
  };
}

export function findBrowser(): string | undefined {
  if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return existsSync(chrome) ? chrome : undefined;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return undefined;
}

/**
 * What keeps the browser from opening connections of its own. The rule "MAP * ~NOTFOUND" rewrites every host the browser is asked for,
 * IP literals included, so the loopback addresses the dashboard is served on must be excluded by name or the page itself would not load.
 */
export const ISOLATED_BROWSER_FLAGS: readonly string[] = [
  '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--no-pings', '--disable-domain-reliability',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
];

export interface OpenedBrowser { cdp: Cdp; pid: number | undefined; close(): void }

/** A headless browser on a throwaway profile, and a debugging connection to its one page. */
export async function openBrowser(browser: string, profileName: string, debugPort: number, isolated = false): Promise<OpenedBrowser> {
  const profile = join(WORKDIR, profileName);
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(browser, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    // A throwaway profile must not ask the desktop session's keychain for a browser-storage key.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : []),
    // The Inbox check watches the machine's connections, so the browser must make none of its own: no background services, and no
    // name but this machine's can be resolved (the dashboard is an address, not a name).
    ...(isolated ? ISOLATED_BROWSER_FLAGS : []),
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let wsUrl: string | undefined;
    for (let i = 0; i < 60 && !wsUrl; i += 1) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch { /* browser starting */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('the browser did not open a debugging page');
    const cdp = await cdpConnect(wsUrl);
    return { cdp, pid: chrome.pid, close: () => { cdp.close(); chrome.kill('SIGKILL'); } };
  } catch (error) {
    chrome.kill('SIGKILL');
    throw error;
  }
}

