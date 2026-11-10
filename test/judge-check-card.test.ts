// The "Check how Olympus labelled your items" card at the top of Privacy › Your items (issue
// #887; mockups L3-4, L3-5), run in a page against the real round logic
// (judge-check.ts) over fixture items: the judge's label is hidden until the
// owner answers, mid-round there is a count and no range, and the finished
// round shows the count, plus the Wilson range as a band only once 30
// randomly picked items are answered.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import { createJudgeCheck, JUDGE_CHECK_RANDOM_PICKS, JUDGE_CHECK_RANGE_MIN_ANSWERS, wilsonInterval } from '../src/workers/classification/judge-check.ts';
import type { OwnerTierItem } from '../src/workers/classification/tier-owner-items.ts';
import { DASHBOARD_JUDGE_CHECK_PATH, JUDGE_CHECK_ITEMS_CHANGED_EVENT } from '../src/workers/dashboard/pages/judge-check.ts';
import { renderDashboardPrivateAnswersPage } from '../src/workers/dashboard/pages/private-answers.ts';
import { PRIVACY_ITEMS_LIST_ID, renderDashboardPrivacyItemsPage } from '../src/workers/dashboard/pages/privacy-items.ts';
import { DASHBOARD_JUDGE_CHECK_COPY as J } from '../src/workers/dashboard/vocabulary.ts';
import { flushMicrotasks } from './helpers/test-clock.ts';

let root: string;
const windows: Window[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'olympus-judge-card-')); });
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
  rmSync(root, { recursive: true, force: true });
});

const items: OwnerTierItem[] = Array.from({ length: 10 }, (_, index) => ({
  item_id: `oti_${index}`, source: 'telegram', family: 'message', title: `Message ${index}`, sender: 'Tiago', location: null,
  tier: index < 5 ? 'Private' : 'Personal', names_tier: 'Personal', decided_by: 'sniffer', owner_set: false,
  judge_reason: `ordinary:0.${index}0`, decided_at: '2026-11-03T10:00:00.000Z', preview: `Text ${index}`,
}));

async function card(earlier?: { compared: number; agreed: number }, failSet = false) {
  if (earlier) writeFileSync(join(root, 'judge-check.json'), JSON.stringify({ v: 1, random_tally: earlier }));
  const check = createJudgeCheck({
    items: { find: () => ({ items }), set: () => (failSet ? { ok: false as const, code: 'secret_item' as const, message: 'Secret' } : { ok: true as const, item: items[0]!, changed: 'set' as const, applies: 'now' as const, results: [] }) },
    get: (id) => items.find((item) => item.item_id === id),
    path: join(root, 'judge-check.json'),
    random: () => 0.5,
  });
  const html = renderDashboardPrivacyItemsPage({
    now: DASHBOARD_PREVIEW_NOW,
    controlSessionCsrfToken: 'csrf-token',
    outsideHelpLocalSession: true,
  });
  const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?privacy-items' });
  windows.push(window);
  const document = window.document;
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-judge-check]'))!;
  const fetchStub = async (path: string, init: { body: string; headers: Record<string, string> }) => {
    expect(path).toBe(DASHBOARD_JUDGE_CHECK_PATH);
    expect(init.headers['X-Olympus-CSRF']).toBe('csrf-token');
    const request = JSON.parse(init.body) as { action: string; item_id?: string; answer?: 'Personal' | 'Private' | 'not_sure' };
    const round = request.action === 'start' ? check.start()
      : request.action === 'answer' ? check.answer(request.item_id!, request.answer!)
        : request.action === 'put_away' ? check.putAway() : request.action === 'resume' ? check.resume() : check.status();
    return { ok: true, status: 200, json: async () => ({ ok: true, round }) };
  };
  new Function('window', 'document', 'fetch', script)({ location: window.location }, document, fetchStub);
  await flushMicrotasks();
  const $ = (selector: string) => document.querySelector(selector) as unknown as (HTMLElement & { click(): void }) | null;
  const click = async (selector: string) => { $(selector)!.click(); await flushMicrotasks(); };
  const text = (selector: string) => $(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const current = () => $('[data-jc-item]')!.getAttribute('data-jc-item')!;
  return { $, click, text, current, document };
}

describe('Check how Olympus labelled your items', () => {
  test('sits at the top of Your items as an optional offer until started', async () => {
    const c = await card();
    expect(c.$('[data-privacy-items] > [data-judge-check]')).not.toBeNull();
    expect(c.text('[data-jc-offer]')).toContain(J.offer);
    expect(c.text('[data-jc-offer]')).toContain(J.optional);
    await c.click('[data-jc-act="start"]');
    expect(c.text('[data-jc-position]')).toBe('Item 1 of 10');
  });

  test('the judge\'s label is hidden until the owner answers; mid-round a plain count, no range', async () => {
    const c = await card();
    await c.click('[data-jc-act="start"]');
    const item = c.$('[data-jc-item]')!;
    expect(item.textContent).not.toContain('Judge');
    expect(c.$('[data-jc-answered-list]')).toBeNull();
    const first = c.current();
    const judge = items.find((candidate) => candidate.item_id === first)!.tier!;
    await c.click(`[data-jc-answer="${judge}"]`);
    expect(c.text(`[data-jc-answered="${first}"]`)).toContain(J.agreed);
    const second = c.current();
    const other = items.find((candidate) => candidate.item_id === second)!.tier === 'Personal' ? 'Private' : 'Personal';
    await c.click(`[data-jc-answer="${other}"]`);
    expect(c.text(`[data-jc-answered="${second}"]`)).toContain('changed');
    expect(c.text('[data-jc-sofar]')).toBe(`So far the judge agreed with you on 1 of 2. ${J.tooFew}`);
    expect(c.$('[data-jc-range]')).toBeNull();
    // Stop for now keeps the answers and picks up where it stopped.
    await c.click('[data-jc-act="put_away"]');
    expect(c.text('[data-jc-offer]')).toContain('You answered 2 of 10.');
    await c.click('[data-jc-act="resume"]');
    expect(c.text('[data-jc-position]')).toBe('Item 3 of 10');
  });

  test('an answer that sets an item tells Your items below to reload; agreeing does not', async () => {
    const c = await card();
    let reloads = 0;
    let changedId: string | undefined;
    c.$('[data-privacy-items]')!.addEventListener(JUDGE_CHECK_ITEMS_CHANGED_EVENT, (event) => { reloads += 1; changedId = (event as unknown as { itemId?: string }).itemId; });
    await c.click('[data-jc-act="start"]');
    const tierOf = (id: string) => items.find((candidate) => candidate.item_id === id)!.tier!;
    await c.click(`[data-jc-answer="${tierOf(c.current())}"]`);
    expect(reloads).toBe(0);
    const differing = c.current();
    await c.click(`[data-jc-answer="${tierOf(differing) === 'Personal' ? 'Private' : 'Personal'}"]`);
    expect(reloads).toBe(1);
    // It names the item, so the list drops its own earlier change to it.
    expect(changedId).toBe(differing);
  });

  const finishRound = async (c: Awaited<ReturnType<typeof card>>) => {
    await c.click('[data-jc-act="start"]');
    for (let index = 0; index < 10; index += 1) {
      const id = c.current();
      const judge = items.find((candidate) => candidate.item_id === id)!.tier!;
      await c.click(`[data-jc-answer="${index === 0 ? (judge === 'Personal' ? 'Private' : 'Personal') : judge}"]`);
    }
    const stored = JSON.parse(readFileSync(join(root, 'judge-check.json'), 'utf8')) as { round: { items: Array<{ random?: boolean; answer: string; judge: string }> } };
    const picks = stored.round.items.filter((item) => item.random);
    return { picks: picks.length, agreed: picks.filter((item) => item.answer === item.judge).length };
  };

  test('a finished round below 30 random answers shows the plain count, no percentage or range, and asks for more', async () => {
    const c = await card();
    const { picks } = await finishRound(c);
    expect(c.text('[data-jc-count]')).toBe('The judge agreed with you on 9 of 10.');
    expect(c.text('[data-jc-need]')).toBe(`${J.roundMix} A reliable accuracy number needs answers about ${JUDGE_CHECK_RANGE_MIN_ANSWERS} items picked at random. You have answered ${picks} so far, and each round adds ${JUDGE_CHECK_RANDOM_PICKS}.`);
    expect(c.$('[data-jc-range]')).toBeNull();
    expect(c.text('[data-jc-result]')).not.toContain('%');
    expect(c.text('.jchonest')).toBe(J.fixesOnly);
    expect(c.text('[data-jc-fixed]')).toContain('1 changed to your answer · 9 confirmed · 0 “Not sure” left with the judge');
    expect(c.$('[data-jc-act="start"]')!.textContent).toBe(J.more);
    // "See them in Your items" goes to the list below the card, on the same tab.
    expect(c.$('[data-jc-fixed] a')!.getAttribute('href')).toBe(`#${PRIVACY_ITEMS_LIST_ID}`);
  });

  test('an answer that could not be applied says so, and never reads as changed', async () => {
    const c = await card(undefined, true);
    await finishRound(c);
    const row = c.text('[data-jc-fixed] [data-jc-answered]');
    expect(row).toContain('not changed, it can no longer be changed here');
    expect(c.text('[data-jc-fixed]')).toContain('0 changed to your answer');
  });

  test('once 30 random answers are in, the finished round shows the likely range as a band', async () => {
    const c = await card({ compared: 27, agreed: 24 });
    const now = await finishRound(c);
    // The range rests on the random picks alone (classification/judge-check.ts).
    const from = 27 + now.picks;
    const range = wilsonInterval(24 + now.agreed, from);
    const low = Math.round(range.low * 100);
    const high = Math.round(range.high * 100);
    expect(c.text('[data-jc-result]')).toContain(`From ${from} answers about items picked at random, it would likely agree with you on ${low}% to ${high}% of your items.`);
    expect(c.$('[data-jc-need]')).toBeNull();
    expect(c.$('[data-jc-range] i')!.getAttribute('style')).toBe(`left:${low}%;width:${high - low}%`);
    expect(c.text('.jchonest')).toBe(`${J.roundMix} ${J.honest}`);
  });
});

describe('where the card lives', () => {
  test('at the top of Your items, and nowhere in Private questions', () => {
    const items = renderDashboardPrivacyItemsPage({ now: DASHBOARD_PREVIEW_NOW, controlSessionCsrfToken: 'csrf-token', outsideHelpLocalSession: true });
    expect(items.indexOf('data-judge-check')).toBeGreaterThan(-1);
    expect(items.indexOf('data-judge-check')).toBeLessThan(items.indexOf('data-pi-list'));
    const questions = renderDashboardPrivateAnswersPage({
      now: DASHBOARD_PREVIEW_NOW,
      controlSessionCsrfToken: 'csrf-token',
      outsideHelpLocalSession: true,
      privateAnswers: { available: true, destinations: { computer: 'ready', venice: 'not_allowed' }, waiting: { questions: [], olderRemoved: false } },
    });
    expect(questions).not.toContain('data-judge-check');
    expect(questions).not.toContain(J.title);
  });
});
