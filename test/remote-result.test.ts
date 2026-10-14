// The remote output boundary (design docs/design/background-agents.md,
// section C): every remote operation's output is an allowlist built field by
// field, every failure (handler, surface, transport, credential) is a fixed
// sentence, and a collected source answer is revalidated against its release
// manifest: every item it read, cited or not, against the current tiers and
// release rules. The stdio MCP and ChatGPT surfaces are unchanged.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.ts';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import { CONSULT_ASK_MESSAGES } from '../src/core/consult-ask.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { findOperationByName } from '../src/core/operations.ts';
import type { OperationCaller } from '../src/core/operation-caller.ts';
import {
  createReleaseManifestSink,
  recordReleaseManifest,
  runWithReleaseManifestSink,
  type ReleaseCheck,
  type ReleaseConstraints,
  type ReleaseInput,
  type ReleaseManifest,
} from '../src/core/release-manifest.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { parseRemotePublicBaseUrl, type RemotePublicUrls } from '../src/core/remote-public-url.ts';
import {
  REMOTE_ANSWER_CHANGED,
  REMOTE_ANSWER_UNVERIFIED,
  REMOTE_ANSWER_WITHHELD,
  REMOTE_DAEMON_CODES,
  REMOTE_ERROR_SCHEMA,
  REMOTE_OUTPUT_SCHEMAS,
  REMOTE_REFUSAL_CODES,
  REMOTE_PROVIDER_UNKNOWN_NOTE,
  REMOTE_REPLY_WITHHELD,
  REMOTE_WITHHELD_PARAMS,
  remoteErrorOutput,
  remoteOperationOutput,
} from '../src/core/remote-result.ts';
import { secretLocationCoverageNote, withoutSecretLocationCoverageNotes } from '../src/core/secret-location-note.ts';
import { SourceAnswerJobRegistry, type SourceAnswerPending } from '../src/core/source-answer-jobs.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createInProcessOperationContext, createRemoteMcpHandler, withRemoteFailureBoundary, withRemoteMcpRoute } from '../src/workers/remote-mcp.ts';
import { AUTHENTICATED_RESPONSE_HEADER, SURFACE_RESPONSE_HEADER } from '../connect-relay/shared/tokens.ts';
import {
  buildRemoteOpenApiSpec,
  createRemoteOpenApiHandler,
  REMOTE_OPENAPI_MAX_BODY_BYTES,
  withRemoteOpenApiRoutes,
} from '../src/workers/remote-openapi.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import { ACCOUNT, CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type TierFixture } from './helpers/tier-fixtures.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-result-tests-0123456789';
const JOB_ID = `saj_${'A'.repeat(43)}`;
const SECRET = 'api_key=ABCDEFGHIJKLMNOPQRSTUV';

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
  'audit', 'policy', 'opsec', 'trust_domain_', 'corpus_id', 'lane', 'example.com', 'api_key',
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

const ANSWERED_RAW = {
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
const NEEDS_CHOICE_RAW = { ok: false, code: 'needs_choice', message: 'whatever', options: { suggestedLevel: 'strict', suggestedCleanup: 'custom', customInstruction: true, extra: 'LEAK' } };
const REFUSED_RAW = { ok: false, code: 'daily_cap_reached', message: 'The daily limit is reached.', sent: 'q?', outcome: 'sent_failed', daemonCode: 'funding_required', httpStatus: 402 };

/** One item the analyst read: a `fixture` item in the internal fixture corpus, account `personal`. */
function input(id: string, overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return { corpusId: CORPORA.internal, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, privateAtAnswer: false, ...overrides };
}

function manifest(inputs: ReleaseInput[], constraints: Partial<ReleaseConstraints> = {}): ReleaseManifest {
  return { inputs, constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false, ...constraints } };
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
const validateError = ajv.compile(REMOTE_ERROR_SCHEMA);

function expectSchemaValid(operation: keyof typeof REMOTE_OUTPUT_SCHEMAS, output: unknown): void {
  const validate = ajv.compile(REMOTE_OUTPUT_SCHEMAS[operation]);
  const ok = validate(output);
  expect({ operation, ok, errors: ok ? null : validate.errors }).toEqual({ operation, ok: true, errors: null });
}

function expectErrorSchema(body: unknown): void {
  const ok = validateError(body);
  expect({ body, ok, errors: ok ? null : validateError.errors }).toEqual({ body, ok: true, errors: null });
}

/** The store, with both credential checks throwing an error that names internal paths. */
function throwingStore(store: RemoteConnectionStore): RemoteConnectionStore {
  const fail = () => { throw new Error('verify failed at /Users/secret/LEAK.sqlite'); };
  return Object.assign(Object.create(store), {
    verifyToken: fail,
    oauth: Object.assign(Object.create(store.oauth), { verifyAccessToken: fail }),
  }) as RemoteConnectionStore;
}

/** A failure body carries no exception text or path, plainly or inside any base64-looking blob. */
function expectNothingInternal(text: string): void {
  const decoded = [...text.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)].map((match) => {
    try {
      return Buffer.from(match[0], match[0].includes('-') || match[0].includes('_') ? 'base64url' : 'base64').toString('utf8');
    } catch {
      return '';
    }
  });
  for (const candidate of [text, ...decoded]) {
    for (const marker of ['LEAK', '/Users', 'verify failed', 'context failed', '    at ', '.ts:', 'Error:']) {
      expect({ marker, found: candidate.includes(marker) }).toEqual({ marker, found: false });
    }
  }
}

/** A release check that judges every input as given. */
function fixedCheck(tier: 'legacy' | 'public_or_personal' | 'private' | 'secret' | 'unknown', posture: 'allow' | 'approval' = 'allow'): ReleaseCheck {
  return { inputs: (inputs) => inputs.map(() => ({ tier, gone: false })), secureDerivativeDefault: () => posture };
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
    const withheld = remoteOperationOutput('source_answer', leakyAnswer([], `Here: ${SECRET}`));
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
    // A job id the scanner flags never leaves (Olympus never mints one).
    expect(() => remoteOperationOutput('source_answer', { ...pending, job_id: `saj_${'A'.repeat(20)}-sk-${'B'.repeat(19)}` })).toThrow(OperationError);
  });

  test('ask_anonymously answered keeps every delivery field, scanned', () => {
    const output = remoteOperationOutput('ask_anonymously', ANSWERED_RAW);
    expect(uniqueKeyPaths(output)).toEqual([
      'cleanup', 'kind', 'level', 'model', 'network_identity', 'note', 'remembered', 'reply', 'rewritten', 'route', 'sent', 'status',
    ]);
    expect(output).toMatchObject({ kind: 'anonymous_answer', status: 'answered', reply: 'Around $200.', network_identity: 'hidden', rewritten: true });
    expectSchemaValid('ask_anonymously', output);
    expectSchemaValid('source_answer_result', remoteOperationOutput('source_answer_result', ANSWERED_RAW));
    expect(remoteOperationOutput('source_answer_result', ANSWERED_RAW)).toEqual(output);

    const secretReply = remoteOperationOutput('ask_anonymously', { ...ANSWERED_RAW, reply: 'use sk-abcdefghijklmnopqrstuvwx' });
    expect(secretReply.reply).toBe(REMOTE_REPLY_WITHHELD);
  });

  test('ask_anonymously answered for an agent whose host is unknown carries one fixed note, in the closed schema', () => {
    const output = remoteOperationOutput('ask_anonymously', { ...ANSWERED_RAW, providerNote: CONSULT_ASK_MESSAGES.providerUnknown });
    expect(output.provider_note).toBe('Olympus does not know which company runs this agent, so it could not make sure the answer came from another company\'s model.');
    expect(REMOTE_PROVIDER_UNKNOWN_NOTE).toBe(CONSULT_ASK_MESSAGES.providerUnknown);
    expectSchemaValid('ask_anonymously', output);
    // Whatever text the worker put there, only the fixed sentence leaves.
    expect(remoteOperationOutput('ask_anonymously', { ...ANSWERED_RAW, providerNote: 'use sk-abcdefghijklmnopqrstuvwx' }).provider_note).toBe(REMOTE_PROVIDER_UNKNOWN_NOTE);
    // The schema stays closed: any other value, or any other new field, is invalid.
    const validate = ajv.compile(REMOTE_OUTPUT_SCHEMAS.ask_anonymously);
    expect(validate({ ...output, provider_note: 'Something else.' })).toBe(false);
    expect(validate({ ...output, provider: 'other' })).toBe(false);
    // Refusals never carry it.
    expect(remoteOperationOutput('ask_anonymously', { ...REFUSED_RAW, providerNote: CONSULT_ASK_MESSAGES.providerUnknown })).not.toHaveProperty('provider_note');
  });

  test('ask_anonymously needs_choice keeps the consent choice and its options', () => {
    const output = remoteOperationOutput('ask_anonymously', NEEDS_CHOICE_RAW);
    expect(uniqueKeyPaths(output)).toEqual([
      'kind', 'message', 'options', 'options.custom_instruction', 'options.suggested_cleanup', 'options.suggested_level', 'status',
    ]);
    expect(output.options).toEqual({ suggested_level: 'strict', suggested_cleanup: 'custom', custom_instruction: true });
    expect(String(output.message)).toContain('Strict');
    expectSchemaValid('ask_anonymously', output);
  });

  test('ask_anonymously refused keeps whether the question left', () => {
    const output = remoteOperationOutput('ask_anonymously', REFUSED_RAW);
    expect(uniqueKeyPaths(output)).toEqual(['code', 'daemon_code', 'kind', 'message', 'outcome', 'sent', 'status']);
    expect(output).toMatchObject({ status: 'refused', code: 'daily_cap_reached', outcome: 'sent_failed', daemon_code: 'funding_required' });
    expectSchemaValid('ask_anonymously', output);
    const minimal = remoteOperationOutput('ask_anonymously', { ok: false, code: 'anonymous_answers_off', message: 'Not sent.' });
    expect(uniqueKeyPaths(minimal)).toEqual(['code', 'kind', 'message', 'status']);
  });

  test('codes and statuses are closed enums; variable identifiers are scanned', () => {
    // An identifier-shaped code outside the enum, or a scanner-detectable token, never passes.
    for (const code of ['not_a_known_code', 'Not An Identifier!', 'sk-abcdefghijklmnopqrstuvwx']) {
      expect(remoteOperationOutput('ask_anonymously', { ok: false, code, message: 'm' }).code).toBe('refused');
    }
    const daemon = remoteOperationOutput('ask_anonymously', { ...REFUSED_RAW, daemonCode: 'ghp_abcdefghijklmnopqrstuvwxyz' });
    expect(daemon).not.toHaveProperty('daemon_code');
    const model = remoteOperationOutput('ask_anonymously', { ...ANSWERED_RAW, model: 'sk-abcdefghijklmnopqrstuvwx' });
    expect(model).not.toHaveProperty('model');
    const odd = remoteOperationOutput('ask_anonymously', { ...ANSWERED_RAW, networkIdentity: 'LEAK', cleanup: 'LEAK' });
    expect(odd).toMatchObject({ network_identity: 'not_verified' });
    expect(odd).not.toHaveProperty('cleanup');

    const status = statusFixture();
    status.corpora.push({ ...status.corpora[0]!, corpus_id: 'internal.sk-abcdefghijklmnopqrstuvwx' });
    status.corpora[0]!.last_refresh = { ...status.corpora[0]!.last_refresh, status: 'syncing_LEAK' };
    const output = remoteOperationOutput('source_index_status', status);
    expect((output.corpora as unknown[]).length).toBe(1);
    expect((output.corpora as Array<Record<string, unknown>>)[0]).not.toHaveProperty('last_refresh');
    expectSchemaValid('source_index_status', output);
  });

  test('the refusal and daemon code enums cover every code their sources can produce', () => {
    const consult = readFileSync(join(import.meta.dir, '../src/core/consult-ask.ts'), 'utf8');
    const consultCodes = [...consult.matchAll(/\bcode: '([a-z_]+)'/g)]
      .map((match) => match[1]!)
      .filter((code) => code !== 'needs_choice');
    const zkapi = readFileSync(join(import.meta.dir, '../src/core/consult-transport-zkapi.ts'), 'utf8');
    const union = /export type ZkapiConsultErrorCode =([^;]+);/.exec(zkapi)![1]!;
    const transportCodes = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
    const daemonList = /const KNOWN_DAEMON_ERROR_CODES = \[([^\]]+)\]/.exec(zkapi)![1]!;
    const daemonCodes = [...daemonList.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
    expect(consultCodes.length).toBeGreaterThan(10);
    expect(transportCodes.length).toBeGreaterThan(30);
    expect(consultCodes.filter((code) => !REMOTE_REFUSAL_CODES.includes(code))).toEqual([]);
    expect(transportCodes.filter((code) => !REMOTE_REFUSAL_CODES.includes(code))).toEqual([]);
    expect(daemonCodes.filter((code) => !REMOTE_DAEMON_CODES.includes(code))).toEqual([]);
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

describe('a secret straddling a length cap never leaves as a prefix', () => {
  // The secret starts just inside each cap, so the capped prefix alone
  // (`api_key=ABC` cut short) would not match the scanner.
  const across = (cap: number) => `${'a'.repeat(cap - 12)} ${SECRET} tail`;

  test('answer (64 KiB) and reply (64 KiB) are withheld', () => {
    const answer = remoteOperationOutput('source_answer', leakyAnswer([], across(64 * 1024)));
    expect(answer).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_WITHHELD, citations: [] });
    const reply = remoteOperationOutput('ask_anonymously', { ...ANSWERED_RAW, reply: across(64 * 1024) });
    expect(reply.reply).toBe(REMOTE_REPLY_WITHHELD);
  });

  test('sent (16 KiB), route (300), note (2,000), title (400) and refusal message (2,000) are dropped', () => {
    const answered = remoteOperationOutput('ask_anonymously', {
      ...ANSWERED_RAW,
      sent: across(16 * 1024),
      route: across(300),
      note: across(2_000),
    });
    expect(answered).not.toHaveProperty('sent');
    expect(answered).not.toHaveProperty('route');
    expect(answered).not.toHaveProperty('note');
    const refused = remoteOperationOutput('ask_anonymously', { ...REFUSED_RAW, message: across(2_000), sent: across(16 * 1024) });
    expect(refused.message).toBe('Olympus could not ask anonymously.');
    expect(refused).not.toHaveProperty('sent');
    const titled = remoteOperationOutput('source_answer', leakyAnswer([{ ...leakyEvidence(), title: across(400) }], 'ok'));
    expect(titled.citations).toEqual([{ label: 'Files', date: '2026-01-02' }]);
    for (const output of [answered, refused, titled]) expect(JSON.stringify(output)).not.toContain('api_key');
  });

  test('a secret split by a zero-width character is caught after normalization', () => {
    const split = remoteOperationOutput('source_answer', leakyAnswer([], 'Here: api_​key=ABCDEFGHIJKLMNOPQRSTUV'));
    expect(split.status).toBe('withheld');
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
    for (const body of [policy, internal]) expectErrorSchema(body);
  });

  test('invalid_params names the argument only when the operation declares it', () => {
    const declared = ['question', 'corpus_id'];
    const named = remoteErrorOutput(new OperationError('invalid_params', 'question must be a non-empty string; got LEAK'), { declaredParams: declared });
    expect(named).toEqual({
      error: 'invalid_params',
      message: 'The question argument was not valid. Check it against the tool\'s schema and try again.',
      param: 'question',
    });
    expectErrorSchema(named);
    // A name the operation does not declare is never repeated, even if the message has it.
    const undeclared = remoteErrorOutput(new OperationError('invalid_params', 'secret_param_LEAK is not allowed'), { declaredParams: declared });
    expect(undeclared).toEqual({ error: 'invalid_params', message: 'The request was not valid. Check the arguments against the tool\'s schema and try again.' });
    // A declared name inside another word does not count.
    expect(remoteErrorOutput(new OperationError('invalid_params', 'subquestion_id bad'), { declaredParams: declared })).not.toHaveProperty('param');
  });
});

describe('the release manifest, revalidated against current tiers and rules', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  async function routed(posture: 'allow' | 'approval' = 'allow'): Promise<{ fixture: TierFixture; check: ReleaseCheck }> {
    const { dir, cleanup } = tempDir('olympus-remote-result-');
    const fixture = openTierFixture(dir);
    cleanups.push(() => { fixture.close(); cleanup(); });
    await fixture.set.sync(fixtureConnector(() => [
      { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' },
      { id: 'orchard', name: 'orchard-plan.txt', text: 'Notes about the orchard.' },
    ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const check = createReleaseTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }], () => posture);
    return { fixture, check };
  }

  const both = () => leakyAnswer([leakyEvidence('garden'), leakyEvidence('orchard')], 'ok');
  const bothRead = (constraints: Partial<ReleaseConstraints> = {}) => [manifest([input('garden'), input('orchard')], constraints)];

  test('verdicts: classified items by exact account; ungoverned or never classified is legacy; no account is unknown', async () => {
    const { check } = await routed();
    expect(check.inputs([
      input('garden'),
      input('garden', { corpusId: 'internal.other' }),
      input('never-seen'),
      input('garden', { accountScope: '' }),
      input('garden', { accountScope: 'another-account' }),
    ])).toEqual([
      { tier: 'public_or_personal', gone: false },
      { tier: 'legacy', gone: false },
      { tier: 'legacy', gone: false },
      { tier: 'unknown', gone: false },
      { tier: 'legacy', gone: false },
    ]);
  });

  test('current inputs release the answer with its citations', async () => {
    const { check } = await routed();
    const output = remoteOperationOutput('source_answer', both(), { releaseCheck: check, releaseManifests: bothRead() });
    expect(output.status).toBe('answered');
    expect((output.citations as unknown[]).length).toBe(2);
  });

  test('a cited input now Secret withholds', async () => {
    const { fixture, check } = await routed();
    await moveTieredItem({ set: fixture.set, identity: identityOf('garden'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
    expect(check.inputs([input('garden')])[0]!.tier).toBe('secret');
    const output = remoteOperationOutput('source_answer_result', both(), { releaseCheck: check, releaseManifests: bothRead() });
    expect(output).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_CHANGED, citations: [] });
    expectNoLeak(JSON.stringify(output));
  });

  test('an UNCITED input now Secret withholds too', async () => {
    const { fixture, check } = await routed();
    await moveTieredItem({ set: fixture.set, identity: identityOf('orchard'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
    // The answer cites garden only; orchard was read but not cited.
    const output = remoteOperationOutput('source_answer_result', leakyAnswer([leakyEvidence('garden')], 'ok'), { releaseCheck: check, releaseManifests: bothRead() });
    expect(output).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_CHANGED, citations: [] });
  });

  test('strict posture: an input now Private withholds, because a Private derivative would not be released', async () => {
    const strict = await routed('approval');
    await moveTieredItem({ set: strict.fixture.set, identity: identityOf('garden'), target: { metadataTier: 'private', contentTier: 'secure' } });
    expect(strict.check.inputs([input('garden')])).toEqual([{ tier: 'private', gone: false }]);
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: strict.check, releaseManifests: bothRead({ secureDerivativeDefault: 'approval' }) }))
      .toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_CHANGED, citations: [] });
    // An explicit request for Private content under the strict posture releases ...
    expect(remoteOperationOutput('source_answer_result', both(), {
      releaseCheck: strict.check,
      releaseManifests: bothRead({ secureDerivativeDefault: 'approval', includeSecureLocalContent: true }),
    }).status).toBe('answered');
    // ... as does the same move under the default posture (Private derivatives release by default).
    const open = await routed('allow');
    await moveTieredItem({ set: open.fixture.set, identity: identityOf('garden'), target: { metadataTier: 'private', contentTier: 'secure' } });
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: open.check, releaseManifests: bothRead() }).status).toBe('answered');
  });

  test('a posture tightened since the answer withholds an answer drawn on Private material', () => {
    const privateRead = [manifest([input('garden', { privateAtAnswer: true })])];
    const answer = leakyAnswer([leakyEvidence('garden')], 'ok');
    expect(remoteOperationOutput('source_answer_result', answer, { releaseCheck: fixedCheck('legacy', 'approval'), releaseManifests: privateRead }))
      .toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_WITHHELD, citations: [] });
    expect(remoteOperationOutput('source_answer_result', answer, { releaseCheck: fixedCheck('legacy', 'allow'), releaseManifests: privateRead }).status)
      .toBe('answered');
  });

  test('a cited input gone drops its citation only', async () => {
    const { fixture, check } = await routed();
    fixture.ledger.removeCopies(identityOf('orchard'));
    const output = remoteOperationOutput('source_answer_result', both(), { releaseCheck: check, releaseManifests: bothRead() });
    expect(output.status).toBe('answered');
    expect(output.citations).toEqual([{ label: 'Files', title: 'garden-plan.txt', date: '2026-01-02' }]);
  });

  test('missing proof withholds: no manifest, an unprovable input, a cited item the manifest lacks, or a check that fails', () => {
    const check = fixedCheck('public_or_personal');
    const unverified = { kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_UNVERIFIED, citations: [] };
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: check, releaseManifests: [] })).toEqual(unverified);
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: fixedCheck('unknown'), releaseManifests: bothRead() })).toEqual(unverified);
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: check, releaseManifests: [manifest([input('garden')])] })).toEqual(unverified);
    const broken: ReleaseCheck = { inputs: () => { throw new Error('ledger locked'); }, secureDerivativeDefault: () => 'allow' };
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: broken, releaseManifests: bothRead() })).toEqual(unverified);
    const short: ReleaseCheck = { inputs: () => [], secureDerivativeDefault: () => 'allow' };
    expect(remoteOperationOutput('source_answer_result', both(), { releaseCheck: short, releaseManifests: bothRead() })).toEqual(unverified);
    // With no check at all (a context without tiered stores) nothing is revalidated.
    expect(remoteOperationOutput('source_answer_result', both()).status).toBe('answered');
  });
});

describe('the analyst handler records every input it read', () => {
  const NOTES = 'internal.fixture.notes';
  const item = (id: string) => ({
    family: 'note' as const,
    provider: 'fixture',
    accountScope: 'work',
    providerItemId: id,
    localItemId: `work:${id}`,
  });

  function handler(posture: 'allow' | 'approval') {
    const analyst: Analyst = {
      async analyze(pack: EvidencePack): Promise<AnalystResult> {
        // Reads both, cites only the first.
        return { answer: 'The first note says hello.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'hello' }], unanswered: [] } as unknown as AnalystResult;
      },
    };
    return createAnalystSourceIndexAnswerHandler({
      analyst,
      secureDerivativeDefault: posture,
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId: NOTES, family: 'note', trustDomain: 'internal' })]),
        adapters: {
          [NOTES]: () => ({
            hits: ['first', 'second'].map((id) => ({
              sourceItem: item(id),
              provenance: { sourceItem: item(id), citation: { title: `${id} note` } },
              score: 1,
              rawExposed: false,
            })),
            latencyMs: 1,
            rawExposed: false,
          }),
        } as SourceIndexRouterAdapterMap,
        contentProviders: {
          [NOTES]: {
            async fetchLocalContent() {
              return { sensitivity: buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }), chunks: ['hello there'] };
            },
          },
        } as LocalContentProviderMap,
      }),
    });
  }

  test('cited and uncited, each with its account, and the rules in force', async () => {
    const sink = createReleaseManifestSink();
    const result = await runWithReleaseManifestSink(sink, () => handler('approval').answer({ question: 'What do the notes say?', corpus_id: NOTES }));
    expect(result.evidence.map((entry) => entry.provider_item_id)).toEqual(['first']);
    expect(sink.manifests).toEqual([{
      inputs: [
        { corpusId: NOTES, provider: 'fixture', accountScope: 'work', providerItemId: 'first', privateAtAnswer: false },
        { corpusId: NOTES, provider: 'fixture', accountScope: 'work', providerItemId: 'second', privateAtAnswer: false },
      ],
      constraints: { secureDerivativeDefault: 'approval', includeSecureLocalContent: false },
    }]);
    // And none of it is serialized into the answer.
    expect(JSON.stringify(result)).not.toContain('privateAtAnswer');
  });

  test('outside a sink nothing is recorded and the answer is the same', async () => {
    const outside = await handler('allow').answer({ question: 'What do the notes say?', corpus_id: NOTES });
    const sink = createReleaseManifestSink();
    const inside = await runWithReleaseManifestSink(sink, () => handler('allow').answer({ question: 'What do the notes say?', corpus_id: NOTES }));
    expect({ answer: inside.answer, evidence: inside.evidence }).toEqual({ answer: outside.answer, evidence: outside.evidence });
    expect(sink.manifests.length).toBe(1);
  });
});

describe('over the wire', () => {
  let dir: string;
  let store: RemoteConnectionStore;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let urls: RemotePublicUrls | undefined;
  let answer: () => Promise<SourceIndexAnswerResult>;
  let consult: () => Promise<unknown>;
  let consultCallers: Array<string | undefined>;
  let releaseCheck: ReleaseCheck | undefined;
  let contextFails: boolean;
  let verifyFails: boolean;
  let relayed: boolean;
  let jobs: SourceAnswerJobRegistry;

  /** The fake answer pipeline records what the analyst handler would: the items it read. */
  const answered = (inputs: ReleaseInput[] = [input('garden')], result: SourceIndexAnswerResult = leakyAnswer()) => {
    recordReleaseManifest(manifest(inputs));
    return result;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'olympus-remote-result-wire-'));
    store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    answer = async () => answered();
    consult = async () => NEEDS_CHOICE_RAW;
    consultCallers = [];
    releaseCheck = undefined;
    contextFails = false;
    verifyFails = false;
    relayed = false;
    jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 60, resultWaitMs: 40 } });
    const worker = createEmailSourceWorker({
      sourceAnswer: { answer: () => answer() },
      sourceAnswerLatencyLog: { record() {} },
      sourceIndexStatus: { async status() { return statusFixture() as never; } },
      consultAsk: (input) => {
        consultCallers.push(input.caller?.provider);
        return consult();
      },
    });
    const remote = {
      // A store whose credential checks throw, as a locked or corrupt database would.
      connections: () => (verifyFails ? throwingStore(store) : store),
      publicUrls: () => urls,
      isRelayed: () => relayed,
      // Wired as email-source/server.ts wires it: the check rides the context.
      makeOperationContext: (caller: OperationCaller, signal: AbortSignal) => {
        if (contextFails) throw new Error('context failed at /Users/secret/LEAK');
        return {
          ...createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal, sourceAnswerJobs: jobs }),
          ...(releaseCheck ? { releaseCheck } : {}),
        };
      },
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
    const resolved = parseRemotePublicBaseUrl(base);
    urls = resolved.enabled ? resolved.urls : undefined;
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A non-ChatGPT OAuth grant (a registered client, as a hosted agent's connector is). */
  function oauthToken(name: string): string {
    const client = store.oauth.registerClient({ clientName: name, redirectUris: ['https://agent.example/oauth/callback'] });
    if (client === 'capacity') throw new Error('capacity');
    return store.oauth.createGrant({ clientId: client.clientId, displayName: name, resource: urls!.resource }).tokens.accessToken;
  }

  function tokens(): Array<[string, string]> {
    return [['bearer', store.create('Grok').token], ['oauth', oauthToken('Grok OAuth')]];
  }

  async function withClient<T>(token: string, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'remote-result-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    return withClient(token, async (client) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
    });
  }

  async function rest(
    token: string | undefined,
    name: string,
    body: Record<string, unknown> | string,
    init: { method?: string; contentType?: string } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const method = init.method ?? 'POST';
    const response = await fetch(`${base}/api/v1/tools/${name}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': init.contentType ?? 'application/json' },
      ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text(), headers: response.headers };
  }

  async function rawMcp(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  async function settled(): Promise<void> {
    for (let i = 0; i < 200 && jobs.stats().running > 0; i += 1) await Bun.sleep(5);
    expect(jobs.stats().running).toBe(0);
  }

  test('bearer and non-ChatGPT OAuth connections: MCP and OpenAPI return the same allowlisted outputs, with no leak', async () => {
    for (const [kind, token] of tokens()) {
      for (const [name, args, operation] of [
        ['source_answer', { question: 'q' }, 'source_answer'],
        ['source_index_status', {}, 'source_index_status'],
        ['ask_anonymously', { question: 'q' }, 'ask_anonymously'],
      ] as const) {
        const viaMcp = await mcp(token, name, args);
        const viaRest = await rest(token, name, args);
        expect({ kind, name, isError: viaMcp.isError, status: viaRest.status }).toEqual({ kind, name, isError: false, status: 200 });
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
    }
  });

  test('each connection reaches the worker as the host it records; an unknown host\'s answer says so, on both paths', async () => {
    consult = async () => ({ ...ANSWERED_RAW, providerNote: CONSULT_ASK_MESSAGES.providerUnknown });
    const connections: Array<[string, string]> = [
      [store.create('Grok API').token, 'xai'],
      [store.create('Scripts', { provider: 'meta' }).token, 'meta'],
      [store.create('Agent').token, 'other'],
      [oauthToken('Claude'), 'anthropic'],
      [oauthToken('My agent'), 'other'],
    ];
    for (const [token, provider] of connections) {
      consultCallers = [];
      const viaMcp = JSON.parse((await mcp(token, 'ask_anonymously', { question: 'q' })).text) as Record<string, unknown>;
      const viaRest = JSON.parse((await rest(token, 'ask_anonymously', { question: 'q' })).text) as Record<string, unknown>;
      expect({ provider, callers: consultCallers }).toEqual({ provider, callers: [provider, provider] });
      expect(viaMcp).toEqual(viaRest);
      expect(viaRest.provider_note).toBe(REMOTE_PROVIDER_UNKNOWN_NOTE);
      expectSchemaValid('ask_anonymously', viaRest);
    }
  });

  test('every source_answer_result family over the wire, on both paths', async () => {
    releaseCheck = fixedCheck('public_or_personal');
    const { token } = store.create('Muse');
    let release: () => void = () => undefined;
    let held: Promise<void> = Promise.resolve();
    const families: Array<[string, 'source_answer' | 'ask_anonymously', () => void, string[]]> = [
      ['source answer', 'source_answer', () => { answer = async () => { await held; return answered([input('garden')], leakyAnswer([leakyEvidence('garden')], 'ok')); }; },
        ['answer', 'citations', 'citations[].date', 'citations[].label', 'citations[].title', 'kind', 'status']],
      ['anonymous answered', 'ask_anonymously', () => { consult = async () => { await held; return ANSWERED_RAW; }; },
        ['cleanup', 'kind', 'level', 'model', 'network_identity', 'note', 'remembered', 'reply', 'rewritten', 'route', 'sent', 'status']],
      ['anonymous needs_choice', 'ask_anonymously', () => { consult = async () => { await held; return NEEDS_CHOICE_RAW; }; },
        ['kind', 'message', 'options', 'options.custom_instruction', 'options.suggested_cleanup', 'options.suggested_level', 'status']],
      ['anonymous refused', 'ask_anonymously', () => { consult = async () => { await held; return REFUSED_RAW; }; },
        ['code', 'daemon_code', 'kind', 'message', 'outcome', 'sent', 'status']],
    ];
    for (const [family, start, arrange, keys] of families) {
      held = new Promise<void>((resolve) => { release = resolve; });
      arrange();
      const first = JSON.parse((await rest(token, start, { question: 'q' })).text) as { status: string; job_id: string };
      expect({ family, status: first.status }).toEqual({ family, status: 'working' });
      // Still running: the pending family.
      const pending = JSON.parse((await mcp(token, 'source_answer_result', { job_id: first.job_id })).text);
      expect(uniqueKeyPaths(pending)).toEqual(['elapsed_ms', 'job_id', 'message', 'next_tool', 'status']);
      expectSchemaValid('source_answer_result', pending);
      release();
      await settled();
      const viaRest = await rest(token, 'source_answer_result', { job_id: first.job_id });
      const viaMcp = await mcp(token, 'source_answer_result', { job_id: first.job_id });
      expect({ family, status: viaRest.status, isError: viaMcp.isError }).toEqual({ family, status: 200, isError: false });
      expect(JSON.parse(viaMcp.text)).toEqual(JSON.parse(viaRest.text));
      expect({ family, keys: uniqueKeyPaths(JSON.parse(viaRest.text)) }).toEqual({ family, keys });
      expectSchemaValid('source_answer_result', JSON.parse(viaRest.text));
      expect(viaRest.text).not.toContain('LEAK');
    }
  });

  test('a delayed answer is withheld when an input it read becomes Secret AFTER the result was stored', async () => {
    const { dir: tiers, cleanup } = tempDir('olympus-remote-result-delayed-');
    const fixture = openTierFixture(tiers);
    try {
      await fixture.set.sync(fixtureConnector(() => [
        { id: 'garden', name: 'garden-plan.txt', text: 'Garden notes.' },
        { id: 'orchard', name: 'orchard-plan.txt', text: 'Orchard notes.' },
        { id: 'meadow', name: 'meadow-plan.txt', text: 'Meadow notes.' },
      ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      releaseCheck = createReleaseTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }], () => 'allow');
      // One connection of each kind, each with its own uncited input.
      for (const [[kind, token], uncited] of tokens().map((entry, index) => [entry, index === 0 ? 'orchard' : 'meadow'] as const)) {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // Reads garden and the uncited item; cites garden only.
        answer = async () => { await held; return answered([input('garden'), input(uncited)], leakyAnswer([leakyEvidence('garden')], 'ok')); };
        const first = JSON.parse((await rest(token, 'source_answer', { question: 'q' })).text) as { status: string; job_id: string };
        expect({ kind, status: first.status }).toEqual({ kind, status: 'working' });
        release();
        await settled();
        // The completed result is stored; nothing has changed yet, so it releases.
        expect(JSON.parse((await mcp(token, 'source_answer_result', { job_id: first.job_id })).text)).toMatchObject({ status: 'answered' });
        // Only now is the UNCITED input reclassified to Secret.
        await moveTieredItem({ set: fixture.set, identity: identityOf(uncited), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
        const viaRest = await rest(token, 'source_answer_result', { job_id: first.job_id });
        expect({ kind, body: JSON.parse(viaRest.text) }).toEqual({ kind, body: { kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_CHANGED, citations: [] } });
        const viaMcp = await mcp(token, 'source_answer_result', { job_id: first.job_id });
        expect(JSON.parse(viaMcp.text)).toEqual(JSON.parse(viaRest.text));
      }
    } finally {
      fixture.close();
      cleanup();
    }
  });

  test('a direct answer is revalidated too, and one with no manifest is withheld', async () => {
    releaseCheck = fixedCheck('public_or_personal');
    const { token } = store.create('Muse');
    expect(JSON.parse((await rest(token, 'source_answer', { question: 'q' })).text)).toMatchObject({ status: 'answered' });
    answer = async () => leakyAnswer();
    for (const text of [(await rest(token, 'source_answer', { question: 'q' })).text, (await mcp(token, 'source_answer', { question: 'q' })).text]) {
      expect(JSON.parse(text)).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_UNVERIFIED, citations: [] });
    }
  });

  test('handler errors are fixed sentences on both paths, with no internal message', async () => {
    const { token } = store.create('Grok');
    answer = async () => { throw new Error('boom at /Users/secret/path SECRET_TITLE_LEAK'); };
    const viaMcp = await mcp(token, 'source_answer', { question: 'q' });
    const viaRest = await rest(token, 'source_answer', { question: 'q' });
    expect(viaMcp.isError).toBe(true);
    for (const text of [viaMcp.text, viaRest.text]) {
      expect(text).not.toContain('LEAK');
      expect(text).not.toContain('/Users/secret');
      expect(text).not.toContain('olympus-worker.internal');
      expectErrorSchema(JSON.parse(text));
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

  test('source_index_status: withheld parameters are not advertised and are refused by name', async () => {
    const { token } = store.create('Muse');
    const withheld = REMOTE_WITHHELD_PARAMS.source_index_status!;
    const remoteTool = (await withClient(token, async (client) => (await client.listTools()).tools))
      .find((tool) => tool.name === 'source_index_status')!;
    const spec = buildRemoteOpenApiSpec() as { paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } } }> };
    const specProperties = spec.paths['/api/v1/tools/source_index_status']!.post.requestBody.content['application/json']!.schema.properties;
    for (const name of withheld) {
      expect({ name, mcp: name in (remoteTool.inputSchema.properties ?? {}), spec: name in specProperties }).toEqual({ name, mcp: false, spec: false });
      expect(remoteTool.description ?? '').not.toContain(name);
    }
    // Local surfaces are unchanged: stdio MCP still lists every parameter.
    const local = listMcpTools(defaultConfig()).find((tool) => tool.name === 'source_index_status')!;
    for (const name of withheld) expect(name in (local.inputSchema.properties as Record<string, unknown>)).toBe(true);

    for (const name of withheld) {
      const viaMcp = await mcp(token, 'source_index_status', { [name]: true });
      const viaRest = await rest(token, 'source_index_status', { [name]: true });
      const expected = { error: 'invalid_params', message: `The ${name} argument is not available to remote agents. Remove it and try again.`, param: name };
      expect({ name, isError: viaMcp.isError, body: JSON.parse(viaMcp.text) }).toEqual({ name, isError: true, body: expected });
      expect({ name, status: viaRest.status, body: JSON.parse(viaRest.text) }).toEqual({ name, status: 400, body: expected });
      expectErrorSchema(expected);
    }
  });

  test('pre-handler failures on /mcp: SDK validation, unknown methods and bad headers carry fixed text only', async () => {
    const { token } = store.create('Grok');
    const cases: Array<[string, unknown, Record<string, string>]> = [
      ['invalid tools/call params', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42, arguments: 'LEAK_ARGUMENT' } }, {}],
      ['unknown method', { jsonrpc: '2.0', id: 2, method: 'LEAK/method', params: {} }, {}],
      ['bad protocol version', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'mcp-protocol-version': 'LEAK-VERSION' }],
    ];
    const fixed = ['Invalid params.', 'Method not found.', 'Internal error.', 'Invalid request.', 'The request could not be handled.'];
    for (const [label, body, headers] of cases) {
      const response = await rawMcp(token, body, headers);
      const parsed = JSON.parse(response.text) as { error?: { code: number; message: string; data?: unknown } };
      expect({ label, hasError: parsed.error !== undefined, data: parsed.error?.data }).toEqual({ label, hasError: true, data: undefined });
      expect({ label, fixed: fixed.includes(parsed.error!.message) }).toEqual({ label, fixed: true });
      expect(response.text).not.toContain('LEAK');
    }
  });

  test('MCP credential and context failures are fixed JSON, unmarked, for bearer and non-ChatGPT OAuth', async () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    for (const [kind, token] of tokens()) {
      relayed = true;
      // A healthy relayed request is marked, so the absence below is meaningful.
      const healthy = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initialize),
      });
      await healthy.text();
      expect({ kind, mark: healthy.headers.get(AUTHENTICATED_RESPONSE_HEADER) }).toEqual({ kind, mark: '1' });

      for (const [label, arrange, status, error] of [
        ['verification throws', () => { verifyFails = true; }, 503, 'remote_connections_unavailable'],
        ['context throws', () => { contextFails = true; }, 500, 'internal_error'],
      ] as const) {
        verifyFails = false;
        contextFails = false;
        arrange();
        for (const isRelayed of [true, false]) {
          relayed = isRelayed;
          const response = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify(initialize),
          });
          const text = await response.text();
          expect({ kind, label, isRelayed, status: response.status, type: response.headers.get('Content-Type') })
            .toEqual({ kind, label, isRelayed, status, type: 'application/json' });
          const body = JSON.parse(text) as Record<string, unknown>;
          expect({ kind, label, error: body.error }).toEqual({ kind, label, error });
          expectErrorSchema(body);
          expectNothingInternal(text);
          expect(response.headers.get(AUTHENTICATED_RESPONSE_HEADER)).toBeNull();
          expect(response.headers.get(SURFACE_RESPONSE_HEADER)).toBeNull();
        }
      }
      verifyFails = false;
      contextFails = false;
    }
    relayed = false;
  });

  test('the outer remote boundary turns anything that escapes into a fixed JSON error', async () => {
    const thrown = withRemoteFailureBoundary(() => { throw new Error('sync at /Users/secret/LEAK'); });
    const rejected = withRemoteFailureBoundary(async () => { throw new Error('async at /Users/secret/LEAK'); });
    for (const handler of [thrown, rejected]) {
      const response = await handler(new Request(`${base}/mcp`, { method: 'POST' }));
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(text)).toMatchObject({ error: 'internal_error' });
      expectErrorSchema(JSON.parse(text));
      expectNothingInternal(text);
      expect(response.headers.get(AUTHENTICATED_RESPONSE_HEADER)).toBeNull();
      expect(response.headers.get(SURFACE_RESPONSE_HEADER)).toBeNull();
    }
    // A healthy response passes through untouched.
    const ok = await withRemoteFailureBoundary(async () => new Response('fine', { status: 202 }))(new Request(`${base}/mcp`));
    expect({ status: ok.status, text: await ok.text() }).toEqual({ status: 202, text: 'fine' });
  });

  test('pre-handler failures on OpenAPI: every one is the published Error shape, nothing reflected', async () => {
    const { token } = store.create('Muse');
    const checks: Array<[string, () => Promise<{ status: number; text: string; headers: Headers }>, number]> = [
      ['no token', () => rest(undefined, 'source_answer', { question: 'q' }), 401],
      ['bad token', () => rest('olympus_conn_LEAK', 'source_answer', { question: 'q' }), 401],
      ['unknown operation', () => rest(token, 'leak_tool', {}), 404],
      ['wrong method', () => rest(token, 'source_answer', {}, { method: 'GET' }), 405],
      ['wrong media type', () => rest(token, 'source_answer', 'question=LEAK', { contentType: 'text/plain' }), 415],
      ['not json', () => rest(token, 'source_answer', '{LEAK'), 400],
      ['undeclared parameter', () => rest(token, 'source_answer', { question: 'q', LEAK_PARAM: 1 }), 400],
      ['too large', () => rest(token, 'source_answer', { question: 'x'.repeat(REMOTE_OPENAPI_MAX_BODY_BYTES) }), 413],
    ];
    for (const [label, run, status] of checks) {
      const response = await run();
      expect({ label, status: response.status }).toEqual({ label, status });
      expectErrorSchema(JSON.parse(response.text));
      expect(response.text).not.toContain('LEAK');
    }
    const unauthorized = await rest(undefined, 'source_answer', { question: 'q' });
    expect(unauthorized.headers.get('WWW-Authenticate') ?? '').toStartWith('Bearer realm="olympus"');
    // A context that cannot be built, and a credential store that throws, are still the Error shape.
    contextFails = true;
    const broken = await rest(token, 'source_answer', { question: 'q' });
    expect(broken.status).toBe(500);
    expectErrorSchema(JSON.parse(broken.text));
    expectNothingInternal(broken.text);
    contextFails = false;
    verifyFails = true;
    const throwing = await rest(token, 'source_answer', { question: 'q' });
    expect({ status: throwing.status, body: JSON.parse(throwing.text) }).toMatchObject({ status: 503, body: { error: 'remote_connections_unavailable' } });
    expectNothingInternal(throwing.text);
    verifyFails = false;
    store.close();
    const closed = await rest(token, 'source_answer', { question: 'q' });
    expect({ status: closed.status, body: JSON.parse(closed.text) }).toMatchObject({ status: 503, body: { error: 'remote_connections_unavailable' } });
    expectErrorSchema(JSON.parse(closed.text));
    expectNothingInternal(closed.text);
    store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  });
});

describe('local and ChatGPT answer release boundaries', () => {
  test('stdio MCP returns the whole serialized operation result after the worker verifies its ticket', async () => {
    const worker = createEmailSourceWorker({
      sourceAnswer: { answer: async () => { recordReleaseManifest(manifest([input('garden')])); return leakyAnswer(); } },
      sourceAnswerReleaseCheck: fixedCheck('public_or_personal'),
    });
    const make = (withCheck: boolean) => ({
      ...createInProcessOperationContext({
        config: defaultConfig(),
        sourceIndexReadEnabled: true,
        caller: { surface: 'mcp', displayName: 'codex' },
        workerFetch: worker.fetch,
      }),
      ...(withCheck ? { releaseCheck: fixedCheck('secret') } : {}),
    });
    const direct = await findOperationByName('source_answer')!.handler(make(false), { question: 'q' });
    for (const withCheck of [false, true]) {
      const viaStdio = await handleMcpCallTool({ params: { name: 'source_answer', arguments: { question: 'q' } } }, () => make(withCheck));
      expect(viaStdio.content[0]!.text).toBe(JSON.stringify(direct, null, 2));
      expect(viaStdio.isError).toBeUndefined();
    }
    const parsed = JSON.parse(JSON.stringify(direct)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['answer', 'evidence', 'secret_locations', 'audit', 'policy']));
    expect(String(parsed.answer)).toContain('Secret(s) matched by location only');
    // And an unknown tool still throws on stdio, as before.
    await expect(handleMcpCallTool({ params: { name: 'no_such_tool' } }, () => make(false))).rejects.toThrow('Unknown Olympus operation: no_such_tool');
    // The stdio tool list keeps every source_index_status parameter.
    const local = listMcpTools(defaultConfig()).find((tool) => tool.name === 'source_index_status')!;
    expect(Object.keys(local.inputSchema.properties as Record<string, unknown>)).toEqual(Object.keys(findOperationByName('source_index_status')!.params));
    worker.close();
  });

  test('the ChatGPT surface releases a proven Personal answer and withholds it after reclassification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-remote-result-chatgpt-'));
    const store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    let releaseCheck: ReleaseCheck = fixedCheck('public_or_personal');
    const clean = leakyAnswer([leakyEvidence('garden')], 'The garden plan covers compost.') as unknown as Record<string, any>;
    clean.audit.answer_synthesis = { ...clean.audit.answer_synthesis, private_context_used: false, secure_local_items_consulted: 0 };
    clean.policy = { ...clean.policy, secure_local_content_exposed: false };
    const worker = createEmailSourceWorker({
      sourceAnswer: { answer: async () => { recordReleaseManifest(manifest([input('garden')])); return clean as unknown as SourceIndexAnswerResult; } },
      sourceAnswerLatencyLog: { record() {} },
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: createRemoteMcpHandler({
        connections: () => store,
        makeOperationContext: (caller, signal) => ({
          ...createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
          ...(releaseCheck ? { releaseCheck } : {}),
        }),
        chatgpt: {
          servesRequest: () => true,
          dashboardView: async () => ({}) as never,
          privateMatchProbe: async () => false,
        },
      }),
    });
    const { token } = store.create('ChatGPT');
    const call = async () => {
      const client = new Client({ name: 'chatgpt-equivalence', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
      try {
        return JSON.stringify(await client.callTool({ name: 'source_answer', arguments: { question: 'garden?' } }));
      } finally {
        await client.close();
      }
    };
    try {
      const without = await call();
      expect(without).toContain('compost');
      for (const tier of ['private', 'secret'] as const) {
        releaseCheck = fixedCheck(tier);
        const withheld = await call();
        expect(withheld).not.toContain('compost');
        expect(withheld).toContain('Olympus withheld this answer');
      }
    } finally {
      server.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
