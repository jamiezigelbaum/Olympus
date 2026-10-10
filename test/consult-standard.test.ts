// Standard is open and the user's choice (owner decision 2026-10-10,
// docs/design/private-answers.md): the question goes out as written, lightly
// cleaned, or by the user's own instruction; the only outbound rule is
// secrets. The ask_anonymously agent tool follows the same mode.

import { describe, expect, test } from 'bun:test';
import { askAnonymously, CONSULT_ASK_MAX_CHARS, CONSULT_ASK_MESSAGES, type ConsultAskDependencies, type ConsultAskInput, type ConsultAskSendOptions } from '../src/core/consult-ask.ts';
import { CONSULT_GATE_STANDARD_MAX_QUESTION_BYTES, consultWriterContextFromPack, evaluateConsultRequest } from '../src/core/consult-gate.ts';
import { CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT, CONSULT_LIGHT_CLEANUP_INSTRUCTION, DEFAULT_CONSULT_SETTINGS, type ConsultSettingsRead } from '../src/core/consult-settings.ts';
import type { ZkapiConsultResult } from '../src/core/consult-transport-zkapi.ts';
import { CONSULT_STANDARD_REPLY_FORMAT, CONSULT_WRITER_SYSTEM, CONSULT_WRITER_SYSTEM_DIRECT, buildConsultWriterPrompt, parseConsultWriterReply, type ConsultWriterInput } from '../src/core/consult-writer.ts';
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

describe('the writer for a direct ask at Strict', () => {
  test('the question is to be sent: the prompt says to always write general questions, shows no first answer or gaps, and keeps Strict\'s rules and form', () => {
    const messages = buildConsultWriterPrompt({ question: 'When will Jo at Heron Lettings return my deposit?', answer: '', gaps: [], direct: true }, 'general');
    expect(messages[0]!.content).toBe(CONSULT_WRITER_SYSTEM_DIRECT);
    expect(messages[0]!.content).toContain('The user asked to send this question');
    expect(messages[0]!.content).toContain('Always write the questions.');
    // Shapes that generalise a question about the user's own situation, and pass a general one through (the built-in writer declined both before).
    expect(messages[0]!.content).toContain('is the normal case, not a reason to stop');
    expect(messages[0]!.content).toContain('already general (a fact, a definition, how something works) is asked as it is');
    expect(messages[0]!.content).toContain('Asked: what to do about the landlord');
    expect(messages[0]!.content).toContain('Asked: which city is the capital of a named country');
    expect(messages[0]!.content).not.toContain('Missing: the booking reference');
    expect(messages[0]!.content).toContain('Reply null: only their own records hold it.');
    expect(messages[0]!.content).not.toContain('Decide first');
    expect(messages[0]!.content).not.toContain('Propose nothing when the material');
    expect(messages[0]!.content).toContain('Strict: ask only general questions');
    expect(messages[0]!.content).toContain('Form: each question is one plain sentence');
    expect(messages[1]!.content).toBe('Question: When will Jo at Heron Lettings return my deposit?');
    // Without the flag (the private-answer escalation) the escalation prompt is unchanged.
    const escalation = buildConsultWriterPrompt({ question: 'q', answer: 'a', gaps: ['g'] }, 'general');
    expect(escalation[0]!.content).toBe(CONSULT_WRITER_SYSTEM);
    expect(CONSULT_WRITER_SYSTEM).toContain('Decide first');
    expect(CONSULT_WRITER_SYSTEM).toContain('Missing: the booking reference itself. Propose nothing');
    expect(CONSULT_WRITER_SYSTEM).toContain('Form: each question is one plain sentence');
    expect(escalation[1]!.content).toContain('Could not find:');
    // Standard's instruction wins over the flag.
    expect(buildConsultWriterPrompt({ question: 'q', answer: '', gaps: [], instruction: 'In Dutch.', direct: true }, 'unnamed')[0]!.content).toContain('In Dutch.');
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
  const settings = (extra: Partial<typeof DEFAULT_CONSULT_SETTINGS> = {}): ConsultSettingsRead => ({ state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 2, enabled: true, ...extra } });
  const reply = (text: string): ZkapiConsultResult => ({ ok: true, text, routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt: {} as never, elapsedMs: 5 });

  /** A question at Standard, as an agent sends it once the level is chosen. */
  const q = (question: unknown): ConsultAskInput => ({ question, level: 'standard' });

  function deps(read: ConsultSettingsRead, prepared: Awaited<ReturnType<ConsultAskDependencies['prepare']>> = { kind: 'questions', questions: ['How long do landlords usually take to return a deposit?'], promptTokens: 1, ms: 1 }, later: Array<Awaited<ReturnType<ConsultAskDependencies['prepare']>>> = []) {
    const calls = { prepare: [] as ConsultWriterInput[], levels: [] as string[], send: [] as string[], sendOptions: [] as ConsultAskSendOptions[], remembered: [] as Array<{ level: string; cleanup?: string }> };
    const value: ConsultAskDependencies = {
      settings: () => read,
      prepare: async (input, _writer, level) => { calls.prepare.push(input); calls.levels.push(level); return calls.prepare.length > 1 ? later[calls.prepare.length - 2] ?? prepared : prepared; },
      // Like the transport: final authorization runs just before dispatch; false sends nothing.
      send: async (question, authorize, options) => {
        if (!authorize()) return { ok: false, error: { code: 'authorization_refused', message: 'refused', outcome: 'not_sent', networkIdentity: 'not_verified' } };
        calls.send.push(question);
        calls.sendOptions.push(options);
        return reply('Usually within two weeks.');
      },
      remember: async (choice) => { calls.remembered.push(choice); return { ok: true }; },
    };
    return { value, calls };
  }

  test('light cleanup (the default) prepares the typed question with the preset and returns exactly what was sent', async () => {
    const d = deps(settings());
    const result = await askAnonymously(q('  When will Jo return my deposit?  '), d.value);
    expect(d.calls.prepare).toEqual([{ question: 'When will Jo return my deposit?', answer: '', gaps: [], instruction: CONSULT_LIGHT_CLEANUP_INSTRUCTION }]);
    expect(d.calls.send).toEqual(['How long do landlords usually take to return a deposit?']);
    expect(result).toEqual({ ok: true, sent: 'How long do landlords usually take to return a deposit?', reply: 'Usually within two weeks.', route: 'zkAPI via Tor', networkIdentity: 'hidden', level: 'standard', cleanup: 'light_cleanup', rewritten: true, remembered: false, model: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT });
    expect(d.calls.levels).toEqual(['unnamed']);
    expect(d.calls.sendOptions).toEqual([{ model: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT }]);
  });

  test('as written sends the typed question unchanged with no model; custom sends the user\'s instruction', async () => {
    const plain = deps(settings({ standardMode: 'as_written' }));
    expect(await askAnonymously(q('When will Jo return my deposit?'), plain.value)).toMatchObject({ ok: true, sent: 'When will Jo return my deposit?' });
    expect(plain.calls.prepare).toEqual([]);
    const custom = deps(settings({ standardMode: 'custom', standardInstruction: 'Ask it in Dutch.' }));
    await askAnonymously(q('When will Jo return my deposit?'), custom.value);
    expect(custom.calls.prepare[0]!.instruction).toBe('Ask it in Dutch.');
  });

  test('nothing is sent when the question is empty or too long, the settings are unreadable, the model declines or fails, or a secret is in it', async () => {
    const none = deps(settings());
    expect(await askAnonymously(q('  '), none.value)).toMatchObject({ ok: false, code: 'question_empty' });
    expect(await askAnonymously(q('x'.repeat(CONSULT_ASK_MAX_CHARS + 1)), none.value)).toMatchObject({ ok: false, code: 'question_too_long' });
    expect(await askAnonymously(q('x'), deps({ state: 'invalid', reason: 'malformed_json' } as unknown as ConsultSettingsRead).value)).toMatchObject({ ok: false, code: 'settings_invalid' });
    // The dashboard switch off, or no settings file yet: refused before anything is prepared, and no Strict/Standard choice is asked.
    const off = deps(settings({ enabled: false }));
    expect(await askAnonymously(q('x'), off.value)).toEqual({ ok: false, code: 'anonymous_answers_off', message: CONSULT_ASK_MESSAGES.off });
    expect(off.calls.prepare).toHaveLength(0);
    expect(off.calls.send).toHaveLength(0);
    const absent = deps({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });
    expect(await askAnonymously(q('x'), absent.value)).toMatchObject({ ok: false, code: 'anonymous_answers_off' });
    expect(await askAnonymously(q('x'), deps(settings(), { kind: 'declined', promptTokens: 1, ms: 1 }).value)).toEqual({ ok: false, code: 'writer_declined', message: CONSULT_ASK_MESSAGES.declined });
    expect(await askAnonymously(q('x'), deps(settings(), { kind: 'failed', reason: 'form' }).value)).toMatchObject({ ok: false, code: 'writer_failed' });
    const keyed = deps(settings({ standardMode: 'as_written' }));
    const refused = await askAnonymously(q(`Why is ${FAKE_KEY} rejected?`), keyed.value);
    expect(refused).toMatchObject({ ok: false, code: 'secret_detected', message: CONSULT_ASK_MESSAGES.secret });
    expect(keyed.calls.send).toEqual([]);
    expect(none.calls.send).toEqual([]);
  });

  test('the transport\'s refusals come back as they are: no route, or a model the listing lacks', async () => {
    const noRoute: ConsultAskDependencies = { ...deps(settings({ standardMode: 'as_written' })).value, send: async () => undefined };
    expect(await askAnonymously(q('What is a deposit?'), noRoute)).toEqual({ ok: false, code: 'route_not_configured', message: CONSULT_ASK_MESSAGES.noRoute });
    const missing: ConsultAskDependencies = {
      ...deps(settings({ standardMode: 'as_written' })).value,
      send: async () => ({ ok: false, error: { code: 'model_unavailable', message: 'not listed', outcome: 'not_sent', networkIdentity: 'not_verified' } }),
    };
    expect(await askAnonymously(q('What is a deposit?'), missing)).toEqual({ ok: false, code: 'model_unavailable', message: 'not listed', sent: 'What is a deposit?', outcome: 'not_sent' });
    // The daemon's own code rides along, so a surface can tell an empty balance (402 funding_required) from other daemon errors.
    const empty: ConsultAskDependencies = {
      ...deps(settings({ standardMode: 'as_written' })).value,
      send: async () => ({ ok: false, error: { code: 'daemon_error', message: 'The zkAPI daemon returned an error.', outcome: 'sent_failed', networkIdentity: 'hidden', daemonCode: 'funding_required', httpStatus: 402 } }),
    };
    expect(await askAnonymously(q('What is a deposit?'), empty)).toEqual({ ok: false, code: 'daemon_error', message: 'The zkAPI daemon returned an error.', sent: 'What is a deposit?', outcome: 'sent_failed', daemonCode: 'funding_required' });
  });

  test('Strict, built-in writer: a draft that kept an exact figure gets one more draft with the finding as feedback (live test 2026-10-10)', async () => {
    const typed = 'My landlord wants to raise my rent by 40% next month. What are my options?';
    const kept = { kind: 'questions' as const, questions: ['What protections usually exist for tenants facing a 40% rent increase?'], promptTokens: 1, ms: 1 };
    const clean = { kind: 'questions' as const, questions: ['What protections usually exist for tenants facing a large rent increase?'], promptTokens: 1, ms: 1 };
    const cured = deps(settings(), kept, [clean]);
    const sent = await askAnonymously({ question: typed, level: 'strict' as const }, cured.value);
    expect(sent).toMatchObject({ ok: true, rewritten: true, sent: clean.questions[0]! });
    expect(cured.calls.prepare).toHaveLength(2);
    expect(cured.calls.prepare[1]).toEqual({ question: typed, answer: '', gaps: [], direct: true, feedback: 'it kept an exact figure from the question.' });
    expect(cured.calls.levels).toEqual(['general', 'general']);
    expect(cured.calls.send).toEqual([clean.questions[0]!]);
    // The second draft kept it too: refused, naming the kind of thing carried, never the value.
    const stubborn = deps(settings(), kept, [kept]);
    const refused = await askAnonymously({ question: typed, level: 'strict' as const }, stubborn.value);
    expect(refused).toEqual({ ok: false, code: 'gate_refused', message: 'Not sent: at Strict the rewritten question still carried an exact figure from your question, so Olympus held it back. Try Standard, or ask more generally.', sent: kept.questions[0]! });
    expect(stubborn.calls.prepare).toHaveLength(2);
    expect(stubborn.calls.send).toEqual([]);
    // A second draft that fails or declines leaves the first refusal standing.
    const failed = deps(settings(), kept, [{ kind: 'declined', promptTokens: 1, ms: 1 }]);
    expect(await askAnonymously({ question: typed, level: 'strict' as const }, failed.value)).toMatchObject({ ok: false, code: 'gate_refused' });
    // The owner's own writer gets no retry: its thin net passes the figure anyway, and its drafts are its own.
    const own = deps(settings({ writer: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' } }), kept, [clean]);
    await askAnonymously({ question: typed, level: 'strict' as const }, own.value);
    expect(own.calls.prepare).toHaveLength(1);
    // Standard never retries: its only rule is secrets.
    const standard = deps(settings(), kept, [clean]);
    expect(await askAnonymously({ question: typed, level: 'standard' as const }, standard.value)).toMatchObject({ ok: true, sent: kept.questions[0]! });
    expect(standard.calls.prepare).toHaveLength(1);
  });

  test('the direct prompt carries the retry feedback as one line after the question, bounded, and only on a direct ask', () => {
    const base = { question: 'My rent is going up 40%. Options?', answer: '', gaps: [] };
    const plain = buildConsultWriterPrompt({ ...base, direct: true }, 'general');
    const retry = buildConsultWriterPrompt({ ...base, direct: true, feedback: 'it kept an exact figure from the question.' }, 'general');
    expect(plain[1]!.content).toBe('Question: My rent is going up 40%. Options?');
    expect(retry[1]!.content).toBe('Question: My rent is going up 40%. Options?\n\nYour previous draft was refused by the privacy check: it kept an exact figure from the question. Write the questions again without that; use bands and classes of thing instead.');
    expect(retry[0]!.content).toBe(plain[0]!.content);
    expect(buildConsultWriterPrompt({ ...base, direct: true, feedback: 'x'.repeat(400) }, 'general')[1]!.content).toHaveLength('Question: My rent is going up 40%. Options?'.length + 'Your previous draft was refused by the privacy check: '.length + 240 + '\n\n'.length + ' Write the questions again without that; use bands and classes of thing instead.'.length);
    expect(buildConsultWriterPrompt({ ...base, feedback: 'ignored', instruction: 'Tidy it.' }, 'unnamed')[1]!.content).not.toContain('ignored');
    expect(buildConsultWriterPrompt({ ...base, feedback: 'ignored' }, 'general')[1]!.content).not.toContain('ignored');
  });

  test('a labelled secret in the typed question stays refused, with or without its label (review of PR #209)', async () => {
    const plain = deps(settings({ standardMode: 'as_written' }));
    expect(await askAnonymously(q('Is password: hunter2 safe?'), plain.value)).toMatchObject({ ok: false, code: 'secret_detected' });
    // The writer dropped the label but kept the value.
    const dropped = deps(settings(), { kind: 'questions', questions: ['Is hunter2 a safe choice?'], promptTokens: 1, ms: 1 });
    expect(await askAnonymously(q('Is password: hunter2 safe?'), dropped.value)).toMatchObject({ ok: false, code: 'secret_detected' });
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
      expect({ change, result: await askAnonymously(q('What is a deposit?'), value) }).toEqual({ change, result: { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale } });
      expect(d.calls.send).toEqual([]);
    }
    // Unchanged: it sends.
    const same = deps(settings({ standardMode: 'custom', standardInstruction: 'One.' }));
    expect(await askAnonymously(q('What is a deposit?'), same.value)).toMatchObject({ ok: true });
  });

  // The agent's path (owner decision 2026-10-10): ask once, remember, Strict rewrites.

  test('an agent\'s first question with no level is not sent: needs_choice offers the card\'s setting; a remembered level is used without asking', async () => {
    const fresh = deps(settings({ standardMode: 'as_written' }));
    expect(await askAnonymously({ question: 'What is a deposit?' }, fresh.value)).toEqual({
      ok: false,
      code: 'needs_choice',
      message: CONSULT_ASK_MESSAGES.needsChoice,
      options: { suggestedLevel: 'standard', suggestedCleanup: 'as_written', customInstruction: false },
    });
    expect(fresh.calls.send).toEqual([]);
    const strictCard = deps(settings({ level: 'general', standardMode: 'custom', standardInstruction: 'In Dutch.' }));
    expect(await askAnonymously({ question: 'What is a deposit?' }, strictCard.value)).toMatchObject({ options: { suggestedLevel: 'strict', suggestedCleanup: 'custom', customInstruction: true } });
    const chosen = deps(settings({ standardMode: 'as_written', levelChosen: true }));
    expect(await askAnonymously({ question: 'What is a deposit?' }, chosen.value)).toMatchObject({ ok: true, level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false });
    expect(chosen.calls.sendOptions).toEqual([{ model: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT }]);
  });

  test('the model follows who hosts the agent (owner decision 2026-10-10): never the provider that holds the conversation, for a one-off model too', async () => {
    const chosen = () => deps(settings({ standardMode: 'as_written', levelChosen: true, claudeFrontierModel: 'openai/some-model' }));
    const fromClaude = chosen();
    expect(await askAnonymously({ question: 'What is a deposit?', callerProvider: 'anthropic' }, fromClaude.value)).toMatchObject({ ok: true, model: 'openai/some-model' });
    expect(fromClaude.calls.sendOptions).toEqual([{ model: 'openai/some-model' }]);
    const fromChatGpt = chosen();
    expect(await askAnonymously({ question: 'What is a deposit?', callerProvider: 'openai' }, fromChatGpt.value)).toMatchObject({ ok: true, model: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT });
    const unknown = chosen();
    expect(await askAnonymously({ question: 'What is a deposit?' }, unknown.value)).toMatchObject({ ok: true, model: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT });
    // A one-off model from the caller's own provider is refused before any work; from another, or from an unknown caller, it is used.
    const refused = chosen();
    expect(await askAnonymously({ question: 'What is a deposit?', callerProvider: 'anthropic', model: 'anthropic/claude-opus-5.5' }, refused.value))
      .toEqual({ ok: false, code: 'model_same_provider', message: CONSULT_ASK_MESSAGES.modelSameProvider });
    expect(await askAnonymously({ question: 'What is a deposit?', callerProvider: 'openai', model: 'OpenAI/gpt-5.5' }, refused.value)).toMatchObject({ code: 'model_same_provider' });
    expect(refused.calls.send).toEqual([]);
    const allowed = chosen();
    expect(await askAnonymously({ question: 'What is a deposit?', callerProvider: 'anthropic', model: 'google/some-model' }, allowed.value)).toMatchObject({ ok: true, model: 'google/some-model' });
    expect(await askAnonymously({ question: 'What is a deposit?', model: 'openai/gpt-5.5' }, allowed.value)).toMatchObject({ ok: true, model: 'openai/gpt-5.5' });
  });

  test('remember stores the choice through the writer before the send and reports it; without a writer the question still goes, once', async () => {
    let current = settings({ standardMode: 'light_cleanup' });
    const d = deps(current);
    const value: ConsultAskDependencies = {
      ...d.value,
      settings: () => current,
      remember: async (choice) => { d.calls.remembered.push(choice); current = settings({ standardMode: 'as_written', levelChosen: true }); return { ok: true }; },
    };
    const result = await askAnonymously({ question: 'What is a deposit?', level: 'standard', cleanup: 'as_written', remember: true }, value);
    expect(d.calls.remembered).toEqual([{ level: 'unnamed', cleanup: 'as_written' }]);
    expect(result).toMatchObject({ ok: true, sent: 'What is a deposit?', remembered: true });
    const { remember: _unused, ...noWriter } = deps(settings({ standardMode: 'as_written' })).value;
    const unsaved = await askAnonymously({ question: 'What is a deposit?', level: 'standard', remember: true }, noWriter);
    expect(unsaved).toMatchObject({ ok: true, remembered: false });
  });

  test('Strict: the writer rewrites with no instruction at the without-names level, the gate checks the rewrite, and the result says it was rewritten', async () => {
    const d = deps(settings({ standardMode: 'as_written' }), { kind: 'questions', questions: ['How long do landlords usually take to return a deposit?'], promptTokens: 1, ms: 1 });
    const result = await askAnonymously({ question: 'When will Jo at Heron Lettings return my deposit?', level: 'strict' }, d.value);
    expect(d.calls.prepare).toEqual([{ question: 'When will Jo at Heron Lettings return my deposit?', answer: '', gaps: [], direct: true }]);
    expect(d.calls.levels).toEqual(['general']);
    expect(result).toMatchObject({ ok: true, level: 'strict', rewritten: true, sent: 'How long do landlords usually take to return a deposit?' });
    expect('cleanup' in result).toBe(false);
    // The rewrite still names the person: held back as gate_refused, nothing sent.
    const leaky = deps(settings({ standardMode: 'as_written' }), { kind: 'questions', questions: ['When will Jo at Heron Lettings return the deposit?'], promptTokens: 1, ms: 1 });
    expect(await askAnonymously({ question: 'When will Jo at Heron Lettings return my deposit?', level: 'strict' }, leaky.value)).toMatchObject({ ok: false, code: 'gate_refused', message: 'Not sent: at Strict the rewritten question still carried wording copied from your question, so Olympus held it back. Try Standard, or ask more generally.' });
    expect(leaky.calls.send).toEqual([]);
    expect(leaky.calls.prepare).toHaveLength(2); // one redraft was asked for, with the finding, and kept the wording
  });

  test('a one-off model and a cleanup override apply to this question only; custom needs a saved instruction; bad values are refused unsent', async () => {
    const d = deps(settings({ standardMode: 'light_cleanup', levelChosen: true }));
    expect(await askAnonymously({ question: 'What is a deposit?', cleanup: 'as_written', model: 'anthropic/claude-sonnet-5.5' }, d.value)).toMatchObject({ ok: true, cleanup: 'as_written', rewritten: false });
    expect(d.calls.prepare).toEqual([]);
    expect(d.calls.sendOptions).toEqual([{ model: 'anthropic/claude-sonnet-5.5' }]);
    expect(d.calls.remembered).toEqual([]);
    expect(await askAnonymously({ question: 'x', level: 'standard', cleanup: 'custom' }, d.value)).toEqual({ ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.cleanupCustomMissing });
    expect(await askAnonymously({ question: 'x', level: 'loose' as never }, d.value)).toEqual({ ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.levelInvalid });
    expect(await askAnonymously({ question: 'x', level: 'standard', model: 'not a model' }, d.value)).toEqual({ ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.modelInvalid });
    expect(d.calls.send).toHaveLength(1);
  });

  test('a write that lands between remember and the send (another conversation, the card) is refused as stale, never sent under the newer revision (Codex review of PR #215)', async () => {
    const races: Array<{ after: Partial<typeof DEFAULT_CONSULT_SETTINGS>; note: string }> = [
      { after: { standardMode: 'light_cleanup', levelChosen: true, revision: 4 }, note: 'another conversation remembered light cleanup' },
      { after: { level: 'general', standardMode: 'as_written', levelChosen: true, revision: 4 }, note: 'the card switched to Strict' },
      { after: { standardMode: 'as_written', revision: 4 }, note: 'the card cleared the choice' },
    ];
    for (const race of races) {
      let current = settings({ standardMode: 'custom', standardInstruction: 'In Dutch.' });
      const d = deps(current);
      const value: ConsultAskDependencies = {
        ...d.value,
        settings: () => current,
        remember: async () => { current = settings({ standardMode: 'custom', standardInstruction: 'In Dutch.', ...race.after }); return { ok: true }; },
      };
      const result = await askAnonymously({ question: 'What is a deposit?', level: 'standard', cleanup: 'as_written', remember: true }, value);
      expect({ note: race.note, result }).toEqual({ note: race.note, result: { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale } });
      expect(d.calls.send).toEqual([]);
    }
    // The remembered write itself, unchanged after: the question goes, prepared by the re-read file.
    let current = settings({ standardMode: 'custom', standardInstruction: 'In Dutch.' });
    const d = deps(current);
    const value: ConsultAskDependencies = {
      ...d.value,
      settings: () => current,
      remember: async () => { current = settings({ standardMode: 'light_cleanup', levelChosen: true, revision: 4 }); return { ok: true }; },
    };
    expect(await askAnonymously({ question: 'What is a deposit?', level: 'standard', cleanup: 'light_cleanup', remember: true }, value)).toMatchObject({ ok: true, cleanup: 'light_cleanup', remembered: true });
    expect(d.calls.prepare[0]!.instruction).toBe(CONSULT_LIGHT_CLEANUP_INSTRUCTION);
  });

  test('a save that fails while the answer succeeds is reported with the answer (Codex review of PR #215)', async () => {
    const d = deps(settings({ standardMode: 'as_written' }));
    const value: ConsultAskDependencies = { ...d.value, remember: async () => ({ ok: false, message: 'The settings changed under you; not saved.' }) };
    const result = await askAnonymously({ question: 'What is a deposit?', level: 'standard', remember: true }, value);
    expect(result).toMatchObject({ ok: true, remembered: false, note: 'The settings changed under you; not saved.' });
    // The save that lands: no note.
    let current = settings({ standardMode: 'as_written' });
    const saved = deps(current);
    const kept = await askAnonymously({ question: 'What is a deposit?', level: 'standard', remember: true }, {
      ...saved.value,
      settings: () => current,
      remember: async () => { current = settings({ standardMode: 'as_written', levelChosen: true, revision: 3 }); return { ok: true }; },
    });
    expect(kept).toMatchObject({ ok: true, remembered: true });
    expect('note' in kept).toBe(false);
  });

  test('the caller\'s cancellation stops the ask before dispatch with nothing sent: before the writer, after it, and at authorization (Codex review of PR #215)', async () => {
    const gone = AbortSignal.abort();
    const before = deps(settings({ standardMode: 'as_written', levelChosen: true }));
    expect(await askAnonymously({ question: 'What is a deposit?', signal: gone }, before.value)).toEqual({ ok: false, code: 'cancelled', message: CONSULT_ASK_MESSAGES.cancelled });
    expect(before.calls.prepare).toEqual([]);
    expect(before.calls.send).toEqual([]);
    // Cancelled while the writer runs: the writer sees the signal, nothing is sent.
    const controller = new AbortController();
    const during = deps(settings({ standardMode: 'light_cleanup', levelChosen: true }));
    const seen: Array<AbortSignal | undefined> = [];
    const value: ConsultAskDependencies = {
      ...during.value,
      prepare: async (_input, _writer, _level, signal) => { seen.push(signal); controller.abort(); return { kind: 'questions', questions: ['How long do deposits take?'], promptTokens: 1, ms: 1 }; },
    };
    expect(await askAnonymously({ question: 'What is a deposit?', signal: controller.signal }, value)).toMatchObject({ ok: false, code: 'cancelled' });
    expect(seen).toEqual([controller.signal]);
    expect(during.calls.send).toEqual([]);
    // Cancelled between the gate and dispatch: authorization refuses, nothing reserved; the signal reaches the transport.
    const late = new AbortController();
    const atSend = deps(settings({ standardMode: 'as_written', levelChosen: true }));
    const sendValue: ConsultAskDependencies = {
      ...atSend.value,
      send: async (question, authorize, options) => {
        late.abort();
        expect(options.signal).toBe(late.signal);
        if (!authorize()) return { ok: false, error: { code: 'authorization_refused', message: 'refused', outcome: 'not_sent', networkIdentity: 'not_verified' } };
        atSend.calls.send.push(question);
        return reply('never');
      },
    };
    expect(await askAnonymously({ question: 'What is a deposit?', signal: late.signal }, sendValue)).toEqual({ ok: false, code: 'cancelled', message: CONSULT_ASK_MESSAGES.cancelled });
    expect(atSend.calls.send).toEqual([]);
  });

  test('the caller\'s own last check runs inside the final authorization: revoked while the question is prepared, nothing is sent', async () => {
    let revoked = false;
    const d = deps(settings({ levelChosen: true }));
    const value: ConsultAskDependencies = {
      ...d.value,
      // Revoked while the writer prepares the question (before the session dispatches).
      prepare: async (input, writer, level, signal) => { revoked = true; return d.value.prepare(input, writer, level, signal); },
    };
    expect(await askAnonymously({ question: 'What is a deposit?', level: 'standard', stillAuthorized: () => !revoked }, value)).toMatchObject({ ok: false, code: 'authorization_refused' });
    expect(d.calls.send).toEqual([]);
    expect(await askAnonymously({ question: 'What is a deposit?', level: 'standard', stillAuthorized: () => { throw new Error('store closed'); } }, d.value)).toMatchObject({ ok: false, code: 'authorization_refused' });
    expect(d.calls.send).toEqual([]);
    expect(await askAnonymously({ question: 'What is a deposit?', level: 'standard', stillAuthorized: () => true }, d.value)).toMatchObject({ ok: true });
    expect(d.calls.send).toHaveLength(1);
  });

  test('a question within the character bound but over the transport\'s 8 KiB is refused as too long, not as a secret (Codex review of PR #215)', async () => {
    const d = deps(settings({ standardMode: 'as_written', levelChosen: true }));
    const cjk = '預'.repeat(3_000);
    expect(await askAnonymously({ question: cjk }, d.value)).toMatchObject({ ok: false, code: 'question_too_long', message: CONSULT_ASK_MESSAGES.tooManyBytes });
    expect(d.calls.send).toEqual([]);
  });
});
