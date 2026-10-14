/** Linux browser transport. The Unix socket remains the authority; TCP never
 * trusts headers as owner identity. Cookies need a separate origin-storage
 * proof because HTTP cookies are shared across ports. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateWorkerSocket, type WorkerTransportOptions } from './worker-transport.ts';
import { openLinuxOwnerTicketFile } from './linux-desktop-opener.ts';
import { readBoundedRequestText } from '../workers/remote-request-body.ts';

const COOKIE = 'olympus_desktop_owner';
const PROOF_HEADER = 'X-Olympus-Owner-Proof';
const FORM_PROOF = '_olympus_owner_proof';
const STORAGE = 'olympus-desktop-owner-v1';
const TICKET_MS = 60_000;
const SESSION_MS = 12 * 60 * 60 * 1000;
export const DESKTOP_OWNER_OPEN_PATH = '/desktop-owner/open';
export const DESKTOP_BRIDGE_REMEDY = 'Use the owner-authenticated SSH socket forward on a trusted browser computer. Never substitute the fixed entry origin for the session origin.';
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'";

export function randomOwnerHostname(): string {
  const bytes = randomBytes(16);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; text += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) text += alphabet[(value << (5 - bits)) & 31];
  return `${text}.localhost`;
}
const secret = () => randomBytes(32).toString('base64url');
function equal(a: string | undefined | null, b: string): boolean {
  return typeof a === 'string' && /^[A-Za-z0-9_-]+$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function boundedBody(request: Request, limit: number): Promise<string> {
  const result = await readBoundedRequestText(request, limit, { deadlineMs: 5_000 });
  if (!result.ok) throw new Error('Body refused.');
  return result.text;
}
function page(body: string, status = 200): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Olympus owner confirmation</title></head><body>${body}</body></html>`, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  } });
}
/** Constant response: no bootstrap, cookie, ticket or origin-storage proof. */
function restarting(): Response {
  const response = page(`${openingView().replace('Opening your dashboard…', 'Olympus is restarting…')}<script>setTimeout(()=>location.reload(),1000)</script>`, 503);
  response.headers.set('Retry-After', '1');
  return response;
}
function refusal(status = 403): Response {
  const response = page(`<p>This Olympus window is out of date, usually because Olympus restarted. Close it and open Olympus again.</p>`, status);
  response.headers.set('X-Olympus-Owner-Refused', '1');
  return response;
}
function safeTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16_384 && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\x00-\x20\x7f]/.test(value) && !value.startsWith('/owner-') && !value.startsWith(DESKTOP_OWNER_OPEN_PATH);
}

// Every new navigation starts with a content-free shell. Only this origin's
// storage plus the HttpOnly cookie can fetch the real document. Browser fetch
// must never carry the proof on a redirect to an OAuth client's callback.
const BOOTSTRAP = `<script>(function(){
const key=${JSON.stringify(STORAGE)}, header=${JSON.stringify(PROOF_HEADER)}, field=${JSON.stringify(FORM_PROOF)};
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
 const url=new URL(input instanceof Request?input.url:input,location.href);
 if(url.origin!==location.origin)return nativeFetch(input,init);
 const opts=Object.assign({},init||{}), headers=new Headers(opts.headers||(input instanceof Request?input.headers:undefined));
 const proof=localStorage.getItem(key);if(proof)headers.set(header,proof);
 opts.headers=headers;opts.redirect='manual';
 const response=await nativeFetch(input,opts);
 const destination=response.headers.get('X-Olympus-Owner-Location');
 if(destination){location.replace(destination);throw new Error('Navigating');}
 return response;
};
document.addEventListener('submit',function(event){
 const form=event.target;if(!(form instanceof HTMLFormElement))return;
 if(new URL(form.action,location.href).origin!==location.origin){event.preventDefault();return;}
 if(form.method.toLowerCase()!=='post')return;
 let input=form.querySelector('input[name="'+field+'"]');if(!input){input=document.createElement('input');input.type='hidden';input.name=field;form.appendChild(input);}
 input.value=localStorage.getItem(key)||'';
},true);
})();</script>`;

function documentPolicy(policy: string | null): string {
  const hash = "'sha256-" + createHash('sha256').update(BOOTSTRAP.slice(8, -9)).digest('base64') + "'";
  const directives = (policy ?? CSP).split(';').map(s => s.trim()).filter(Boolean);
  // A hash would disable unsafe-inline and break the dashboard's sandboxed
  // srcdoc panel, which intentionally shares the original inline policy.
  const needsHash = (list: string) => !list.includes("'unsafe-inline'") || /'(sha256|sha384|sha512|nonce)-/.test(list);
  const withHash = (list: string) => ['script-src', ...list.split(/\s+/).filter(s => s && s !== "'none'"), hash].join(' ');
  const index = directives.findIndex(s => /^script-src(\s|$)/.test(s));
  if (index >= 0) {
    if (needsHash(directives[index]!)) directives[index] = withHash(directives[index]!.slice('script-src'.length));
  } else {
    // Without script-src, scripts follow default-src, or nothing at all. A
    // bare hash here would forbid every inline script the page was allowed
    // (the Agents page's controls went dead), so extend the fallback instead.
    const fallback = directives.find(s => /^default-src(\s|$)/.test(s));
    if (fallback && needsHash(fallback)) directives.push(withHash(fallback.slice('default-src'.length)));
  }
  return directives.filter(s => !/^worker-src(\s|$)/.test(s)).join('; ') + "; worker-src 'none'";
}
/** The same policy as a <meta> element, without the directives browsers ignore there. */
function metaPolicy(policy: string): string {
  return policy.split('; ').filter(s => !/^(frame-ancestors|report-uri|report-to|sandbox)(\s|$)/.test(s)).join('; ');
}
function attribute(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }

function confirmation(): Response {
  return page(`<h1>Confirm it's you on this computer</h1><p id="message">Open the private owner ticket in your desktop browser.</p><button id="confirm">Confirm it's you</button>${BOOTSTRAP}<script>
(async function(){
 const message=document.getElementById('message');
 document.getElementById('confirm').onclick=async function(){
  try{const r=await fetch('/owner-open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:location.pathname+location.search+location.hash})});
  message.textContent=r.ok?'A private ticket was opened in your desktop browser. Return to it to continue.':'Unable to open the private ticket. Wait a moment and retry, or use the owner SSH socket forward.';}catch{message.textContent='Owner confirmation unavailable. Use the owner SSH socket forward.';}
 };
 if(!localStorage.getItem(${JSON.stringify(STORAGE)}))return;
 try{const r=await fetch(location.pathname+location.search);if(!r.ok&&r.status!==503)return;
 const html=await r.text();document.open();document.write(html);document.close();}catch{}
})();</script>`);
}
// The private file is the first view of the SAME Olympus window, not a
// disposable owner-check popup. Keep its opening state across the origin hop.
function openingView(): string {
  return `<meta name="viewport" content="width=device-width, initial-scale=1"><style>
html{color-scheme:light dark;background:#faf9f6;color:#24231f;font:16px system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(32rem,calc(100vw - 4rem))}h1{font-size:2rem;font-weight:600;margin:0 0 1rem}p{line-height:1.6} @media(prefers-color-scheme:dark){html{background:#171715;color:#efeee8}}
</style><main><h1>Olympus</h1><p id="message" role="status">Opening your dashboard…</p></main>`;
}
function proofPage(): Response {
  const response = page(`${openingView()}<script>
(async function(){
 const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);
 if(!ticket){document.getElementById('message').textContent='Open Olympus from the desktop command, or confirm from the requesting page.';return;}
 try{let r;do{r=await fetch('/owner-proof',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});if(r.status===503&&r.headers.has('Retry-After'))await new Promise(resolve=>setTimeout(resolve,1000));else break;}while(true);
 if(!r.ok)throw new Error();const result=await r.json();localStorage.setItem(${JSON.stringify(STORAGE)},result.proof);
 // Render the requested document in this window. The proof stays at this
 // origin. The bridge header policy and worker meta policy constrain this view;
 // header-only worker CSP directives cannot be carried through document.write.
 const documentResponse=await fetch(result.target,{redirect:'error',headers:{${JSON.stringify(PROOF_HEADER)}:result.proof}});
 const destination=documentResponse.headers.get('X-Olympus-Owner-Location');
 if(destination){location.replace(destination);return;} // ordinary navigation, without a proof header
 if(!documentResponse.ok||!documentResponse.headers.get('Content-Type')?.includes('text/html'))throw new Error();
 const html=await documentResponse.text();history.replaceState(null,'',result.target);document.open();document.write(html);document.close();
 }catch{document.getElementById('message').textContent='This private ticket expired or was refused. Run olympus dashboard again. Use the owner SSH socket forward if this browser cannot resolve the session origin.';}
})();</script>`);
  // The private file probes browser resolution before navigating. No owner
  // data, cookie or secret is returned by this GET; file origins are opaque.
  response.headers.set('Access-Control-Allow-Origin', '*');
  return response;
}

export interface LinuxOwnerBridgeOptions {
  port: number;
  socketPath: string;
  transport?: WorkerTransportOptions;
  ready: () => boolean;
  /** Host keeps the listener and epoch while its worker is unavailable. */
  workerReady?: () => boolean;
  fetchSocket: (request: Request) => Promise<Response>;
  openFile?: (path: string) => Promise<void>;
  /** Called only after the private single-use owner ticket is consumed. */
  establishDashboard?: () => Promise<readonly string[]>;
  now?: () => number;
}
interface Ticket { value: string; target: string; path: string; expires: number }
interface Session { cookieHash: string; proofHash: string; expires: number }
const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
function equalHash(value: string | null | undefined, hash: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && timingSafeEqual(Buffer.from(hashSecret(value), 'hex'), Buffer.from(hash, 'hex'));
}
export class LinuxOwnerBridge {
  readonly hostname: string;
  readonly origin: string;
  readonly entryOrigin: string;
  private ticket: Ticket | undefined;
  private sessions: Session[] = [];
  private lastOpen = -Infinity;
  private closed = false;
  private readonly now: () => number;
  private ticketTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: LinuxOwnerBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.origin = `http://${randomOwnerHostname()}:${options.port}`;
    this.hostname = new URL(this.origin).hostname;
    this.entryOrigin = `http://127.0.0.1:${options.port}`;
  }
  private live(): boolean { return !this.closed && this.options.ready(); }
  close(): void {
    this.closed = true; this.sessions = []; this.clearTicket();
  }
  private clearTicket(): void {
    if (this.ticketTimer) clearTimeout(this.ticketTimer);
    if (this.ticket) { try { unlinkSync(this.ticket.path); } catch {} }
    this.ticket = undefined;
  }
  async openTicket(target: string): Promise<void> {
    if (!safeTarget(target) || !this.live()) throw new Error('Desktop owner confirmation is unavailable.');
    if (this.now() - this.lastOpen < 10_000) throw new Error('Wait ten seconds before opening another owner ticket.');
    this.lastOpen = this.now();
    if (validateWorkerSocket(this.options.transport) !== this.options.socketPath) throw new Error('Owner socket changed.');
    this.clearTicket();
    const value = secret();
    // The filename is independent of the proof. It is the ONLY opener argument.
    const path = join(dirname(this.options.socketPath), `owner-ticket-${randomBytes(16).toString('hex')}.html`);
    const url = `${this.origin}/owner-proof#${value}`;
    const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${this.origin}; worker-src 'none'; base-uri 'none'"><title>Olympus</title>${openingView()}<script>
fetch(${JSON.stringify(this.origin + '/owner-proof')},{mode:'cors',credentials:'omit',redirect:'error',cache:'no-store'}).then(r=>{if(!r.ok)throw new Error();location.replace(${JSON.stringify(url)});}).catch(()=>{document.getElementById('message').textContent=${JSON.stringify('This browser cannot reach the private *.localhost session origin. ' + DESKTOP_BRIDGE_REMEDY)};});</script>`;
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, html); } finally { closeSync(fd); }
    this.ticket = { value, target, path, expires: this.now() + TICKET_MS };
    this.ticketTimer = setTimeout(() => this.clearTicket(), TICKET_MS); this.ticketTimer.unref();
    try {
      await (this.options.openFile ?? openLinuxOwnerTicketFile)(path);
      if (!this.live()) throw new Error('Graphical session ended.');
    } catch (error) { this.clearTicket(); throw error; }
  }
  async handle(request: Request, ownerRequestAdmitted?: () => void): Promise<Response> {
    if (!this.live()) return refusal(503);
    const url = new URL(request.url);
    const host = request.headers.get('host');
    if (request.headers.has('Service-Worker')) return refusal();
    // Entry point is deliberately inert: no body, cookie, script, owner data,
    // or response to any old/random Host. A 303 retains the query verbatim;
    // browsers inherit a fragment when Location has none.
    if (host === new URL(this.entryOrigin).host && url.host === host) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return refusal();
      return new Response(null, { status: 303, headers: { Location: this.origin + url.pathname + url.search,
        'Cache-Control': 'no-store', 'Clear-Site-Data': '"cache", "storage"', 'Content-Security-Policy': "default-src 'none'; worker-src 'none'", 'Referrer-Policy': 'no-referrer' } });
    }
    if (host !== new URL(this.origin).host || url.origin !== this.origin) return refusal(421);
    if (request.headers.has('x-olympus-relay') || ['x-forwarded-host','x-forwarded-for','x-forwarded-proto','forwarded'].some(h => request.headers.has(h))) return refusal();
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if (request.method !== 'GET' && request.method !== 'HEAD' && (origin !== this.origin || (site !== null && site !== 'same-origin'))) return refusal();
    if (this.options.workerReady?.() === false) return restarting();
    if (url.pathname === '/owner-proof' && request.method === 'GET') return proofPage();
    if (url.pathname === '/owner-proof' && request.method === 'POST') {
      let body: { ticket?: string };
      try { body = JSON.parse(await boundedBody(request, 1024)); } catch { return refusal(); }
      const ticket = this.ticket;
      if (!this.live() || !ticket || ticket.expires <= this.now() || !equal(body.ticket, ticket.value)) return refusal();
      this.clearTicket(); // consume before any asynchronous work
      let dashboardCookies: readonly string[];
      try { dashboardCookies = await this.options.establishDashboard?.() ?? []; } catch { return refusal(503); }
      if (!this.live()) return refusal(503);
      const cookie = secret(), proof = secret();
      const session = { cookieHash: hashSecret(cookie), proofHash: hashSecret(proof), expires: this.now() + SESSION_MS };
      this.sessions = [...this.sessions.filter(s => s.expires > this.now()).slice(-14), session];
      const response = Response.json({ proof, target: ticket.target }, { headers: {
        'Set-Cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
        'Cache-Control': 'no-store', 'Clear-Site-Data': '"cache"', 'Content-Security-Policy': CSP,
      } });
      for (const cookie of dashboardCookies) response.headers.append('Set-Cookie', cookie);
      return response;
    }
    if (url.pathname === '/owner-open' && request.method === 'POST') {
      try {
        const body = JSON.parse(await boundedBody(request, 20_000));
        await this.openTicket(body.target);
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      } catch { return refusal(429); }
    }
    // Private control endpoint is NEVER forwarded from TCP, even by an owner.
    if (url.pathname === DESKTOP_OWNER_OPEN_PATH || url.pathname.startsWith('/owner-')) return refusal();
    const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (this.sessions.some(s => s.expires <= this.now())) this.sessions = this.sessions.filter(s => s.expires > this.now()).slice(-15);
    const session = this.sessions.find(s => equalHash(cookie, s.cookieHash));
    let proof = request.headers.get(PROOF_HEADER);
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try { body = await boundedBody(request, 1_048_576); } catch { return refusal(413); }
      if (request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
        const form = new URLSearchParams(body);
        proof ??= form.get(FORM_PROOF); form.delete(FORM_PROOF); body = form.toString();
      }
    }
    if (!session || !equalHash(proof, session.proofHash)) {
      // Only top-level documents receive the content-free confirmation shell.
      if (request.method === 'GET' && !proof && (request.headers.get('accept') ?? '').includes('text/html')) return confirmation();
      return refusal();
    }
    if (!this.live()) return refusal(503);
    // The worker permits long-running owner operations. Only a proven
    // request may disable the TCP idle timeout; public traffic keeps it.
    ownerRequestAdmitted?.();
    // Preserve refusal evidence until AFTER checking browser origin and proof.
    // Internal origin rewriting is confined to this proven owner's socket hop.
    const headers = new Headers(request.headers);
    headers.delete(PROOF_HEADER); headers.delete('content-length');
    headers.set('Host', new URL(this.entryOrigin).host);
    if (origin === this.origin) headers.set('Origin', this.entryOrigin);
    const referer = headers.get('referer');
    if (referer?.startsWith(this.origin + '/')) headers.set('Referer', this.entryOrigin + referer.slice(this.origin.length));
    headers.set('Cookie', (headers.get('cookie') ?? '').split(';').filter(v => !v.trim().startsWith(COOKIE + '=')).join(';'));
    let response: Response;
    try { response = await this.options.fetchSocket(new Request(this.entryOrigin + url.pathname + url.search, {
      method: request.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual',
    })); } catch { return this.live() ? restarting() : refusal(503); }
    if (!this.live()) return refusal(503);
    const outgoing = new Headers(response.headers);
    outgoing.delete('access-control-allow-origin'); outgoing.delete('access-control-allow-credentials');
    outgoing.set('Cache-Control', 'no-store'); outgoing.set('Cross-Origin-Opener-Policy', 'same-origin');
    const policy = documentPolicy(response.headers.get('content-security-policy'));
    outgoing.set('Content-Security-Policy', policy);
    outgoing.set('Referrer-Policy', 'same-origin'); outgoing.set('X-Content-Type-Options', 'nosniff');
    const location = outgoing.get('location');
    if (location) {
      const target = location.startsWith(this.entryOrigin + '/') ? this.origin + location.slice(this.entryOrigin.length) : location;
      // fetch must not follow a redirect with the storage proof. Return an
      // inert destination for the shell; normal form navigation stays native.
      if (request.headers.has(PROOF_HEADER)) {
        outgoing.delete('location'); outgoing.set('X-Olympus-Owner-Location', target);
        return new Response(null, { status: 200, headers: outgoing });
      }
      outgoing.set('Location', target);
    }
    if (outgoing.get('content-type')?.includes('text/html')) {
      outgoing.delete('content-length'); outgoing.delete('content-encoding');
      const html = (await response.text()).replace(/<meta name="referrer" content="no-referrer">/g, '<meta name="referrer" content="same-origin">');
      if (!this.live()) return refusal(503);
      const htmlPolicy = documentPolicy(response.headers.get('content-security-policy'));
      outgoing.set('Content-Security-Policy', htmlPolicy);
      return new Response(html.replace(/<head([^>]*)>/i, `<head$1><meta name="referrer" content="same-origin"><meta http-equiv="Content-Security-Policy" content="${attribute(metaPolicy(htmlPolicy))}">${BOOTSTRAP}`), { status: response.status, headers: outgoing });
    }
    return new Response(response.body, { status: location ? 303 : response.status, headers: outgoing });
  }
}

export type DesktopBridgeStatus = { state: 'listening' | 'restarting' | 'headless' | 'port_in_use' | 'unavailable'; origin?: string; remedy?: string; listener_owner?: 'engine-host' | 'worker' };
/** One epoch per active desktop. Rotation also occurs after logout/relogin,
 * not merely after process restart. No reusePort or hostname fallback. */
export function manageLinuxOwnerBridge(options: LinuxOwnerBridgeOptions & { platform?: string; listenerOwner?: 'engine-host' | 'worker'; listen?: (bridge: LinuxOwnerBridge) => { stop(closeActiveConnections?: boolean): unknown } }) {
  let bridge: LinuxOwnerBridge | undefined;
  let listener: { stop(closeActiveConnections?: boolean): unknown } | undefined;
  let status: DesktopBridgeStatus = { state: 'headless' };
  let closed = false;
  // Revoke before releasing the listener. No epoch is ever persisted/restored.
  const stop = () => {
    bridge?.close(); bridge = undefined;
    listener?.stop(true); listener = undefined;
  };
  const refresh = () => {
    if (closed) return;
    if ((options.platform ?? process.platform) !== 'linux' || !options.ready()) { stop(); status = { state: 'headless' }; return; }
    if (bridge) return;
    const candidate = new LinuxOwnerBridge(options);
    try {
      listener = options.listen ? options.listen(candidate) : Bun.serve({ hostname: '127.0.0.1', port: options.port, fetch: (r, server) => candidate.handle(r, () => server.timeout(r, 0)) });
      bridge = candidate; status = { state: 'listening', origin: bridge.origin, listener_owner: options.listenerOwner ?? 'worker' };
    } catch (error) {
      candidate.close();
      status = { state: (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'port_in_use' : 'unavailable',
        remedy: 'Close the process occupying the configured loopback port, then retry. ' + DESKTOP_BRIDGE_REMEDY };
    }
  };
  refresh();
  const timer = setInterval(refresh, 2_000); timer.unref();
  return {
    refresh,
    status: (): DesktopBridgeStatus => { refresh(); return { ...status, ...(bridge && options.workerReady?.() === false ? { state: 'restarting' as const } : {}) }; },
    async open(target: string): Promise<string> {
      refresh(); if (closed || !bridge) throw new Error(status.remedy ?? DESKTOP_BRIDGE_REMEDY);
      const current = bridge; await current.openTicket(target);
      if (bridge !== current) throw new Error('Desktop session changed.');
      return current.origin;
    },
    close() {
      closed = true; clearInterval(timer);
      stop(); status = { state: 'headless' };
    },
  };
}
