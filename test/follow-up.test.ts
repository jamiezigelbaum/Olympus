import { afterEach, describe, expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { EvidencePackBuildDetail, LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  FOLLOW_UP_WEAK_BARS,
  followUpScopeOptions,
  isNarrowHandle,
  issueNarrowHandle,
  resolveNarrowHandle,
  scopeContains,
  searchCutShort,
  setNarrowHandleClockForTest,
  weakSearch,
  type FollowUpCandidate,
} from '../src/core/follow-up.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { answerToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { parseSourceIndexAnswerRequest } from '../src/workers/engine/http/source-index-requests.ts';
import type { SourceIndexAnswerRequest } from '../src/workers/source-index/answer-types.ts';
import { createAnalystSourceIndexAnswerHandler, weakSearchFollowUp } from '../src/workers/source-index/analyst-answer.ts';

const STRONG = { rerankBest: 6, conceptShareBest: 0.9, vectorMarginBest: 0.1 };
const WEAK = { rerankBest: -8, conceptShareBest: 0.2 };

afterEach(() => setNarrowHandleClockForTest(undefined));

describe('weak search decision', () => {
  test('no citations is weak; a cut-short search never is', () => {
    expect(weakSearch({ citations: 0, strength: STRONG, cutShort: false })).toEqual({ weak: true, reason: 'no_citations' });
    expect(weakSearch({ citations: 0, strength: WEAK, cutShort: true })).toEqual({ weak: false });
  });

  test('cited answers are weak only when every measured signal is under its bar', () => {
    expect(weakSearch({ citations: 2, strength: WEAK, cutShort: false })).toEqual({ weak: true, reason: 'low_relevance' });
    expect(weakSearch({ citations: 2, strength: STRONG, cutShort: false })).toEqual({ weak: false });
    expect(weakSearch({ citations: 2, strength: { ...WEAK, rerankBest: FOLLOW_UP_WEAK_BARS.rerankScore + 1 }, cutShort: false })).toEqual({ weak: false });
    expect(weakSearch({ citations: 2, strength: { ...WEAK, conceptShareBest: 0.5 }, cutShort: false })).toEqual({ weak: false });
    expect(weakSearch({ citations: 2, strength: { ...WEAK, vectorMarginBest: 0.2 }, cutShort: false })).toEqual({ weak: false });
  });

  test('a signal nobody measured never makes a cited answer weak', () => {
    expect(weakSearch({ citations: 1, cutShort: false })).toEqual({ weak: false });
    expect(weakSearch({ citations: 1, strength: { conceptShareBest: 0 }, cutShort: false })).toEqual({ weak: false });
    expect(weakSearch({ citations: 1, strength: { rerankBest: -10 }, cutShort: false })).toEqual({ weak: false });
  });

  test('busy or cut stores are coverage, an unwired one is not', () => {
    expect(searchCutShort({ skippedReasons: ['lane_timeout'], degradationReasons: [] })).toBe(true);
    expect(searchCutShort({ skippedReasons: [], degradationReasons: ['semantic_lane_skipped'] })).toBe(true);
    expect(searchCutShort({ skippedReasons: ['not_requested'], degradationReasons: ['lane_budget_cut', 'lane_no_adapter'] })).toBe(false);
  });
});

describe('follow-up options', () => {
  const chat = (over: Partial<FollowUpCandidate> = {}): FollowUpCandidate => ({
    corpusId: 'internal.telegram.messages', source: 'Telegram', conversationId: 'chat-1', conversationLabel: 'Wellness chat',
    authorLabel: 'Alice', authoredAt: '2022-03-01T10:00:00Z', namesReleasable: true, ...over,
  });

  test('groups by metadata only, biggest first, with counts and years', () => {
    const options = followUpScopeOptions([
      chat(), chat({ authoredAt: '2024-05-01T00:00:00Z', authorLabel: 'Bob' }), chat({ authorLabel: 'Bob' }),
      { corpusId: 'internal.gmail.messages', source: 'Gmail', authorLabel: 'Dr. X', authoredAt: '2022-01-02T00:00:00Z', namesReleasable: true },
    ]);
    expect(options.map((option) => option.label)).toEqual([
      'Wellness chat in Telegram (3 items, 2022 to 2024)',
      '2022 (3 items)',
      'Telegram from Bob (2 items, 2022 to 2024)',
      'Gmail from Dr. X (1 item, 2022)',
    ]);
    expect(options[0]!.scope).toEqual({ corpus_ids: ['internal.telegram.messages'], conversation_id: 'chat-1' });
    expect(options[1]!.scope).toEqual({ authored_after: '2022-01-01T00:00:00.000Z', authored_before: '2022-12-31T23:59:59.999Z' });
    expect(options[3]!.scope).toEqual({ corpus_ids: ['internal.gmail.messages'], sender_label: 'Dr. X' });
  });

  test('a candidate whose names may not be released is left out entirely', () => {
    const options = followUpScopeOptions([
      chat({ conversationLabel: 'Private chat', authorLabel: 'Hidden', namesReleasable: false }),
      chat(),
    ]);
    const text = JSON.stringify(options);
    expect(text).not.toContain('Private chat');
    expect(text).not.toContain('Hidden');
    expect(options[0]!.label).toBe('Wellness chat in Telegram (1 item, 2022)');
    expect(followUpScopeOptions([chat({ namesReleasable: false })])).toEqual([]);
  });

  test('a secret-like label is never offered; two groups with the same items are offered once', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGH12';
    const { authorLabel: _author, authoredAt: _at, ...bare } = chat({ conversationLabel: token });
    const options = followUpScopeOptions([bare]);
    expect(JSON.stringify(options)).not.toContain(token);
    // Source and nothing else: the conversation was dropped, so one option remains.
    expect(options.map((option) => option.kind)).toEqual(['source']);
  });

  test('scopes contain exactly the items they name', () => {
    const item = { corpusId: 'internal.telegram.messages', conversationId: 'chat-1', senderLabel: 'Alice Smith', authoredAt: '2022-03-01T10:00:00Z' };
    expect(scopeContains({ corpus_ids: ['internal.telegram.messages'], conversation_id: 'chat-1' }, item)).toBe(true);
    expect(scopeContains({ corpus_ids: ['internal.gmail.messages'] }, item)).toBe(false);
    expect(scopeContains({ sender_label: 'alice' }, item)).toBe(true);
    expect(scopeContains({ authored_after: '2023-01-01T00:00:00Z' }, item)).toBe(false);
  });
});

describe('narrow handles', () => {
  test('a handle names no identifier and resolves to its scope until it expires', () => {
    let now = 1_000;
    setNarrowHandleClockForTest(() => now);
    const scope = { corpus_ids: ['internal.telegram.messages'], conversation_id: 'chat-1' };
    const handle = issueNarrowHandle(scope);
    expect(isNarrowHandle(handle)).toBe(true);
    expect(handle).not.toContain('chat-1');
    expect(resolveNarrowHandle(handle)).toEqual(scope);
    expect(resolveNarrowHandle('fu_AAAAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
    now += 2 * 60 * 60 * 1000;
    expect(resolveNarrowHandle(handle)).toBeUndefined();
  });

  test('the engine request turns a narrow into its filters and refuses a clash or an unknown handle', async () => {
    const handle = issueNarrowHandle({ corpus_ids: ['internal.telegram.messages'], conversation_id: 'chat-1' });
    const parsed = await parseSourceIndexAnswerRequest(answerRequest({ question: 'When is the retreat?', narrow: handle }));
    expect(parsed.corpus_ids).toEqual(['internal.telegram.messages']);
    expect(parsed.conversation_id).toBe('chat-1');
    expect(parsed).not.toHaveProperty('narrow');
    await expect(parseSourceIndexAnswerRequest(answerRequest({ question: 'q', narrow: handle, corpus_id: 'internal.gmail.messages' })))
      .rejects.toThrow('narrow already sets the search scope');
    await expect(parseSourceIndexAnswerRequest(answerRequest({ question: 'q', narrow: 'fu_AAAAAAAAAAAAAAAAAAAAAAAA' })))
      .rejects.toThrow('narrow is unknown or has expired');
  });
});

describe('Ask with a weak first search', () => {
  const CHAT = 'internal.telegram.messages';
  const FILES = 'internal.dropbox.files';
  const SECURE = 'secure_local.whatsapp.messages';
  const ITEM_TEXT = 'the retreat moved to the lake house';

  test('carries what was found and one metadata-only follow-up; the narrow re-runs inside its scope with no second follow-up', async () => {
    const requests: SourceIndexAnswerRequest[] = [];
    const answers = handler(requests);
    const first = await answers.answer({ question: 'When is the retreat?' });
    expect(first.follow_up).toBeDefined();
    const followUp = first.follow_up!;
    const text = JSON.stringify(followUp);
    expect(text).not.toContain(ITEM_TEXT);
    expect(text).not.toContain('Secret family chat');
    expect(text).not.toContain('Carol');
    expect(followUp.question).toStartWith("I didn't find a clear answer. Possible places: ");
    const conversation = followUp.options.find((option) => option.label.startsWith('Retreat planning in Telegram'));
    expect(conversation?.label).toBe('Retreat planning in Telegram (2 items, 2023)');
    for (const option of followUp.options) expect(isNarrowHandle(option.narrow)).toBe(true);

    const narrowed = await parseSourceIndexAnswerRequest(answerRequest({ question: 'When is the retreat?', narrow: conversation!.narrow }));
    const second = await answers.answer(narrowed);
    expect(requests.at(-1)?.conversation_id).toBe('chat-retreat');
    expect(second.audit.searched_corpora).toEqual([CHAT]);
    expect(second.follow_up).toBeUndefined();
  });

  test('a cited, strong answer asks nothing', async () => {
    const answers = handler([], (pack) => ({
      answer: 'It is in May.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'It is in May.' }], unanswered: [],
    }));
    const result = await answers.answer({ question: 'When is the retreat?' });
    expect(result.follow_up).toBeUndefined();
  });

  test('the follow-up records the names it shows as release inputs, Private items excluded', () => {
    const detail = {
      pack: { question: 'q', builtAt: '2026-01-01T00:00:00Z', coverage: { searchedCorpora: [CHAT, SECURE], skippedCorpora: [], extractionGaps: [] },
        candidates: [candidate(CHAT, 'm1', 'chat-retreat', 'Retreat planning', 'Alice', 'S1', 'internal'),
          candidate(SECURE, 's1', 'chat-secret', 'Secret family chat', 'Carol', 'S4', 'secure_local')] },
      candidateCorpusIds: [CHAT, SECURE], laneAudits: [], secureLaneAudits: [], skippedCorpora: [], degradations: [], encounteredSecureLocal: true,
    } as unknown as EvidencePackBuildDetail;
    const built = weakSearchFollowUp(detail, 0)!;
    expect(JSON.stringify(built.followUp)).not.toContain('Secret family chat');
    expect(built.names.map((input) => [input.corpusId, input.providerItemId, input.layer])).toEqual([[CHAT, 'm1', 'names']]);
    expect(weakSearchFollowUp({ ...detail, skippedCorpora: [{ corpusId: CHAT, trustDomain: 'internal', reason: 'lane_timeout' }] }, 0)).toBeUndefined();
  });

  test('remote agents and ChatGPT receive the follow-up as metadata and opaque handles only', async () => {
    const result = await handler([]).answer({ question: 'When is the retreat?' });
    const remote = remoteOperationOutput('source_answer', result) as { follow_up?: { question: string; options: { label: string; narrow: string }[] } };
    expect(remote.follow_up?.question).toBe(result.follow_up!.question);
    expect(remote.follow_up?.options.map((option) => option.narrow)).toEqual(result.follow_up!.options.map((option) => option.narrow));
    const app = answerToolResult(result);
    expect((app.structuredContent as { follow_up?: unknown }).follow_up).toEqual(result.follow_up);
    expect(app.content[0]!.text).toContain(`Follow-up: ${result.follow_up!.question}`);
    expect(JSON.stringify(app)).not.toContain('chat-retreat');
  });

  function handler(requests: SourceIndexAnswerRequest[], respond: (pack: EvidencePack) => AnalystResult = () => ({
    answer: 'I cannot answer this from the evidence.', citations: [], unanswered: [],
  })) {
    const hits: Record<string, ReturnType<typeof candidate>[]> = {
      [CHAT]: [candidate(CHAT, 'm1', 'chat-retreat', 'Retreat planning', 'Alice', 'S1', 'internal'),
        candidate(CHAT, 'm2', 'chat-retreat', 'Retreat planning', 'Bob', 'S1', 'internal')],
      [FILES]: [candidate(FILES, 'f1', undefined, undefined, undefined, 'S1', 'internal')],
      [SECURE]: [candidate(SECURE, 's1', 'chat-secret', 'Secret family chat', 'Carol', 'S4', 'secure_local')],
    };
    const analyst: Analyst = { async analyze(pack) { return respond(pack); } };
    return createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: (request) => {
        requests.push(request);
        return {
          registry: buildSourceIndexCorpusRegistry([
            defineSourceIndexCorpus({ corpusId: CHAT, family: 'chat', trustDomain: 'internal' }),
            defineSourceIndexCorpus({ corpusId: FILES, family: 'file', trustDomain: 'internal' }),
          ]),
          adapters: Object.fromEntries([CHAT, FILES].map((corpusId) => [corpusId, () => ({
            hits: hits[corpusId]!.map(({ provenance }) => ({ sourceItem: provenance.sourceItem, provenance, score: 1, rawExposed: false as const })),
            latencyMs: 1, rawExposed: false as const,
          })])) as SourceIndexRouterAdapterMap,
          contentProviders: Object.fromEntries([CHAT, FILES].map((corpusId) => [corpusId, {
            async fetchLocalContent() {
              return { sensitivity: buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }), chunks: [ITEM_TEXT] };
            },
          }])) as LocalContentProviderMap,
        };
      },
    });
  }

  function candidate(corpusId: string, id: string, conversationId: string | undefined, conversationLabel: string | undefined,
    authorLabel: string | undefined, trustTier: 'S1' | 'S4', trustDomain: 'internal' | 'secure_local') {
    const sourceItem = {
      family: corpusId.includes('files') ? 'file' as const : 'chat' as const,
      provider: corpusId.includes('files') ? 'dropbox' : corpusId.includes('whatsapp') ? 'whatsapp' : 'telegram',
      accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`,
      ...(conversationId ? { providerConversationId: conversationId } : {}),
    };
    return {
      provenance: { sourceItem, citation: {
        title: `${id} title`, authoredAt: '2023-06-01T00:00:00Z',
        ...(conversationLabel ? { conversationLabel } : {}), ...(authorLabel ? { authorLabel } : {}),
      } },
      trustTier, trustDomain, chunks: [ITEM_TEXT],
    };
  }
});

function answerRequest(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1/source/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
