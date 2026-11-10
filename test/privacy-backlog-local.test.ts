// #1036: the privacy-backlog note on the local paths (stdio MCP, native,
// CLI). The count lives in the worker's tier sniffer, so the worker adds it:
// a local caller's source answer carries the local note in its coverage
// notes, a search carries the count that the plugin turns into the note, and
// a remote caller's answer gets nothing from the worker (its own boundary
// adds the remote note, so it is never said twice).
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { EmailClient, type EmailTransport } from '../src/core/email.ts';
import { markInProcessRemoteRequest } from '../src/core/operation-caller.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { privacyBacklogCoverageNote, withCoverageNote } from '../src/core/privacy-backlog-coverage.ts';
import { recordReleaseManifest } from '../src/core/release-manifest.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import { scriptedSearchReleaseCheck } from './helpers/scripted-search-release.ts';

const LOCAL_NOTE = 'Olympus is still checking 7 new items for privacy. Until then they are found by exact words only, not by meaning. This can take a while on this computer.';
const REMOTE_NOTE = 'Olympus is still checking 7 new items for privacy before they can be searched. This can take a while on this computer.';

function answerFixture(answer = 'I have no matching evidence for this question.'): SourceIndexAnswerResult {
  return {
    answer,
    evidence: [],
    audit: {
      searched_corpora: ['internal.email'],
      skipped_corpora: [],
      lane_audits: [],
      answer_synthesis: { analyst_backend: 'local', private_context_used: false, secure_local_items_consulted: 0, internal_items_consulted: 0, raw_source_exposed: false },
      latency_ms: 5,
      raw_source_exposed: false,
    },
    policy: { raw_source_exposed: false, source_packets_exposed: false, internal_content_exposed: false, secure_local_content_exposed: false, castor_safe_bridge: true },
    opsec: { structured_evidence: [], release_decision: { decision: 'allow', reasons: ['release_gate_passed'] }, raw_source_exposed: false },
  } as unknown as SourceIndexAnswerResult;
}

function harness(pending: number | undefined, answer?: string) {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.email', family: 'email', trustDomain: 'internal', tierLedger: null });
  const worker = createEmailSourceWorker({
    connectorStores: [store],
    sourceAnswer: {
      async answer() {
        recordReleaseManifest({ inputs: [], constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } });
        return answerFixture(answer);
      },
    },
    sourceAnswerReleaseCheck: scriptedSearchReleaseCheck,
    pendingPrivacyItems: () => pending,
  });
  const transport: EmailTransport = {
    async requestJson(url, init) {
      const response = await worker.fetch(new Request(url, init));
      const body = await response.json();
      if (!response.ok) throw new Error(`worker ${response.status}: ${JSON.stringify(body)}`);
      return body;
    },
  };
  const config = defaultConfig();
  const context = (): OperationContext => ({
    config,
    delphi: {} as OperationContext['delphi'],
    email: new EmailClient(config, transport),
    caller: { surface: 'mcp', displayName: 'backlog-test' },
  });
  const close = () => { worker.close(); store.close(); };
  return { worker, context, close };
}

async function postAnswer(worker: ReturnType<typeof harness>['worker'], caller?: Record<string, unknown>): Promise<{ answer: string }> {
  const request = new Request('http://worker.test/v1/source/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'q', ...(caller ? { caller } : {}) }),
  });
  // Only the worker's own remote endpoint may say a request is remote.
  const response = await worker.fetch(caller?.surface === 'remote' ? markInProcessRemoteRequest(request) : request);
  expect(response.status).toBe(200);
  return await response.json() as { answer: string };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('privacy backlog note on the local paths', () => {
  test('the local wording says the items are found by words, not by meaning yet', () => {
    expect(privacyBacklogCoverageNote(7, 'local')).toBe(LOCAL_NOTE);
    expect(privacyBacklogCoverageNote(1, 'local')).toBe('Olympus is still checking 1 new item for privacy. Until then it is found by exact words only, not by meaning. This can take a while on this computer.');
    expect(privacyBacklogCoverageNote(0, 'local')).toBeUndefined();
    expect(privacyBacklogCoverageNote(7)).toBe(REMOTE_NOTE);
  });

  test('the note joins an existing Coverage notes block, or starts one', () => {
    expect(withCoverageNote('Answer.', 'N.')).toBe('Answer.\n\nCoverage notes:\n- N.');
    expect(withCoverageNote('Answer.\n\nCoverage notes:\n- A gap.', 'N.')).toBe('Answer.\n\nCoverage notes:\n- A gap.\n- N.');
    expect(withCoverageNote('Answer.', undefined)).toBe('Answer.');
  });

  test('the worker adds the note to a local caller\'s answer and never to a remote one\'s', async () => {
    const { worker, close } = harness(7);
    try {
      for (const caller of [{ surface: 'mcp' }, { surface: 'native' }, { surface: 'cli' }, undefined]) {
        expect((await postAnswer(worker, caller)).answer).toContain(LOCAL_NOTE);
      }
      const remote = await postAnswer(worker, { surface: 'remote', connection_id: 'conn-1' });
      expect(remote.answer).not.toContain('still checking');
    } finally { close(); }
  });

  test('no note when nothing is pending or the count cannot be read', async () => {
    for (const pending of [0, undefined]) {
      const { worker, close } = harness(pending);
      try {
        expect((await postAnswer(worker, { surface: 'mcp' })).answer).toBe('I have no matching evidence for this question.');
      } finally { close(); }
    }
  });

  test("'mcp' surface: source_answer carries the local note once, in the answer's coverage notes", async () => {
    const { context, close } = harness(7, 'Nothing matched.\n\nCoverage notes:\n- 2 item(s) pending classification in internal.email were searched by keyword only.');
    try {
      const result = await handleMcpCallTool({ method: 'tools/call', params: { name: 'source_answer', arguments: { question: 'q' } } } as never, context, 'mcp');
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text) as { answer: string };
      expect(parsed.answer).toEndWith(`- ${LOCAL_NOTE}`);
      expect(occurrences(parsed.answer, 'Coverage notes:')).toBe(1);
      expect(occurrences(text, 'still checking')).toBe(1);
    } finally { close(); }
  });

  test("'mcp' surface: an empty source_index_search says items are still being checked", async () => {
    const { context, close } = harness(7);
    try {
      const result = await handleMcpCallTool({ method: 'tools/call', params: { name: 'source_index_search', arguments: { corpus_id: 'internal.email', query: 'invoice' } } } as never, context, 'mcp');
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { hits: unknown[]; coverage_notes?: string[]; audit: Record<string, unknown> };
      expect(parsed.hits).toEqual([]);
      expect(parsed.coverage_notes).toEqual([LOCAL_NOTE]);
      // The plugin passes on the sentence, not the worker's raw field.
      expect(parsed.audit.pending_privacy_items).toBeUndefined();
    } finally { close(); }
  });

  test("'mcp' surface: no search note when nothing is pending", async () => {
    const { context, close } = harness(0);
    try {
      const result = await handleMcpCallTool({ method: 'tools/call', params: { name: 'source_index_search', arguments: { corpus_id: 'internal.email', query: 'invoice' } } } as never, context, 'mcp');
      expect((result.content as Array<{ text: string }>)[0]!.text).not.toContain('still checking');
    } finally { close(); }
  });
});
