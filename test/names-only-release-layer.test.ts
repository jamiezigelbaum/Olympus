/**
 * A names-only candidate (a Private file whose names stay Personal) put only
 * its names in front of the model, so the release check judges it by its names
 * tier. Judging it by the Private text the answer never read withheld every
 * answer that merely matched such a file by name ("an item became Private").
 */
import { describe, expect, test } from 'bun:test';
import {
  ANSWER_BECAME_PRIVATE,
  createReleaseManifestSink,
  runWithReleaseManifestSink,
  type ReleaseCheck,
  type ReleaseInput,
} from '../src/core/release-manifest.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';

const CORPUS = 'internal.dropbox.files';
const ANSWER = 'Two files are about beekeeping.';

/** The ledger as it stands for a Private file: names Personal, content Private. */
function privateFileCheck(): { check: ReleaseCheck; seen: ReleaseInput[][] } {
  const seen: ReleaseInput[][] = [];
  return {
    seen,
    check: {
      inputs: (inputs) => {
        seen.push([...inputs]);
        return inputs.map((input) => (input.providerItemId === 'private-file' && input.layer !== 'names'
          ? { tier: 'private' as const, gone: false }
          : { tier: 'public_or_personal' as const, gone: false }));
      },
      secureDerivativeDefault: () => 'allow',
    },
  };
}

function handlerFor(check: ReleaseCheck) {
  const item = (id: string) => ({ family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}` });
  const hit = (id: string, title: string) => ({ sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title } }, score: 1, rawExposed: false as const });
  return createAnalystSourceIndexAnswerHandler({
    releaseCheck: check,
    analyst: {
      async analyze(pack) {
        return { answer: ANSWER, citations: [{ provenance: pack.candidates[0]!.provenance, claim: ANSWER }], unanswered: [] };
      },
    },
    lanes: () => ({
      registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' })]),
      adapters: {
        [CORPUS]: () => ({
          hits: [hit('personal-file', 'hive-inspection.md'), hit('private-file', 'beekeeping-insurance.md')],
          latencyMs: 1,
          rawExposed: false as const,
        }),
      },
      contentProviders: {
        [CORPUS]: {
          async fetchLocalContent(request: { provenance: { sourceItem: { providerItemId: string } } }) {
            const sensitivity = buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' });
            return request.provenance.sourceItem.providerItemId === 'private-file'
              ? { sensitivity, chunks: [], namesOnly: true }
              : { sensitivity, chunks: ['Inspected both hives on Saturday.'] };
          },
        },
      },
    }),
  });
}

describe('a names-only candidate in the release check', () => {
  test('is a names-layer input, so a Private file matched by name does not withhold the answer', async () => {
    const { check, seen } = privateFileCheck();
    const sink = createReleaseManifestSink();
    const result = await runWithReleaseManifestSink(sink, () => handlerFor(check).answer({ question: 'How many items do I have about beekeeping?' }));

    expect(result.answer).not.toBe(ANSWER_BECAME_PRIVATE);
    expect(result.answer).toContain(ANSWER);
    const inputs = sink.manifests[0]!.inputs;
    expect(inputs.find((input) => input.providerItemId === 'private-file')).toMatchObject({ layer: 'names', privateAtAnswer: false });
    expect(inputs.find((input) => input.providerItemId === 'personal-file')?.layer).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
  });
});
