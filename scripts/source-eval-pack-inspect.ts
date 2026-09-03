import { existsSync, readFileSync } from 'node:fs';
import {
  buildEvidencePackDetailed,
  type EvidencePackBuildDetail,
} from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
} from '../src/workers/connector-store/index.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_FILES_CORPUS_ID,
} from '../src/workers/dropbox-files/index.ts';
import type { EvalDataset, EvalQuestion } from '../eval/types.ts';

const DEFAULT_DATASET_PATH = 'eval/private/held-out.real.json';
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_CHARS_PER_CANDIDATE = 3_000;

const QUESTION_STOPWORDS = new Set([
  'about',
  'across',
  'answer',
  'and',
  'are',
  'cite',
  'details',
  'document',
  'documents',
  'each',
  'for',
  'from',
  'give',
  'into',
  'looking',
  'recorded',
  'source',
  'sources',
  'the',
  'value',
  'values',
  'what',
  'where',
  'which',
  'with',
]);

async function main(): Promise<void> {
  const datasetPath = process.argv[2] ?? DEFAULT_DATASET_PATH;
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }
  const dbPath = process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH?.trim();
  if (!dbPath) {
    throw new Error('Set OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH to the local Dropbox connector store.');
  }

  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as EvalDataset;
  const questionId = process.env.OLYMPUS_EVAL_INSPECT_QUESTION_ID?.trim();
  const question = selectQuestion(dataset, questionId);
  const account = process.env.OLYMPUS_SOURCE_INDEX_ACCOUNT?.trim() || undefined;
  const approvedScopeKey = process.env.OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY?.trim() || undefined;
  const maxResults = parsePositiveIntegerEnv(
    process.env.OLYMPUS_EVAL_MAX_RESULTS,
    DEFAULT_MAX_RESULTS,
    'OLYMPUS_EVAL_MAX_RESULTS',
  );
  const maxCharsPerCandidate = parsePositiveIntegerEnv(
    process.env.OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE,
    DEFAULT_MAX_CHARS_PER_CANDIDATE,
    'OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE',
  );

  const store = new LocalConnectorStore({
    dbPath,
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    readOnly: true,
  });
  try {
    const detail = await buildPack({
      store,
      question,
      ...(account ? { account } : {}),
      ...(approvedScopeKey ? { approvedScopeKey } : {}),
      maxResults,
      maxCharsPerCandidate,
    });
    console.log(JSON.stringify(summarizePack(detail, question, {
      maxResults,
      maxCharsPerCandidate,
    }), null, 2));
  } finally {
    store.close();
  }
}

function selectQuestion(dataset: EvalDataset, questionId: string | undefined): EvalQuestion {
  const question = questionId
    ? dataset.questions.find((candidate) => candidate.id === questionId)
    : dataset.questions[0];
  if (!question) {
    throw new Error(questionId ? `Question not found: ${questionId}` : 'Dataset has no questions.');
  }
  return question;
}

async function buildPack(input: {
  store: LocalConnectorStore;
  question: EvalQuestion;
  account?: string;
  approvedScopeKey?: string;
  maxResults: number;
  maxCharsPerCandidate: number;
}): Promise<EvidencePackBuildDetail> {
  const scope = resolveDropboxScope(input.account, input.approvedScopeKey);
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({
      corpusId: DROPBOX_FILES_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    }),
  ]);
  const adapters = {
    [DROPBOX_FILES_CORPUS_ID]: createConnectorStoreCorpusAdapter({
      store: input.store,
      ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
      ...(scope.locatorPathScope
        ? { filters: { provider: 'dropbox', locatorPathScope: scope.locatorPathScope } }
        : {}),
    }),
  };
  const contentProviders = {
    [DROPBOX_FILES_CORPUS_ID]: createConnectorStoreContentProvider({ store: input.store }),
  };
  return buildEvidencePackDetailed({
    question: input.question.question,
    maxResults: input.maxResults,
    maxCharsPerCandidate: input.maxCharsPerCandidate,
    searchContext: {
      allowedTrustDomains: ['public_safe', 'internal', 'secure_local'],
    },
    registry,
    adapters,
    contentProviders,
  });
}

function resolveDropboxScope(
  account: string | undefined,
  approvedScopeKey: string | undefined,
): { accountScope?: string; locatorPathScope?: string } {
  if (!approvedScopeKey) return account ? { accountScope: account } : {};
  if (!account) throw new Error('OLYMPUS_SOURCE_INDEX_ACCOUNT is required for an approved Dropbox scope.');
  const resolution = DROPBOX_APPROVED_SCOPE_FILTER_CODEC.resolveLocatorPath(approvedScopeKey, {
    provider: 'dropbox',
    accountScope: account,
  });
  if (resolution.kind !== 'path') throw new Error('Approved Dropbox scope must resolve to a path.');
  return { accountScope: resolution.accountScope, locatorPathScope: resolution.locatorPath };
}

function summarizePack(
  detail: EvidencePackBuildDetail,
  question: EvalQuestion,
  options: { maxResults: number; maxCharsPerCandidate: number },
): Record<string, unknown> {
  const questionTerms = substantiveQuestionTerms(question.question);
  const expectedValues = question.expectedAnswerContains ?? [];
  const expectedIds = new Set(
    (question.expectedEvidence ?? [])
      .map((evidence) => evidence.providerItemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const candidates = detail.pack.candidates.map((candidate, rank) => {
    const citation = candidate.provenance.citation;
    const sourceText = [
      ...candidate.chunks,
      ...(candidate.facts ?? []).map((fact) => fact.claim),
      ...(candidate.tables ?? []).flatMap((table) => table.rows.flatMap((row) => [...row])),
      citation?.title ?? '',
      citation?.sourceLabel ?? '',
      citation?.uri ?? '',
      citation?.authoredAt ?? '',
      citation?.updatedAt ?? '',
    ].join(' ');
    const normalized = sourceText.toLowerCase();
    const providerItemId = candidate.provenance.sourceItem.providerItemId;
    return {
      rank,
      providerItemId,
      expectedEvidence: expectedIds.has(providerItemId),
      trustDomain: candidate.trustDomain,
      trustTier: candidate.trustTier,
      score: candidate.score,
      chunkCount: candidate.chunks.length,
      chunkChars: candidate.chunks.map((chunk) => chunk.length),
      totalChunkChars: candidate.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      truncatedByRequest: candidate.chunks.some((chunk) => chunk.length >= options.maxCharsPerCandidate),
      factCount: candidate.facts?.length ?? 0,
      tableCount: candidate.tables?.length ?? 0,
      expectedValuePresence: expectedValues.map((value, index) => ({
        index,
        present: normalized.includes(value.toLowerCase()),
      })),
      questionTermHits: questionTerms.filter((term) => normalized.includes(term)),
    };
  });
  return {
    kind: 'source_eval_pack_inspection',
    questionId: question.id,
    shape: question.shape,
    maxCharsPerCandidate: options.maxCharsPerCandidate,
    maxResultsRequested: options.maxResults,
    searchedCorpora: detail.pack.coverage.searchedCorpora,
    extractionGapCount: detail.pack.coverage.extractionGaps.length,
    extractionGaps: detail.pack.coverage.extractionGaps,
    expectedEvidenceFound: [...expectedIds].map((providerItemId) => ({
      providerItemId,
      rank: candidates.find((candidate) => candidate.providerItemId === providerItemId)?.rank ?? -1,
    })),
    totalChunkChars: candidates.reduce((sum, candidate) => sum + candidate.totalChunkChars, 0),
    candidateCount: candidates.length,
    candidates,
  };
}

function substantiveQuestionTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || QUESTION_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

await main();
