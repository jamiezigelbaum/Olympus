import { expect, test } from 'bun:test';
import { askAnonymously, type ConsultAskDependencies } from '../src/core/consult-ask.ts';
import { DEFAULT_CONSULT_SETTINGS } from '../src/core/consult-settings.ts';
import { buildConsultWriterPrompt, type ConsultWriterInput } from '../src/core/consult-writer.ts';
import { askAnonymouslyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS, ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION } from '../src/core/zkapi-consult-settings.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';

const digest = '[{"date":"2025-01-03","test":"Marker Z","value":"71","unit":"mg/dL","reference":"60-100"}]';
const context = { entries: [{ kind: 'text' as const, text: 'Avery Example measured Marker Z at 71 mg/dL.', path: 'candidates[].chunks[]', group: 0 }], overflow: false };
function fixture() {
  let current = true;
  const seen: ConsultWriterInput[] = [];
  const sent: string[] = [];
  const deps: ConsultAskDependencies = {
    settings: () => ({ state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, enabled: true, levelChosen: true, standardMode: 'as_written' } }),
    prepare: async input => { seen.push(input); return { kind: 'questions', questions: ['Please assess Marker Z at 71 mg/dL against a 60-100 reference range.'], promptTokens: 0, ms: 0 }; },
    send: async (text, authorize, options) => {
      if (!authorize(options.model)) return { ok: false, error: { code: 'authorization_refused', message: 'Not sent.', outcome: 'not_sent', networkIdentity: 'not_verified' } };
      sent.push(text);
      return { ok: true, text: 'The invented value is inside its supplied reference range.', routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt: {} as never, elapsedMs: 1 };
    },
  };
  return { deps, seen, sent, documents: { digest, context, current: () => current }, revoke: () => { current = false; } };
}

test('documents always pass the digest to the deciding writer, including Standard as-written', async () => {
  const f = fixture();
  const result = await askAnonymously({ question: 'Review my labs', documents: f.documents, callerProvider: 'openai' }, f.deps);
  expect(f.seen).toHaveLength(1);
  expect(f.seen[0]?.digest).toBe(digest);
  expect(f.seen[0]?.direct).toBeUndefined();
  expect(result).toMatchObject({ ok: true, privateDocuments: true, rewritten: true, sent: f.sent[0] });
});

test('document writer may decline the frontier call; no bypass when Standard is as-written', async () => {
  const f = fixture();
  const result = await askAnonymously({ question: 'Review my labs', documents: f.documents }, { ...f.deps, prepare: async () => ({ kind: 'declined', ms: 0, promptTokens: 0 }) });
  expect(result).toMatchObject({ ok: false, code: 'writer_declined', privateDocuments: true });
  expect(f.sent).toEqual([]);
});

test('current tier and scope are checked after the writer and at dispatch', async () => {
  const f = fixture();
  const result = await askAnonymously({ question: 'Review', documents: f.documents }, { ...f.deps, prepare: async input => { f.revoke(); return f.deps.prepare(input, null, 'unnamed'); } });
  expect(result.ok).toBe(false);
  expect(f.sent).toEqual([]);
  const g = fixture();
  const duringSend = await askAnonymously({ question: 'Review', documents: g.documents }, { ...g.deps, send: async (...args) => { g.revoke(); return g.deps.send(...args); } });
  expect(duringSend.ok).toBe(false);
  expect(g.sent).toEqual([]);
});

test('the outbound gate checks the actual drafted bytes against document context', async () => {
  const f = fixture();
  const result = await askAnonymously({ question: 'Review', documents: { ...f.documents, context: { entries: [{ kind: 'text', text: 'password: invented-secret-fixture-71', path: 'document', group: 0 }], overflow: false } } }, { ...f.deps, prepare: async () => ({ kind: 'questions', questions: ['What does invented-secret-fixture-71 mean?'], ms: 0, promptTokens: 0 }) });
  expect(result).toMatchObject({ ok: false, code: 'secret_detected', privateDocuments: true });
  expect(f.sent).toEqual([]);
});

test('a Private digest, its answer, sent text and refusal details never become ChatGPT fields', () => {
  for (const raw of [
    { ok: true, privateDocuments: true, reply: 'Private invented health inference', sent: digest, model: 'fixture' },
    { ok: false, privateDocuments: true, message: 'Private invented lab content', sent: digest, code: 'failed' },
  ]) {
    const result = askAnonymouslyToolResult(raw);
    const text = JSON.stringify(result);
    expect(text).not.toContain('Marker Z');
    expect(text).not.toContain('invented');
    expect(text).not.toContain('2025');
    expect(text).toContain('private');
  }
});

test('the writer sees the complete digest instead of the old twelve-excerpt truncation', () => {
  const annual = digest.repeat(150);
  const prompt = buildConsultWriterPrompt({ question: 'Review the year', answer: '', gaps: [], digest: annual, instruction: 'Prepare a useful question.' }, 'unnamed');
  expect(prompt[1]?.content).toContain(annual);
  expect(prompt[0]?.content).toContain('Decide whether');
});

test('the first document send requires the updated provider-reading acknowledgement', () => {
  expect(ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION).toBe(8);
  expect(ZKAPI_RISK_ACKNOWLEDGEMENTS.find(item => item.id === 'provider_reads')?.statement).toContain('document');
});
test('a document result cannot escape through either remote collection operation', () => {
  const raw = { ok: true, privateDocuments: true, reply: 'Invented private inference', sent: digest, model: 'fixture/model' };
  for (const operation of ['ask_anonymously', 'source_answer_result'] as const) {
    const output = JSON.stringify(remoteOperationOutput(operation, raw));
    expect(output).not.toContain('Marker Z');
    expect(output).not.toContain('private inference');
  }
});
test('an excerpt fallback still asks the local writer whether frontier help would be useful', () => {
  const prompt = buildConsultWriterPrompt({ question: 'Review exact wording', answer: '', gaps: [], documents: true, evidence: ['Invented agreement clause'], instruction: 'Prepare a useful question.' }, 'unnamed');
  expect(prompt[0]?.content).toContain('Decide whether');
});
