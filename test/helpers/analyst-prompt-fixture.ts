import type { EvidencePack } from '../../src/core/contracts.ts';

/** Synthetic Private items with the citation labels a real retrieved pack carries. */
export function analystPromptFixture(): { pack: EvidencePack; corpusIds: string[] } {
  const corpusIds = Array.from({ length: 24 }, (_, index) => `secure_local.fixture.store-${index % 3}`);
  const pack: EvidencePack = {
    question: 'What do the sources hold about the harbor project?',
    candidates: corpusIds.map((_, index) => ({
      provenance: {
        sourceItem: {
          family: 'file', provider: 'fixture', accountScope: 'personal',
          providerItemId: `report-${index}`, localItemId: `personal:report-${index}`,
        },
        citation: {
          title: `Harbor project progress report ${String(index).padStart(2, '0')}.txt`,
          uri: `/Documents/Projects/Harbor/Quarterly reports/Harbor project progress report ${String(index).padStart(2, '0')}.txt`,
          sourceLabel: 'Project document archive',
          conversationLabel: 'Harbor project planning discussion',
          authorLabel: 'Morgan Ellis, project coordinator',
          parentLabel: 'Harbor project quarterly planning records',
          authoredAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-31T16:30:00.000Z',
        },
      },
      trustTier: 'S4', trustDomain: 'secure_local',
      chunks: [`Report ${index}: ${'The harbor project records the survey findings and next steps. '.repeat(65)}`],
    })),
    coverage: {
      searchedCorpora: [...new Set(corpusIds)],
      skippedCorpora: [{ corpusId: 'unavailable', reason: 'not mounted' }],
      extractionGaps: ['One scanned appendix could not be read.'],
      matchCounts: [...new Set(corpusIds)].map((corpusId, index) => ({
        corpusId, family: 'file', matchedItems: 80, contentMatchedItems: 70,
        atLeast: index === 0, inEvidence: 8,
      })),
    },
    builtAt: '2026-11-01T00:00:00.000Z',
  };
  return { pack, corpusIds };
}
