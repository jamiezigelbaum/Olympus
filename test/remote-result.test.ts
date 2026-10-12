// The remote output boundary (design docs/design/background-agents.md,
// section C): every remote operation's output is an allowlist built field by
// field, errors are fixed sentences, and a collected answer's cited items are
// rechecked against their current tiers. The stdio MCP surface is unchanged.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { findOperationByName } from '../src/core/operations.ts';
import type { OperationCaller } from '../src/core/operation-caller.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import {
  REMOTE_ANSWER_CHANGED,
  REMOTE_ANSWER_WITHHELD,
  REMOTE_OUTPUT_SCHEMAS,
  REMOTE_REPLY_WITHHELD,
  remoteErrorOutput,
  remoteOperationOutput,
  type CitedItemCheck,
} from '../src/core/remote-result.ts';
import { secretLocationCoverageNote, withoutSecretLocationCoverageNotes } from '../src/core/secret-location-note.ts';
import { SourceAnswerJobRegistry, type SourceAnswerPending } from '../src/core/source-answer-jobs.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createCitedItemTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createInProcessOperationContext, createRemoteMcpHandler, withRemoteMcpRoute } from '../src/workers/remote-mcp.ts';
import { createRemoteOpenApiHandler, withRemoteOpenApiRoutes } from '../src/workers/remote-openapi.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type TierFixture } from './helpers/tier-fixtures.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-result-tests-0123456789';
const JOB_ID = `saj_${'A'.repeat(43)}`;

// Every field today's worker result can carry, each a leak if it reached a
// remote agent: provider ids, URIs, spans, trust fields, Secret locations and
// count, audit, policy, opsec.
function leakyEvidence(id = 'garden', corpusId = CORPORA.internal): Record<string, unknown> {
  return {
    corpus_id: corpusId,
    trust_domain: 'internal',
    family: 'file',
    provider: 'fixture',
    provider_item_id: id,
    provider_thread_id: 'THREAD_ID_LEAK',
    provider_conversation_id: undefined,
    provider_file_id: 'FILE_ID_LEAK',
    title: `${id}-plan.txt`,
    source_label: 'SOURCE_LABEL_LEAK',
    conversation_label: 'CONVERSATION_LABEL_LEAK',
    author_label: 'AUTHOR_LABEL_LEAK',
    uri: 'https://example.com/URI_LEAK',
    authored_at: '2026-01-02T03:04:05.000Z',
    citation_span: { chunk_index: 0, chunk_id: 'CHUNK_ID_LEAK', char_start: 0, char_end: 5, item_char_start: 0, item_char_end: 5, chunk_chars: 5, lane: 'keyword' },
  };
}

function leakyAnswer(evidence: Array<Record<string, unknown>> = [leakyEvidence()], text?: string): SourceIndexAnswerResult {
  return {
    answer: text ?? `The garden plan covers compost.\n\nCoverage notes:\n- 1 item(s) pending classification in internal.email were searched by keyword only.\n- ${secretLocationCoverageNote(3)}`,
    evidence: evidence.map((entry) => JSON.parse(JSON.stringify(entry))),
    secret_locations: [{ source: 'dropbox', ref: 'SECRET_REF_LEAK', locator: '/SECRET_LOCATOR_LEAK', title: 'SECRET_TITLE_LEAK', finding_kinds: ['api_key'] }],
    audit: {
      searched_corpora: ['internal.email'],
      skipped_corpora: [{ corpus_id: 'AUDIT_LEAK', trust_domain: 'internal', reason: 'x' }],
      lane_audits: [{ lane: 'LANE_LEAK' }],
      answer_synthesis: { analyst_backend: 'local', private_context_used: true, secure_local_items_consulted: 2, internal_items_consulted: 1, raw_source_exposed: false },
      latency_ms: 5,
      raw_source_exposed: false,
    },
    policy: { raw_source_exposed: false, source_packets_exposed: false, internal_content_exposed: false, secure_local_content_exposed: true, castor_safe_bridge: true },
    opsec: { structured_evidence: [{ fact_id: 'OPSEC_LEAK' }], release_decision: { decision: 'allow', reasons: ['release_gate_passed'] }, raw_source_exposed: false },
  } as unknown as SourceIndexAnswerResult;
}

const LEAK_MARKERS = [
  'LEAK', 'secret_locations', 'Secret(s)', 'provider_item_id', 'provider', 'uri', 'citation_span',
  'audit', 'policy', 'opsec', 'trust_domain_', 'corpus_id', 'lane', 'example.com',
];

function statusFixture() {
  return {
    kind: 'source_index_status',
    generated_at: '2026-09-24T00:00:00.000Z',
    corpora: [{
      corpus_id: 'internal.fixture.files',
      family: 'file',
      provider: 'dropbox',
      trust_domain: 'internal',
      activation_mode: 'ACTIVATION_LEAK',
      embedding_policy: 'EMBEDDING_POLICY_LEAK',
      configured: true,
      item_metadata_returned: false,
      read_authority: 'connector_store',
      scope_revision: 'SCOPE_REVISION_LEAK',
      last_refresh: { sync_run_id: 'SYNC_RUN_LEAK', status: 'completed', completed_at: '2026-09-23T00:00:00.000Z', items_seen: 9, items_indexed: 9, source_scope: 'SCOPE_LEAK' },
      retrieval: { declared_mode: 'hybrid', servable_mode: 'hybrid', state: 'ready', model_id: 'MODEL_LEAK', embedding_epoch: 'EPOCH_LEAK', backend: 'BACKEND_LEAK' },
      embedding_parity: { required: true, chunks: 1, embedded_chunks: 1, missing_chunks: 0, refresh_needed: false },
      counts: { indexed_items: 12, tombstoned_items: 1, chunks: 30, embedded_chunks: 28, sync_runs: 4, secret_locations: 2 },
      skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
    }],
    degraded_credentials: [{ handle: 'CREDENTIAL_LEAK' }],
    tier_classification: { checking_items: 3, remaining_questions: 1, summary: 'TIER_SUMMARY_LEAK', awaiting_owner_approval: false },
    tier_migration: { plan_id: 'PLAN_LEAK' },
    sender_aggregation: { senders: [{ label: 'SENDER_LEAK' }] },
    ingestion_ledger: { rows: ['INGESTION_LEAK'] },
    answer_latency_ledger: { write_failure_count: 0 },
    policy: { read_only: true, raw_source_exposed: false, source_packets_exposed: false, source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true },
  };
}

/** Every key path in a value, arrays as `[]`, sorted. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => keyPaths(entry, `${prefix}[]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keyPaths(entry, path)];
  });
}

function uniqueKeyPaths(value: unknown): string[] {
  return [...new Set(keyPaths(value))].sort();
}

function expectNoLeak(text: string): void {
  for (const marker of LEAK_MARKERS) {
    expect({ marker, found: text.includes(marker) }).toEqual({ marker, found: false });
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/);
ajv.addFormat('date-time', (value: string) => Number.isFinite(Date.parse(value)));

function expectSchemaValid(operation: keyof typeof REMOTE_OUTPUT_SCHEMAS, output: unknown): void {
  const validate = ajv.compile(REMOTE_OUTPUT_SCHEMAS[operation]);
  const ok = validate(output);
  expect({ operation, ok, errors: ok ? null : validate.errors }).toEqual({ operation, ok: true, errors: null });
}

describe('remote output allowlists, per operation and result family', () => {
  test('source_answer answered: answer, status, kind and citations of label, title and date only', () => {
    const output = remoteOperationOutput('source_answer', leakyAnswer());
    expect(uniqueKeyPaths(output)).toEqual([
      'answer', 'citations', 'citations[].date', 'citations[].label', 'citations[].title', 'kind', 'status',
    ]);
    expect(output).toEqual({
      kind: 'source_answer',
      status: 'answered',
      // The Secret coverage note is gone; the other note stays.
      answer: 'The garden plan covers compost.\n\nCoverage notes:\n- 1 item(s) pending classification in internal.email were searched by keyword only.',
      citations: [{ label: 'Files', title: 'garden-plan.txt', date: '2026-01-02' }],
    });
    expectNoLeak(JSON.stringify(output));
    expectSchemaValid('source_answer', output);
  });

  test('a lone Secret note takes its Coverage notes heading with it', () => {
    const output = remoteOperationOutput('source_answer', leakyAnswer([], `Nothing found.\n\nCoverage notes:\n- ${secretLocationCoverageNote(1)}`));
    expect(output.answer).toBe('Nothing found.');
    expect(withoutSecretLocationCoverageNotes('No notes here.')).toBe('No notes here.');
  });

  test('secret-like free text is never retained: an answer is withheld, a title dropped', () => {
    const withheld = remoteOperationOutput('source_answer', leakyAnswer([], 'Here: api_key = abcdefghijklmnopqrstuv'));
    expect(withheld).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_WITHHELD, citations: [] });
    const titled = remoteOperationOutput('source_answer', leakyAnswer([{ ...leakyEvidence(), title: 'password: hunter2hunter2' }], 'ok'));
    expect(titled.citations).toEqual([{ label: 'Files', date: '2026-01-02' }]);
  });

  test('working survives with its job id on source_answer, source_answer_result and ask_anonymously', () => {
    const pending: SourceAnswerPending = { status: 'working', job_id: JOB_ID, elapsed_ms: 1234, next_tool: 'source_answer_result', message: 'internal text' };
    for (const operation of ['source_answer', 'source_answer_result', 'ask_anonymously'] as const) {
      const output = remoteOperationOutput(operation, { ...pending, extra: 'LEAK' });
      expect(uniqueKeyPaths(output)).toEqual(['elapsed_ms', 'job_id', 'message', 'next_tool', 'status']);
      expect(output).toMatchObject({ status: 'working', job_id: JOB_ID, next_tool: 'source_answer_result' });
      expectSchemaValid(operation, output);
    }
  });

  test('ask_anonymously answered keeps every delivery field, scanned', () => {
    const raw = {
      ok: true,
      sent: 'What is a fair price for a used bike?',
      reply: 'Around $200.',
      route: 'anonymous route (payment, key and network identity hidden)',
      networkIdentity: 'hidden',
      level: 'standard',
      cleanup: 'light_cleanup',
      rewritten: true,
      remembered: true,
      model: 'anthropic/claude-sonnet-5.5',
      note: 'The choice could not be saved here; it was used for this question only.',
      receipt: { leak: 'RECEIPT_LEAK' },
    };
    const output = remoteOperationOutput('ask_anonymously', raw);
    expect(uniqueKeyPaths(output)).toEqual([
      'cleanup', 'kind', 'level', 'model', 'network_identity', 'note', 'remembered', 'reply', 'rewritten', 'route', 'sent', 'status',
    ]);
    expect(output).toMatchObject({ kind: 'anonymous_answer', status: 'answered', reply: 'Around $200.', network_identity: 'hidden', rewritten: true });
    expectSchemaValid('ask_anonymously', output);
    expectSchemaValid('source_answer_result', remoteOperationOutput('source_answer_result', raw));
    expect(remoteOperationOutput('source_answer_result', raw)).toEqual(output);

    const secretReply = remoteOperationOutput('ask_anonymously', { ...raw, reply: 'use sk-abcdefghijklmnopqrstuvwx' });
    expect(secretReply.reply).toBe(REMOTE_REPLY_WITHHELD);
  });

  test('ask_anonymously needs_choice keeps the consent choice and its options', () => {
    const raw = { ok: false, code: 'needs_choice', message: 'whatever', options: { suggestedLevel: 'strict', suggestedCleanup: 'custom', customInstruction: true, extra: 'LEAK' } };
    const output = remoteOperationOutput('ask_anonymously', raw);
    expect(uniqueKeyPaths(output)).toEqual([
      'kind', 'message', 'options', 'options.custom_instruction', 'options.suggested_cleanup', 'options.suggested_level', 'status',
    ]);
    expect(output.options).toEqual({ suggested_level: 'strict', suggested_cleanup: 'custom', custom_instruction: true });
    expect(String(output.message)).toContain('Strict');
    expectSchemaValid('ask_anonymously', output);
  });

  test('ask_anonymously refused keeps whether the question left', () => {
    const raw = { ok: false, code: 'daily_cap_reached', message: 'The daily limit is reached.', sent: 'q?', outcome: 'sent_failed', daemonCode: 'funding_required', httpStatus: 402 };
    const output = remoteOperationOutput('ask_anonymously', raw);
    expect(uniqueKeyPaths(output)).toEqual(['code', 'daemon_code', 'kind', 'message', 'outcome', 'sent', 'status']);
    expect(output).toMatchObject({ status: 'refused', code: 'daily_cap_reached', outcome: 'sent_failed', daemon_code: 'funding_required' });
    expectSchemaValid('ask_anonymously', output);
    const minimal = remoteOperationOutput('ask_anonymously', { ok: false, code: 'anonymous_answers_off', message: 'Not sent.' });
    expect(uniqueKeyPaths(minimal)).toEqual(['code', 'kind', 'message', 'status']);
    const odd = remoteOperationOutput('ask_anonymously', { ok: false, code: 'Not An Identifier!', message: 'token: x' });
    expect(odd.code).toBe('refused');
  });

  test('source_index_status keeps per-corpus status and counts only', () => {
    const output = remoteOperationOutput('source_index_status', statusFixture());
    expect(uniqueKeyPaths(output)).toEqual([
      'corpora', 'corpora[].configured', 'corpora[].corpus_id', 'corpora[].counts', 'corpora[].counts.chunks',
      'corpora[].counts.embedded_chunks', 'corpora[].counts.indexed_items', 'corpora[].label', 'corpora[].last_refresh',
      'corpora[].last_refresh.completed_at', 'corpora[].last_refresh.status', 'corpora[].retrieval', 'corpora[].retrieval.mode',
      'corpora[].retrieval.state', 'corpora[].trust_domain', 'generated_at', 'kind',
    ]);
    expect(JSON.stringify(output)).not.toContain('LEAK');
    expect(JSON.stringify(output)).not.toContain('secret');
    expectSchemaValid('source_index_status', output);
  });

  test('an unknown shape is an error, never a pass-through', () => {
    expect(() => remoteOperationOutput('source_answer', { surprise: true })).toThrow(OperationError);
    expect(() => remoteOperationOutput('source_index_status', { corpora: [] })).toThrow(OperationError);
    expect(() => remoteOperationOutput('ask_anonymously', 'text')).toThrow(OperationError);
  });
});

describe('remote errors', () => {
  test('a fixed sentence per code; internal messages and suggestions never leave', () => {
    const policy = remoteErrorOutput(new OperationError('source_index_policy_violation', 'Refused: SECRET_TITLE_LEAK at /Users/x', 'see https://internal'));
    expect(policy).toEqual({ error: 'source_index_policy_violation', message: 'Olympus withheld this result under the owner\'s privacy rules.' });
    const internal = remoteErrorOutput(new Error('boom sk-live-123 /Users/secret'));
    expect(Object.keys(internal).sort()).toEqual(['error', 'message', 'ref']);
    expect(internal.error).toBe('internal_error');
    expect(internal.ref).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(internal)).not.toContain('sk-live');
  });
});

describe('cited items rechecked against current tiers', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  async function routed(): Promise<{ fixture: TierFixture; check: CitedItemCheck }> {
    const { dir, cleanup } = tempDir('olympus-remote-result-');
    const fixture = openTierFixture(dir);
    cleanups.push(() => { fixture.close(); cleanup(); });
    await fixture.set.sync(fixtureConnector(() => [
      { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' },
      { id: 'orchard', name: 'orchard-plan.txt', text: 'Notes about the orchard.' },
    ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const check = createCitedItemTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }]);
    return { fixture, check };
  }

  test('current items keep their citations; an ungoverned corpus is not rechecked', async () => {
    const { check } = await routed();
    expect(check([
      { corpusId: CORPORA.internal, provider: 'fixture', providerItemId: 'garden' },
      { corpusId: 'internal.other', provider: 'fixture', providerItemId: 'garden' },
      { corpusId: CORPORA.internal, provider: 'fixture', providerItemId: 'never-seen' },
    ])).toEqual(['current', 'unknown', 'unknown']);
    const output = remoteOperationOutput('source_answer', leakyAnswer([leakyEvidence('garden'), leakyEvidence('orchard')], 'ok'), { citedItemCheck: check });
    expect(output.status).toBe('answered');
    expect((output.citations as unknown[]).length).toBe(2);
  });

  test('an item reclassified to Secret after the answer was written withholds it', async () => {
    const { fixture, check } = await routed();
    await moveTieredItem({ set: fixture.set, identity: identityOf('garden'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
    expect(check([{ corpusId: CORPORA.internal, provider: 'fixture', providerItemId: 'garden' }])).toEqual(['secret']);
    const output = remoteOperationOutput('source_answer_result', leakyAnswer([leakyEvidence('garden'), leakyEvidence('orchard')]), { citedItemCheck: check });
    expect(output).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_CHANGED, citations: [] });
    expectNoLeak(JSON.stringify(output));
  });

  test('an item gone since drops its citation only', async () => {
    const { fixture, check } = await routed();
    fixture.ledger.removeCopies(identityOf('orchard'));
    const output = remoteOperationOutput('source_answer_result', leakyAnswer([leakyEvidence('garden'), leakyEvidence('orchard')], 'ok'), { citedItemCheck: check });
    expect(output.status).toBe('answered');
    expect(output.citations).toEqual([{ label: 'Files', title: 'garden-plan.txt', date: '2026-01-02' }]);
  });

  test('a check that cannot read the tiers withholds (fails closed)', () => {
    const broken: CitedItemCheck = () => { throw new Error('ledger locked'); };
    const output = remoteOperationOutput('source_answer_result', leakyAnswer(), { citedItemCheck: broken });
    expect(output.status).toBe('withheld');
    const short: CitedItemCheck = () => [];
    expect(remoteOperationOutput('source_answer_result', leakyAnswer(), { citedItemCheck: short }).status).toBe('withheld');
  });
});

describe('over the wire', () => {
  let dir: string;
  let store: RemoteConnectionStore;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let answer: () => Promise<SourceIndexAnswerResult>;
  let consult: () => Promise<unknown>;
  let citedItemCheck: CitedItemCheck | undefined;
  let jobs: SourceAnswerJobRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'olympus-remote-result-wire-'));
    store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    answer = async () => leakyAnswer();
    consult = async () => ({ ok: false, code: 'needs_choice', message: 'm', options: { suggestedLevel: 'standard', suggestedCleanup: 'as_written', customInstruction: false } });
    citedItemCheck = undefined;
    jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 60, resultWaitMs: 40 } });
    const worker = createEmailSourceWorker({
      sourceAnswer: { answer: () => answer() },
      sourceAnswerLatencyLog: { record() {} },
      sourceIndexStatus: { async status() { return statusFixture() as never; } },
      consultAsk: () => consult(),
    });
    const remote = {
      connections: () => store,
      // Wired as email-source/server.ts wires it: the check rides the context.
      makeOperationContext: (caller: OperationCaller, signal: AbortSignal) => ({
        ...createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal, sourceAnswerJobs: jobs }),
        ...(citedItemCheck ? { citedItemCheck } : {}),
      }),
    };
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: withRemoteOpenApiRoutes(
        createRemoteOpenApiHandler(remote),
        withRemoteMcpRoute(createRemoteMcpHandler(remote), withWorkerBearerAuth(worker.fetch, { authToken: WORKER_TOKEN })),
      ),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const client = new Client({ name: 'remote-result-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    try {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
    } finally {
      await client.close();
    }
  }

  async function rest(token: string, name: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}/api/v1/tools/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  test('MCP and OpenAPI return the same allowlisted answer, status and anonymous outputs, with no leak', async () => {
    const { token } = store.create('Grok');
    for (const [name, args, operation] of [
      ['source_answer', { question: 'q' }, 'source_answer'],
      ['source_index_status', {}, 'source_index_status'],
      ['ask_anonymously', { question: 'q' }, 'ask_anonymously'],
    ] as const) {
      const viaMcp = await mcp(token, name, args);
      const viaRest = await rest(token, name, args);
      expect({ name, isError: viaMcp.isError, status: viaRest.status }).toEqual({ name, isError: false, status: 200 });
      expect(JSON.parse(viaMcp.text)).toEqual(JSON.parse(viaRest.text));
      expectSchemaValid(operation, JSON.parse(viaRest.text));
      for (const text of [viaMcp.text, viaRest.text]) {
        expect(text).not.toContain('LEAK');
        expect(text).not.toContain('Secret(s)');
        expect(text).not.toContain('secret_locations');
        expect(text).not.toContain('audit');
        expect(text).not.toContain('policy');
      }
    }
  });

  test('errors are fixed sentences on both paths, with no internal message', async () => {
    const { token } = store.create('Grok');
    answer = async () => { throw new Error('boom at /Users/secret/path SECRET_TITLE_LEAK'); };
    const viaMcp = await mcp(token, 'source_answer', { question: 'q' });
    const viaRest = await rest(token, 'source_answer', { question: 'q' });
    expect(viaMcp.isError).toBe(true);
    for (const text of [viaMcp.text, viaRest.text]) {
      expect(text).not.toContain('LEAK');
      expect(text).not.toContain('/Users/secret');
      expect(text).not.toContain('olympus-worker.internal');
    }
    const missing = await mcp(token, 'source_answer_result', { job_id: JOB_ID });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.text)).toEqual({
      error: 'source_answer_job_not_found',
      message: 'No Olympus answer with that job_id is available to this connection. It may have expired or Olympus may have restarted. Ask the question again with source_answer.',
    });
    const unknown = await mcp(token, 'argus_complete', { prompt: 'x' });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(unknown.text)).toEqual({ error: 'unknown_operation', message: 'Olympus has no operation with that name here.' });
  });

  test('a delayed answer whose cited item became Secret is withheld when collected', async () => {
    const { dir: tiers, cleanup } = tempDir('olympus-remote-result-delayed-');
    const fixture = openTierFixture(tiers);
    try {
      await fixture.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'garden-plan.txt', text: 'Garden notes.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      citedItemCheck = createCitedItemTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }]);
      const { token } = store.create('Muse');
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      answer = async () => { await held; return leakyAnswer(); };

      const first = JSON.parse((await rest(token, 'source_answer', { question: 'q' })).text) as { status: string; job_id: string };
      expect(first.status).toBe('working');
      // Reclassified while the answer was being written.
      await moveTieredItem({ set: fixture.set, identity: identityOf('garden'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
      release();
      await Bun.sleep(20);

      const viaRest = await rest(token, 'source_answer_result', { job_id: first.job_id });
      expect(JSON.parse(viaRest.text)).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_CHANGED, citations: [] });
      const viaMcp = await mcp(token, 'source_answer_result', { job_id: first.job_id });
      expect(JSON.parse(viaMcp.text)).toEqual(JSON.parse(viaRest.text));
    } finally {
      fixture.close();
      cleanup();
    }
  });
});

describe('stdio MCP is unchanged', () => {
  test('the local stdio surface still returns the whole serialized operation result', async () => {
    const ctx = createInProcessOperationContext({
      config: defaultConfig(),
      sourceIndexReadEnabled: true,
      caller: { surface: 'mcp', displayName: 'codex' },
      workerFetch: async () => Response.json(leakyAnswer()),
    });
    const direct = await findOperationByName('source_answer')!.handler(ctx, { question: 'q' });
    const viaStdio = await handleMcpCallTool({ params: { name: 'source_answer', arguments: { question: 'q' } } }, () => ctx);
    expect(viaStdio.content[0]!.text).toBe(JSON.stringify(direct, null, 2));
    expect(viaStdio.isError).toBeUndefined();
    const parsed = JSON.parse(viaStdio.content[0]!.text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['answer', 'evidence', 'secret_locations', 'audit', 'policy']));
    expect(String(parsed.answer)).toContain('Secret(s) matched by location only');
    // And an unknown tool still throws on stdio, as before.
    await expect(handleMcpCallTool({ params: { name: 'no_such_tool' } }, () => ctx)).rejects.toThrow('Unknown Olympus operation: no_such_tool');
  });
});
