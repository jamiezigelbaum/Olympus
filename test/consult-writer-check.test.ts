// The writer capability check (src/core/consult-writer-check.ts; owner
// decision 2026-10-10): fixed invented cases through a writer and the gate,
// run only on request, sending nothing to zkAPI. Every writer here is a fake.

import { describe, expect, test } from 'bun:test';
import {
  CONSULT_WRITER_CHECK_CASES,
  checkOwnConsultWriter,
  consultWriterCheckAsksAboutDocuments,
  consultWriterCheckCanaryPresent,
  consultWriterCheckInput,
  runConsultWriterCheck,
} from '../src/core/consult-writer-check.ts';
import type { ConsultWriterInput } from '../src/core/consult-writer.ts';

describe('the writer check', () => {
  test('the fixed set: six invented cases, the live LOI failure with and without the letter', () => {
    expect(CONSULT_WRITER_CHECK_CASES.map((entry) => entry.id)).toEqual(['loi-notary-missing', 'loi-notary-present', 'medication-interaction', 'insurance-water', 'driver-epilepsy', 'unpaid-overtime']);
    const withEvidence = consultWriterCheckInput(CONSULT_WRITER_CHECK_CASES[1]!, true);
    expect(withEvidence.evidence![0]).toContain('CARTA DE INTENCIONES');
    expect(consultWriterCheckInput(CONSULT_WRITER_CHECK_CASES[1]!, false).evidence).toBeUndefined();
  });

  test('gate verdicts, a canary past the gate, a question about a document, declines and failures are all reported', async () => {
    const seen: ConsultWriterInput[] = [];
    const replies = new Map<string, string[] | 'decline' | 'fail'>([
      ['loi-notary-missing', ['Does the document signed by the landlord mention a notary?']],
      ['loi-notary-present', ['Does a non binding letter of intent for a commercial lease in Spain need a notary?']],
      ['medication-interaction', ['Mr Ferreira takes warfarin and starts clarithromycin. Does this interact?']],
      ['insurance-water', 'decline'],
      ['driver-epilepsy', 'fail'],
      ['unpaid-overtime', ['An employee worked extra hours that a manager signed but never approved in writing. Is the overtime owed?']],
    ]);
    const report = await runConsultWriterCheck({
      level: 'unnamed',
      withEvidence: true,
      writer: async (input) => {
        seen.push(input);
        const entry = CONSULT_WRITER_CHECK_CASES.find((item) => item.userQuestion === input.question && input.evidence?.[0] && item.documents.some((doc) => input.evidence![0]!.includes(doc.slice(0, 20))))!;
        const reply = replies.get(entry.id)!;
        if (reply === 'decline') return { kind: 'declined', promptTokens: 0, ms: 1 };
        if (reply === 'fail') return { kind: 'failed', reason: 'not_json' };
        return { kind: 'questions', questions: reply, promptTokens: 0, ms: 1 };
      },
    });
    expect(seen.every((input) => (input.evidence?.length ?? 0) > 0)).toBe(true);
    expect(report.cases).toBe(6);
    expect(report.written).toBe(4);
    expect(report.declined).toBe(1);
    expect(report.failed).toBe(1);
    const byId = Object.fromEntries(report.results.map((result) => [result.id, result]));
    expect(byId['loi-notary-missing']!.asksAboutDocuments).toBe(true);
    expect(byId['loi-notary-present']!.asksAboutDocuments).toBe(false);
    expect(byId['loi-notary-present']!.gate).toBe('pass');
    // The name is refused by the gate, so it is not a leak past it.
    expect(byId['medication-interaction']!.gate).toBe('refuse');
    expect(byId['medication-interaction']!.canaryLeak).toBe(false);
    expect(byId['driver-epilepsy']).toMatchObject({ outcome: 'failed', reason: 'not_json', gate: 'not_sent' });
    expect(report.documentQuestions).toEqual(['loi-notary-missing']);
    expect(report.canaryLeaks).toEqual([]);
  });

  test('canary and document heuristics', () => {
    expect(consultWriterCheckCanaryPresent(['Does Benítez need a notary?'], ['Benitez'])).toBe(true);
    expect(consultWriterCheckCanaryPresent(['Does a tenant need a notary?'], ['Benitez'])).toBe(false);
    expect(consultWriterCheckAsksAboutDocuments('What does the contract say about notice?')).toBe(true);
    expect(consultWriterCheckAsksAboutDocuments('Can you share the letter so I can check it?')).toBe(true);
    expect(consultWriterCheckAsksAboutDocuments('How much notice does a fixed-term contract usually require?')).toBe(false);
  });

  test('against the owner\'s own server: one request per case to that address only (nothing to zkAPI)', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"questions": null}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const report = await checkOwnConsultWriter({ endpoint: { baseUrl: 'http://10.0.0.5:8090/v1', model: 'delphi/source-answer' }, level: 'general', deadlineMs: 5_000, fetchImpl });
    expect(report.declined).toBe(6);
    expect(urls).toEqual(Array(6).fill('http://10.0.0.5:8090/v1/chat/completions'));
  });
});
