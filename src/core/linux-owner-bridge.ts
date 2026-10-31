/** Linux browser transport. The Unix socket remains the authority; TCP never
 * trusts headers as owner identity. Cookies need a separate origin-storage
 * proof because HTTP cookies are shared across ports. */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { validateWorkerSocket, type WorkerTransportOptions } from './worker-transport.ts';
import { openLinuxOwnerTicketFile } from './linux-desktop-opener.ts';
import { readBoundedRequestText } from '../workers/remote-request-body.ts';

const COOKIE = 'olympus_desktop_owner';
const PROOF_HEADER = 'X-Olympus-Owner-Proof';
const FORM_PROOF = '_olympus_owner_proof';
const STORAGE = 'olympus-desktop-owner-v1';
const TICKET_MS = 60_000;
// A waiting page in another browser: its claim, the code both windows show,
// and the approval id its own browser keeps (same-browser windows need no approval).
const CLAIM_HEADER = 'X-Olympus-Owner-Claim';
const CODE_HEADER = 'X-Olympus-Owner-Code';
const APPROVAL_HEADER = 'X-Olympus-Owner-Approval';
const DECLINED_HEADER = 'X-Olympus-Owner-Declined';
const WAIT_STORAGE = 'olympus-desktop-owner-wait-v1';
const CLAIM_MS = 3 * 60_000;
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
function matchCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // 32 symbols, so each random byte's low five bits pick one without bias.
  const [a, b, c, d, e, f] = [...randomBytes(6)].map(byte => alphabet[byte & 31]);
  return `${a}${b}${c}-${d}${e}${f}`;
}
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
const WORKER_CONFLICT_HEADER = 'X-Olympus-Worker-Conflict';
const restartWords = (conflict?: string | null): string => conflict === 'data' || conflict === 'endpoint'
  ? `Olympus cannot start because another process owns its ${conflict}. Run olympus worker uninstall to remove an older worker service; otherwise stop the competing process. Retrying automatically.`
  : 'Olympus is restarting…';
/** A closed status code, never arbitrary response copy, crosses into the waiting scripts. */
const restartWordsScript = (response: string): string => `(${restartWords.toString()})(${response}.headers.get(${JSON.stringify(WORKER_CONFLICT_HEADER)}))`;
function restarting(conflict?: 'data' | 'endpoint'): Response {
  const response = page(`${openingView().replace('Opening your dashboard…', restartWords(conflict))}<script>setTimeout(()=>location.reload(),1000)</script>`, 503);
  response.headers.set('Retry-After', '1');
  if (conflict) response.headers.set(WORKER_CONFLICT_HEADER, conflict);
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
// An upload's pieces go by XMLHttpRequest (for its progress): same-origin ones carry the proof too. A proven request is
// never redirected (handle() turns its Location into a header), so the proof cannot follow one elsewhere. The proof
// page writes the document into its own window, so this runs twice there: a header set twice is joined, and refused.
const sameOrigin=new WeakSet(), sent=Symbol.for('olympus-owner-proof'), nativeOpen=XMLHttpRequest.prototype.open, nativeSend=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(method,url){
 if(new URL(url,location.href).origin===location.origin)sameOrigin.add(this);else sameOrigin.delete(this);
 return nativeOpen.apply(this,arguments);
};
XMLHttpRequest.prototype.send=function(body){
 const proof=localStorage.getItem(key);if(proof&&sameOrigin.has(this)&&!this[sent]){this[sent]=true;this.setRequestHeader(header,proof);}
 return nativeSend.call(this,body);
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

const BROWSER_OPEN_LIMIT_MESSAGE = 'Too many windows were opened from the browser. Run olympus dashboard in a terminal on this computer.';
/** Which limiter refused a browser open: `hourly` (six an hour) or `recent` (ten seconds). */
const OWNER_LIMIT_HEADER = 'X-Olympus-Owner-Limit';
const BROWSER_OPEN_RECENT_MESSAGE = 'A window was just opened. Look for it, or try again in a few seconds.';
const BROWSER_OPEN_FAILED_MESSAGE = 'Unable to open the private ticket. Run olympus dashboard in a terminal on this computer.';
/** A limiter refusal, as opposed to a failure to open the window. */
class OwnerOpenLimited extends Error {
  constructor(message: string, readonly hourly: boolean) { super(message); }
}

function confirmation(): Response {
  return page(`<h1>Confirm it's you on this computer</h1><p id="message">Open the private owner ticket in your desktop browser.</p><p id="code" hidden></p><button id="confirm">Confirm it's you</button>${BOOTSTRAP}<script>
(async function(){
 const message=document.getElementById('message'), code=document.getElementById('code'), confirm=document.getElementById('confirm'), key=${JSON.stringify(STORAGE)};
 let resuming=false, opening=false, waiting=false, claim='', claiming=false, poll, timeout;
 const stopWaiting=()=>{removeEventListener('storage',onStorage);clearInterval(poll);clearTimeout(timeout);waiting=false;claim='';code.hidden=true;confirm.disabled=opening;};
 async function resume(){
  if(resuming||!localStorage.getItem(key))return;
  resuming=true;
  try{const r=await fetch(location.pathname+location.search);if(!r.ok&&r.status!==503){resuming=false;return;}
   const html=await r.text();stopWaiting();document.open();document.write(html);document.close();
  }catch{resuming=false;}
 }
 function onStorage(event){if(event.key===key)void resume();}
 // An Olympus window in another browser cannot share this page's storage: once
 // the owner approves there (codes matching), the engine hands this claim its own proof.
 async function collect(){
  if(!claim||claiming||resuming)return;
  claiming=true;
  try{const r=await fetch('/owner-claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({claim})});
   if(r.status===202||r.status===503)return;
   if(r.ok){const result=await r.json();localStorage.setItem(key,result.proof);await resume();return;}
   const declined=r.headers.has(${JSON.stringify(DECLINED_HEADER)});stopWaiting();
   message.textContent=declined?"The Olympus window said this wasn't you. Press Confirm it's you to try again.":"This confirmation expired or was replaced. Press Confirm it's you to try again.";
  }catch{}finally{claiming=false;}
 }
 confirm.onclick=async function(){
  if(opening||waiting)return;
  opening=true;confirm.disabled=true;
  try{const r=await fetch('/owner-open',{method:'POST'});
   if(!r.ok){message.textContent=r.status!==429?${JSON.stringify(BROWSER_OPEN_FAILED_MESSAGE)}:r.headers.get(${JSON.stringify(OWNER_LIMIT_HEADER)})==='hourly'?${JSON.stringify(BROWSER_OPEN_LIMIT_MESSAGE)}:${JSON.stringify(BROWSER_OPEN_RECENT_MESSAGE)};return;}
   // A refused replacement must leave the current wait intact. Only a
   // successful open replaces its ticket and starts a fresh 60-second wait.
   stopWaiting();waiting=true;confirm.disabled=true;claim=r.headers.get(${JSON.stringify(CLAIM_HEADER)})||'';
   const approval=r.headers.get(${JSON.stringify(APPROVAL_HEADER)});if(approval)try{localStorage.setItem(${JSON.stringify(WAIT_STORAGE)},approval);}catch{}
   const shown=r.headers.get(${JSON.stringify(CODE_HEADER)});if(shown){code.textContent='If the Olympus window asks, it shows this code: '+shown;code.hidden=false;}
   message.textContent='Approve in the Olympus window that just opened. This page continues by itself.';
   // Check storage after subscribing too: the opener may already have proved.
   addEventListener('storage',onStorage);
   poll=setInterval(()=>{void resume();void collect();},1000);
   timeout=setTimeout(()=>{stopWaiting();message.textContent="This confirmation timed out. Press Confirm it's you to try again.";},${CLAIM_MS});
   await resume();
  }catch{message.textContent=${JSON.stringify(BROWSER_OPEN_FAILED_MESSAGE)};}
  finally{opening=false;confirm.disabled=waiting;}
 };
 await resume();
})();</script>`);
}
// The private file is the first view of the SAME Olympus window, not a
// disposable owner-check popup. Keep its opening state across the origin hop.
function openingView(): string {
  return `<meta name="viewport" content="width=device-width, initial-scale=1"><style>
html{color-scheme:light dark;background:#faf9f6;color:#24231f;font:16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Liberation Sans", "DejaVu Sans", "Helvetica Neue", Arial, system-ui, sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(32rem,calc(100vw - 4rem))}h1{font-size:2rem;font-weight:600;margin:0 0 1rem}p{line-height:1.6} @media(prefers-color-scheme:dark){html{background:#171715;color:#efeee8}}
</style><main><h1>Olympus</h1><p id="message" role="status">Opening your dashboard…</p></main>`;
}
function proofPage(): Response {
  const response = page(`${openingView()}<script>
// A page in another browser asked for this window. Its own browser keeps the
// approval id, so a page in this browser continues by itself with no question.
function approve(request,proof){return new Promise(function(done){
 const wait=${JSON.stringify(WAIT_STORAGE)}, same=()=>{try{return localStorage.getItem(wait)===request.id;}catch{return false;}};
 if(same()){done();return;}
 const panel=document.createElement('div'), text=document.createElement('p'), code=document.createElement('p'), yes=document.createElement('button'), no=document.createElement('button');
 text.textContent="A page in another browser is waiting for you to confirm it's you. Approve only if that page shows this code:";
 code.id='approval-code';code.style.cssText='font-size:1.5rem;font-weight:600;letter-spacing:.1em';code.textContent=request.code;
 yes.id='approve';yes.textContent='Approve';no.id='decline';no.textContent='Not me';no.style.marginLeft='.5rem';
 panel.append(text,code,yes,no);document.querySelector('main').append(panel);
 const message=document.getElementById('message'), opening=message.textContent;message.textContent='Olympus';message.hidden=true;
 const finish=()=>{removeEventListener('storage',onStorage);panel.remove();message.textContent=opening;message.hidden=false;done();};
 function onStorage(event){if(event.key===wait&&same())finish();}
 addEventListener('storage',onStorage);
 const answer=async approved=>{yes.disabled=no.disabled=true;
  try{await fetch('/owner-approve',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',${JSON.stringify(PROOF_HEADER)}:proof},body:JSON.stringify({id:request.id,approve:approved})});}catch{}
  finish();};
 yes.onclick=()=>answer(true);no.onclick=()=>answer(false);
});}
(async function(){
 const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);
 if(!ticket){document.getElementById('message').textContent='Open Olympus from the desktop command, or confirm from the requesting page.';return;}
 try{let r;do{r=await fetch('/owner-proof',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});if(r.status===503&&r.headers.has('Retry-After')){document.getElementById('message').textContent=${restartWordsScript('r')};await new Promise(resolve=>setTimeout(resolve,1000));}else break;}while(true);
 if(!r.ok)throw new Error();const result=await r.json();localStorage.setItem(${JSON.stringify(STORAGE)},result.proof);
 if(result.approval)await approve(result.approval,result.proof);
 // Render the requested document in this window. The proof stays at this
 // origin. The bridge header policy and worker meta policy constrain this view;
 // header-only worker CSP directives cannot be carried through document.write.
 // The ticket is spent now, so a worker restart here must wait, not fail.
 let documentResponse;do{documentResponse=await fetch(result.target,{redirect:'error',headers:{${JSON.stringify(PROOF_HEADER)}:result.proof}});if(documentResponse.status===503&&documentResponse.headers.has('Retry-After')){document.getElementById('message').textContent=${restartWordsScript('documentResponse')};await new Promise(resolve=>setTimeout(resolve,1000));}else break;}while(true);
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
  /** Set by the engine host only, from its own supervised worker diagnosis. */
  workerConflict?: () => 'data' | 'endpoint' | undefined;
  fetchSocket: (request: Request) => Promise<Response>;
  openFile?: (path: string) => Promise<void>;
  /** Called under an exclusive private-ticket claim. Null is a final refusal;
   * throw for a transient transport failure or worker 503 so the claim retries. */
  establishDashboard?: () => Promise<readonly string[] | null>;
  now?: () => number;
}
interface Ticket { value: string; challenge: string; target: string; path: string; expires: number; claimed?: boolean; timer?: ReturnType<typeof setTimeout> }
interface Session { cookieHash: string; proofHash: string; expires: number }
/** The browser lane's one waiting page: approved in an Olympus window, then collected once by its claim. */
interface Claim { hash: string; code: string; approvalId: string; ticket: Ticket; expires: number; state: 'waiting' | 'asked' | 'approved' | 'declined'; collecting?: boolean }
const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
function equalHash(value: string | null | undefined, hash: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && timingSafeEqual(Buffer.from(hashSecret(value), 'hex'), Buffer.from(hash, 'hex'));
}
export class LinuxOwnerBridge {
  readonly hostname: string;
  readonly origin: string;
  readonly entryOrigin: string;
  private tickets = new Map<'control' | 'browser', Ticket>();
  private sessions: Session[] = [];
  private claim: { secret: string; record: Claim } | undefined;
  private lastBrowserOpen = -Infinity;
  private browserOpens: number[] = [];
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: LinuxOwnerBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.origin = `http://${randomOwnerHostname()}:${options.port}`;
    this.hostname = new URL(this.origin).hostname;
    this.entryOrigin = `http://127.0.0.1:${options.port}`;
  }
  private live(): boolean { return !this.closed && this.options.ready(); }
  close(): void {
    this.closed = true; this.sessions = []; this.claim = undefined; this.clearTicket();
  }
  private clearTicket(ticket?: Ticket): void {
    for (const [lane, current] of this.tickets) {
      if (ticket && current !== ticket) continue;
      if (current.timer) clearTimeout(current.timer);
      try { unlinkSync(current.path); } catch {}
      this.tickets.delete(lane);
    }
  }
  async openTicket(target: string, lane: 'control' | 'browser' = 'control'): Promise<void> {
    if (!safeTarget(target) || !this.live()) throw new Error('Desktop owner confirmation is unavailable.');
    // The owner's own opens (the launcher, an olympus:// link, olympus dashboard) come over the owner socket and are never
    // refused: a link pressed just after the launcher used to do nothing at all. A newer ticket replaces the pending one.
    if (lane === 'control') return this.launchTicket(target, lane);
    // The unauthenticated Confirm button is bounded, so another account cannot flood the owner's screen with windows.
    // The hourly cap is checked first: when both limits apply, it decides the real wait.
    const openedAt = this.now(), previousOpen = this.lastBrowserOpen;
    this.browserOpens = this.browserOpens.filter(time => time > openedAt - 60 * 60 * 1000);
    if (this.browserOpens.length >= 6) throw new OwnerOpenLimited('Wait before opening another owner ticket.', true);
    if (openedAt - this.lastBrowserOpen < 10_000) throw new OwnerOpenLimited('Wait ten seconds before opening another owner ticket.', false);
    this.browserOpens.push(openedAt);
    this.lastBrowserOpen = openedAt;
    try {
      await this.launchTicket(target, lane);
    } catch (error) {
      // No window opened, so the attempt counts toward neither limiter.
      if (this.lastBrowserOpen === openedAt) this.lastBrowserOpen = previousOpen;
      const index = this.browserOpens.lastIndexOf(openedAt);
      if (index >= 0) this.browserOpens.splice(index, 1);
      throw error;
    }
  }
  private async launchTicket(target: string, lane: 'control' | 'browser'): Promise<void> {
    if (validateWorkerSocket(this.options.transport) !== this.options.socketPath) throw new Error('Owner socket changed.');
    const previous = this.tickets.get(lane);
    if (previous) this.clearTicket(previous);
    const value = secret(), challenge = secret();
    const answer = createHmac('sha256', value).update(challenge).digest('base64url');
    // The filename is independent of the proof. It is the ONLY opener argument.
    const path = join(dirname(this.options.socketPath), `owner-ticket-${randomBytes(16).toString('hex')}.html`);
    const url = `${this.origin}/owner-proof#${value}`;
    const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${this.origin}; worker-src 'none'; base-uri 'none'"><title>Olympus</title>${openingView()}<script>
(async function(){
 const message=document.getElementById('message');
 try{let r;do{r=await fetch(${JSON.stringify(this.origin + '/owner-proof?challenge=' + challenge)},{mode:'cors',credentials:'omit',redirect:'error',cache:'no-store'});if(r.status===503&&r.headers.get('Retry-After')){message.textContent=${restartWordsScript('r')};await new Promise(resolve=>setTimeout(resolve,1000));}else break;}while(true);
 if(!r.ok||await r.text()!==${JSON.stringify(answer)}){message.textContent='Olympus refused: the private ticket expired or this listener could not prove its identity. The private ticket was not sent. Run olympus dashboard again.';return;}
 location.replace(${JSON.stringify(url)});
 }catch{message.textContent=${JSON.stringify('This browser cannot reach the private *.localhost session origin. The private ticket was not sent. ' + DESKTOP_BRIDGE_REMEDY)};}
})();</script>`;
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, html); } finally { closeSync(fd); }
    const ticket: Ticket = { value, challenge, target, path, expires: this.now() + TICKET_MS };
    this.tickets.set(lane, ticket);
    ticket.timer = setTimeout(() => this.clearTicket(ticket), TICKET_MS); ticket.timer.unref();
    // Made before the window opens, so its redemption always finds the claim. A new browser open replaces it.
    if (lane === 'browser') {
      const claimSecret = secret();
      this.claim = { secret: claimSecret, record: { hash: hashSecret(claimSecret), code: matchCode(), approvalId: secret(), ticket, expires: this.now() + CLAIM_MS, state: 'waiting' } };
    }
    try {
      await (this.options.openFile ?? openLinuxOwnerTicketFile)(path);
      if (!this.live()) throw new Error('Graphical session ended.');
    } catch (error) {
      if (this.claim?.record.ticket === ticket) this.claim = undefined;
      this.clearTicket(ticket); throw error;
    }
  }
  private cookieSession(request: Request): Session | undefined {
    const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (this.sessions.some(s => s.expires <= this.now())) this.sessions = this.sessions.filter(s => s.expires > this.now()).slice(-15);
    return this.sessions.find(s => equalHash(cookie, s.cookieHash));
  }
  private provenSession(request: Request): boolean {
    const session = this.cookieSession(request);
    return !!session && equalHash(request.headers.get(PROOF_HEADER), session.proofHash);
  }
  private grantSession(dashboardCookies: readonly string[], extra: Record<string, unknown>): Response {
    const cookie = secret(), proof = secret();
    const session = { cookieHash: hashSecret(cookie), proofHash: hashSecret(proof), expires: this.now() + SESSION_MS };
    this.sessions = [...this.sessions.filter(s => s.expires > this.now()).slice(-14), session];
    const response = Response.json({ proof, ...extra }, { headers: {
      'Set-Cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
      'Cache-Control': 'no-store', 'Clear-Site-Data': '"cache"', 'Content-Security-Policy': CSP,
    } });
    for (const cookie of dashboardCookies) response.headers.append('Set-Cookie', cookie);
    return response;
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
    if (url.pathname === '/owner-proof' && request.method === 'GET') {
      if (!url.searchParams.has('challenge')) return proofPage();
      // Only the private file knows the expected answer. Never reflect the
      // ticket, or accept a challenge supplied alongside a caller's ticket.
      const challenge = url.searchParams.get('challenge');
      const ticket = [...this.tickets.values()].find(t => t.expires > this.now() && equal(challenge, t.challenge));
      const response = !ticket ? refusal() : this.options.workerReady?.() === false ? restarting(this.options.workerConflict?.())
        : new Response(createHmac('sha256', ticket.value).update(ticket.challenge).digest('base64url'), { headers: { 'Cache-Control': 'no-store' } });
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Expose-Headers', `Retry-After, ${WORKER_CONFLICT_HEADER}`);
      return response;
    }
    if (this.options.workerReady?.() === false) return restarting(this.options.workerConflict?.());
    if (url.pathname === '/owner-proof' && request.method === 'POST') {
      let body: { ticket?: string };
      try { body = JSON.parse(await boundedBody(request, 1024)); } catch { return refusal(); }
      const ticket = [...this.tickets.values()].find(t => equal(body.ticket, t.value));
      if (!this.live() || !ticket || ticket.expires <= this.now() || !equal(body.ticket, ticket.value)) return refusal();
      if (ticket.claimed) return restarting(this.options.workerConflict?.());
      ticket.claimed = true; // exclusive claim before any asynchronous work
      try { unlinkSync(ticket.path); } catch {}
      const current = () => [...this.tickets.values()].includes(ticket) && ticket.expires > this.now();
      let dashboardCookies: readonly string[];
      try {
        const result = this.options.establishDashboard ? await this.options.establishDashboard() : [];
        if (result === null) { this.clearTicket(ticket); return refusal(); }
        dashboardCookies = result;
      }
      catch {
        // A stale health snapshot may hide a just-restarted worker. Retain
        // only this live, unexpired claim for retry; never restore a replaced
        // ticket, recreate its file, or extend its original expiry.
        if (this.live() && current()) { ticket.claimed = false; return restarting(this.options.workerConflict?.()); }
        this.clearTicket(ticket); return refusal(503);
      }
      if (!this.live() || !current()) { this.clearTicket(ticket); return refusal(503); }
      this.clearTicket(ticket); // successful redemption is now permanently spent
      const claim = this.claim?.record;
      const asking = claim?.ticket === ticket && claim.state === 'waiting' && claim.expires > this.now();
      if (asking) claim.state = 'asked';
      return this.grantSession(dashboardCookies, { target: ticket.target, ...(asking ? { approval: { id: claim.approvalId, code: claim.code } } : {}) });
    }
    if (url.pathname === '/owner-claim' && request.method === 'POST') {
      let body: { claim?: string };
      try { body = JSON.parse(await boundedBody(request, 1024)); } catch { return refusal(); }
      const claim = this.claim?.record;
      if (!claim || claim.expires <= this.now() || !equalHash(body.claim, claim.hash)) return refusal();
      if (claim.state === 'declined') {
        this.claim = undefined;
        const declined = refusal(); declined.headers.set(DECLINED_HEADER, '1'); return declined;
      }
      if (claim.state !== 'approved') return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
      if (claim.collecting) return restarting(this.options.workerConflict?.());
      claim.collecting = true; // exclusive, like a ticket's claim
      const current = () => this.claim?.record === claim && claim.expires > this.now();
      let dashboardCookies: readonly string[];
      try {
        const result = this.options.establishDashboard ? await this.options.establishDashboard() : [];
        if (result === null) { if (current()) this.claim = undefined; return refusal(); }
        dashboardCookies = result;
      } catch {
        if (this.live() && current()) { claim.collecting = false; return restarting(this.options.workerConflict?.()); }
        return refusal(503);
      }
      if (!this.live() || !current()) return refusal(503);
      this.claim = undefined; // collected once
      return this.grantSession(dashboardCookies, {});
    }
    if (url.pathname === '/owner-approve' && request.method === 'POST') {
      let body: { id?: string; approve?: boolean };
      try { body = JSON.parse(await boundedBody(request, 1024)); } catch { return refusal(); }
      // Only a proven Olympus window answers, and only for the claim its own ticket was asked about.
      const claim = this.claim?.record;
      if (!this.provenSession(request) || !claim || claim.state !== 'asked' || claim.expires <= this.now() || !equal(body.id, claim.approvalId)) return refusal();
      claim.state = body.approve === true ? 'approved' : 'declined';
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/owner-open' && request.method === 'POST') {
      try {
        // This unauthenticated confirmation button can only open the dashboard.
        // Its limiter and pending ticket cannot replace or starve a CLI ticket.
        await this.openTicket('/dashboard', 'browser');
        const claim = this.claim;
        const headers = new Headers({ 'Cache-Control': 'no-store' });
        if (claim) { headers.set(CLAIM_HEADER, claim.secret); headers.set(CODE_HEADER, claim.record.code); headers.set(APPROVAL_HEADER, claim.record.approvalId); }
        return new Response(null, { status: 204, headers });
      } catch (error) {
        if (!(error instanceof OwnerOpenLimited)) {
          // No window opened (launcher, session or socket failure): not the limit.
          const failed = page(`<p>${BROWSER_OPEN_FAILED_MESSAGE}</p>`, 503);
          failed.headers.set('X-Olympus-Owner-Refused', '1');
          return failed;
        }
        const response = page(`<p>${error.hourly ? BROWSER_OPEN_LIMIT_MESSAGE : BROWSER_OPEN_RECENT_MESSAGE}</p>`, 429);
        response.headers.set('X-Olympus-Owner-Refused', '1');
        response.headers.set(OWNER_LIMIT_HEADER, error.hourly ? 'hourly' : 'recent');
        const retryAt = Math.max(this.lastBrowserOpen + 10_000,
          this.browserOpens.length >= 6 ? this.browserOpens[0]! + 60 * 60 * 1000 : 0);
        response.headers.set('Retry-After', String(Math.max(1, Math.ceil((retryAt - this.now()) / 1000))));
        return response;
      }
    }
    // Private control endpoint is NEVER forwarded from TCP, even by an owner.
    if (url.pathname === DESKTOP_OWNER_OPEN_PATH || url.pathname.startsWith('/owner-')) return refusal();
    const session = this.cookieSession(request);
    let proof = request.headers.get(PROOF_HEADER);
    let body: string | ReadableStream<Uint8Array> | undefined;
    // Binary bodies (a dropped archive's pieces, up to the upload route's own cap) are never text: once the owner is
    // proven they stream to the worker byte for byte, and the worker's route bounds them. Their proof is the header.
    const binary = request.headers.get('content-type')?.split(';', 1)[0]!.trim().toLowerCase() === 'application/octet-stream';
    if (request.method !== 'GET' && request.method !== 'HEAD' && !binary) {
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
    // Body parsing and owner proof can await; recheck custody before the hop.
    if (this.options.workerReady?.() === false) return restarting(this.options.workerConflict?.());
    if (binary && request.body) body = request.body;
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
      method: request.method, headers, ...(body !== undefined ? { body, duplex: 'half' } : {}), redirect: 'manual',
      // A streamed upload's sender going away ends the hop too, so the worker does not wait on a body nobody sends.
      ...(typeof body === 'object' ? { signal: request.signal } : {}),
    } as RequestInit)); } catch { return this.live() ? restarting(this.options.workerConflict?.()) : refusal(503); }
    if (!this.live()) return refusal(503);
    if (this.options.workerReady?.() === false) {
      await response.body?.cancel().catch(() => {});
      return restarting(this.options.workerConflict?.());
    }
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

export type DesktopBridgeStatus = { state: 'listening' | 'restarting' | 'headless' | 'port_in_use' | 'unavailable'; origin?: string; remedy?: string; listener_owner?: 'engine-host' | 'worker'; ipv6?: 'listening' | 'unavailable' };
/** Kernel addresses decide presence. Ephemeral-port exhaustion, permissions
 * and resource failures can make bind(::1, 0) fail while ::1 remains usable. */
function ipv6LoopbackPresent(): boolean {
  return Object.values(networkInterfaces()).some(addresses =>
    addresses?.some(address => address.internal && address.address === '::1'));
}
/** One epoch per active desktop. Rotation also occurs after logout/relogin,
 * not merely after process restart. No reusePort or hostname fallback. */
export function manageLinuxOwnerBridge(options: LinuxOwnerBridgeOptions & { ipv6Present?: () => boolean; platform?: string; listenerOwner?: 'engine-host' | 'worker'; listen?: (bridge: LinuxOwnerBridge) => { stop(closeActiveConnections?: boolean): unknown } }) {
  const ipv6Present = () => {
    try { return (options.ipv6Present ?? ipv6LoopbackPresent)(); }
    catch { return true; } // Uncertain kernel state requires custody of both families.
  };
  let bridge: LinuxOwnerBridge | undefined;
  let listener: { stop(closeActiveConnections?: boolean): unknown; ipv6?: 'listening' | 'unavailable' } | undefined;
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
    let ipv6Available: boolean | undefined;
    if (bridge) {
      if (listener?.ipv6 !== 'unavailable') return;
      ipv6Available = ipv6Present();
      if (!ipv6Available) return;
      // IPv6 appeared: revoke the IPv4 epoch before trying to hold BOTH
      // families. A squatter must never coexist with a live old origin.
      stop();
    }
    const candidate = new LinuxOwnerBridge(options);
    try {
      if (options.listen) listener = options.listen(candidate);
      else {
        const servers: ReturnType<typeof Bun.serve>[] = [];
        const release = () => {
          candidate.close(); // revoke before EITHER family can be released
          for (const server of servers) void server.stop(true);
        };
        const ipv6 = (ipv6Available ?? ipv6Present()) ? 'listening' : 'unavailable';
        try {
          for (const hostname of ipv6 === 'listening' ? ['127.0.0.1', '::1'] : ['127.0.0.1']) {
            servers.push(Bun.serve({ hostname, port: options.port, fetch: (r, server) => candidate.handle(r, () => server.timeout(r, 0)) }));
          }
        } catch (error) { release(); throw error; }
        listener = { stop: release, ipv6 };
      }
      bridge = candidate; status = { state: 'listening', origin: bridge.origin, listener_owner: options.listenerOwner ?? 'worker', ...(listener.ipv6 ? { ipv6: listener.ipv6 } : {}) };
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
