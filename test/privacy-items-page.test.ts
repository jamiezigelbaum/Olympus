// Privacy › Your items (issues #1060, #887): the page that fixes one item's
// label. It lists items through the dashboard's local find route, shows what
// an item says and the judge's reason, and changes that one item. Lowering to
// Personal always asks first (Cancel, X, Esc or a click outside all cancel);
// raising to Private never asks; Undo gives the item back to the judge.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beginFrontProgress, finishFrontProgress } from '../src/core/boot-progress.ts';
import { answerReleaseWithheldReasonOffThread } from '../src/core/release-manifest.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { ownerTierItemId } from '../src/workers/classification/tier-owner-items.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { createPendingItemProtection, createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';
import {
  DASHBOARD_PRIVACY_ITEMS_PATHS,
  PRIVACY_ITEMS_SEARCH_DEBOUNCE_MS,
  PRIVACY_ITEMS_TOAST_MS,
} from '../src/workers/dashboard/pages/privacy-items.ts';
import { DASHBOARD_PRIVACY_ITEMS_COPY as C, judgeReasonPhrase } from '../src/workers/dashboard/vocabulary.ts';
import { createEngineFront, createEngineFrontRoutes, createFrontGate } from '../src/workers/engine-split/runtime.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture } from './helpers/tier-fixtures.ts';

const URL_ITEMS = new URL('http://127.0.0.1:8010/dashboard?privacy-items');

interface Item {
  item_id: string; source: string; family: string; title: string | null; sender: string | null; location: string | null;
  tier: string | null; names_tier: string | null; decided_by: string | null; owner_set: boolean; judge_reason: string | null;
  decided_at: string | null; preview?: string | null; owner_choice?: string; waiting_for_judge?: true; names_only?: true; not_read?: { kind: 'by_choice' } | { kind: 'cannot_read'; reason: string };
}

const invoice = (): Item => ({
  item_id: 'oti_inv', source: 'dropbox', family: 'file', title: 'Invoice_2026-014.pdf', sender: null, location: '/Money/Invoices/Invoice_2026-014.pdf',
  tier: 'Private', names_tier: 'Personal', decided_by: 'sniffer', owner_set: false, judge_reason: 'financial:0.90',
  decided_at: '2026-11-02T11:05:00.000Z', preview: 'Invoice 2026-014 · €4,200.00 + VAT',
});
const appointment = (): Item => ({
  item_id: 'oti_appt', source: 'gmail', family: 'email', title: 'Appointment confirmed', sender: 'Clínica Sorriso', location: null,
  tier: 'Personal', names_tier: 'Personal', decided_by: 'sniffer', owner_set: false, judge_reason: 'mystery:0.51',
  decided_at: '2026-11-06T09:12:00.000Z', preview: 'This confirms the appointment on Saturday.',
});

const windows: Window[] = [];
afterEach(async () => { while (windows.length) await windows.pop()!.happyDOM.close(); });

function render(options: NonNullable<Parameters<typeof renderDashboardLocalPage>[1]['options']>): string {
  return renderDashboardLocalPage('privacy_items', { url: URL_ITEMS, options });
}

/** The page on a local session, its script run against a stubbed engine, on the shared test clock. */
async function page(items: Item[], options: { narrow?: boolean; refuse?: boolean; hold?: boolean; pending?: boolean } = {}) {
  const html = render({ controlSessionCsrfToken: 'csrf-token', outsideHelpLocalSession: true });
  const window = new Window({ url: URL_ITEMS.href });
  windows.push(window);
  const document = window.document;
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-privacy-items]'))!;
  const clock = createTestClock();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const state = items.map((item) => ({ ...item, judge: item.tier }));
  // With hold, a save answers only when the test releases it.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let received: Record<string, unknown> | undefined;
  let settled = false;
  const fetchStub = async (path: string, init: { body: string; headers: Record<string, string> }) => {
    expect(init.headers['X-Olympus-CSRF']).toBe('csrf-token');
    let request = JSON.parse(init.body) as Record<string, unknown>;
    posts.push({ path, body: request });
    if (options.hold && path === DASHBOARD_PRIVACY_ITEMS_PATHS.set) await gate;
    if (options.pending && path === DASHBOARD_PRIVACY_ITEMS_PATHS.set) {
      received = request;
      return { ok: true, status: 202, json: async () => ({ ok: true, state: 'pending', request_id: 'privacy-click' }) };
    }
    if (path === DASHBOARD_PRIVACY_ITEMS_PATHS.status) {
      expect(request).toEqual({ request_id: 'privacy-click' });
      if (!settled) return { ok: true, status: 200, json: async () => ({ ok: true, state: 'pending' }) };
      request = received!;
    }
    let result: unknown;
    if (path === DASHBOARD_PRIVACY_ITEMS_PATHS.find) {
      const words = typeof request.query === 'string' ? request.query.toLowerCase() : '';
      const filter = request.filter;
      result = {
        ok: true,
        items: state.filter((item) => (!words || (item.title ?? '').toLowerCase().includes(words))
          && (filter === undefined || (filter === 'changed' ? item.owner_set : item.tier === (filter === 'personal' ? 'Personal' : 'Private'))))
          .map(({ judge: _judge, ...item }) => item),
        counts: { personal: 47_006, private: 1_204, changed: state.filter((item) => item.owner_set).length },
      };
    } else if (options.refuse) {
      result = { ok: false, code: 'secret_item', message: 'This item is Secret. Secret items are not changed from here.' };
    } else {
      const item = state.find((candidate) => candidate.item_id === request.item_id)!;
      if (request.tier === 'judge') Object.assign(item, { tier: item.judge, owner_set: false });
      else Object.assign(item, { tier: request.tier === 'personal' ? 'Personal' : 'Private', owner_set: true, judge_reason: null });
      const { judge: _judge, preview: _preview, ...shown } = item;
      result = { ok: true, item: shown, changed: request.tier === 'judge' ? 'cleared' : 'set', applies: 'now', results: [] };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  const pageWindow = {
    location: window.location,
    setTimeout: (callback: () => void, ms: number) => clock.setTimeout(callback, ms),
    clearTimeout: (timer: Parameters<typeof clock.clearTimeout>[0]) => clock.clearTimeout(timer),
    matchMedia: () => ({ matches: options.narrow === true, addEventListener: () => undefined }),
  };
  new Function('window', 'document', 'fetch', script)(pageWindow, document, fetchStub);
  await flushMicrotasks();
  const $ = (selector: string) => document.querySelector(selector) as unknown as (HTMLElement & { click(): void }) | null;
  const click = async (selector: string) => { $(selector)!.click(); await flushMicrotasks(); };
  const sets = () => posts.filter((post) => post.path === DASHBOARD_PRIVACY_ITEMS_PATHS.set).map((post) => post.body);
  const dialogOpen = () => $('[data-pi-confirm]')!.hasAttribute('open');
  const text = (selector: string) => $(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { window, document, clock, posts, sets, $, click, dialogOpen, text, release: () => { settled = true; release(); } };
}

test('Make it Private applies and withholds search while the background waits for front visibility', async () => {
  const root = mkdtempSync('/tmp/olympus-privacy-boot-');
  const env = { HOME: root, XDG_DATA_HOME: root, PATH: process.env.PATH ?? '', FIXTURE_TOKEN: randomUUID(), FIXTURE_WAIT_FOR_VISIBILITY: '1' };
  const socketPath = join(root, 'bg.sock');
  const identity = identityOf('boot-item');
  const front = createEngineFront({ env, socketPath, authToken: env.FIXTURE_TOKEN });
  let background: ReturnType<typeof Bun.spawn> | undefined;
  let reader: TierLedger | undefined;
  let store: LocalConnectorStore | undefined;
  try {
    const seed = openTierFixture(root, { embed: false });
    try {
      seed.ledger.setOverride(identity, { kind: 'tier', tier: 'private' });
      await seed.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Orchard', text: 'Synthetic orchard notes.' }]), {
        fetchContent: true, placement: FIXTURE_PLACEMENT,
      });
    } finally {
      seed.close();
    }
    const ledger = reader = new TierLedger({ dbPath: seed.ledger.dbPath, readOnly: true });
    const internal = store = new LocalConnectorStore({ dbPath: seed.paths.internal, corpusId: CORPORA.internal, trustDomain: 'internal', family: 'file', tierLedger: ledger, readOnly: true });
    beginFrontProgress(env);
    background = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'engine-control-blocked-child.ts'),
      socketPath, join(root, 'held.sqlite'), root, seed.paths.internal, seed.paths.secure_local], { env, stdout: 'ignore', stderr: 'inherit' });
    const building = () => existsSync(join(root, 'visibility-building'));
    const waiting = () => existsSync(join(root, 'visibility-step')) && !building()
      && readFileSync(join(root, 'visibility-step'), 'utf8').startsWith('waiting for the front');
    await waitFor(waiting, { description: 'background waiting for front visibility' });

    const protection = createPendingItemProtection();
    const scopes = () => [{ ledger, corpusIds: new Set([CORPORA.internal]), stores: () => [internal] }];
    const visibility = createTierVisibilityGate(scopes, undefined, protection);
    const release = createReleaseTierCheck(scopes, () => 'allow', {}, protection);
    const worker = createEmailSourceWorker({ connectorStores: [internal], sourceIndexVisibilityGate: visibility });
    const routes = createEngineFrontRoutes({ client: front.client, pendingItemProtection: protection, gate: createFrontGate(), restartFront: () => {} });
    const serve = withWorkerBearerAuth(async request => (await routes(request)) ?? worker.fetch(request), { authToken: env.FIXTURE_TOKEN });
    const origin = 'http://127.0.0.1:8010';
    const local = await ownerLocalMint(serve, origin, env.FIXTURE_TOKEN);
    expect(local.status).toBe(200);
    const { csrf_token: csrf } = await local.json() as { csrf_token: string };
    const cookie = local.headers.get('Set-Cookie')!.split(';')[0]!;
    const post = (path: string, body: object, headers: Record<string, string>) => serve(new Request(origin + path, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }));
    const dashboard = (path: string, body: object) => post(path, body, { Cookie: cookie, 'X-Olympus-CSRF': csrf });
    const search = async () => {
      const response = await post('/v1/source/index/search', { corpus_id: CORPORA.internal, query: 'orchard', all_tiers: false }, { Authorization: `Bearer ${env.FIXTURE_TOKEN}` });
      expect(response.status).toBe(200);
      const { hits } = await response.json() as { hits: Array<{ sourceItem: { providerItemId: string } }> };
      return hits.some(hit => hit.sourceItem.providerItemId === identity.providerItemId);
    };
    expect(await search()).toBe(true);
    const receipt = await dashboard(DASHBOARD_PRIVACY_ITEMS_PATHS.set, { item_id: ownerTierItemId(identity), tier: 'private' });
    expect(receipt.status).toBe(202);
    const { request_id } = await receipt.json() as { request_id: string };
    await waitFor(async () => {
      const result = await dashboard(DASHBOARD_PRIVACY_ITEMS_PATHS.status, { request_id });
      const body = await result.json();
      return body.ok === true && body.state !== 'pending';
    }, { description: 'Private click applied before the visibility build' });
    expect(ledger.getOverride(identity)).toMatchObject({ kind: 'tier', tier: 'secure' });
    expect(ledger.getCurrent(identity)?.contentTier).toBe('private');
    expect(await search()).toBe(false);
    expect(await answerReleaseWithheldReasonOffThread([{
      inputs: [{ ...identity, corpusId: CORPORA.internal, privateAtAnswer: false, layer: 'names' }],
      constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false },
    }], release)).toBeDefined();
    expect(waiting()).toBe(true);
    finishFrontProgress();
    front.visibilityFinished();
    await waitFor(building, { description: 'background building after the front receipt' });
  } finally {
    front.stop();
    finishFrontProgress();
    background?.kill('SIGKILL');
    await background?.exited;
    store?.close();
    reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.each([false, true])('a pending receipt leaves the row saving until the background settles (refusal %s)', async (refuse) => {
  const p = await page([appointment()], { pending: true, refuse });
  await p.click('[data-pi-item="oti_appt"]');
  await p.click('[data-pi-choose="Private"]');
  expect(p.text('[data-pi-item="oti_appt"]')).toContain('Saving…');
  expect(p.text('[data-pi-item="oti_appt"]')).toContain('Personal');
  expect(p.text('[data-pi-status]')).toBe(C.pendingRestart);
  await p.clock.advance(250);
  expect(p.posts.at(-1)).toEqual({ path: DASHBOARD_PRIVACY_ITEMS_PATHS.status, body: { request_id: 'privacy-click' } });
  expect(p.text('[data-pi-item="oti_appt"]')).toContain('Saving…');
  p.release();
  await p.clock.advance(250);
  expect(p.text('[data-pi-item="oti_appt"]')).not.toContain('Saving…');
  if (refuse) {
    expect(p.text('[data-pi-status]')).toBe('This item is Secret. Secret items are not changed from here.');
    expect(p.text('[data-pi-item="oti_appt"]')).toContain('Personal');
  } else {
    expect(p.text('[data-pi-toast-text]')).toBe(C.toastPrivate);
    expect(p.text('[data-pi-item="oti_appt"]')).toContain('Private');
  }
});

describe('the Privacy tabs', () => {
  test('Your items is the third tab, after Private questions and Privacy rules and before What AI apps received', () => {
    const html = render({});
    const tabs = [...html.matchAll(/<a class="ptab[^"]*"[^>]*>([^<]+)<\/a>/g)].map((match) => match[1]);
    expect(tabs).toEqual(['Private questions', 'Privacy rules', C.tab, 'What AI apps received']);
    expect(html).toContain('class="ptab on" aria-current="page" href="/dashboard?privacy-items"');
  });

  test('without a session the page shows no items and runs nothing; a launch-link session only offers to unlock', () => {
    const locked = render({});
    expect(locked).toContain(C.locked);
    expect(locked).not.toContain('class="pilist"');
    expect(locked).not.toContain(DASHBOARD_PRIVACY_ITEMS_PATHS.find);
    const bearer = render({ controlSessionCsrfToken: 'csrf-token', outsideHelpLocalSession: false });
    expect(bearer).toContain('data-pi-unlock');
    expect(bearer).not.toContain('class="pilist"');
    expect(bearer).not.toContain('csrf-token');
  });
});

describe('finding an item', () => {
  test('opens on the recently sorted list; a row opens beside it with what the item says and the judge\'s reason', async () => {
    const p = await page([invoice(), appointment()]);
    expect(p.posts[0]).toEqual({ path: DASHBOARD_PRIVACY_ITEMS_PATHS.find, body: { recent: true } });
    expect(p.document.querySelectorAll('[data-pi-item]')).toHaveLength(2);
    expect(p.$('[data-pi-heading]')!.hasAttribute('hidden')).toBe(true);
    expect(p.text('[data-pi-filter][aria-pressed="true"]')).toBe(C.recentHeading);
    expect(p.text('[data-pi-filter="private"]')).toBe('Private1,204');
    expect(p.text('[data-pi-filter="changed"]')).toBe(`${C.changedByYou}0`);
    expect(p.text('[data-pi-apps]')).toBe(C.apps);
    await p.click('[data-pi-item="oti_inv"]');
    expect(p.$('[data-pi-side] [data-pi-detail="oti_inv"]')).not.toBeNull();
    expect(p.text('[data-pi-preview]')).toBe('Invoice 2026-014 · €4,200.00 + VAT');
    expect(p.text('[data-pi-why]')).toBe(`The judge chose Private: ${judgeReasonPhrase('financial:0.90')}`);
    expect(p.text('[data-pi-foot]')).toContain('Your choice changes this one item.');
    expect(p.$('[data-pi-choose="Private"]')!.getAttribute('aria-checked')).toBe('true');
    expect(p.$('[data-pi-choose="Personal"]')!.getAttribute('aria-checked')).toBe('false');
    // An unknown reason code falls back to the label alone.
    await p.click('[data-pi-item="oti_appt"]');
    expect(p.text('[data-pi-why]')).toBe('The judge marked this Personal.');
    expect(p.text('[data-pi-foot]')).toContain('a rule for Clínica Sorriso or your other items');
  });

  test('an item held until its text is read, or judged on its names by the owner\'s choice, says so instead of a verdict (#1295)', async () => {
    const unread: Item = { ...invoice(), item_id: 'oti_unread', title: 'Scan_0042.pdf', judge_reason: 'fail_safe:unread', decided_by: 'sniffer', waiting_for_judge: true, preview: null };
    const names: Item = { ...appointment(), item_id: 'oti_names', source: 'dropbox', family: 'file', sender: null, title: 'Holiday plan.docx', location: '/Archive/Holiday plan.docx', judge_reason: null, decided_by: 'default', names_only: true, preview: null };
    const p = await page([unread, names]);
    await p.click('[data-pi-item="oti_unread"]');
    expect(p.text('[data-pi-why]')).toBe('Waiting to be read. It stays Private until the judge reads it.');
    await p.click('[data-pi-item="oti_names"]');
    expect(p.text('[data-pi-why]')).toBe(C.namesOnly);
  });

  test('policy and failed reads are shown as holds, never judge verdicts', async () => {
    const p = await page([
      { ...invoice(), item_id: 'oti_choice', not_read: { kind: 'by_choice' }, judge_reason: 'fail_safe:unread' },
      { ...invoice(), item_id: 'oti_failed', not_read: { kind: 'cannot_read', reason: 'password' }, judge_reason: 'fail_safe:unread' },
    ]);
    await p.click('[data-pi-item="oti_choice"]');
    expect(p.text('[data-pi-why]')).toBe('Not read, by your choice.');
    await p.click('[data-pi-item="oti_failed"]');
    expect(p.text('[data-pi-why]')).toBe("Kept Private: Olympus couldn't read it (locked with a password).");
  });

  test('on a phone the item opens in place, under its row', async () => {
    const p = await page([invoice(), appointment()], { narrow: true });
    await p.click('[data-pi-item="oti_inv"]');
    expect(p.$('[data-pi-side] [data-pi-detail]')).toBeNull();
    const listed = [...p.document.querySelectorAll('[data-pi-list] > li')].map((li) => li.querySelector('[data-pi-item]')?.getAttribute('data-pi-item') ?? 'detail');
    expect(listed).toEqual(['oti_inv', 'detail', 'oti_appt']);
  });

  test('search runs once typing settles, with no Search button', async () => {
    const p = await page([invoice(), appointment()]);
    const search = p.$('[data-pi-search]') as unknown as { value: string; dispatchEvent(event: unknown): void };
    search.value = 'appoint';
    search.dispatchEvent(new p.window.Event('input'));
    await p.clock.advance(PRIVACY_ITEMS_SEARCH_DEBOUNCE_MS - 1);
    expect(p.posts).toHaveLength(1);
    await p.clock.advance(1);
    await flushMicrotasks();
    expect(p.posts.at(-1)).toEqual({ path: DASHBOARD_PRIVACY_ITEMS_PATHS.find, body: { query: 'appoint' } });
    expect(p.document.querySelectorAll('[data-pi-item]')).toHaveLength(1);
    expect(p.text('[data-pi-heading]')).toBe(C.resultsHeading);
    expect(p.$('[data-pi-filter][aria-pressed="true"]')).toBeNull();
    search.value = 'nothing like it';
    search.dispatchEvent(new p.window.Event('input'));
    await p.clock.advance(PRIVACY_ITEMS_SEARCH_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(p.text('[data-pi-msg]')).toBe(C.noMatch);
  });
});

describe('the filters', () => {
  test('Private, Personal and Changed by you list only those, each with its count', async () => {
    const p = await page([invoice(), appointment()]);
    await p.click('[data-pi-filter="private"]');
    expect(p.posts.at(-1)!.body).toEqual({ recent: true, filter: 'private' });
    expect([...p.document.querySelectorAll('[data-pi-item]')].map((row) => row.getAttribute('data-pi-item'))).toEqual(['oti_inv']);
    expect(p.$('[data-pi-filter="private"]')!.getAttribute('aria-pressed')).toBe('true');
    await p.click('[data-pi-filter="changed"]');
    expect(p.text('[data-pi-msg]')).toBe(C.empty);
    await p.click('[data-pi-filter=""]');
    await p.click('[data-pi-item="oti_appt"]');
    await p.click('[data-pi-choose="Private"]');
    // The change counts at once.
    expect(p.text('[data-pi-filter="changed"]')).toBe(`${C.changedByYou}1`);
    await p.click('[data-pi-filter="changed"]');
    expect([...p.document.querySelectorAll('[data-pi-item]')].map((row) => row.getAttribute('data-pi-item'))).toEqual(['oti_appt']);
    await p.click('[data-pi-item="oti_appt"]');
    await p.click('[data-pi-undo]');
    expect(p.text('[data-pi-filter="changed"]')).toBe(`${C.changedByYou}0`);
  });
});

describe('changing one item', () => {
  test('a Personal choice waiting for its pass shows after a reload, and Private can still be chosen', async () => {
    // Recorded Private, the owner chose Personal, and the page was reloaded before the pass.
    const p = await page([{ ...invoice(), owner_set: true, owner_choice: 'Personal' }]);
    await p.click('[data-pi-item="oti_inv"]');
    await p.click('[data-pi-choose="Private"]');
    expect(p.sets()).toEqual([{ item_id: 'oti_inv', tier: 'private' }]);
  });

  test('raising to Private asks nothing and changes it at once', async () => {
    const p = await page([appointment()]);
    await p.click('[data-pi-item="oti_appt"]');
    await p.click('[data-pi-choose="Private"]');
    expect(p.dialogOpen()).toBe(false);
    expect(p.sets()).toEqual([{ item_id: 'oti_appt', tier: 'private' }]);
    expect(p.text('[data-pi-toast-text]')).toBe(C.toastPrivate);
  });

  test('while a change is saving, the item\'s choices wait; the next choice is sent once it has saved', async () => {
    const p = await page([invoice()], { hold: true });
    await p.click('[data-pi-item="oti_inv"]');
    await p.click('[data-pi-choose="Personal"]');
    await p.click('[data-pi-confirm-ok]');
    expect(p.sets()).toEqual([{ item_id: 'oti_inv', tier: 'personal' }]);
    // Saving: both choices are disabled, and a click on Private is not lost silently later.
    expect(p.$('[data-pi-choose="Private"]')!.hasAttribute('disabled')).toBe(true);
    expect(p.$('[data-pi-choose="Personal"]')!.hasAttribute('disabled')).toBe(true);
    await p.click('[data-pi-choose="Private"]');
    expect(p.sets()).toHaveLength(1);
    p.release();
    await flushMicrotasks();
    expect(p.$('[data-pi-choose="Private"]')!.hasAttribute('disabled')).toBe(false);
    expect(p.$('[data-pi-choose="Personal"]')!.getAttribute('aria-checked')).toBe('true');
    await p.click('[data-pi-choose="Private"]');
    expect(p.sets()).toEqual([{ item_id: 'oti_inv', tier: 'personal' }, { item_id: 'oti_inv', tier: 'private' }]);
  });

  test('lowering to Personal asks first; Cancel, X, Esc and a click outside each cancel', async () => {
    const p = await page([invoice()]);
    await p.click('[data-pi-item="oti_inv"]');
    const dialog = p.$('[data-pi-confirm]')!;
    const cancels: Array<() => Promise<void>> = [
      () => p.click('[data-pi-confirm-cancel]'),
      () => p.click('[data-pi-confirm-close]'),
      async () => { (dialog as unknown as { close(): void }).close(); dialog.dispatchEvent(new p.window.Event('cancel') as never); await flushMicrotasks(); },
      async () => { dialog.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }) as never); await flushMicrotasks(); },
    ];
    for (const cancel of cancels) {
      await p.click('[data-pi-choose="Personal"]');
      expect(p.dialogOpen()).toBe(true);
      expect(p.text('[data-pi-confirm-item]')).toContain('Invoice_2026-014.pdf');
      await cancel();
      expect(p.dialogOpen()).toBe(false);
      // Confirming after a cancel changes nothing: the cancel forgot the item.
      await p.click('[data-pi-confirm-ok]');
    }
    expect(p.sets()).toEqual([]);
    expect(p.$('[data-pi-choose="Private"]')!.getAttribute('aria-checked')).toBe('true');
  });

  test('after Make Personal: Changed by you, what the judge said, Undo; Undo gives it back to the judge', async () => {
    const p = await page([invoice()]);
    await p.click('[data-pi-item="oti_inv"]');
    await p.click('[data-pi-choose="Personal"]');
    await p.click('[data-pi-confirm-ok]');
    expect(p.sets()).toEqual([{ item_id: 'oti_inv', tier: 'personal' }]);
    expect(p.dialogOpen()).toBe(false);
    expect(p.text('[data-pi-item="oti_inv"]')).toContain(`Personal${C.changedByYou}`);
    expect(p.text('[data-pi-undo-row]')).toBe('You chose Personal just now. The judge said Private.Undo');
    expect(p.text('[data-pi-foot]')).toBe(`${C.afterPersonal} ${C.undoGivesBack}`);
    // The preview stays: the set route does not send it back.
    expect(p.text('[data-pi-preview]')).toBe('Invoice 2026-014 · €4,200.00 + VAT');
    // The confirmation stays a few seconds, then goes.
    expect(p.$('[data-pi-toast]')!.hasAttribute('hidden')).toBe(false);
    expect(p.text('[data-pi-toast-text]')).toBe(C.toastPersonal);
    await p.clock.advance(PRIVACY_ITEMS_TOAST_MS);
    expect(p.$('[data-pi-toast]')!.hasAttribute('hidden')).toBe(true);

    await p.click('[data-pi-undo]');
    expect(p.sets().at(-1)).toEqual({ item_id: 'oti_inv', tier: 'judge' });
    expect(p.$('[data-pi-undo]')).toBeNull();
    expect(p.text('[data-pi-item="oti_inv"]')).not.toContain(C.changedByYou);
    expect(p.$('[data-pi-choose="Private"]')!.getAttribute('aria-checked')).toBe('true');
    expect(p.text('[data-pi-toast-text]')).toBe(C.toastJudge);
    expect(p.$('[data-pi-toast-undo]')!.hasAttribute('hidden')).toBe(true);
  });

  test('the confirmation\'s Undo undoes the change', async () => {
    const p = await page([appointment()]);
    await p.click('[data-pi-item="oti_appt"]');
    await p.click('[data-pi-choose="Private"]');
    await p.click('[data-pi-toast-undo]');
    expect(p.sets()).toEqual([{ item_id: 'oti_appt', tier: 'private' }, { item_id: 'oti_appt', tier: 'judge' }]);
    expect(p.$('[data-pi-choose="Personal"]')!.getAttribute('aria-checked')).toBe('true');
  });

  test('the confirmation\'s Undo works after a search or a filter has moved the item out of the list', async () => {
    const p = await page([invoice(), appointment()]);
    await p.click('[data-pi-item="oti_appt"]');
    await p.click('[data-pi-choose="Private"]');
    expect(p.text('[data-pi-filter="changed"]')).toBe(`${C.changedByYou}1`);
    // The Personal filter no longer lists it: it is Private now.
    await p.click('[data-pi-filter="personal"]');
    expect(p.$('[data-pi-item="oti_appt"]')).toBeNull();
    expect(p.$('[data-pi-toast]')!.hasAttribute('hidden')).toBe(false);
    await p.click('[data-pi-toast-undo]');
    expect(p.sets()).toEqual([{ item_id: 'oti_appt', tier: 'private' }, { item_id: 'oti_appt', tier: 'judge' }]);
    expect(p.text('[data-pi-toast-text]')).toBe(C.toastJudge);
    expect(p.text('[data-pi-filter="changed"]')).toBe(`${C.changedByYou}0`);
    // Back on the full list, the item has the judge's label again.
    await p.click('[data-pi-filter=""]');
    await p.click('[data-pi-item="oti_appt"]');
    expect(p.$('[data-pi-choose="Personal"]')!.getAttribute('aria-checked')).toBe('true');
    expect(p.$('[data-pi-undo]')).toBeNull();
  });

  test('a refusal is shown on the item and nothing is marked changed', async () => {
    const p = await page([invoice()], { refuse: true });
    await p.click('[data-pi-item="oti_inv"]');
    await p.click('[data-pi-choose="Private"]');
    await p.click('[data-pi-choose="Personal"]');
    await p.click('[data-pi-confirm-ok]');
    expect(p.text('[data-pi-status]')).toBe('This item is Secret. Secret items are not changed from here.');
    expect(p.text('[data-pi-item="oti_inv"]')).not.toContain(C.changedByYou);
    expect(p.$('[data-pi-undo]')).toBeNull();
    expect(p.$('[data-pi-toast]')!.hasAttribute('hidden')).toBe(true);
  });
});

describe('the judge\'s reason', () => {
  test('one table of short phrases; unknown codes have none', () => {
    expect(judgeReasonPhrase('financial:0.90')).toBe('it has money details, like amounts or account numbers.');
    expect(judgeReasonPhrase('record_held:health:0.80')).toBe('it is about health.');
    expect(judgeReasonPhrase('decision:0.70')).toBeUndefined();
    expect(judgeReasonPhrase('other:0.70')).toBeUndefined();
    expect(judgeReasonPhrase('toString')).toBeUndefined();
    expect(judgeReasonPhrase(null)).toBeUndefined();
  });
});
