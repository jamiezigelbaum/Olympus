import type {
  RetrievalLaneAudit,
  SourceFamily,
  SourceIndexProvenance,
  SourceItemIdentity,
} from './types.ts';

export interface SourceIndexEvalCase<Filters extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  family: SourceFamily;
  query: string;
  filters?: Filters;
  expected: SourceIndexEvalExpectation;
  k?: number;
  maxResults?: number;
}

export interface SourceIndexEvalExpectation {
  sourceItem?: SourceItemIdentityExpectation;
  provenance?: SourceIndexProvenanceExpectation;
}

export type SourceItemIdentityExpectation = Partial<Pick<
  SourceItemIdentity,
  | 'family'
  | 'provider'
  | 'accountScope'
  | 'providerItemId'
  | 'providerThreadId'
  | 'providerConversationId'
  | 'providerFileId'
  | 'providerEventId'
  | 'localItemId'
  | 'sourceVersion'
>>;

export interface SourceIndexProvenanceExpectation {
  providerIds?: Readonly<Record<string, string>>;
  providerIdKeys?: readonly string[];
  localIds?: Readonly<Record<string, string>>;
  localIdKeys?: readonly string[];
  syncRunId?: string;
  syncRunRequired?: boolean;
  syncCheckpoint?: string;
  chunkRequired?: boolean;
  citationRequired?: boolean;
}

export interface SourceIndexEvalSearchItem {
  sourceItem: SourceItemIdentity;
  provenance?: SourceIndexProvenance;
  laneAudits?: readonly RetrievalLaneAudit[];
  rawExposed: false;
}

export interface SourceIndexEvalSearchResponse {
  items: readonly SourceIndexEvalSearchItem[];
  latencyMs: number;
  laneAudits?: readonly RetrievalLaneAudit[];
  rawExposed: false;
}

export type SourceIndexEvalSearchAdapter<Filters extends Record<string, unknown> = Record<string, unknown>> = (
  evalCase: SourceIndexEvalCase<Filters>,
) => SourceIndexEvalSearchResponse | Promise<SourceIndexEvalSearchResponse>;

export interface SourceIndexEvalResult {
  caseId: string;
  family: SourceFamily;
  foundExpected: boolean;
  topResultCorrect: boolean;
  provenanceCorrect: boolean;
  itemCount: number;
  latencyMs: number;
  rawExposed: false;
  laneAudits?: readonly SourceIndexEvalLaneAuditSummary[];
}

export interface SourceIndexEvalLaneAuditSummary {
  laneName: string;
  laneType: RetrievalLaneAudit['laneType'];
  candidateCount: number;
  returnedCount: number;
  skippedReason?: string;
  backend?: string;
  localOnly: boolean;
  rawExposed: false;
}

export interface SourceIndexEvalSummary {
  caseCount: number;
  recallAtK: number;
  topResultCorrectRate: number;
  provenanceCorrectRate: number;
  rawExposed: false;
  avgLatencyMs: number;
  results: SourceIndexEvalResult[];
}

export interface RunSourceIndexEvalOptions<Filters extends Record<string, unknown> = Record<string, unknown>> {
  cases: readonly SourceIndexEvalCase<Filters>[];
  search: SourceIndexEvalSearchAdapter<Filters>;
}

const FORBIDDEN_SOURCE_INDEX_EVAL_KEYS = new Set([
  'body',
  'bodies',
  'content',
  'contents',
  'message',
  'messages',
  'raw',
  'raw_packet',
  'rawPacket',
  'raw_source',
  'rawSource',
  'raw_source_text',
  'rawSourceText',
  'snippet',
  'snippets',
  'source_text',
  'sourceText',
  'text',
  'access_token',
  'accessToken',
  'api_key',
  'apiKey',
  'approved_scope_key',
  'approvedScopeKey',
  'refresh_token',
  'refreshToken',
  'token',
]);
const NORMALIZED_FORBIDDEN_SOURCE_INDEX_EVAL_KEYS = new Set(
  [...FORBIDDEN_SOURCE_INDEX_EVAL_KEYS].map(normalizeSourceIndexEvalKey),
);

export async function runSourceIndexEval<Filters extends Record<string, unknown> = Record<string, unknown>>(
  options: RunSourceIndexEvalOptions<Filters>,
): Promise<SourceIndexEvalSummary> {
  const results: SourceIndexEvalResult[] = [];

  for (const evalCase of options.cases) {
    const response = await options.search(evalCase);
    assertSafeEvalResponse(response);

    const evaluatedItems = response.items.slice(0, evalResultLimit(evalCase, response.items.length));
    const top = evaluatedItems[0];
    const expected = normalizeExpectation(evalCase);
    const matchingItems = evaluatedItems.filter((item) => matchesExpectation(item, expected));
    const foundExpected = matchingItems.length > 0;
    const topResultCorrect = top ? matchesExpectation(top, expected) : false;
    const provenanceCorrect = foundExpected
      ? matchingItems.some((item) => provenanceMatches(item.provenance, expected.provenance))
      : false;

    const laneAudits = summarizeLaneAudits(response.laneAudits);
    results.push({
      caseId: evalCase.id,
      family: evalCase.family,
      foundExpected,
      topResultCorrect,
      provenanceCorrect,
      itemCount: evaluatedItems.length,
      latencyMs: Math.round(response.latencyMs),
      rawExposed: false,
      ...(laneAudits.length > 0 ? { laneAudits } : {}),
    });
  }

  const summary: SourceIndexEvalSummary = {
    caseCount: options.cases.length,
    recallAtK: average(results.map((result) => result.foundExpected)),
    topResultCorrectRate: average(results.map((result) => result.topResultCorrect)),
    provenanceCorrectRate: average(results.map((result) => result.provenanceCorrect)),
    rawExposed: false,
    avgLatencyMs: Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / Math.max(1, results.length)),
    results,
  };
  assertSafeEvalSummary(summary);
  return summary;
}

function normalizeExpectation(evalCase: SourceIndexEvalCase): SourceIndexEvalExpectation {
  return {
    ...evalCase.expected,
    sourceItem: {
      family: evalCase.family,
      ...evalCase.expected?.sourceItem,
    },
  };
}

function evalResultLimit(evalCase: SourceIndexEvalCase, returnedCount: number): number {
  const requested = evalCase.k ?? evalCase.maxResults ?? returnedCount;
  if (!Number.isFinite(requested)) return returnedCount;
  return Math.max(0, Math.min(Math.floor(requested), returnedCount));
}

function matchesExpectation(item: SourceIndexEvalSearchItem, expectation: SourceIndexEvalExpectation): boolean {
  const sourceItem = expectation.sourceItem;
  if (!sourceItem) return true;
  return Object.entries(sourceItem).every(([key, expected]) => {
    if (expected === undefined) return true;
    return item.sourceItem[key as keyof SourceItemIdentity] === expected;
  });
}

function provenanceMatches(
  provenance: SourceIndexProvenance | undefined,
  expectation: SourceIndexProvenanceExpectation | undefined,
): boolean {
  if (!expectation) return provenance !== undefined;
  if (!provenance) return false;
  if (expectation.syncRunRequired === true && typeof provenance.syncRunId !== 'string') return false;
  if (expectation.syncRunId !== undefined && provenance.syncRunId !== expectation.syncRunId) return false;
  if (expectation.syncCheckpoint !== undefined && provenance.syncCheckpoint !== expectation.syncCheckpoint) return false;
  if (expectation.chunkRequired === true && !provenance.chunk) return false;
  if (expectation.citationRequired === true && !provenance.citation) return false;
  if (!recordContains(provenance.providerIds, expectation.providerIds)) return false;
  if (!recordContains(provenance.localIds, expectation.localIds)) return false;
  if (!recordHasKeys(provenance.providerIds, expectation.providerIdKeys)) return false;
  if (!recordHasKeys(provenance.localIds, expectation.localIdKeys)) return false;
  return true;
}

function recordContains(
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function recordHasKeys(
  actual: Readonly<Record<string, string>> | undefined,
  expectedKeys: readonly string[] | undefined,
): boolean {
  if (!expectedKeys) return true;
  if (!actual) return false;
  return expectedKeys.every((key) => typeof actual[key] === 'string' && actual[key].length > 0);
}

function summarizeLaneAudits(laneAudits: readonly RetrievalLaneAudit[] | undefined): SourceIndexEvalLaneAuditSummary[] {
  if (!laneAudits) return [];
  return laneAudits.map((audit) => ({
    laneName: audit.laneName,
    laneType: audit.laneType,
    candidateCount: audit.candidateCount,
    returnedCount: audit.returnedCount,
    ...(audit.skippedReason ? { skippedReason: audit.skippedReason } : {}),
    ...(audit.backend ? { backend: audit.backend } : {}),
    localOnly: audit.localOnly,
    rawExposed: false,
  }));
}

function average(values: boolean[]): number {
  if (values.length === 0) return 0;
  return Number((values.filter(Boolean).length / values.length).toFixed(3));
}

function assertSafeEvalResponse(response: SourceIndexEvalSearchResponse): void {
  if (response.rawExposed !== false) {
    throw new Error('Source-index eval adapter reported raw source exposure.');
  }
  for (const item of response.items) {
    if (item.rawExposed !== false) {
      throw new Error('Source-index eval adapter returned an item with raw source exposure.');
    }
  }
  assertNoForbiddenEvalKeys(response, []);
}

function assertSafeEvalSummary(summary: SourceIndexEvalSummary): void {
  assertNoForbiddenEvalKeys(summary, []);
}

function assertNoForbiddenEvalKeys(value: unknown, path: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenEvalKeys(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (NORMALIZED_FORBIDDEN_SOURCE_INDEX_EVAL_KEYS.has(normalizeSourceIndexEvalKey(key))) {
      const location = [...path, key].join('.');
      throw new Error(`Source-index eval output included forbidden raw field "${location}".`);
    }
    assertNoForbiddenEvalKeys(child, [...path, key]);
  }
}

function normalizeSourceIndexEvalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
