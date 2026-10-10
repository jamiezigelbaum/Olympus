// Standard is open and the user's choice (owner decision 2026-10-10,
// docs/design/private-answers.md): the question goes out as written, lightly
// cleaned, or by the user's own instruction; the only outbound rule is
// secrets. "Ask anonymously" on the dashboard follows the same mode.

import { describe, expect, test } from 'bun:test';
import { askAnonymously, CONSULT_ASK_MAX_CHARS, CONSULT_ASK_MESSAGES, type ConsultAskDependencies } from '../src/core/consult-ask.ts';
import { CONSULT_GATE_STANDARD_MAX_QUESTION_BYTES, consultWriterContextFromPack, evaluateConsultRequest } from '../src/core/consult-gate.ts';
import { CONSULT_LIGHT_CLEANUP_INSTRUCTION, DEFAULT_CONSULT_SETTINGS, type ConsultSettingsRead } from '../src/core/consult-settings.ts';
import type { ZkapiConsultResult } from '../src/core/consult-transport-zkapi.ts';
import { CONSULT_STANDARD_REPLY_FORMAT, buildConsultWriterPrompt, parseConsultWriterReply, type ConsultWriterInput } from '../src/core/consult-writer.ts';
import { privateEvidencePack } from '../src/core/analyst-built-in.ts';

const FAKE_KEY = ['sk', '-', 'Zq8Rr7Tt6Yy5Uu4Ii3Oo2Pp1'].join('');
const SNAPSHOT_PASSWORD = ['Heron', 'quay', '77!'].join('');

function secrets(questions: string[], snapshot = 'The lease for Marguerite Okafor at 14 Heron Quay ends in May; deposit 2,375.50.') {
  const pack = privateEvidencePack('When does my lease end?', [{ id: 'lease', title: 'Lease', text: snapshot }]);
  return evaluateConsultRequest(questions, consultWriterContextFromPack(pack, { writerVisibleTexts: ['When does my lease end?'] }), {}, {}, { languages: ['en'], level: 'unnamed', net: 'secrets' });
}

describe('the secrets net', () => {
  test('names, places, figures and copied words pass; only secrets are refused', () => {
    expect(secrets(['Can Marguerite Okafor keep the 2,375.50 deposit for 14 Heron Quay after the lease ends in May?'])).toEqual({ decision: 'pass', reasons: [] });
    expect(secrets([`Why would the key ${FAKE_KEY} be rejected?`])).toEqual({ decision: 'refuse', reasons: ['secret_detected'] });
    expect(secrets([`Is ${['pass', 'word', ': ', 'hunter2hunter2'].join('')} strong enough?`])).toEqual({ decision: 'refuse', reasons: ['secret_detected'] });
    // A labelled secret in the snapshot, repeated without its label.
    expect(secrets([`Is ${SNAPSHOT_PASSWORD} a strong choice for a router?`], `Router password: ${SNAPSHOT_PASSWORD}`)).toEqual({ decision: 'refuse', reasons: ['secret_detected'] });
    expect(secrets(['   '])).toEqual({ decision: 'refuse', reasons: ['question_empty'] });
  });

  test('a long question is bounded only by the transport (8 KiB), not the general-question size', () => {
    const long = `${'Please explain the usual deposit rules in detail. '.repeat(30)}What applies here?`;
    expect(new TextEncoder().encode(long).byteLength).toBeGreaterThan(600);
    expect(secrets([long])).toEqual({ decision: 'pass', reasons: [] });
    expect(secrets(['x'.repeat(CONSULT_GATE_STANDARD_MAX_QUESTION_BYTES + 1)])).toEqual({ decision: 'refuse', reasons: ['question_too_many_bytes'] });
  });
});

describe('the writer under Standard', () => {
  const input: ConsultWriterInput = { question: 'When will Jo at Heron Lettings return my deposit?', answer: '', gaps: [], instruction: 'Write it in Dutch.\nKeep my name out.' };

  test('the user\'s instruction is the whole system prompt, wrapped only by the fixed reply format; the question (and evidence) follow', () => {
    const messages = buildConsultWriterPrompt({ ...input, evidence: ['Lease: ends in May.'] }, 'unnamed');
    expect(messages[0]).toEqual({ role: 'system', content: `Write it in Dutch.\nKeep my name out.\n\n${CONSULT_STANDARD_REPLY_FORMAT}` });
    expect(messages[1]!.content).toContain('When will Jo at Heron Lettings return my deposit?');
    expect(messages[1]!.content).toContain('Lease: ends in May.');
    expect(JSON.stringify(messages)).not.toContain('Vitalik');
  });

  test('the reply is checked for shape only: names and longer text are kept; null sends nothing; control characters are refused', () => {
    expect(parseConsultWriterReply('{"questions": ["Wanneer krijgt Jo mijn borg terug?\\nHet huurcontract eindigt in mei."]}', { standard: true }))
      .toEqual({ kind: 'questions', questions: ['Wanneer krijgt Jo mijn borg terug?\nHet huurcontract eindigt in mei.'] });
    expect(parseConsultWriterReply('{"questions": null}', { standard: true })).toEqual({ kind: 'declined' });
    expect(parseConsultWriterReply('{"questions": ["bad\\u0007bell"]}', { standard: true })).toEqual({ kind: 'invalid', reason: 'form' });
    // Strict's form rules still apply without the flag.
    expect(parseConsultWriterReply('{"questions": ["Wanneer krijgt Jo mijn borg terug?\\nHet huurcontract eindigt in mei."]}')).toEqual({ kind: 'invalid', reason: 'form' });
  });
});

describe('Ask anonymously', () => {
  const settings = (extra: Partial<typeof DEFAULT_CONSULT_SETTINGS> = {}): ConsultSettingsRead => ({ state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 2, ...extra } });
  const reply = (text: string): ZkapiConsultResult => ({ ok: true, text, routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt: {} as never, elapsedMs: 5 });

  function deps(read: ConsultSettingsRead, prepared: Awaited<ReturnType<ConsultAskDependencies['prepare']>> = { kind: 'questions', questions: ['How long do landlords usually take to return a deposit?'], promptTokens: 1, ms: 1 }) {
    const calls = { prepare: [] as ConsultWriterInput[], send: [] as string[] };
    const value: ConsultAskDependencies = {
      settings: () => read,
      prepare: async (input) => { calls.prepare.push(input); return prepared; },
      // Like the transport: final authorization runs just before dispatch; false sends nothing.
      send: async (question, authorize) => {
        if (!authorize()) return { ok: false, error: { code: 'authorization_refused', message: 'refused', outcome: 'not_sent', networkIdentity: 'not_verified' } };
        calls.send.push(question);
        return reply('Usually within two weeks.');
      },
    };
    return { value, calls };
  }

  test('light cleanup (the default) prepares the typed question with the preset and returns exactly what was sent', async () => {
    const d = deps(settings());
    const result = await askAnonymously('  When will Jo return my deposit?  ', d.value);
    expect(d.calls.prepare).toEqual([{ question: 'When will Jo return my deposit?', answer: '', gaps: [], instruction: CONSULT_LIGHT_CLEANUP_INSTRUCTION }]);
    expect(d.calls.send).toEqual(['How long do landlords usually take to return a deposit?']);
    expect(result).toEqual({ ok: true, sent: 'How long do landlords usually take to return a deposit?', reply: 'Usually within two weeks.', route: 'zkAPI via Tor' });
  });

  test('as written sends the typed question unchanged with no model; custom sends the user\'s instruction', async () => {
    const plain = deps(settings({ standardMode: 'as_written' }));
    expect(await askAnonymously('When will Jo return my deposit?', plain.value)).toMatchObject({ ok: true, sent: 'When will Jo return my deposit?' });
    expect(plain.calls.prepare).toEqual([]);
    const custom = deps(settings({ standardMode: 'custom', standardInstruction: 'Ask it in Dutch.' }));
    await askAnonymously('When will Jo return my deposit?', custom.value);
    expect(custom.calls.prepare[0]!.instruction).toBe('Ask it in Dutch.');
  });

  test('nothing is sent when the question is empty or too long, the settings are unreadable, the model declines or fails, or a secret is in it', async () => {
    const none = deps(settings());
    expect(await askAnonymously('  ', none.value)).toMatchObject({ ok: false, code: 'question_empty' });
    expect(await askAnonymously('x'.repeat(CONSULT_ASK_MAX_CHARS + 1), none.value)).toMatchObject({ ok: false, code: 'question_too_long' });
    expect(await askAnonymously('x', deps({ state: 'invalid', reason: 'malformed_json' } as unknown as ConsultSettingsRead).value)).toMatchObject({ ok: false, code: 'settings_invalid' });
    expect(await askAnonymously('x', deps(settings(), { kind: 'declined', promptTokens: 1, ms: 1 }).value)).toEqual({ ok: false, code: 'writer_declined', message: CONSULT_ASK_MESSAGES.declined });
    expect(await askAnonymously('x', deps(settings(), { kind: 'failed', reason: 'form' }).value)).toMatchObject({ ok: false, code: 'writer_failed' });
    const keyed = deps(settings({ standardMode: 'as_written' }));
    const refused = await askAnonymously(`Why is ${FAKE_KEY} rejected?`, keyed.value);
    expect(refused).toMatchObject({ ok: false, code: 'secret_detected', message: CONSULT_ASK_MESSAGES.secret });
    expect(keyed.calls.send).toEqual([]);
    expect(none.calls.send).toEqual([]);
  });

  test('the transport\'s refusals come back as they are: no route, or a model the listing lacks', async () => {
    const noRoute: ConsultAskDependencies = { ...deps(settings({ standardMode: 'as_written' })).value, send: async () => undefined };
    expect(await askAnonymously('What is a deposit?', noRoute)).toEqual({ ok: false, code: 'route_not_configured', message: CONSULT_ASK_MESSAGES.noRoute });
    const missing: ConsultAskDependencies = {
      ...deps(settings({ standardMode: 'as_written' })).value,
      send: async () => ({ ok: false, error: { code: 'model_unavailable', message: 'not listed', outcome: 'not_sent', networkIdentity: 'not_verified' } }),
    };
    expect(await askAnonymously('What is a deposit?', missing)).toEqual({ ok: false, code: 'model_unavailable', message: 'not listed', sent: 'What is a deposit?' });
  });

  test('a labelled secret in the typed question stays refused, with or without its label (review of PR #209)', async () => {
    const plain = deps(settings({ standardMode: 'as_written' }));
    expect(await askAnonymously('Is password: hunter2 safe?', plain.value)).toMatchObject({ ok: false, code: 'secret_detected' });
    // The writer dropped the label but kept the value.
    const dropped = deps(settings(), { kind: 'questions', questions: ['Is hunter2 a safe choice?'], promptTokens: 1, ms: 1 });
    expect(await askAnonymously('Is password: hunter2 safe?', dropped.value)).toMatchObject({ ok: false, code: 'secret_detected' });
    expect([...plain.calls.send, ...dropped.calls.send]).toEqual([]);
  });

  test('a change to the mode, instruction, writer or revision while the question is prepared refuses the send as stale (review of PR #209)', async () => {
    const changes: Array<Partial<typeof DEFAULT_CONSULT_SETTINGS>> = [
      { standardMode: 'custom', standardInstruction: 'Two.' },
      { standardMode: 'as_written' },
      { writer: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' } },
      { revision: 3, standardMode: 'custom', standardInstruction: 'One.' },
    ];
    for (const change of changes) {
      let current = settings({ standardMode: 'custom', standardInstruction: 'One.' });
      const d = deps(current);
      const value: ConsultAskDependencies = {
        ...d.value,
        settings: () => current,
        prepare: async (input) => {
          current = settings({ standardMode: 'custom', standardInstruction: 'One.', ...change });
          return { kind: 'questions', questions: [input.question], promptTokens: 1, ms: 1 };
        },
      };
      expect({ change, result: await askAnonymously('What is a deposit?', value) }).toEqual({ change, result: { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale } });
      expect(d.calls.send).toEqual([]);
    }
    // Unchanged: it sends.
    const same = deps(settings({ standardMode: 'custom', standardInstruction: 'One.' }));
    expect(await askAnonymously('What is a deposit?', same.value)).toMatchObject({ ok: true });
  });
});
