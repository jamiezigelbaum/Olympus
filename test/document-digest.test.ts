import { describe, expect, test } from 'bun:test';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import type { EvidenceCandidate } from '../src/core/contracts.ts';
import { createDocumentDigest, DOCUMENT_DIGEST_LIMITS, documentDigestAnalyst } from '../src/core/document-digest.ts';

// Invented records only. Expected values come from the fixture, never the reducer.
function record(month: number, tier: 'S4' | 'S5' = 'S4'): EvidenceCandidate {
  return {
    provenance: { sourceItem: { family: 'file', provider: 'fixture', accountScope: 'synthetic', localItemId: `lab-${month}`, providerItemId: `lab-${month}` } },
    trustTier: tier, trustDomain: 'secure_local',
    chunks: [`Patient: Avery Example. Account: ACCT-12345678. Date: 2025-${String(month).padStart(2, '0')}-03. Marker Z: ${70 + month} mg/dL; reference 60-100 mg/dL.`],
  };
}
function model(reply: (request: AnalystModelRequest) => unknown): { model: AnalystModel; calls: AnalystModelRequest[] } {
  const calls: AnalystModelRequest[] = [];
  return { calls, model: { async complete(request) { calls.push(request); return { text: JSON.stringify(reply(request)), modelId: 'synthetic-local' }; } } };
}
const facts = { fits: true, identifiers: ['Avery Example', 'ACCT-12345678'], facts: [{ date: '2025-01-03', test: 'Marker Z', value: '71', unit: 'mg/dL', reference: '60-100' }] };

describe('local document digest', () => {
  test('actual UTF-8 prompts and output reserves fit the built-in model, including multibyte documents', async () => {
    const fake = model(() => ({ fits: true, identifiers: [], facts: [] }));
    const document = { ...record(1), chunks: [Array.from({ length: 100 }, () => '検査の記録には測定値と単位と基準範囲があります。').join('\n')] };
    const job = createDocumentDigest({ question: 'Summarize relevant facts.', documents: [document], model: fake.model, eligible: async () => true });
    while (job.progress().state === 'working') await job.step();
    expect(fake.calls.length).toBeGreaterThan(1);
    for (const call of fake.calls) {
      expect(new TextEncoder().encode(JSON.stringify([{ role: 'system', content: call.system }, { role: 'user', content: call.prompt }])).length).toBeLessThanOrEqual(7_000);
      expect(call.maxOutputChars).toBeLessThanOrEqual(8_000);
    }
    expect(fake.calls.map(call => JSON.parse(call.prompt).document).join('')).toBe(document.chunks[0]!);
  });
  test('digest prompts omit source names and account identifiers while citations keep local provenance', async () => {
    const original = record(1);
    original.provenance.citation = { title: 'Avery Example private laboratory file', authorLabel: 'Avery Example' };
    const seen: unknown[] = [];
    const wrapped = documentDigestAnalyst({ analyze: async pack => {
      seen.push(pack);
      return { answer: 'Invented answer', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'Invented fact' }], unanswered: [] };
    } });
    const out = await wrapped.analyze({ question: 'Review', candidates: [{ ...original, chunks: ['[{"value":"71"}]'] }], builtAt: '2026-10-13T00:00:00Z', coverage: { searchedCorpora: ['private.account-id'], skippedCorpora: [], extractionGaps: [] } }, { localOnly: true });
    expect(JSON.stringify(seen)).not.toContain('Avery');
    expect(JSON.stringify(seen)).not.toContain('synthetic');
    expect(JSON.stringify(seen)).not.toContain('private.account-id');
    expect(out.citations[0]?.provenance).toEqual(original.provenance);
  });
  test('twelve monthly labs retain dates, values, units and ranges, without patient identifiers', async () => {
    let month = 0;
    const fake = model(() => ({ ...facts, facts: [{ ...facts.facts[0], date: `2025-${String(++month).padStart(2, '0')}-03`, value: String(70 + month) }] }));
    const job = createDocumentDigest({ question: 'Review the year of labs.', documents: Array.from({ length: 12 }, (_, i) => record(i + 1)), model: fake.model, eligible: async () => true });
    while (job.progress().state === 'working') await job.step();
    const result = job.result();
    expect(result?.kind).toBe('digest');
    if (result?.kind !== 'digest') throw new Error('digest missing');
    const rows = result.pack.candidates.flatMap(candidate => JSON.parse(candidate.chunks[0]!) as unknown[]);
    expect(rows).toEqual(Array.from({ length: 12 }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, '0')}-03`, test: 'Marker Z', value: String(71 + i), unit: 'mg/dL', reference: '60-100' })));
    const outbound = JSON.stringify(result.pack.candidates.map(candidate => candidate.chunks));
    expect(outbound).not.toContain('Avery');
    expect(outbound).not.toContain('ACCT-');
    expect(fake.calls.every(call => call.localOnly)).toBe(true);
    expect(result.pack.candidates.every(candidate => candidate.trustTier === 'S4' && candidate.trustDomain === 'secure_local')).toBe(true);
  });

  test('a resumable step stops by count, reports only counts, and never re-reads completed documents', async () => {
    const fake = model(() => facts);
    const job = createDocumentDigest({ question: 'Review labs', documents: [record(1), record(2), record(3)], model: fake.model, eligible: async () => true, limits: { documentsPerStep: 1 } });
    await job.step();
    expect(job.progress()).toMatchObject({ state: 'working', documentsRead: 1, documentsTotal: 3 });
    expect(JSON.stringify(job.progress())).not.toContain('Avery');
    expect(job.result()).toBeUndefined();
    await job.step();
    await job.step();
    expect(job.progress()).toMatchObject({ state: 'complete', documentsRead: 3 });
    expect(fake.calls).toHaveLength(3);
  });

  test('Secrets and unknown tiers never reach the local model or the digest', async () => {
    const fake = model(() => facts);
    for (const document of [record(1, 'S5'), { ...record(1), trustTier: 'unexpected' as 'S4' }]) {
      const job = createDocumentDigest({ question: 'Review', documents: [document], model: fake.model, eligible: async () => true });
      await job.step();
      expect(job.progress().state).toBe('refused');
      expect(job.result()).toBeUndefined();
    }
    expect(fake.calls).toHaveLength(0);
  });

  test('a credential in otherwise eligible text is excluded before extraction', async () => {
    const fake = model(() => facts);
    const job = createDocumentDigest({ question: 'Review', documents: [{ ...record(1), chunks: ['password: invented-secret-fixture-71'] }], model: fake.model, eligible: async () => true });
    await job.step();
    expect(job.progress().state).toBe('refused');
    expect(fake.calls).toHaveLength(0);
  });

  test('a tier/scope change during extraction discards the derived digest', async () => {
    let active = true;
    const fake = model(() => { active = false; return facts; });
    const job = createDocumentDigest({ question: 'Review', documents: [record(1)], model: fake.model, eligible: async () => active });
    await job.step();
    expect(job.progress().state).toBe('refused');
    expect(job.result()).toBeUndefined();
  });

  test('identifiers repeated by the extractor are refused, never silently removed from a fact', async () => {
    const fake = model(() => ({ ...facts, facts: [{ patient: 'Avery Example', value: '71' }] }));
    const job = createDocumentDigest({ question: 'Review', documents: [record(1)], model: fake.model, eligible: async () => true });
    await job.step();
    expect(job.progress().state).toBe('refused');
    expect(job.result()).toBeUndefined();
  });

  test('a question requiring wording selects the bounded excerpt fallback without treating facts as the answer', async () => {
    const fake = model(() => ({ fits: false, identifiers: [], facts: [] }));
    const job = createDocumentDigest({ question: 'Explain the wording of this invented agreement', documents: [record(1)], model: fake.model, eligible: async () => true });
    await job.step();
    expect(job.result()?.kind).toBe('excerpts');
  });

  test('budget overflow never publishes a truncated digest as complete', async () => {
    const fake = model(() => facts);
    const job = createDocumentDigest({ question: 'Review', documents: [record(1), record(2)], model: fake.model, eligible: async () => true, limits: { digestBytes: 150 } });
    while (job.progress().state === 'working') await job.step();
    expect(job.progress()).toMatchObject({ state: 'refused', reason: 'digest_limit' });
    expect(job.result()).toBeUndefined();
  });

  test('monthly statements fit the documented annual budget with category and counterparty class', async () => {
    const expected = Array.from({ length: 12 }, (_, month) => Array.from({ length: 100 }, (_, i) => ({ date: `2025-${String(month + 1).padStart(2, '0')}-03`, category: 'groceries', amount: String(i + 1), counterparty_class: 'retailer' }))).flat();
    const statements = Array.from({ length: 12 }, (_, month) => ({ ...record(month + 1), chunks: [expected.slice(month * 100, (month + 1) * 100).map(row => Object.values(row).join(',')).join('\n')] }));
    const fake = model(request => ({ fits: true, identifiers: [], facts: String(JSON.parse(request.prompt).document).trim().split('\n').filter(Boolean).map(line => {
      const [date, category, amount, counterparty_class] = line.split(',');
      return { date, category, amount, counterparty_class };
    }) }));
    const job = createDocumentDigest({ question: 'Review annual statements', documents: statements, model: fake.model, eligible: async () => true });
    while (job.progress().state === 'working') await job.step();
    expect(DOCUMENT_DIGEST_LIMITS.digestBytes).toBeGreaterThanOrEqual(128_000);
    expect(job.result()?.kind).toBe('digest');
    const result = job.result();
    if (result?.kind !== 'digest') throw new Error('digest missing');
    expect(result.pack.candidates.flatMap(candidate => JSON.parse(candidate.chunks[0]!))).toEqual(expected);
  });

  test('abort and model exceptions return content-free refusal and no partial result', async () => {
    const controller = new AbortController();
    const fake: AnalystModel = { async complete() { controller.abort(); throw new Error('Avery Example 71 mg/dL'); } };
    const job = createDocumentDigest({ question: 'Review', documents: [record(1)], model: fake, eligible: async () => true, signal: controller.signal });
    await job.step();
    expect(job.progress().state).toBe('refused');
    expect(JSON.stringify(job.progress())).not.toContain('Avery');
    expect(job.result()).toBeUndefined();
  });
});
