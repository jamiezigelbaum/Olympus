// The "Check the judge" card at the top of Private questions' Inbox (issue
// #887; mockups L3-4, L3-5), run in a page against the real round logic
// (judge-check.ts) over fixture items: the judge's label is hidden until the
// owner answers, mid-round there is a count and no range, and the finished
// round shows the count and the Wilson range as a band.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import { createJudgeCheck, wilsonInterval } from '../src/workers/classification/judge-check.ts';
import type { OwnerTierItem } from '../src/workers/classification/tier-owner-items.ts';
import { DASHBOARD_JUDGE_CHECK_PATH } from '../src/workers/dashboard/pages/judge-check.ts';
import { renderDashboardPrivateAnswersPage } from '../src/workers/dashboard/pages/private-answers.ts';
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

async function card() {
  const check = createJudgeCheck({
    items: { find: () => ({ items }), set: () => ({ ok: true, item: items[0]!, changed: 'set', applies: 'now', results: [] }) },
    get: (id) => items.find((item) => item.item_id === id),
    path: join(root, 'judge-check.json'),
    random: () => 0.5,
  });
  const html = renderDashboardPrivateAnswersPage({
    now: DASHBOARD_PREVIEW_NOW,
    controlSessionCsrfToken: 'csrf-token',
    outsideHelpLocalSession: true,
    privateAnswers: { available: true, destinations: { computer: 'ready', venice: 'not_allowed' }, waiting: { questions: [], olderRemoved: false } },
  });
  const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?private-answers' });
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

describe('Check the judge', () => {
  test('sits at the top of the Inbox as an optional offer until started', async () => {
    const c = await card();
    expect(c.$('#waiting')).not.toBeNull();
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

  test('a finished round shows the count, the likely range as a band, and Check 10 more', async () => {
    const c = await card();
    await c.click('[data-jc-act="start"]');
    for (let index = 0; index < 10; index += 1) {
      const id = c.current();
      const judge = items.find((candidate) => candidate.item_id === id)!.tier!;
      await c.click(`[data-jc-answer="${index === 0 ? (judge === 'Personal' ? 'Private' : 'Personal') : judge}"]`);
    }
    expect(c.text('[data-jc-count]')).toBe('The judge agreed with you on 9 of 10.');
    const range = wilsonInterval(9, 10);
    const low = Math.round(range.low * 100);
    const high = Math.round(range.high * 100);
    expect(c.text('[data-jc-result]')).toContain(`it would likely agree with you on ${low}% to ${high}% of your items.`);
    const band = c.$('[data-jc-range] i')!.getAttribute('style');
    expect(band).toBe(`left:${low}%;width:${high - low}%`);
    expect(c.text('[data-jc-fixed]')).toContain('1 changed to your answer · 9 confirmed · 0 “Not sure” left with the judge');
    expect(c.$('[data-jc-act="start"]')!.textContent).toBe(J.more);
  });
});
