// Cross-route guard for the corpus-alias defect class.
//
// The registry documents input aliases for corpus ids: a caller may name a
// corpus by an old id and must reach the same corpus. Routes that compared the
// raw request string instead of resolving it through the registry broke in four
// different ways, and the worst way was silent:
//
//   /source/index/sync    400 on an alias  (fixed 2026-07-28, sibling WO)
//   /source/index/status  400 on an alias, canonical 200
//   /source/index/embed   400 on an alias, canonical 501
//   /source/answer        200 with NO EVIDENCE - reads as "this source has
//                         nothing on the topic" rather than "wrong id"
//   /source/watch/create  accepted, then the watch never fires
//
// This guard is written so it cannot rot into a restatement of today's code:
//
//   * The alias pair comes from the registry, never from a literal here. If the
//     registry stops aliasing, the premise test fails loudly instead of letting
//     every case pass vacuously by sending the canonical id to itself.
//   * The assertion is not "the route calls the canonicaliser" but "the alias
//     and the canonical id produce the SAME OUTCOME", measured by driving a
//     real worker over HTTP. A route can satisfy it any way it likes; a route
//     cannot satisfy it by accident.
//   * The route inventory is derived by reading the worker source and finding
//     every route whose request-parsing path reads a corpus id off the request.
//     The coverage test then fails if an inventoried route has neither an
//     exercise below nor an explicit acknowledgement. Route number five, added
//     next month, therefore cannot quietly reintroduce this: it lands red.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  LEGACY_READWISE_LIBRARY_CORPUS_ID,
  READWISE_LIBRARY_CORPUS_ID,
  canonicalSourceCorpusId,
} from '../src/core/source-corpus-registry.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type {
  SourceIndexCorpusSearchAdapter,
  SourceIndexRouterAdapterMap,
} from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalSourceWatchStore,
  createTrustedSourceWatchOwnerContext,
} from '../src/core/source-watch.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  sourceAnswerCorpusIds,
} from '../src/workers/source-index/analyst-answer.ts';
import type {
  SourceIndexStatusRequest,
  SourceIndexStatusResult,
} from '../src/workers/source-index/status.ts';
import type {
  ReadwiseConnectorStoreSyncHandler,
  ReadwiseConnectorStoreSyncResult,
} from '../src/workers/readwise/index.ts';

const WORKER_SOURCE = join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'index.ts');
const BASE = 'http://worker.test/v1';

// The two ids under test are read from the registry, not written out here.
const ALIAS = LEGACY_READWISE_LIBRARY_CORPUS_ID;
const CANONICAL = READWISE_LIBRARY_CORPUS_ID;

/**
 * What a route did with the corpus id it was given. Alias and canonical must
 * produce deeply equal outcomes, so anything a route can get wrong has to be
 * visible in here: the status code, the error code, and the effect the route
 * had (which corpus it actually dispatched, stored, or searched).
 */
interface RouteOutcome {
  status: number;
  code?: string;
  effect?: unknown;
}

interface RouteAliasExercise {
  /** Route path under the worker base path, as it appears in the source. */
  route: string;
  run(corpusId: string): Promise<RouteOutcome>;
}

function jsonRequest(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function outcomeOf(response: Response, effect?: unknown): Promise<RouteOutcome> {
  const body = await response.json() as { error?: { code?: string } };
  return {
    status: response.status,
    ...(body?.error?.code ? { code: body.error.code } : {}),
    ...(effect !== undefined ? { effect } : {}),
  };
}

function readwiseSyncResultFixture(): ReadwiseConnectorStoreSyncResult {
  return {
    status: 'idle',
    counts: {
      api_requests: 0,
      daily_api_request_budget: 100,
      items_seen: 0,
      items_indexed: 0,
      items_tombstoned: 0,
      chunks_indexed: 0,
      chunks_embedded: 0,
    },
    api_usage: { utc_day: '2026-08-29' },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      provider_cursor_exposed: false,
    },
  };
}

function statusResultFixture(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-28T00:00:00.000Z',
    corpora: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

/** An adapter that always has something to say, so "no evidence" can only mean
 *  the corpus was never searched. */
function alwaysHitsAdapter(corpusId: string): SourceIndexCorpusSearchAdapter {
  return (request) => ({
    hits: [{
      sourceItem: {
        family: 'readwise' as const,
        provider: 'readwise',
        accountScope: 'personal',
        providerItemId: 'highlight-1',
        localItemId: 'highlight-1',
      },
      provenance: {
        sourceItem: {
          family: 'readwise' as const,
          provider: 'readwise',
          accountScope: 'personal',
          providerItemId: 'highlight-1',
          localItemId: 'highlight-1',
        },
        citation: { title: 'Saved article', uri: `readwise://${corpusId}/highlight-1` },
      },
      score: 1,
      rawExposed: false as const,
    }].slice(0, Math.max(request.maxResults, 1)),
    latencyMs: 1,
    laneAudits: [{
      laneName: `${corpusId}-keyword`,
      laneType: 'keyword' as const,
      candidateCount: 1,
      returnedCount: 1,
      localOnly: true,
      rawExposed: false,
    }],
    rawExposed: false as const,
  });
}

function citingAnalyst(): Analyst {
  return {
    async analyze(pack: EvidencePack): Promise<AnalystResult> {
      return {
        answer: 'Answer from the saved library.',
        citations: pack.candidates.length > 0
          ? [{ provenance: pack.candidates[0]!.provenance, claim: 'a claim' }]
          : [],
        unanswered: [],
      };
    },
  };
}

interface AnsweredCorpora {
  status: number;
  code?: string;
  evidence_corpora: string[];
  searched: string[];
  skipped: string[];
}

/**
 * Drives /source/answer through the real analyst handler - the seam being fixed
 * lives inside it, so a stubbed handler would prove nothing - against a registry
 * that holds only the canonical corpus, with an adapter that always has a hit.
 * Empty evidence therefore means one thing only: the corpus was never searched.
 */
async function runAnswerWithCorpusIds(corpusIds: string[]): Promise<AnsweredCorpora> {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: CANONICAL, family: 'readwise', trustDomain: 'internal' }),
  ]);
  const adapters: Record<string, SourceIndexCorpusSearchAdapter> = {
    [CANONICAL]: alwaysHitsAdapter(CANONICAL),
  };
  const contentProviders = {
    [CANONICAL]: {
      async fetchLocalContent() {
        return {
          sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' as const }),
          chunks: ['a saved highlight about the topic'],
        };
      },
    },
  };
  const worker = createEmailSourceWorker({
    sourceAnswer: createAnalystSourceIndexAnswerHandler({
      analyst: citingAnalyst(),
      lanes: () => ({
        registry,
        adapters: adapters as SourceIndexRouterAdapterMap,
        contentProviders: contentProviders as LocalContentProviderMap,
      }),
    }),
  });
  const response = await worker.fetch(jsonRequest('/source/answer', {
    question: 'What did I save about the topic?',
    corpus_ids: corpusIds,
  }));
  const body = await response.json() as {
    evidence?: { corpus_id: string }[];
    audit?: { searched_corpora?: string[]; skipped_corpora?: { corpus_id: string; reason: string }[] };
    error?: { code?: string };
  };
  return {
    status: response.status,
    ...(body?.error?.code ? { code: body.error.code } : {}),
    evidence_corpora: (body.evidence ?? []).map((item) => item.corpus_id),
    searched: body.audit?.searched_corpora ?? [],
    skipped: (body.audit?.skipped_corpora ?? []).map((item) => `${item.corpus_id}:${item.reason}`),
  };
}

const EXERCISES: RouteAliasExercise[] = [
  {
    // Locks in the sibling WO's fix so it cannot regress.
    route: '/source/index/sync',
    async run(corpusId) {
      let syncCalls = 0;
      const worker = createEmailSourceWorker({
        readwiseConnectorStoreSync: {
          async sync(): Promise<ReadwiseConnectorStoreSyncResult> {
            syncCalls += 1;
            return readwiseSyncResultFixture();
          },
        } as unknown as ReadwiseConnectorStoreSyncHandler,
      });
      const response = await worker.fetch(jsonRequest('/source/index/sync', {
        corpus_id: corpusId,
        account: 'person@example.com',
      }));
      return outcomeOf(response, { corpus_id: CANONICAL, sync_calls: syncCalls });
    },
  },
  {
    route: '/source/index/status',
    async run(corpusId) {
      const seen: (string | undefined)[] = [];
      const worker = createEmailSourceWorker({
        sourceIndexStatus: {
          async status(request: SourceIndexStatusRequest = {}): Promise<SourceIndexStatusResult> {
            seen.push(request.corpus_id);
            return statusResultFixture();
          },
        },
      });
      const response = await worker.fetch(jsonRequest('/source/index/status', { corpus_id: corpusId }));
      return outcomeOf(response, { seen });
    },
  },
  {
    // The GET variant parses the corpus id out of the query string on a
    // different path from POST, so it gets its own exercise.
    route: '/source/index/status#GET',
    async run(corpusId) {
      const seen: (string | undefined)[] = [];
      const worker = createEmailSourceWorker({
        sourceIndexStatus: {
          async status(request: SourceIndexStatusRequest = {}): Promise<SourceIndexStatusResult> {
            seen.push(request.corpus_id);
            return statusResultFixture();
          },
        },
      });
      const response = await worker.fetch(new Request(
        `${BASE}/source/index/status?corpus_id=${encodeURIComponent(corpusId)}`,
      ));
      return outcomeOf(response, { seen });
    },
  },
  {
    // No Readwise embedding lane is configured here, so the honest answer for
    // BOTH ids is the same "not supported" refusal. Before the fix the alias
    // was rejected as an unknown corpus (400) while the canonical id reached
    // the capability gate (501).
    route: '/source/index/embed',
    async run(corpusId) {
      const worker = createEmailSourceWorker({});
      const response = await worker.fetch(jsonRequest('/source/index/embed', { corpus_id: corpusId }));
      return outcomeOf(response);
    },
  },
  {
    // The silent one. The route returns 200 either way; the defect is visible
    // only in whether the corpus was actually searched.
    route: '/source/answer',
    async run(corpusId) {
      const answered = await runAnswerWithCorpusIds([corpusId]);
      return {
        status: answered.status,
        ...(answered.code ? { code: answered.code } : {}),
        effect: {
          evidence_corpora: answered.evidence_corpora,
          searched: answered.searched,
          skipped: answered.skipped,
        },
      };
    },
  },
  {
    // A watch stored against an alias is accepted and then never fires, because
    // the evaluation pass resolves the stored id through a registry that does
    // not carry the alias. The stored corpus id is therefore the outcome.
    route: '/source/watch/create',
    async run(corpusId) {
      const dir = mkdtempSync(join(tmpdir(), 'olympus-alias-watch-'));
      const stateDir = join(dir, 'private-state');
      mkdirSync(stateDir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      const store = new LocalSourceWatchStore(join(stateDir, 'watches.sqlite'));
      try {
        const worker = createEmailSourceWorker({ sourceWatch: { store } });
        const response = await worker.fetch(jsonRequest('/source/watch/create', {
          corpus_id: corpusId,
          query_text: 'a standing question',
          mode: 'one_shot',
        }, {
          'x-olympus-source-watch-owner': 'owner-alias-guard',
          'x-olympus-source-watch-route-kind': 'openclaw_channel',
          'x-olympus-source-watch-route-target': 'telegram:12345',
        }));
        const body = await response.json() as {
          watch?: { corpus_id?: string };
          error?: { code?: string };
        };
        const owner = createTrustedSourceWatchOwnerContext({
          ownerId: 'owner-alias-guard',
          routeKind: 'openclaw_channel',
          routeTargetId: 'telegram:12345',
        });
        const stored = store.listWatches(owner, { limit: 10 }).items.map((watch) => watch.corpusId);
        return {
          status: response.status,
          ...(body?.error?.code ? { code: body.error.code } : {}),
          effect: { returned: body.watch?.corpus_id, stored },
        };
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

/**
 * Reads the worker source and returns every route whose handler - or a request
 * parser that handler calls - reads a corpus id off the request. Derived rather
 * than hand-listed so a newly added route joins the inventory by existing.
 */
function inventoryCorpusAcceptingRoutes(): string[] {
  const source = readFileSync(WORKER_SOURCE, 'utf8');

  // Every request parser in the file, so a route that delegates its parsing is
  // still judged on what its parser reads.
  const parsers = new Map<string, string>();
  for (const match of source.matchAll(/(?:async\s+)?function\s+(parse[A-Za-z0-9_]*)\s*\(/g)) {
    parsers.set(match[1]!, functionBodyAt(source, match.index!));
  }

  const routeMatches = [...source.matchAll(/url\.pathname === `\$\{basePath\}(\/[a-z0-9/_-]+)`/g)];
  const inventory: string[] = [];
  for (const [index, match] of routeMatches.entries()) {
    const start = match.index!;
    const end = index + 1 < routeMatches.length ? routeMatches[index + 1]!.index! : source.length;
    let text = source.slice(start, end);
    for (const [name, body] of parsers) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(text)) text += `\n${body}`;
    }
    if (READS_A_REQUEST_CORPUS_ID.test(text)) inventory.push(match[1]!);
  }
  return [...new Set(inventory)];
}

// A corpus id taken off the request body or query string, as opposed to one
// written into a response. canonicalRequestCorpusId counts because reading the
// request's corpus id is the whole of what it does - a route that has been
// fixed must stay in the inventory, or fixing a route would quietly remove it
// from this guard's coverage.
const READS_A_REQUEST_CORPUS_ID = /record\.corpus_ids?\b|searchParams\.get\(['"]corpus_id|canonicalRequestCorpusId\s*\(/;

function functionBodyAt(source: string, start: number): string {
  const open = source.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
}

describe('corpus alias resolution across every route that accepts a corpus id', () => {
  test('the premise holds: the registry still documents an alias distinct from its canonical id', () => {
    // Without this, every case below could pass by sending the canonical id to
    // itself and proving nothing at all.
    expect(ALIAS).not.toBe(CANONICAL);
    expect(canonicalSourceCorpusId(ALIAS)).toBe(CANONICAL);
    expect(canonicalSourceCorpusId(CANONICAL)).toBe(CANONICAL);
  });

  for (const exercise of EXERCISES) {
    test(`${exercise.route} treats a documented alias exactly like its canonical id`, async () => {
      const canonical = await exercise.run(CANONICAL);
      const alias = await exercise.run(ALIAS);
      expect(alias).toEqual(canonical);
    });
  }

  test('naming one corpus by both of its ids behaves exactly like naming it once', async () => {
    const once = await runAnswerWithCorpusIds([CANONICAL]);
    const twice = await runAnswerWithCorpusIds([ALIAS, CANONICAL]);

    expect(twice).toEqual(once);
    expect(once.searched).toEqual([CANONICAL]);
    expect(once.evidence_corpora).toEqual([CANONICAL]);
  });

  test('the requested-corpus list resolves before it dedupes, so both ids collapse to one', () => {
    // The router visits each registry corpus once however many times it was
    // named, so getting this order wrong is invisible from outside the process.
    // Asserted at the seam instead, because a requirement whose test cannot fail
    // is not being tested.
    expect(sourceAnswerCorpusIds({ question: 'q', corpus_ids: [ALIAS, CANONICAL] })).toEqual([CANONICAL]);
    expect(sourceAnswerCorpusIds({ question: 'q', corpus_id: ALIAS, corpus_ids: [CANONICAL] })).toEqual([CANONICAL]);
    expect(sourceAnswerCorpusIds({ question: 'q', corpus_ids: [` ${ALIAS} `] })).toEqual([CANONICAL]);
    expect(sourceAnswerCorpusIds({ question: 'q' })).toBeUndefined();
  });

  test('the derived route inventory is real and covers every deeply exercised route', () => {
    const inventory = inventoryCorpusAcceptingRoutes();
    // If the derivation breaks, the sweep below would pass over an empty list
    // and prove nothing. Fail loudly instead.
    expect(inventory.length).toBeGreaterThan(5);

    // A deep exercise naming a route that no longer exists is a dead test.
    const exercised = [...new Set(EXERCISES.map((exercise) => exercise.route.split('#')[0]!))];
    expect(exercised.filter((route) => !inventory.includes(route))).toEqual([]);
  });

  // Every route that reads a corpus id off the request gets swept, whether or not
  // anyone remembered to write it a deep exercise. There is no list to forget to
  // update: the inventory is derived from the worker source, so route number
  // five joins this sweep by existing. Routes whose family the registry does not
  // alias pass trivially - which is the point, because the day an alias IS added
  // for one of those families, they stop passing trivially and start failing.
  for (const route of inventoryCorpusAcceptingRoutes()) {
    test(`${route} does not diverge between a documented alias and its canonical id`, async () => {
      const run = async (corpusId: string): Promise<RouteOutcome> => {
        const worker = createEmailSourceWorker({});
        const response = await worker.fetch(jsonRequest(route, { corpus_id: corpusId }));
        return outcomeOf(response);
      };
      expect(await run(ALIAS)).toEqual(await run(CANONICAL));
    });
  }
});
