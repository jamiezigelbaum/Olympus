import { expect, test } from 'bun:test';
import type { EvidencePack } from '../src/core/contracts.ts';
import { runDocumentConsult, type DocumentConsultDependencies } from '../src/workers/source-index/document-consult.ts';
const pack: EvidencePack = { question: 'Review the invented labs', candidates: [{ provenance: { sourceItem: { family: 'file', provider: 'fixture', accountScope: 'synthetic', localItemId: 'lab', providerItemId: 'lab' } }, trustDomain: 'secure_local', trustTier: 'S4', chunks: ['[{"test":"Marker Z","value":"71","unit":"mg/dL"}]'] }], coverage: { searchedCorpora: ['fixture.private'], skippedCorpora: [], extractionGaps: [] }, builtAt: '2026-10-13T00:00:00.000Z' };
test('both providers use the same local digest and keep its source guard through final delivery', async () => {
  let current = true;
  const seen: unknown[] = [];
  let guard: (() => Promise<boolean>) | undefined;
  const deps: DocumentConsultDependencies = {
    preflight: () => undefined,
    prepare: async () => ({ kind: 'digest', pack, snapshot: pack, refs: [], current: () => current }),
    ask: async input => { seen.push(input.documents?.digest); return { ok: true, reply: 'Invented answer', sent: 'Invented exact request', model: 'fixture/answer', route: 'zkAPI via Tor', networkIdentity: 'hidden', level: 'standard', rewritten: true, remembered: false }; },
    venice: async (evidence, authorize) => { expect(authorize()).toBe(true); seen.push(evidence); return { reply: 'Venice invented answer', sent: 'Exact Venice messages', model: 'fixture/venice' }; },
  };
  const input = { question: pack.question, signal: new AbortController().signal, registerDocumentGuard: (value: () => Promise<boolean>) => { guard = value; } };
  expect(await runDocumentConsult(input, deps)).toMatchObject({ ok: true, privateDocuments: true, sent: 'Invented exact request' });
  expect(await runDocumentConsult({ ...input, provider: 'venice' }, deps)).toMatchObject({ ok: true, privateDocuments: true, sent: 'Exact Venice messages', model: 'fixture/venice' });
  expect(JSON.stringify(seen[0])).toContain('Marker Z');
  expect(seen[1]).toEqual(pack);
  current = false;
  expect(await guard!()).toBe(false);
});
test('a source change while the provider works withdraws reply and sent text', async () => {
  let current = true;
  const result = await runDocumentConsult({ question: pack.question, provider: 'venice' }, {
    preflight: () => undefined,
    prepare: async () => ({ kind: 'digest', pack, snapshot: pack, refs: [], current: () => current }),
    ask: async () => { throw new Error('must not run'); },
    venice: async () => { current = false; return { reply: 'Invented private inference', sent: 'Marker Z 71', model: 'fixture' }; },
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain('Marker Z');
  expect(JSON.stringify(result)).not.toContain('private inference');
});
test('unsupported traversal and unaccepted notice refuse before any provider sees data', async () => {
  let prepared = false;
  let sent = false;
  const deps: DocumentConsultDependencies = {
    preflight: () => ({ ok: false, code: 'acknowledgements_incomplete', message: 'Accept the notice on this computer.' }),
    prepare: async () => { prepared = true; return { kind: 'refused', reason: 'document_traversal_unsupported', current: () => false }; },
    ask: async () => { sent = true; throw new Error('must not run'); },
  };
  expect(await runDocumentConsult({ question: 'Review' }, deps)).toMatchObject({ ok: false, code: 'acknowledgements_incomplete' });
  expect(prepared).toBe(false);
  expect(await runDocumentConsult({ question: 'Review' }, { ...deps, preflight: () => undefined })).toMatchObject({ ok: false, code: 'documents_unavailable' });
  expect(sent).toBe(false);
});
test('a failed Venice response retains the exact attempted request only in the private result', async () => {
  const result = await runDocumentConsult({ question: pack.question, provider: 'venice' }, {
    preflight: () => undefined,
    prepare: async () => ({ kind: 'digest', pack, snapshot: pack, refs: [], current: () => true }),
    ask: async () => { throw new Error('must not run'); },
    venice: async (_pack, _guard, _input, dispatched) => { dispatched('Exact invented request bytes'); throw new Error('synthetic provider failure'); },
  });
  expect(result).toMatchObject({ ok: false, privateDocuments: true, sent: 'Exact invented request bytes', outcome: 'unknown' });
});
