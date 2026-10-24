// Strict or Standard per question on the Ask page (owner decision 2026-10-24):
// the zkAPI row offers both, starting at the saved setting, and the choice goes
// with that one question to the anonymous ask lane. A Strict question is
// rewritten into general questions and a Standard one is not, whichever level
// is saved. The page route and the lane run for real; only the writer and
// zkAPI are stand-ins.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { askAnonymously, consultAskLevelOrSaved, type ConsultAskDependencies } from '../src/core/consult-ask.ts';
import { DEFAULT_CONSULT_SETTINGS, type ConsultSettings, type ConsultSettingsRead } from '../src/core/consult-settings.ts';
import type { ConsultLevel } from '../src/core/consult-gate.ts';
import { DASHBOARD_PREVIEW_NOW, previewOutsideHelp } from '../scripts/dashboard-preview.ts';
import { renderDashboardPrivateAnswersPage } from '../src/workers/dashboard/pages/private-answers.ts';
import { createLocalPrivateAnswers } from '../src/workers/email-source/local-private-answers.ts';

const TYPED = 'When will Jo at Heron Lettings return my deposit?';
const GENERAL = 'How long do landlords usually take to return a deposit?';

function lane(saved: ConsultLevel, extra: Partial<ConsultSettings> = {}) {
  const read: ConsultSettingsRead = { state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 2, enabled: true, level: saved, ...extra } };
  const calls = { writerLevels: [] as ConsultLevel[], sent: [] as string[] };
  const deps: ConsultAskDependencies = {
    settings: () => read,
    prepare: async (_input, _writer, level) => { calls.writerLevels.push(level); return { kind: 'questions', questions: [GENERAL], promptTokens: 1, ms: 1 }; },
    send: async (question, authorize) => {
      if (!authorize()) return { ok: false, error: { code: 'authorization_refused', message: 'refused', outcome: 'not_sent', networkIdentity: 'not_verified' } };
      calls.sent.push(question);
      return { ok: true, text: 'Usually within two weeks.', routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt: {} as never, elapsedMs: 5 };
    },
  };
  // The page route, wired as the worker wires it: the picked level, else the saved one.
  const route = createLocalPrivateAnswers({
    store: () => undefined,
    answer: async () => ({ status: 'not_found', leftOut: [] }),
    anonymousAsk: (input) => askAnonymously({ ...input, level: consultAskLevelOrSaved(input.level, read) }, deps),
  });
  return { route, calls };
}

describe('the zkAPI ask route takes Strict or Standard per question', () => {
  for (const saved of ['unnamed', 'general'] as const) {
    test(`saved ${saved === 'general' ? 'Strict' : 'Standard'}: a Strict question is rewritten, a Standard one goes as written`, async () => {
      const strict = lane(saved, { standardMode: 'as_written' });
      const strictReply = await strict.route.handle({ action: 'ask_anonymous', question: TYPED, level: 'strict' }, 'local');
      expect(strictReply.status).toBe(200);
      expect(strictReply.body.sent).toBe(GENERAL);
      expect(strict.calls.writerLevels).toEqual(['general']);
      expect(strict.calls.sent).toEqual([GENERAL]);

      const standard = lane(saved, { standardMode: 'as_written' });
      const standardReply = await standard.route.handle({ action: 'ask_anonymous', question: TYPED, level: 'standard' }, 'local');
      expect(standardReply.status).toBe(200);
      expect(standardReply.body.sent).toBe(TYPED);
      expect(standard.calls.writerLevels).toEqual([]);
      expect(standard.calls.sent).toEqual([TYPED]);
    });
  }

  test('Standard with light cleanup is prepared at Standard, never rewritten into general questions', async () => {
    const { route, calls } = lane('general');
    expect((await route.handle({ action: 'ask_anonymous', question: TYPED, level: 'standard' }, 'local')).status).toBe(200);
    expect(calls.writerLevels).toEqual(['unnamed']);
  });

  test('no level in the request uses the saved one; an unknown level sends nothing', async () => {
    const savedStrict = lane('general', { standardMode: 'as_written' });
    await savedStrict.route.handle({ action: 'ask_anonymous', question: TYPED }, 'local');
    expect(savedStrict.calls.writerLevels).toEqual(['general']);
    const savedStandard = lane('unnamed', { standardMode: 'as_written' });
    await savedStandard.route.handle({ action: 'ask_anonymous', question: TYPED }, 'local');
    expect(savedStandard.calls.sent).toEqual([TYPED]);

    const bad = lane('unnamed');
    const reply = await bad.route.handle({ action: 'ask_anonymous', question: TYPED, level: 'general' }, 'local');
    expect(reply.status).toBe(400);
    expect(bad.calls.writerLevels).toEqual([]);
    expect(bad.calls.sent).toEqual([]);
  });
});

describe('the Ask page offers the choice on the zkAPI row', () => {
  const windows: Window[] = [];
  afterEach(async () => { while (windows.length) await windows.pop()!.happyDOM.close(); });

  function page(saved: ConsultLevel) {
    const outsideHelp = previewOutsideHelp(true);
    const html = renderDashboardPrivateAnswersPage({
      now: DASHBOARD_PREVIEW_NOW,
      controlSessionCsrfToken: 'csrf-token',
      outsideHelpLocalSession: true,
      outsideHelp: { ...outsideHelp, settings: { ...outsideHelp.settings, level: saved } },
      privateAnswers: { available: true, destinations: { computer: 'ready', venice: 'not_allowed' }, waiting: { questions: [], olderRemoved: false } },
    });
    const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?private-answers' });
    windows.push(window);
    const document = window.document;
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-private-answers]'))!;
    // Each ask is followed by the inbox's list read; only the asks are kept.
    const posts: Array<Record<string, unknown>> = [];
    const fetchStub = async (_target: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.action !== 'list') posts.push(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'answered', answer: 'Reply', citations: [] }) };
    };
    const pageWindow = { location: window.location, confirm: () => true, addEventListener: () => undefined, setTimeout: () => undefined };
    new Function('window', 'document', 'fetch', script)(pageWindow, document, fetchStub);
    const ask = async (destination: 'anonymous' | 'computer') => {
      (document.querySelector('textarea') as unknown as { value: string }).value = TYPED;
      const form = document.querySelector('form[data-pa-ask]')!;
      const event = new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as { submitter: unknown };
      event.submitter = document.querySelector(`[data-pa-destination="${destination}"]`);
      form.dispatchEvent(event as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const checked = () => ([...document.querySelectorAll('[data-pa-level] input')] as unknown as Array<{ value: string; checked: boolean }>).find((input) => input.checked)!.value;
    const pick = (level: 'strict' | 'standard') => { (document.querySelector(`[data-pa-level] input[value="${level}"]`) as unknown as { click(): void }).click(); };
    return { document, posts, ask, checked, pick };
  }

  test('the choice starts at the saved setting', () => {
    expect(page('general').checked()).toBe('strict');
    expect(page('unnamed').checked()).toBe('standard');
    const text = page('unnamed').document.querySelector('[data-pa-card="anonymous"]')!.textContent;
    expect(text).toContain('How this question leaves');
    expect(text).toContain('Strict');
    expect(text).toContain('Standard');
  });

  test('the picked level goes with the zkAPI question only', async () => {
    const p = page('unnamed');
    p.pick('strict');
    await p.ask('anonymous');
    expect(p.posts.at(-1)).toEqual({ action: 'ask_anonymous', question: TYPED, level: 'strict' });
    p.pick('standard');
    await p.ask('anonymous');
    expect(p.posts.at(-1)).toEqual({ action: 'ask_anonymous', question: TYPED, level: 'standard' });
    await p.ask('computer');
    expect(p.posts.at(-1)).toEqual({ action: 'ask', question: TYPED });
  });
});
