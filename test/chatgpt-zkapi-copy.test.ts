// Anonymous answers inside ChatGPT (owner decision 2026-10-10, for the
// ChatGPT plugin directory): the money side of zkAPI stays outside ChatGPT.
// Tool descriptions, tool results and the private question panel carry no
// money words, no amounts and no add-money link; one neutral line says each
// question uses the user's zkAPI balance; an empty balance is told as such and
// routed to Olympus on the user's computer. The Mac dashboard's own card is
// not ChatGPT and keeps its costs and risks (test/dashboard-outside-help.test.ts).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSULT_ASK_MESSAGES } from '../src/core/consult-ask.ts';
import { ZKAPI_CONSULT_ERROR_MESSAGES, type ZkapiConsultErrorCode } from '../src/core/consult-transport-zkapi.ts';
import { ASK_ANONYMOUSLY_TOOL, OPEN_PRIVATE_QUESTION_TOOL } from '../src/workers/chatgpt/mcp-surface.ts';
import { resultOf } from '../src/workers/chatgpt/private-question-jobs.ts';
import { askAnonymouslyToolResult, PRIVATE_QUESTION_OPENED_TEXT, PRIVATE_QUESTION_UNAVAILABLE_TEXT } from '../src/workers/chatgpt/response-builder.ts';
import {
  CHATGPT_ZKAPI_BALANCE_RUN_OUT,
  CHATGPT_ZKAPI_FORBIDDEN_TERMS,
  CHATGPT_ZKAPI_TOOL_ACCOUNT_SENTENCE,
  chatgptZkapiRouteLabel,
} from '../src/workers/chatgpt/zkapi-copy.ts';
import { DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY } from '../src/workers/dashboard/vocabulary.ts';

const ZKAPI_TOOLS = [ASK_ANONYMOUSLY_TOOL, OPEN_PRIVATE_QUESTION_TOOL];

/** Every string a tool definition shows the model: title, description, input descriptions. */
function toolStrings(tool: { title?: string; description: string; inputSchema: unknown }): string[] {
  const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
  return [tool.title ?? '', tool.description, ...Object.values(properties).map((property) => property.description ?? '')];
}

function expectClean(text: string, where: string): void {
  const hit = CHATGPT_ZKAPI_FORBIDDEN_TERMS.exec(text);
  expect(hit ? `${where}: "${hit[0]}" in ${text}` : '').toBe('');
}

describe('the forbidden-terms check itself', () => {
  test('catches the money words and lets the allowed ones through', () => {
    for (const bad of ['paid per question', 'Pay with ETH', 'a $2 hold', 'on-chain deposit', 'top up your wallet', 'add money', 'funding date', 'network fee', 'may have been charged', 'daily spend limit', 'crypto']) {
      expect(CHATGPT_ZKAPI_FORBIDDEN_TERMS.test(bad)).toBe(true);
    }
    for (const fine of [CHATGPT_ZKAPI_TOOL_ACCOUNT_SENTENCE, 'Uses your zkAPI balance.', CHATGPT_ZKAPI_BALANCE_RUN_OUT, 'Ask anonymously']) {
      expect(CHATGPT_ZKAPI_FORBIDDEN_TERMS.test(fine)).toBe(false);
    }
  });
});

describe('ChatGPT tool definitions', () => {
  test('ask_anonymously and open_private_question carry no money words and one account sentence each', () => {
    for (const tool of ZKAPI_TOOLS) {
      for (const text of toolStrings(tool)) expectClean(text, tool.name);
      expect(tool.description.split(CHATGPT_ZKAPI_TOOL_ACCOUNT_SENTENCE)).toHaveLength(2);
      // The existing rule stays: only when the user explicitly asks.
      expect(tool.description).toMatch(/whenever the user asks|only when the user/);
    }
  });

  test('the relay\'s generated copy says the same', () => {
    const generated = JSON.parse(readFileSync(join(import.meta.dir, '..', 'connect-relay/server/generated/chatgpt-tools.json'), 'utf8')) as { tools: Array<{ name: string; title?: string; description: string; inputSchema: unknown }> };
    for (const name of ZKAPI_TOOLS.map((tool) => tool.name)) {
      const tool = generated.tools.find((entry) => entry.name === name)!;
      expect(tool).toBeDefined();
      for (const text of toolStrings(tool)) expectClean(text, `generated ${name}`);
    }
  });

  test('the open_private_question results are clean too', () => {
    expectClean(PRIVATE_QUESTION_OPENED_TEXT, 'opened');
    expectClean(PRIVATE_QUESTION_UNAVAILABLE_TEXT, 'unavailable');
  });
});

describe('the private question panel', () => {
  test('every word the panel shows is clean, and the one side-effect line is neutral', () => {
    for (const [key, value] of Object.entries(DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY)) expectClean(value, `panel ${key}`);
    expect(DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY.cost).toBe('Uses your zkAPI balance.');
  });

  test('the generated panel resource carries no money words in its copy', () => {
    const resource = readFileSync(join(import.meta.dir, '..', 'connect-relay/server/generated/chatgpt-private-question.json'), 'utf8');
    expect(resource).toContain('Uses your zkAPI balance.');
    expect(resource).not.toContain('Paid from');
    expect(resource).not.toContain('payment was private');
  });
});

describe('refusals as ChatGPT and the panel tell them', () => {
  const askCodes: Record<string, string> = { noRoute: 'route_not_configured', cancelled: 'cancelled', off: 'anonymous_answers_off' };

  test('every engine refusal reads without money words, in the tool result and in the panel', () => {
    const cases: Array<[string, string]> = [
      ...(Object.entries(ZKAPI_CONSULT_ERROR_MESSAGES) as Array<[ZkapiConsultErrorCode, string]>),
      ...Object.entries(CONSULT_ASK_MESSAGES).filter(([key]) => key !== 'needsChoice').map(([key, message]): [string, string] => [askCodes[key] ?? key, message]),
    ];
    for (const [code, message] of cases) {
      for (const outcome of ['not_sent', 'sent_failed'] as const) {
        const result = askAnonymouslyToolResult({ ok: false, code, message, outcome });
        expectClean(JSON.stringify(result), `tool ${code}`);
        const sealed = resultOf({ ok: false, code, message, outcome });
        expectClean(JSON.stringify(sealed), `panel ${code}`);
      }
    }
  });

  test('an empty balance (the daemon\'s 402 funding_required) is told as such, with a route and no add-money step', () => {
    const raw = { ok: false, code: 'daemon_error', message: ZKAPI_CONSULT_ERROR_MESSAGES.daemon_error, sent: 'q', outcome: 'sent_failed', daemonCode: 'funding_required' } as const;
    const result = askAnonymouslyToolResult(raw);
    expect(result.structuredContent).toMatchObject({ status: 'refused', code: 'balance_run_out', message: 'Your zkAPI balance has run out. Olympus on your computer has the details.' });
    expect(result.content[0]!.text).toBe('Not answered: Your zkAPI balance has run out. Olympus on your computer has the details.');
    expect(JSON.stringify(result)).not.toMatch(/https?:|add |daemonCode|funding/i);
    expect(resultOf(raw)).toMatchObject({ state: 'refused', code: 'balance_run_out', message: CHATGPT_ZKAPI_BALANCE_RUN_OUT });
    // Any other daemon error keeps its own words.
    expect(askAnonymouslyToolResult({ ...raw, daemonCode: 'upstream_error' }).structuredContent).toMatchObject({ code: 'daemon_error', message: ZKAPI_CONSULT_ERROR_MESSAGES.daemon_error });
  });

  test('not set up and turned off are informational, with a route to Olympus on the computer', () => {
    expect(askAnonymouslyToolResult({ ok: false, code: 'route_not_configured', message: CONSULT_ASK_MESSAGES.noRoute }).structuredContent)
      .toMatchObject({ code: 'route_not_configured', message: 'Anonymous answers are not set up yet. Olympus on your computer has the details.' });
    expect(askAnonymouslyToolResult({ ok: false, code: 'anonymous_answers_off', message: CONSULT_ASK_MESSAGES.off }).structuredContent)
      .toMatchObject({ code: 'anonymous_answers_off', message: CONSULT_ASK_MESSAGES.off });
  });

  test('a reworded refusal keeps what the engine appended after its fixed sentence', () => {
    const note = 'The choice could not be saved here; it was used for this question only.';
    const result = askAnonymouslyToolResult({ ok: false, code: 'timeout', message: `${ZKAPI_CONSULT_ERROR_MESSAGES.timeout} ${note}`, outcome: 'unknown' });
    expect((result.structuredContent as { message: string }).message).toBe(`The zkAPI question timed out; it may still have used some of your zkAPI balance. ${note}`);
  });
});

describe('route labels', () => {
  const labels: Array<[string, string, RegExp]> = [
    ['anonymous route (payment, key and network identity hidden)', 'hidden', /^anonymous route \(key and network identity hidden\)$/],
    ['payment privacy only (network address visible)', 'visible', /^network address visible$/],
    ['payment privacy only: the daemon still reached the network after Tor stopped (Tor bypass observed)', 'visible', /Tor bypass observed/],
    ['payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; no network confinement', 'not_verified', /actual route is not verified; no network confinement$/],
    ['payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; no network confinement; lease settlement not confirmed', 'not_verified', /no network confinement$/],
    ['payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; no network confinement; lease settlement pending', 'not_verified', /no network confinement$/],
    ['not anonymous: key isolation or local authentication not confirmed', 'not_verified', /^not anonymous: key isolation/],
  ];

  test('read without payment or settlement clauses, keeping the network facts', () => {
    for (const [label, identity, kept] of labels) {
      const shown = chatgptZkapiRouteLabel(label, identity);
      expectClean(shown, label);
      expect(shown).toMatch(kept);
      const result = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y', route: label, networkIdentity: identity, level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false });
      expectClean(JSON.stringify(result), `answered via ${label}`);
    }
  });
});
