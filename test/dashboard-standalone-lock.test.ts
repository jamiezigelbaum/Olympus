// Lock on a computer page (Keys, Agents) opened by its control session alone: the page can read nothing
// once locked, so it locks in place with the way back in, and asks the worker for nothing it would refuse
// (release check pages.keys: `GET /dashboard?keys -> 401`). A page opened with a reader's token reads on.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { pageShell } from '../src/workers/dashboard/components.ts';

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) { await w.happyDOM.abort(); w.close(); }
});

const BODY = '<div class="attncard" data-dashboard-control-gate data-state="connected">'
  + '<form data-control-session-kind="lock"><button type="submit">Lock</button><span data-action-message></span></form></div>';

async function lockPage(url: string, answer: (url: string, method: string) => { status: number; body: string }) {
  const w = new Window({ url });
  windows.push(w);
  const requests: string[] = [];
  (w as unknown as { fetch: unknown }).fetch = async (target: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${new URL(String(target), url).pathname}${new URL(String(target), url).search}`);
    const { status, body } = answer(String(target), method);
    return new w.Response(body, { status, headers: { 'Content-Type': 'text/html' } });
  };
  const html = pageShell({ title: 'Olympus', meta: '', body: BODY, controller: { csrfToken: 'csrf' }, poll: { intervalMs: 0, unlocked: true, controlSessionCsrfToken: 'csrf' } });
  // The page without its script, then the script itself run against this window (as chatgpt-dashboard-ui does).
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  w.document.write(html.slice(0, start - '<script>'.length) + html.slice(end + '</script>'.length));
  // The page's globals are this window's (fetch, DOM classes); the language's own (Boolean, WeakMap), which
  // happy-dom's window leaves undefined, stay the runtime's.
  const scope = new Proxy(w, { has: (target, key) => (target as unknown as Record<PropertyKey, unknown>)[key] !== undefined });
  new Function('window', 'scope', `with (scope) {\n${html.slice(start, end)}\n}`)(w, scope);
  w.document.querySelector('form[data-control-session-kind="lock"]')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { w, requests };
}

describe('Lock on a page opened by its session alone', () => {
  test('locks in place with the way back in, and asks for nothing the worker would refuse', async () => {
    const { w, requests } = await lockPage('https://olympus.test/dashboard?keys', (target) => (
      target.includes('/lock') ? { status: 200, body: '{}' } : { status: 401, body: '{}' }
    ));
    expect(requests).toEqual(['POST /dashboard/control/session/lock']);
    const gate = w.document.querySelector('[data-dashboard-control-gate]')!;
    expect(gate.getAttribute('data-state')).toBe('locked');
    expect(gate.querySelector('a')?.getAttribute('href')).toBe('olympus://open/dashboard');
    expect(w.document.querySelector('form[data-control-session-kind="lock"]')).toBeNull();
    // The page keeps its header.
    expect(w.document.querySelector('.top .brand')?.textContent).toBe('Olympus');
  });

  test('a page opened with a reader\'s token reads its locked page from the worker instead', async () => {
    const locked = pageShell({ title: 'Olympus', meta: '', body: '<div data-dashboard-control-gate data-state="locked">locked gate</div>', poll: { intervalMs: 0 } });
    const { w, requests } = await lockPage('https://olympus.test/dashboard?keys&token=dash_x', (target) => (
      target.includes('/lock') ? { status: 200, body: '{}' } : { status: 200, body: locked }
    ));
    // The token still reads, so the worker's own locked page is asked for (and loaded), never the in-place notice.
    expect(requests).toEqual(['POST /dashboard/control/session/lock', 'GET /dashboard?keys&token=dash_x']);
    expect(w.document.querySelector('a[href="olympus://open/dashboard"]')).toBeNull();
  });
});
