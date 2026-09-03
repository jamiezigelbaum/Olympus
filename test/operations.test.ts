import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  planAnnasArchiveImport,
  planDomainAgent,
  planDomainAsk,
  planDomainDoc,
  planDomainSource,
  planRagCorpus,
} from '../src/core/domain-expert.ts';
import { operations, operationDescription, operationToolSchema } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

// The domain expert's cloud tenant is deployment configuration with no
// committed default (see `DOMAIN_GCP_PROJECT_ENV` /
// `DOMAIN_GCS_BUCKET_TEMPLATE_ENV`). These suites exercise a *configured*
// deployment, so they supply invented tenant values; the unconfigured
// fail-closed behaviour has its own test that clears them.
process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = 'olympus-fixture-project';
process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = 'fixture-{domain}-rag';

describe('operations', () => {
  test('defines the current operation surface', () => {
    expect(operations.map((operation) => operation.name)).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'email_ping',
      'email_answer',
      'source_answer',
      'source_index_status',
      'source_index_sync',
      'source_index_search',
      'source_export',
      'source_transcribe',
      'source_media_ingest',
      'source_index_promotion_candidates',
      'source_index_promotion_propose',
      'source_index_promotion_proposals',
      'source_index_promotion_proposal',
      'source_index_promotion_decide',
      'source_watch_create',
      'source_watches',
      'source_watch_cancel',
      'xanthos_file_deliver',
      'castor_workspace',
      'domain_agent',
      'domain_ask',
      'domain_source',
      'rag_corpus',
      'domain_doc',
      'annas_archive_search',
      'annas_archive_import',
      'email_search',
      'email_index_sync',
      'email_index_embed',
      'email_index_search',
      'expert_hire',
      'expert_report',
      'olympus_doctor',
    ]);
    expect(operations.find((operation) => operation.name === 'olympus_doctor')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'olympus_doctor')?.nativeExposure).toBe('always');
    expect(operations.find((operation) => operation.name === 'email_index_sync')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_index_sync')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'email_index_embed')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'xanthos_file_deliver')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_export')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_export')?.nativeExposure).toBe('sourceIndexAnswerDevOnly');
    expect(operations.find((operation) => operation.name === 'source_transcribe')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_transcribe')?.nativeExposure).toBe('sourceIndexAnswerDevOnly');
    expect(operations.find((operation) => operation.name === 'source_media_ingest')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_media_ingest')?.nativeExposure).toBe('sourceIndexAnswerDevOnly');
    expect(operations.find((operation) => operation.name === 'source_index_promotion_propose')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_index_promotion_decide')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'domain_agent')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'domain_ask')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'domain_source')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'rag_corpus')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'domain_doc')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'annas_archive_search')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'annas_archive_import')?.mutating).toBe(true);
    expect(operations.find((operation) => operation.name === 'source_index_status')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'source_answer')?.nativeExposure).toBe('sourceIndexEnabledOnly');
    expect(operations.find((operation) => operation.name === 'source_index_status')?.nativeExposure).toBe('sourceIndexEnabledOnly');
    expect(operations.find((operation) => operation.name === 'source_index_search')?.nativeExposure).toBe('sourceIndexEnabledOnly');
    expect(operations.find((operation) => operation.name === 'source_index_promotion_candidates')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'source_index_promotion_proposals')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'source_index_promotion_proposal')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'expert_hire')).toMatchObject({
      mutating: true,
      nativeExposure: 'hireBrokerEnabledOnly',
    });
    expect(operations.find((operation) => operation.name === 'expert_report')).toMatchObject({
      mutating: false,
      nativeExposure: 'hireBrokerEnabledOnly',
    });
  });

  test('expert bridge operations delegate only to the broker and bind confirmation to trusted owner context', async () => {
    const hire = operations.find((operation) => operation.name === 'expert_hire')!;
    const report = operations.find((operation) => operation.name === 'expert_report')!;
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {} as OperationContext['email'],
      hireBroker: {
        hire: async (request: unknown) => {
          calls.push(request);
          return { status: 'submitted', handle: 'hire_fixture' };
        },
        report: async (handle: string) => {
          calls.push({ handle });
          return { handle, status: 'pending' };
        },
      } as unknown as NonNullable<OperationContext['hireBroker']>,
      hireBrokerAuthority: { senderIsOwner: true },
    };
    const listing = { name: 'Fixture', endpoint: 'https://expert.example/a2a' };
    const budget = { amount: 5, currency: 'USDC' };

    await hire.handler(ctx, { listing, brief: 'Shape-only brief.', budget, owner_confirmed: true });
    await report.handler(ctx, { handle: 'hire_fixture' });

    expect(calls).toEqual([
      { listing, brief: 'Shape-only brief.', budget, ownerConfirmed: true, ownerAuthorized: true },
      { handle: 'hire_fixture' },
    ]);
    expect(operationToolSchema(hire)).toMatchObject({
      required: ['listing', 'brief', 'budget'],
      properties: {
        listing: { type: 'object' },
        brief: { type: 'string' },
        budget: { type: 'object' },
        owner_confirmed: { type: 'boolean' },
      },
    });
  });

  test('generates required tool schema for argus_complete', () => {
    const complete = operations.find((operation) => operation.name === 'argus_complete');
    expect(complete).toBeDefined();

    expect(operationToolSchema(complete!)).toMatchObject({
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        profile: {
          type: 'string',
          enum: [
            'default_chat',
            'source_answer',
            'classification_fast',
            'embedding_secure_local',
            'vlm_document',
            'vlm_fast',
            'vlm_qwen36_27b',
            'vlm_qwen36_35b',
          ],
        },
        lane: { type: 'string', enum: ['fast', 'deep'] },
      },
    });
  });

  test('argus_complete resolves default profile and delegates to Delphi client', async () => {
    const complete = operations.find((operation) => operation.name === 'argus_complete');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {
        complete: async (options: unknown) => {
          calls.push(options);
          return { text: 'ok', profile: 'default_chat', model: 'model' };
        },
      } as OperationContext['delphi'],
      email: {} as OperationContext['email'],
    };

    const result = await complete!.handler(ctx, { prompt: 'test' });

    expect(result).toMatchObject({ text: 'ok' });
    expect(calls[0]).toMatchObject({ profile: 'default_chat', prompt: 'test' });
  });

  test('doctor runs the read-only health walk from ctx config and delphi', async () => {
    const doctor = operations.find((operation) => operation.name === 'olympus_doctor');
    const profiles: unknown[] = [];
    const config = defaultConfig();
    config.sourceIndex.enabled = false;
    const ctx: OperationContext = {
      config,
      delphi: {
        listModelsForProfile: async (profile: unknown) => {
          profiles.push(profile);
          return [{ id: 'model-1' }];
        },
        complete: async (options: { profile: 'default_chat' }) => ({
          text: 'OLYMPUS_DOCTOR_OK',
          profile: options.profile,
          model: 'model-1',
        }),
      } as unknown as OperationContext['delphi'],
      email: {} as OperationContext['email'],
    };

    const result = await doctor!.handler(ctx, {}) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };

    expect(result.ok).toBe(true);
    // No sovereignty posture in defaultConfig() → the Argus probe is skipped
    // (a fresh install never assumes a local model pool), so no profile is probed.
    expect(profiles).toEqual([]);
    expect(result.checks.map((check) => check.name)).toEqual([
      'dependencies',
      'source_capability_catalog',
      'sovereignty_prerequisites',
      'credential_handles',
      'detached_oauth_connections',
      'google_oauth_refresh_lifetime',
      'credential_reauthorization_backlog',
      'argus_model_pool',
      'sovereignty_model_lanes',
      'email_worker',
      'worker_credential_lanes',
      'dropbox_content_extraction_throughput',
      'source_index_status',
      'source_scheduler_status',
      'source_ingestion_health',
    ]);
    expect(operationToolSchema(doctor!)).toMatchObject({
      type: 'object',
      required: [],
    });
  });

  test('email_answer delegates only bounded question parameters to private email lane', async () => {
    const emailAnswer = operations.find((operation) => operation.name === 'email_answer');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        answer: async (options: unknown) => {
          calls.push(options);
          return {
            answer: 'The relevant message says yes.',
            policy: { raw_email_exposed: false, reasoning_lane: 'delphi_local' },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await emailAnswer!.handler(ctx, {
      question: 'Did Alex send the invoice?',
      from: 'alex@example.com',
      max_messages: 5,
    });

    expect(result).toMatchObject({
      answer: 'The relevant message says yes.',
      policy: { raw_email_exposed: false },
    });
    expect(calls[0]).toEqual({
      question: 'Did Alex send the invoice?',
      from: 'alex@example.com',
      maxMessages: 5,
    });
  });

  test('email_search delegates local packet parameters to private email lane', async () => {
    const emailSearch = operations.find((operation) => operation.name === 'email_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        search: async (options: unknown) => {
          calls.push(options);
          return {
            packet: {
              kind: 'email_source_packet',
              packet_id: 'packet-1',
              source: 'gmail',
              items: [],
            },
            audit: {
              request_id: 'request-1',
              queries_attempted: 1,
              retrieval_mode: 'hybrid',
              keyword_candidates: 2,
              vector_candidates: 2,
              fused_candidates: 0,
              metadata_hits: 0,
              items_returned: 0,
              sanitized_reads_attempted: 0,
              sanitized_reads_succeeded: 0,
              truncated: false,
              local_packet: true,
              raw_email_exposed: false,
            },
            policy: { raw_email_exposed: false, local_only: true, requires_local_session: true },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await emailSearch!.handler(ctx, {
      question: 'Find the school visit thread.',
      query: 'OpenApply appointment',
      from: 'admissions@example.com',
      max_messages: 5,
      include_sanitized_text: false,
    });

    expect(result).toMatchObject({
      policy: { raw_email_exposed: false, local_only: true },
    });
    expect(calls[0]).toEqual({
      question: 'Find the school visit thread.',
      query: 'OpenApply appointment',
      from: 'admissions@example.com',
      maxMessages: 5,
      includeSanitizedText: false,
    });
  });

  test('source_answer delegates Castor-safe source parameters to private source lane', async () => {
    const sourceAnswer = operations.find((operation) => operation.name === 'source_answer');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceAnswer: async (options: unknown) => {
          calls.push(options);
          return {
            answer: 'I found 1 safe source result with provenance.',
            evidence: [],
            audit: {
              searched_corpora: ['internal.drive.docs'],
              skipped_corpora: [],
              lane_audits: [],
              latency_ms: 1,
              raw_source_exposed: false,
            },
            policy: {
              raw_source_exposed: false,
              source_packets_exposed: false,
              internal_content_exposed: true,
              secure_local_content_exposed: false,
              castor_safe_bridge: true,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceAnswer!.handler(ctx, {
      question: 'Find school visit sources.',
      query: 'school visit',
      account: 'person@example.com',
      corpus_id: 'secure_local.dropbox.files',
      corpus_ids: ['secure_local.dropbox.files', 'internal.email', 'internal.telegram.messages', 'internal.telegram.messages'],
      approved_scope_key: 'dropbox.personal:/Approved',
      chat_scope: 'telegram.personal:chat:chat-porto',
      conversation_id: 'chat-porto',
      selected_items: [{
        corpus_id: 'secure_local.dropbox.files',
        family: 'file',
        provider: 'dropbox',
        account_scope: 'personal',
        provider_item_id: 'lab-1',
        local_item_id: 'personal:lab-1',
        title: 'Forged labs.pdf',
        uri: 'https://example.invalid/forged-labs.pdf',
      }],
      retrieval_mode: 'keyword',
      analyst_provider: 'venice',
      analyst_model: 'GLM 5.2 EE2E',
      max_results: 3,
      include_secure_local: true,
      include_secure_local_content: true,
      include_internal: false,
      include_internal_content: true,
      internal_content_max_bytes: 12_000,
      timeoutMs: 600_000,
    });

    expect(result).toMatchObject({
      policy: { raw_source_exposed: false, castor_safe_bridge: true },
    });
    expect(calls[0]).toEqual({
      question: 'Find school visit sources.',
      query: 'school visit',
      account: 'person@example.com',
      corpusId: 'secure_local.dropbox.files',
      corpusIds: ['secure_local.dropbox.files', 'internal.email', 'internal.telegram.messages'],
      approvedScopeKey: 'dropbox.personal:/Approved',
      chatScope: 'telegram.personal:chat:chat-porto',
      conversationId: 'chat-porto',
      selectedItems: [{
        corpus_id: 'secure_local.dropbox.files',
        family: 'file',
        provider: 'dropbox',
        account_scope: 'personal',
        provider_item_id: 'lab-1',
        local_item_id: 'personal:lab-1',
      }],
      retrievalMode: 'keyword',
      analystProvider: 'venice',
      analystModel: 'e2ee-glm-5-2-p',
      maxResults: 3,
      includeSecureLocal: true,
      includeSecureLocalContent: true,
      includeInternal: false,
      includeInternalContent: true,
      internalContentMaxBytes: 12_000,
      timeoutMs: 600_000,
    });
    expect(operationToolSchema(sourceAnswer!)).toMatchObject({
      properties: {
        corpus_id: { enum: ['secure_local.email.private', 'internal.email', 'internal.drive.docs', 'secure_local.drive.docs', 'internal.telegram.messages', 'internal.readwise.library', 'internal.x.bookmarks', 'secure_local.dropbox.files', 'secure_local.telegram.protected.messages', 'secure_local.whatsapp.messages'] },
        approved_scope_key: { type: 'string' },
        chat_scope: {
          type: 'string',
          description: expect.stringContaining('pass the group title'),
        },
        conversation_id: { type: 'string' },
        selected_items: { type: 'array' },
        retrieval_mode: { enum: ['keyword', 'hybrid'] },
        analyst_provider: { enum: ['default', 'local', 'venice', 'cloud'] },
        analyst_model: { type: 'string' },
        include_secure_local_content: { type: 'boolean' },
        timeoutMs: {
          type: 'number',
          description: expect.stringContaining('OpenClaw dynamic-tool watchdog'),
        },
      },
    });
    expect(operationToolSchema(sourceAnswer!).properties).toMatchObject({
      analyst_provider: {
        description: expect.stringContaining('when the owner explicitly asks'),
      },
      include_internal_content: {
        description: expect.stringContaining('the calling assistant summarization'),
      },
    });
    const customConfig = defaultConfig();
    customConfig.identity = { ownerName: 'Alex', assistantName: 'Athena' };
    expect(operationToolSchema(sourceAnswer!, { config: customConfig }).properties).toMatchObject({
      analyst_provider: {
        description: expect.stringContaining('when Alex explicitly asks'),
      },
      include_internal_content: {
        description: expect.stringContaining('Athena summarization'),
      },
    });
    expect(operationToolSchema(sourceAnswer!).properties).toMatchObject({
      analyst_provider: {
        description: expect.stringContaining('private-cloud-only = Venice only'),
      },
    });
    expect(operationDescription(sourceAnswer!, { config: customConfig })).toContain('calling-assistant-safe answer');
  });

  test('source_answer supports natural bounded secure-local requests without hidden routing knobs', async () => {
    const sourceAnswer = operations.find((operation) => operation.name === 'source_answer');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceAnswer: async (options: unknown) => {
          calls.push(options);
          return {
            answer: 'The bounded secure-local derivative was released with citations.',
            evidence: [{
              corpus_id: 'secure_local.dropbox.files',
              trust_domain: 'secure_local',
              family: 'file',
              provider: 'dropbox',
              provider_item_id: 'lab-1',
              title: 'Recent labs.pdf',
            }],
            audit: {
              searched_corpora: ['secure_local.dropbox.files'],
              skipped_corpora: [],
              lane_audits: [],
              answer_synthesis: {
                private_context_used: true,
                secure_local_items_consulted: 1,
                internal_items_consulted: 0,
                analyst_backend: 'local',
                raw_source_exposed: false,
              },
              latency_ms: 1,
              raw_source_exposed: false,
            },
            policy: {
              raw_source_exposed: false,
              source_packets_exposed: false,
              internal_content_exposed: false,
              secure_local_content_exposed: true,
              castor_safe_bridge: true,
            },
            opsec: {
              structured_evidence: [{
                fact_id: 'citation-1',
                trust_domain: 'secure_local',
                trust_tier: 'S4',
                release_surface: 'castor_answer',
                claim: 'bounded derivative',
              }],
              release_decision: {
                decision: 'allow',
                reasons: ['bounded_secure_derivative_allowed', 'release_gate_passed'],
              },
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceAnswer!.handler(ctx, {
      question: 'Analyze my recent labs and tell me the important numbers.',
      corpus_id: 'secure_local.dropbox.files',
      include_secure_local: true,
      include_secure_local_content: true,
      timeoutMs: 600_000,
    });

    expect(result).toMatchObject({
      policy: {
        raw_source_exposed: false,
        secure_local_content_exposed: true,
        castor_safe_bridge: true,
      },
      opsec: {
        release_decision: {
          decision: 'allow',
          reasons: expect.arrayContaining(['bounded_secure_derivative_allowed']),
        },
      },
    });
    expect(calls[0]).toEqual({
      question: 'Analyze my recent labs and tell me the important numbers.',
      corpusId: 'secure_local.dropbox.files',
      includeSecureLocal: true,
      includeSecureLocalContent: true,
      timeoutMs: 600_000,
    });
    expect(calls[0]).not.toHaveProperty('account');
    expect(calls[0]).not.toHaveProperty('approvedScopeKey');
    expect(calls[0]).not.toHaveProperty('analystProvider');
    expect(operationToolSchema(sourceAnswer!)).toMatchObject({
      properties: {
        approved_scope_key: {
          description: expect.stringContaining('Optional Dropbox scope filter'),
        },
        include_secure_local_content: {
          description: expect.stringContaining('OPSEC-scanned derivative content'),
        },
        timeoutMs: {
          description: expect.stringContaining('OpenClaw dynamic-tool watchdog'),
        },
      },
    });
  });

  test('source_index_status delegates read-only status parameters to private source lane', async () => {
    const sourceIndexStatus = operations.find((operation) => operation.name === 'source_index_status');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexStatus: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_status',
            generated_at: '2026-05-17T12:00:00.000Z',
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
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexStatus!.handler(ctx, {
      account: 'person@example.com',
      corpus_id: 'internal.drive.docs',
      approved_scope_key: 'dropbox.personal:/Approved',
      chat_scope: 'telegram.personal:chat:chat-porto',
      conversation_id: 'chat-porto',
      include_sender_aggregation: true,
      max_senders: 10,
      include_ingestion_ledger: true,
      include_items: true,
      max_items: 25,
      query: 'banking',
    });

    expect(result).toMatchObject({
      kind: 'source_index_status',
      policy: { read_only: true, raw_source_exposed: false },
    });
    expect(calls[0]).toEqual({
      account: 'person@example.com',
      corpusId: 'internal.drive.docs',
      approvedScopeKey: 'dropbox.personal:/Approved',
      chatScope: 'telegram.personal:chat:chat-porto',
      conversationId: 'chat-porto',
      includeSenderAggregation: true,
      maxSenders: 10,
      includeIngestionLedger: true,
      includeItems: true,
      maxItems: 25,
      query: 'banking',
    });
    expect(operationToolSchema(sourceIndexStatus!)).toMatchObject({
      properties: {
        corpus_id: { enum: ['secure_local.email.private', 'internal.email', 'internal.drive.docs', 'secure_local.drive.docs', 'internal.telegram.messages', 'internal.readwise.library', 'internal.x.bookmarks', 'secure_local.dropbox.files', 'secure_local.telegram.protected.messages', 'secure_local.whatsapp.messages'] },
        include_ingestion_ledger: {
          description: expect.stringContaining('normalized cross-source ingestion ledger'),
        },
        include_sender_aggregation: {
          description: expect.stringContaining('top-sender counts'),
        },
      },
    });
  });

  test('source_index_sync delegates bounded Dropbox sync parameters to private source lane', async () => {
    const sourceIndexSync = operations.find((operation) => operation.name === 'source_index_sync');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSync: async (options: unknown) => {
          calls.push(options);
          return {
            sync_run_id: 'dropbox-sync-1',
            status: 'completed',
            corpus_id: 'secure_local.dropbox.files',
            provider: 'dropbox',
            account: 'personal',
            items_indexed: 1,
            policy: { raw_source_exposed: false, source_text_returned: false },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSync!.handler(ctx, {
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/Approved',
      folder_path: '/Approved',
      recursive: false,
      max_entries: 10,
      max_pages: 2,
      provider_cursor: 'cursor-secret',
    });

    expect(result).toMatchObject({ provider: 'dropbox', items_indexed: 1 });
    expect(calls[0]).toEqual({
      corpusId: 'secure_local.dropbox.files',
      account: 'personal',
      approvedScopeKey: 'dropbox.personal:/Approved',
      folderPath: '/Approved',
      recursive: false,
      maxEntries: 10,
      maxPages: 2,
      providerCursor: 'cursor-secret',
    });
  });

  test('source_index_sync delegates bounded Telegram sync parameters to private source lane', async () => {
    const sourceIndexSync = operations.find((operation) => operation.name === 'source_index_sync');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSync: async (options: unknown) => {
          calls.push(options);
          return {
            sync_run_id: 'telegram-sync-1',
            status: 'completed',
            corpus_id: 'secure_local.telegram.protected.messages',
            provider: 'telegram',
            account: 'telegram.personal',
            messages_indexed: 1,
            policy: { raw_source_exposed: false, source_text_returned: false },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSync!.handler(ctx, {
      corpus_id: 'secure_local.telegram.messages',
      account: 'telegram.personal',
      chat_scope: 'telegram.personal:chat:chat-porto',
      max_messages: 10,
      provider_cursor: 'min_id:100',
      sync_direction: 'forward',
      coverage_start: '2026-05-20T09:00:00.000Z',
      coverage_end: '2026-05-20T10:00:00.000Z',
    });

    expect(result).toMatchObject({ provider: 'telegram', messages_indexed: 1 });
    expect(calls[0]).toEqual({
      corpusId: 'secure_local.telegram.protected.messages',
      account: 'telegram.personal',
      chatScope: 'telegram.personal:chat:chat-porto',
      maxMessages: 10,
      providerCursor: 'min_id:100',
      syncDirection: 'forward',
      coverageStart: '2026-05-20T09:00:00.000Z',
      coverageEnd: '2026-05-20T10:00:00.000Z',
    });
  });

  test('source_answer accepts selected items from returned search hits and legacy sourceItem metadata', async () => {
    const sourceAnswer = operations.find((operation) => operation.name === 'source_answer');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceAnswer: async (options: unknown) => {
          calls.push(options);
          return {
            answer: 'ok',
            evidence: [],
            policy: {
              raw_source_exposed: false,
              source_packets_exposed: false,
              internal_content_exposed: true,
              secure_local_content_exposed: false,
              castor_safe_bridge: true,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    await sourceAnswer!.handler(ctx, {
      question: 'Summarize selected Telegram items.',
      corpus_id: 'internal.telegram.messages',
      selected_items: [
        {
          selected_item: {
            corpus_id: 'internal.telegram.messages',
            family: 'chat',
            provider: 'telegram',
            account_scope: 'telegram.personal',
            provider_item_id: '84919',
            local_item_id: 'telegram.personal:-1001688680296:84919',
            provider_conversation_id: '-1001688680296',
          },
        },
        {
          sourceItem: {
            family: 'chat',
            provider: 'telegram',
            accountScope: 'telegram.personal',
            providerItemId: '85458',
            providerConversationId: '-1001688680296',
            localItemId: 'telegram.personal:-1001688680296:85458',
            sourceVersion: 'telegram.personal:-1001688680296:85458:2026-05-07T17:08:46Z',
          },
        },
        {
          corpus_id: 'internal.telegram.messages',
          family: 'chat',
          provider: 'telegram',
          accountScope: 'telegram.personal',
          providerItemId: '87002',
          providerConversationId: '-1001688680296',
          localItemId: 'telegram.personal:-1001688680296:87002',
        },
      ],
    });

    expect(calls[0]).toMatchObject({
      corpusId: 'internal.telegram.messages',
      selectedItems: [
        {
          corpus_id: 'internal.telegram.messages',
          provider_item_id: '84919',
          provider_conversation_id: '-1001688680296',
        },
        {
          corpus_id: 'internal.telegram.messages',
          account_scope: 'telegram.personal',
          provider_item_id: '85458',
          provider_conversation_id: '-1001688680296',
          local_item_id: 'telegram.personal:-1001688680296:85458',
          source_version: 'telegram.personal:-1001688680296:85458:2026-05-07T17:08:46Z',
        },
        {
          corpus_id: 'internal.telegram.messages',
          account_scope: 'telegram.personal',
          provider_item_id: '87002',
          provider_conversation_id: '-1001688680296',
          local_item_id: 'telegram.personal:-1001688680296:87002',
        },
      ],
    });
  });

  test('source_answer rejects content-like fields anywhere inside selected items', async () => {
    const sourceAnswer = operations.find((operation) => operation.name === 'source_answer');
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceAnswer: async () => {
          throw new Error('selected item validation should fail before the worker call');
        },
      } as unknown as OperationContext['email'],
    };

    await expect(sourceAnswer!.handler(ctx, {
      question: 'Summarize selected Telegram items.',
      corpus_id: 'internal.telegram.messages',
      selected_items: [{
        selected_item: {
          corpus_id: 'internal.telegram.messages',
          family: 'chat',
          provider: 'telegram',
          account_scope: 'telegram.personal',
          provider_item_id: '84919',
          local_item_id: 'telegram.personal:-1001688680296:84919',
          provider_conversation_id: '-1001688680296',
        },
        rawText: 'source text must not be accepted on the router boundary',
      }],
    })).rejects.toThrow('must not include source content field');
  });

  test('source_index_search delegates safe Dropbox search parameters to private source lane', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_search',
            corpus_id: 'secure_local.dropbox.files',
            retrieval_source: 'local_index',
            hits: [],
            audit: {
              request_id: 'request-1',
              retrieval_source: 'local_index',
              queries_attempted: 1,
              metadata_hits: 0,
              items_returned: 0,
              latency_ms: 1,
              raw_source_exposed: false,
              source_text_returned: false,
            },
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              source_packets_exposed: false,
              local_only: true,
              trust_domain: 'secure_local',
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSearch!.handler(ctx, {
      query: 'Portugal Receipt',
      corpus_id: 'secure_local.dropbox.files',
      retrieval_mode: 'hybrid',
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/Approved',
      max_results: 5,
    });

    expect(result).toMatchObject({
      kind: 'source_index_search',
      policy: { raw_source_exposed: false, source_text_returned: false },
    });
    expect(calls[0]).toEqual({
      query: 'Portugal Receipt',
      corpusId: 'secure_local.dropbox.files',
      retrievalMode: 'hybrid',
      account: 'personal',
      approvedScopeKey: 'dropbox.personal:/Approved',
      maxResults: 5,
    });

    await sourceIndexSearch!.handler(ctx, {
      query: 'Portugal Receipt',
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/Approved',
      include_locators: true,
    });

    expect(calls[1]).toEqual({
      query: 'Portugal Receipt',
      corpusId: 'secure_local.dropbox.files',
      account: 'personal',
      approvedScopeKey: 'dropbox.personal:/Approved',
      includeLocators: true,
    });
    const toolSchema = operationToolSchema(sourceIndexSearch!) as {
      properties: Record<string, { description: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    expect(toolSchema).toMatchObject({
      properties: {
        retrieval_mode: { enum: ['keyword', 'hybrid'] },
        include_locators: { type: 'boolean' },
      },
    });
    const description = operationDescription(sourceIndexSearch!);
    expect(description).toContain('does not currently return direct X URLs');
    expect(description).toContain('Dropbox file locators are opt-in only');
    expect(description).toContain('Folder locators are not supported');
    expect(description).not.toContain('file/folder locators');
    expect(description).not.toContain('paths, folders');
    const locatorDescription = (toolSchema.properties.include_locators as { description: string }).description;
    expect(locatorDescription).toContain('Dropbox files only');
    expect(locatorDescription).toContain('Folder locators are not supported');
    expect(locatorDescription).not.toContain('file/folder');

    await expect(sourceIndexSearch!.handler(ctx, {
      query: 'Portugal Receipt',
      corpus_id: 'secure_local.dropbox.files',
      account: 'dropbox.primary',
    })).rejects.toThrow('Dropbox source account must be omitted or set to personal');
  });

  test('source_index_search preserves typed worker filter errors through the public tool boundary', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search')!;
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: new EmailClient(
        config,
        new DirectHttpEmailTransport(async () => new Response(JSON.stringify({
          error: {
            code: 'unsupported_filter',
            message: 'Filter "include_locators" is not supported for connector-store search of family "chat". Remove it and retry.',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })),
      ),
    };

    try {
      await sourceIndexSearch.handler(ctx, {
        query: 'tool-boundary filter probe',
        corpus_id: 'internal.telegram.messages',
        include_locators: true,
      });
      throw new Error('expected source_index_search to reject the unsupported filter');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'unsupported_filter',
        message: 'Filter "include_locators" is not supported for connector-store search of family "chat". Remove it and retry.',
      });
      expect((error as { toJSON(): unknown }).toJSON()).toEqual({
        error: 'unsupported_filter',
        message: 'Filter "include_locators" is not supported for connector-store search of family "chat". Remove it and retry.',
      });
    }
  });

  test('source_index_search preserves connector-store alias conflicts and trust mismatches through the real tool stack', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search')!;
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-operation-connector-store-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'telegram.sqlite'),
      corpusId: 'internal.telegram.messages',
      family: 'chat',
      trustDomain: 'internal',
    });
    const worker = createEmailSourceWorker({
      connectorStores: [store],
      connectorStoreAccountScopes: new Map([['internal.telegram.messages', 'telegram.personal']]),
      connectorStorePrincipals: new Map([['internal.telegram.messages', {
        provider: 'telegram',
        accountScope: 'telegram.personal',
      }]]),
    });
    const items: RawItem[] = [
      operationSearchItem('message-old', '2026-07-05T10:00:00.000Z'),
      operationSearchItem('message-new', '2026-07-05T12:00:00.000Z'),
    ];
    const connector: SourceConnector = {
      id: 'telegram-operation-search-test',
      family: 'chat',
      async authenticate(): Promise<void> {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items, done: true };
        })();
      },
      async fetchItem(localItemId: string): Promise<RawItem> {
        const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
        if (!item) throw new Error(`missing operation search fixture ${localItemId}`);
        return item;
      },
      classify() {
        return buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' });
      },
    };
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: new EmailClient(
        config,
        new DirectHttpEmailTransport((input, init) => worker.fetch(new Request(input, init))),
      ),
    };

    try {
      await store.syncFromConnector(connector, { fetchContent: true });
      const matchingTrust = await sourceIndexSearch.handler(ctx, {
        query: 'typed tool stack fixture',
        corpus_id: 'internal.telegram.messages',
        trust_domain: 'internal',
      });
      expect(matchingTrust).toMatchObject({
        kind: 'source_index_search',
        corpus_id: 'internal.telegram.messages',
        policy: { trust_domain: 'internal' },
      });
      const omittedTrust = await sourceIndexSearch.handler(ctx, {
        query: 'typed tool stack fixture',
        corpus_id: 'internal.telegram.messages',
      });
      const orderedIds = (result: unknown) => (result as {
        hits: { selected_item: { provider_item_id: string } }[];
      }).hits.map(
        (hit: { selected_item: { provider_item_id: string } }) => hit.selected_item.provider_item_id,
      );
      expect(orderedIds(matchingTrust)).toEqual(orderedIds(omittedTrust));
      expect(orderedIds(matchingTrust)).toEqual(['message-new', 'message-old']);

      for (const trustDomain of [
        'inter\nnal',
        'inter\u2028nal',
        ' internal ',
        '\tinternal',
        'internal\t',
        'internal\n',
      ]) {
        try {
          await sourceIndexSearch.handler(ctx, {
            query: 'typed tool stack fixture',
            corpus_id: 'internal.telegram.messages',
            trust_domain: trustDomain,
          });
          throw new Error('expected source_index_search to reject an inexact trust domain');
        } catch (error) {
          expect(error).toMatchObject({ code: 'invalid_request' });
          expect((error as Error).message).toBe(
            'trust_domain does not exactly match the selected corpus trust domain.',
          );
          expect((error as { toJSON(): unknown }).toJSON()).toEqual({
            error: 'invalid_request',
            message: 'trust_domain does not exactly match the selected corpus trust domain.',
          });
        }
      }

      try {
        await sourceIndexSearch.handler(ctx, {
          query: 'typed tool stack fixture',
          corpus_id: 'internal.telegram.messages',
          after: '2026-07-05T10:00:00Z',
          authored_after: '2026-07-05T10:00:00Z',
          before: '2026-07-05T12:00:00Z',
          authored_before: '2026-07-05T12:00:00Z',
        });
        throw new Error('expected source_index_search to reject all four date fields');
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_request' });
        expect((error as Error).message).toContain('"after"');
        expect((error as Error).message).toContain('"authored_after"');
        expect((error as Error).message).not.toContain('"before"');
        expect((error as Error).message).not.toContain('"authored_before"');
      }

      for (const [canonicalField, aliasField] of [
        ['authored_after', 'after'],
        ['authored_before', 'before'],
      ] as const) {
        const canonical = await sourceIndexSearch.handler(ctx, {
          query: 'typed tool stack fixture',
          corpus_id: 'internal.telegram.messages',
          [canonicalField]: '2026-07-05T10:00:00Z',
        });
        const alias = await sourceIndexSearch.handler(ctx, {
          query: 'typed tool stack fixture',
          corpus_id: 'internal.telegram.messages',
          [aliasField]: '2026-07-05T12:00:00+02:00',
        });
        expect(orderedIds(alias)).toEqual(orderedIds(canonical));
        expect(orderedIds(alias)).toContain('message-old');
      }

      for (const expected of [
        {
          params: {
            after: '2026-07-05T09:00:00Z',
            authored_after: '2026-07-05T09:00:00Z',
          },
          fields: ['"after"', '"authored_after"'],
        },
        {
          params: {
            before: '2026-07-05T09:00:00Z',
            authored_before: '2026-07-05T09:00:00Z',
          },
          fields: ['"before"', '"authored_before"'],
        },
        {
          params: { trust_domain: 'secure_local' },
          fields: ['trust_domain does not exactly match the selected corpus trust domain.'],
        },
        {
          params: {
            chat_scope: 'telegram.personal:chat:chat-one',
            conversation_id: 'chat-two',
          },
          fields: ['chat_scope', 'conversation_id'],
        },
        {
          params: {
            chat_scope: 'Missing Room',
            conversation_id: 'chat-one',
          },
          fields: ['chat_scope', 'conversation_id'],
        },
      ] as const) {
        try {
          await sourceIndexSearch.handler(ctx, {
            query: 'typed tool stack probe',
            corpus_id: 'internal.telegram.messages',
            ...expected.params,
          });
          throw new Error('expected source_index_search to reject the contradictory filters');
        } catch (error) {
          expect(error).toMatchObject({ code: 'invalid_request' });
          for (const field of expected.fields) {
            expect((error as Error).message).toContain(field);
          }
          expect((error as { toJSON(): unknown }).toJSON()).toMatchObject({
            error: 'invalid_request',
          });
        }
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('source_index_search preserves every Dropbox approved-scope typed error through the real tool stack', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search')!;
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-operation-dropbox-scope-errors-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'dropbox.sqlite'),
      corpusId: 'secure_local.dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    const worker = createEmailSourceWorker({
      connectorStores: [store],
      connectorStorePrincipals: new Map([['secure_local.dropbox.files', {
        provider: 'dropbox',
        accountScope: 'personal',
      }]]),
    });
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: new EmailClient(
        config,
        new DirectHttpEmailTransport((input, init) => worker.fetch(new Request(input, init))),
      ),
    };

    try {
      for (const expected of [
        {
          params: { approved_scope_key: 'dropbox.personal:folder_id:id:abc123' },
          messageParts: ['folder_id', 'not persisted'],
        },
        {
          params: { approved_scope_key: ' dropbox.personal:/2 Areas' },
          messageParts: ['approved_scope_key', 'exactly match'],
        },
        {
          params: { approved_scope_key: 'dropbox.personal:/2 Areas', account: 'work' },
          messageParts: ['account', 'approved_scope_key'],
        },
      ] as const) {
        try {
          await sourceIndexSearch.handler(ctx, {
            query: 'Dropbox typed scope error fixture',
            corpus_id: 'secure_local.dropbox.files',
            ...expected.params,
          });
          throw new Error('expected source_index_search to reject the Dropbox approved scope');
        } catch (error) {
          expect(error).toMatchObject({ code: 'invalid_request' });
          for (const part of expected.messageParts) {
            expect((error as Error).message).toContain(part);
          }
          expect((error as { toJSON(): unknown }).toJSON()).toMatchObject({
            error: 'invalid_request',
          });
        }
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('source_index_search releases Dropbox locators through the real operation, client membrane, worker, and connector store', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search')!;
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-operation-dropbox-locator-release-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'dropbox.sqlite'),
      corpusId: 'secure_local.dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    const item: RawItem = {
      identity: {
        family: 'file',
        provider: 'dropbox',
        accountScope: 'personal',
        providerItemId: 'operation-locator-file',
        providerFileId: 'operation-locator-file',
        localItemId: 'personal:operation-locator-file',
        sourceVersion: 'operation-locator-file:v1',
      },
      mimeType: 'text/plain; charset=utf-8',
      content: { kind: 'text', text: 'real locator operation fixture' },
      metadata: {
        title: 'Real Locator.txt',
        locatorUri: '/2 Areas/Real Locator.txt',
        pathDisplay: '/2 Areas/Real Locator.txt',
      },
      fetchedAt: '2026-07-31T10:00:00.000Z',
    };
    const connector: SourceConnector = {
      id: 'operation-dropbox-locator-fixture',
      family: 'file',
      async authenticate(): Promise<void> {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items: [item], done: true };
        })();
      },
      async fetchItem(): Promise<RawItem> {
        return item;
      },
      classify() {
        return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
      },
    };
    const worker = createEmailSourceWorker({
      connectorStores: [store],
      connectorStorePrincipals: new Map([['secure_local.dropbox.files', {
        provider: 'dropbox',
        accountScope: 'personal',
      }]]),
    });
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: new EmailClient(
        config,
        new DirectHttpEmailTransport((input, init) => worker.fetch(new Request(input, init))),
      ),
    };

    try {
      await store.syncFromConnector(connector, { fetchContent: true });
      const released = await sourceIndexSearch.handler(ctx, {
        query: 'real locator operation fixture',
        corpus_id: 'secure_local.dropbox.files',
        account: 'personal',
        approved_scope_key: 'dropbox.personal:/2 Areas',
        include_locators: true,
      }) as Record<string, any>;
      expect(released.hits[0].locator).toEqual({
        display_path: '/2 Areas/Real Locator.txt',
        parent_display_path: '/2 Areas',
        dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Real%20Locator.txt',
        parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
      });
      expect(released.audit.locators_requested).toBe(true);
      expect(released.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
      const serialized = JSON.stringify(released);
      for (const forbidden of [
        'real locator operation fixture',
        'dropbox.personal:/2 Areas',
        'locator_uri',
        'provider_cursor',
        'bounded_text',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }

      for (const includeLocators of [undefined, false]) {
        const withheld = await sourceIndexSearch.handler(ctx, {
          query: 'real locator operation fixture',
          corpus_id: 'secure_local.dropbox.files',
          ...(includeLocators === undefined ? {} : { include_locators: includeLocators }),
        }) as Record<string, any>;
        expect(withheld.hits[0]).not.toHaveProperty('locator');
        expect(withheld.audit).not.toHaveProperty('locators_requested');
        expect(withheld.policy).not.toHaveProperty('locators_exposed');
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('source_index_search rejects sorted unknown tool properties before the real worker stack', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search')!;
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    let workerCalls = 0;
    const worker = createEmailSourceWorker();
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: new EmailClient(
        config,
        new DirectHttpEmailTransport((input, init) => {
          workerCalls += 1;
          return worker.fetch(new Request(input, init));
        }),
      ),
    };

    try {
      try {
        await sourceIndexSearch.handler(ctx, {
          query: 'unknown tool property probe',
          corpus_id: 'internal.email',
          zebra_scope: true,
          mystery_scope: true,
        });
        throw new Error('expected source_index_search to reject unknown tool properties');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'invalid_request',
          message: 'Source-index search request contains undeclared properties: "mystery_scope", "zebra_scope". Remove them and retry.',
        });
      }
      expect(workerCalls).toBe(0);
    } finally {
    }
  });

  test('source_index_search exposes classified internal email without secure-local mail fallback', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_search',
            corpus_id: 'internal.email',
            retrieval_source: 'local_index',
            hits: [],
            audit: {
              request_id: 'request-internal-email',
              retrieval_source: 'local_index',
              queries_attempted: 1,
              metadata_hits: 0,
              items_returned: 0,
              latency_ms: 1,
              raw_source_exposed: false,
              source_text_returned: false,
            },
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              source_packets_exposed: false,
              local_only: false,
              trust_domain: 'internal',
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSearch!.handler(ctx, {
      query: 'school visit',
      corpus_id: 'internal.email',
      account: 'person@example.com',
      max_results: 4,
    });

    expect(result).toMatchObject({
      kind: 'source_index_search',
      corpus_id: 'internal.email',
      policy: { raw_source_exposed: false, trust_domain: 'internal' },
    });
    expect(calls[0]).toEqual({
      query: 'school visit',
      corpusId: 'internal.email',
      account: 'person@example.com',
      maxResults: 4,
    });
    expect(operationToolSchema(sourceIndexSearch!)).toMatchObject({
      properties: {
        corpus_id: { enum: expect.arrayContaining(['internal.email']) },
      },
    });
  });

  test('source_export delegates verified locator export parameters to private source lane', async () => {
    const sourceExport = operations.find((operation) => operation.name === 'source_export');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceExport: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_source_export',
            destination_root: '/Olympus Exports/Otter',
            items_requested: 2,
            items_copied: 2,
            items_skipped_unknown: 0,
            items_skipped_s5: 0,
            items_skipped_existing: 0,
            dry_run: false,
            policy: {
              raw_source_exposed: false,
              content_transited_models: false,
              destination_user_owned: true,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceExport!.handler(ctx, {
      destination_root: '/Olympus Exports/Otter',
      items: JSON.stringify([
        { path: '/2 Areas/Otter/Standup 2026-06-01.txt', dest_subfolder: 'Standups' },
        '/2 Areas/Otter/Retro 2026-06-02.txt',
      ]),
      dry_run: true,
    });

    expect(result).toMatchObject({
      kind: 'dropbox_source_export',
      policy: { raw_source_exposed: false, content_transited_models: false },
    });
    expect(calls[0]).toEqual({
      destinationRoot: '/Olympus Exports/Otter',
      items: [
        { path: '/2 Areas/Otter/Standup 2026-06-01.txt', destSubfolder: 'Standups' },
        { path: '/2 Areas/Otter/Retro 2026-06-02.txt' },
      ],
      dryRun: true,
    });

    expect(operationToolSchema(sourceExport!)).toMatchObject({
      required: ['destination_root', 'items'],
      properties: {
        destination_root: { type: 'string' },
        items: { type: 'string' },
        dry_run: { type: 'boolean' },
      },
    });

    await expect(sourceExport!.handler(ctx, {
      destination_root: '/Olympus Exports/Otter',
      items: '[]',
    })).rejects.toThrow('items must include at least one export item');

    await expect(sourceExport!.handler(ctx, {
      destination_root: '/Olympus Exports/Otter',
      items: '[{"dest_subfolder":"Standups"}]',
    })).rejects.toThrow('items.0.path must be a non-empty string');

    await expect(sourceExport!.handler(ctx, {
      destination_root: '/Olympus Exports/Otter',
      items: '/2 Areas/Otter/Standup 2026-06-01.txt',
      account: 'dropbox.primary',
    })).rejects.toThrow('Dropbox source account must be omitted or set to personal');
  });

  test('source_media_ingest delegates deliberate local media queue parameters', async () => {
    const sourceMediaIngest = operations.find((operation) => operation.name === 'source_media_ingest');
    expect(sourceMediaIngest).toBeDefined();
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceMediaIngest: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_content_extraction_enqueue',
            jobs_queued: 2,
            policy: { raw_source_exposed: false, source_text_returned: false },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceMediaIngest!.handler(ctx, {
      approved_scope_key: 'dropbox.personal:/2 Areas',
      include_path_prefixes: '/2 Areas/Project Photos',
      limit: 20,
      max_bytes_per_file: 25000000,
    });

    expect(result).toMatchObject({ kind: 'dropbox_content_extraction_enqueue' });
    expect(calls[0]).toEqual({
      approvedScopeKey: 'dropbox.personal:/2 Areas',
      includePathPrefixes: ['/2 Areas/Project Photos'],
      limit: 20,
      maxBytesPerFile: 25000000,
    });

    expect(operationToolSchema(sourceMediaIngest!)).toMatchObject({
      required: ['approved_scope_key'],
      properties: {
        approved_scope_key: { type: 'string' },
        items: { type: 'string' },
        include_path_prefixes: { type: 'string' },
        max_bytes_per_file: { type: 'number' },
      },
    });

    await expect(sourceMediaIngest!.handler(ctx, {
      approved_scope_key: 'dropbox.personal:/2 Areas',
    })).rejects.toThrow('source_media_ingest requires items or include_path_prefixes');

    await expect(sourceMediaIngest!.handler(ctx, {
      approved_scope_key: 'dropbox.personal:/2 Areas',
      include_path_prefixes: '/2 Areas/Project Photos',
      account: 'dropbox.primary',
    })).rejects.toThrow('Dropbox source account must be omitted or set to personal');
  });

  test('source_index_search delegates safe X bookmarks search parameters to private source lane', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_search',
            corpus_id: 'internal.x.bookmarks',
            retrieval_source: 'local_index',
            hits: [],
            audit: {
              request_id: 'request-x-1',
              retrieval_source: 'local_index',
              queries_attempted: 1,
              retrieval_mode: 'hybrid',
              metadata_hits: 0,
              items_returned: 0,
              latency_ms: 1,
              raw_source_exposed: false,
              source_text_returned: false,
            },
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              source_packets_exposed: false,
              local_only: true,
              trust_domain: 'internal',
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSearch!.handler(ctx, {
      query: 'pmarca TV show',
      corpus_id: 'internal.x.bookmarks',
      retrieval_mode: 'hybrid',
      account: 'alias-x',
      folder_name: 'Media',
      max_results: 5,
    });

    expect(result).toMatchObject({
      kind: 'source_index_search',
      corpus_id: 'internal.x.bookmarks',
      policy: { trust_domain: 'internal', raw_source_exposed: false },
    });
    expect(calls[0]).toEqual({
      query: 'pmarca TV show',
      corpusId: 'internal.x.bookmarks',
      retrievalMode: 'hybrid',
      account: 'alias-x',
      folderName: 'Media',
      maxResults: 5,
    });
    expect(operationToolSchema(sourceIndexSearch!)).toMatchObject({
      properties: {
        corpus_id: { enum: expect.arrayContaining(['internal.x.bookmarks']) },
        folder_name: { type: 'string' },
      },
    });
  });

  test('source_index_promotion_candidates delegates safe Dropbox review parameters', async () => {
    const promotionCandidates = operations.find((operation) => operation.name === 'source_index_promotion_candidates');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexPromotionCandidates: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_content_promotion_candidates',
            corpus_id: 'secure_local.dropbox.files',
            provider: 'dropbox',
            account: 'personal',
            scope_key_hash: 'scope-hash',
            candidates: [{
              classification_id: '1',
              target_kind: 'chunk',
              source_content_hash: 'content-hash',
              scope_key_hash: 'scope-hash',
              provider_file_id_hash: 'file-hash',
              trust_tier: 'S4',
              trust_domain: 'secure_local',
              policy_decision: 'needs_review',
              review_status: 'needs_review',
              finding_count: 1,
            }],
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              local_only: true,
              trust_domain: 'secure_local',
              promotion_write_performed: false,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await promotionCandidates!.handler(ctx, {
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/Approved',
      max_results: 5,
    });

    expect(result).toMatchObject({
      kind: 'dropbox_content_promotion_candidates',
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        promotion_write_performed: false,
      },
    });
    expect(calls[0]).toEqual({
      corpusId: 'secure_local.dropbox.files',
      account: 'personal',
      approvedScopeKey: 'dropbox.personal:/Approved',
      maxResults: 5,
    });
    expect(operationToolSchema(promotionCandidates!)).toMatchObject({
      required: ['approved_scope_key'],
      properties: {
        corpus_id: { enum: ['secure_local.dropbox.files'] },
      },
    });
  });

  test('source_index_promotion_propose delegates typed Dropbox review proposals', async () => {
    const promotionPropose = operations.find((operation) => operation.name === 'source_index_promotion_propose');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexPromotionProposal: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_content_promotion_proposal',
            corpus_id: 'secure_local.dropbox.files',
            provider: 'dropbox',
            account: 'personal',
            scope_key_hash: 'scope-hash',
            proposal_id: 'dropbox-promotion-proposal-1',
            proposal_revision_id: 'dropbox-promotion-revision-1',
            status: 'proposed',
            canonical_type: 'project_work_item',
            target_surface: 'review_queue',
            reason_code: 'project_material',
            evidence_count: 2,
            trust_domain: 'secure_local',
            trust_tiers: ['S4'],
            policy_decisions: ['needs_review'],
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              local_only: true,
              trust_domain: 'secure_local',
              resource_write_performed: false,
              proposal_only: true,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await promotionPropose!.handler(ctx, {
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/Approved',
      classification_ids: '1,2',
      canonical_type: 'project_work_item',
      target_surface: 'review_queue',
      reason_code: 'project_material',
      proposed_by: 'castor',
    });

    expect(result).toMatchObject({
      kind: 'dropbox_content_promotion_proposal',
      evidence_count: 2,
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        resource_write_performed: false,
        proposal_only: true,
      },
    });
    expect(calls[0]).toEqual({
      account: 'personal',
      approvedScopeKey: 'dropbox.personal:/Approved',
      classificationIds: ['1', '2'],
      canonicalType: 'project_work_item',
      targetSurface: 'review_queue',
      reasonCode: 'project_material',
      proposedBy: 'castor',
    });
    expect(operationToolSchema(promotionPropose!)).toMatchObject({
      required: ['approved_scope_key', 'classification_ids', 'canonical_type', 'target_surface', 'reason_code'],
      properties: {
        canonical_type: { enum: expect.arrayContaining(['project_work_item', 'resource_wiki_page']) },
        target_surface: { enum: expect.arrayContaining(['review_queue', 'resource_wiki']) },
      },
    });
  });

  test('source_index_promotion_proposals lists safe Dropbox review queue metadata', async () => {
    const promotionProposals = operations.find((operation) => operation.name === 'source_index_promotion_proposals');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexPromotionProposals: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_content_promotion_proposals',
            corpus_id: 'secure_local.dropbox.files',
            provider: 'dropbox',
            proposals: [{
              proposal_id: 'dropbox-promotion-proposal-1',
              proposal_revision_id: 'dropbox-promotion-revision-1',
              account: 'personal',
              scope_key_hash: 'scope-hash',
              canonical_type: 'project_work_item',
              target_surface: 'review_queue',
              reason_code: 'project_material',
              status: 'approved',
              evidence_count: 2,
              decision_count: 1,
              resource_write_performed: false,
              created_at: '2026-05-22T00:00:00.000Z',
              updated_at: '2026-05-22T00:01:00.000Z',
            }],
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              local_only: true,
              trust_domain: 'secure_local',
              resource_write_performed: false,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await promotionProposals!.handler(ctx, {
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/Approved',
      status: 'approved',
      max_results: 5,
    });

    expect(result).toMatchObject({
      kind: 'dropbox_content_promotion_proposals',
      proposals: [{
        status: 'approved',
        decision_count: 1,
        resource_write_performed: false,
      }],
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        resource_write_performed: false,
      },
    });
    expect(calls[0]).toEqual({
      account: 'personal',
      approvedScopeKey: 'dropbox.personal:/Approved',
      status: 'approved',
      maxResults: 5,
    });
    expect(operationToolSchema(promotionProposals!)).toMatchObject({
      properties: {
        status: { enum: ['proposed', 'approved', 'rejected', 'deferred', 'needs_changes'] },
      },
    });
  });

  test('source_index_promotion_proposal reads safe Dropbox review detail metadata', async () => {
    const promotionProposal = operations.find((operation) => operation.name === 'source_index_promotion_proposal');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexPromotionProposalDetail: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_content_promotion_proposal_detail',
            corpus_id: 'secure_local.dropbox.files',
            provider: 'dropbox',
            proposal: {
              proposal_id: 'dropbox-promotion-proposal-1',
              proposal_revision_id: 'dropbox-promotion-revision-1',
              account: 'personal',
              scope_key_hash: 'scope-hash',
              canonical_type: 'project_work_item',
              target_surface: 'review_queue',
              reason_code: 'project_material',
              status: 'approved',
              evidence_count: 1,
              decision_count: 1,
              resource_write_performed: false,
              created_at: '2026-05-22T00:00:00.000Z',
              updated_at: '2026-05-22T00:01:00.000Z',
            },
            evidence: [{
              classification_id: '1',
              evidence_ordinal: 0,
              target_kind: 'chunk',
              source_content_hash: 'content-hash',
              provider_file_id_hash: 'file-hash',
              trust_tier: 'S4',
              trust_domain: 'secure_local',
              policy_decision: 'needs_review',
              review_status_at_proposal: 'needs_review',
              finding_count: 1,
            }],
            decisions: [{
              decision_id: 'dropbox-promotion-decision-1',
              decision: 'approved',
              reason_code: 'manual_review',
              decided_at: '2026-05-22T00:01:00.000Z',
              resource_write_performed: false,
              execution_performed: false,
            }],
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              local_only: true,
              trust_domain: 'secure_local',
              resource_write_performed: false,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await promotionProposal!.handler(ctx, {
      proposal_id: 'dropbox-promotion-proposal-1',
    });

    expect(result).toMatchObject({
      kind: 'dropbox_content_promotion_proposal_detail',
      proposal: {
        status: 'approved',
        resource_write_performed: false,
      },
      evidence: [{
        classification_id: '1',
        provider_file_id_hash: 'file-hash',
      }],
      decisions: [{
        decision: 'approved',
        execution_performed: false,
      }],
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        resource_write_performed: false,
      },
    });
    expect(calls[0]).toEqual({
      proposalId: 'dropbox-promotion-proposal-1',
    });
    expect(operationToolSchema(promotionProposal!)).toMatchObject({
      required: ['proposal_id'],
    });
  });

  test('source_index_promotion_decide records review decisions without executing writes', async () => {
    const promotionDecide = operations.find((operation) => operation.name === 'source_index_promotion_decide');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexPromotionDecision: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'dropbox_content_promotion_decision',
            corpus_id: 'secure_local.dropbox.files',
            provider: 'dropbox',
            proposal_id: 'dropbox-promotion-proposal-1',
            decision_id: 'dropbox-promotion-decision-1',
            decision: 'approved',
            status: 'approved',
            evidence_count: 2,
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              local_only: true,
              trust_domain: 'secure_local',
              resource_write_performed: false,
              execution_performed: false,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await promotionDecide!.handler(ctx, {
      proposal_id: 'dropbox-promotion-proposal-1',
      decision: 'approved',
      decided_by: 'owner',
      reason_code: 'manual_review',
    });

    expect(result).toMatchObject({
      kind: 'dropbox_content_promotion_decision',
      decision: 'approved',
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        resource_write_performed: false,
        execution_performed: false,
      },
    });
    expect(calls[0]).toEqual({
      proposalId: 'dropbox-promotion-proposal-1',
      decision: 'approved',
      decidedBy: 'owner',
      reasonCode: 'manual_review',
    });
    expect(operationToolSchema(promotionDecide!)).toMatchObject({
      required: ['proposal_id', 'decision'],
      properties: {
        decision: { enum: ['approved', 'rejected', 'deferred', 'needs_changes'] },
      },
    });
  });

  test('source_index_search delegates safe Telegram search parameters to private source lane', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_search',
            corpus_id: 'secure_local.telegram.protected.messages',
            retrieval_source: 'local_index',
            hits: [],
            audit: {
              request_id: 'request-1',
              retrieval_source: 'local_index',
              queries_attempted: 1,
              metadata_hits: 0,
              items_returned: 0,
              latency_ms: 1,
              raw_source_exposed: false,
              source_text_returned: false,
            },
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              source_packets_exposed: false,
              local_only: true,
              trust_domain: 'secure_local',
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSearch!.handler(ctx, {
      query: 'surface',
      corpus_id: 'secure_local.telegram.messages',
      account: 'telegram.personal',
      chat_scope: 'telegram.personal:chat:chat-porto',
      trust_domain: 'secure_local',
      participant_id: 'user-1',
      include_deleted: false,
      attachment_type: 'file',
      max_results: 5,
    });

    expect(result).toMatchObject({
      kind: 'source_index_search',
      policy: { raw_source_exposed: false, source_text_returned: false },
    });
    expect(calls[0]).toEqual({
      query: 'surface',
      corpusId: 'secure_local.telegram.protected.messages',
      account: 'telegram.personal',
      chatScope: 'telegram.personal:chat:chat-porto',
      trustDomain: 'secure_local',
      participantId: 'user-1',
      includeDeleted: false,
      attachmentType: 'file',
      maxResults: 5,
    });
  });

  test('source_index_search accepts protected Telegram corpus parameters', async () => {
    const sourceIndexSearch = operations.find((operation) => operation.name === 'source_index_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_search',
            corpus_id: 'secure_local.telegram.protected.messages',
            retrieval_source: 'local_index',
            hits: [],
            audit: {
              request_id: 'request-1',
              retrieval_source: 'local_index',
              queries_attempted: 1,
              metadata_hits: 0,
              items_returned: 0,
              latency_ms: 1,
              raw_source_exposed: false,
              source_text_returned: false,
            },
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              source_packets_exposed: false,
              local_only: true,
              trust_domain: 'secure_local',
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await sourceIndexSearch!.handler(ctx, {
      query: 'accountant',
      corpus_id: 'secure_local.telegram.protected.messages',
      account: 'telegram.personal',
      chat_scope: 'telegram.personal:chat:accountant',
      trust_domain: 'secure_local',
      max_results: 3,
    });

    expect(result).toMatchObject({
      kind: 'source_index_search',
      corpus_id: 'secure_local.telegram.protected.messages',
      policy: { raw_source_exposed: false, source_text_returned: false },
    });
    expect(calls[0]).toEqual({
      query: 'accountant',
      corpusId: 'secure_local.telegram.protected.messages',
      account: 'telegram.personal',
      chatScope: 'telegram.personal:chat:accountant',
      trustDomain: 'secure_local',
      maxResults: 3,
    });
  });

  test('xanthos_file_deliver delegates only bounded delivery parameters', async () => {
    const fileDeliver = operations.find((operation) => operation.name === 'xanthos_file_deliver');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {} as OperationContext['email'],
      fileDelivery: {
        deliver: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'file_delivery_result',
            delivery_id: 'delivery-1',
            root_id: 'olympus_smoke',
            relative_path: 'notes/test.md',
            bytes_written: 11,
            content_sha256: 'hash-1',
            write_mode: 'create_new',
            created_at: '2026-05-20T12:00:00.000Z',
            approval_status: 'not_required',
            audit_ref: 'file_delivery:delivery-1',
            policy: {
              bounded_file_delivery: true,
              shell_used: false,
              absolute_path_exposed: false,
            },
          };
        },
      } as unknown as NonNullable<OperationContext['fileDelivery']>,
    };

    const result = await fileDeliver!.handler(ctx, {
      root_id: 'olympus_smoke',
      relative_path: 'notes/test.md',
      content: 'hello world',
      content_encoding: 'utf8',
      write_mode: 'create_new',
      trust_domain: 'internal',
      source_provenance: 'Owner request',
      idempotency_key: 'request-1',
      actor_id: 'castor',
      session_id: 'session-1',
      model_provider: 'olympus-local',
      model_id: 'qwen-local',
    });

    expect(result).toMatchObject({
      kind: 'file_delivery_result',
      root_id: 'olympus_smoke',
      policy: { shell_used: false, absolute_path_exposed: false },
    });
    expect(calls[0]).toEqual({
      rootId: 'olympus_smoke',
      relativePath: 'notes/test.md',
      content: 'hello world',
      contentEncoding: 'utf8',
      writeMode: 'create_new',
      trustDomain: 'internal',
      sourceProvenance: 'Owner request',
      idempotencyKey: 'request-1',
      actorId: 'castor',
      sessionId: 'session-1',
      modelProvider: 'olympus-local',
      modelId: 'qwen-local',
    });
    expect(operationToolSchema(fileDeliver!)).toMatchObject({
      required: ['root_id', 'relative_path', 'content', 'write_mode', 'trust_domain', 'idempotency_key'],
      properties: {
        write_mode: { enum: ['dry_run', 'create_new', 'overwrite_with_approval'] },
        trust_domain: { enum: ['public_safe', 'internal', 'secure_local'] },
      },
    });
  });

  test('castor_workspace delegates bounded workspace parameters', async () => {
    const workspace = operations.find((operation) => operation.name === 'castor_workspace');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {} as OperationContext['email'],
      castorWorkspace: {
        run: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'castor_workspace_export_gcs',
            root_id: 'castor_workspace',
            relative_path: 'trading-books',
            destination_uri: 'gs://fixture-trading-books-rag/trading-books',
            dry_run: true,
            files: 10,
            directories: 2,
            bytes: 1234,
            policy: {
              castor_workspace_delegated: true,
              shell_exposed_to_agent: false,
              absolute_path_exposed: false,
            },
          };
        },
      } as unknown as NonNullable<OperationContext['castorWorkspace']>,
    };

    const result = await workspace!.handler(ctx, {
      action: 'export_gcs',
      root_id: 'castor_workspace',
      relative_path: 'trading-books',
      destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      dry_run: true,
      include_media: true,
      recursive: true,
      idempotency_key: 'export-1',
      actor_id: 'castor',
      session_id: 'session-1',
    });

    expect(result).toMatchObject({
      kind: 'castor_workspace_export_gcs',
      policy: { castor_workspace_delegated: true, shell_exposed_to_agent: false },
    });
    expect(calls[0]).toEqual({
      action: 'export_gcs',
      rootId: 'castor_workspace',
      relativePath: 'trading-books',
      destinationUri: 'gs://fixture-trading-books-rag/trading-books',
      recursive: true,
      dryRun: true,
      includeMedia: true,
      idempotencyKey: 'export-1',
      actorId: 'castor',
      sessionId: 'session-1',
    });
    expect(operationToolSchema(workspace!)).toMatchObject({
      required: ['action'],
      properties: {
        action: { enum: ['health', 'list', 'read', 'write', 'delete', 'export_gcs'] },
        root_id: { type: 'string' },
        destination_uri: { type: 'string' },
        include_media: { type: 'boolean' },
      },
    });

    await expect(workspace!.handler({
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {} as OperationContext['email'],
    }, {
      action: 'list',
      root_id: 'castor_workspace',
    })).rejects.toThrow('Delegated workspace client is not configured');
  });

  test('domain expert backend planners remain reusable and enforce policy', async () => {
    const domainDoc = operations.find((operation) => operation.name === 'domain_doc');

    const bootstrap = planDomainAgent({
      action: 'bootstrap',
      domainId: 'governance',
    }) as Record<string, any>;

    expect(bootstrap).toMatchObject({
      kind: 'domain_agent_plan',
      status: 'dry_run_scaffold_ready',
      domain: {
        domain_id: 'governance',
        display_name: 'Solon',
        workspace_relative_path: 'castor-solon',
        gcp_project: 'olympus-fixture-project',
      },
      openclaw_agent: {
        agent_id: 'solon',
        display_name: 'Solon',
        created_by_skill: 'agent-workshop',
        operating_skill: 'governance-research',
      },
    });
    expect(bootstrap.openclaw_agent.scoped_tools).not.toContain('domain_agent');
    expect(bootstrap.domain.corpora).toEqual([{
      id: 'governance-jamie-docs',
      description: "Single Solon governance corpus for the owner's governance writing, essays by Vitalik and other authors, and governance books; author attribution lives on source records and display names.",
    }]);
    expect(bootstrap.workspace_scaffold.files.map((file: { relative_path: string }) => file.relative_path)).toContain(
      'castor-solon/domain.manifest.json',
    );

    const datingBootstrap = planDomainAgent({
      action: 'bootstrap',
      domainId: 'dating',
      displayName: 'Ariadne',
    }) as Record<string, any>;
    expect(datingBootstrap).toMatchObject({
      openclaw_agent: {
        agent_id: 'dating',
        display_name: 'Ariadne',
        created_by_skill: 'agent-workshop',
        operating_skill: 'dating-research',
      },
    });

    const answerPlan = planDomainAsk({
      domainId: 'governance',
      question: 'Where does my governance writing leave open questions?',
    }) as Record<string, any>;
    expect(answerPlan).toMatchObject({
      kind: 'domain_ask_plan',
      status: 'requires_gemini_enterprise_rag_backend',
      retrieval: {
        backend: 'gemini_enterprise_rag_engine',
        cross_corpus_retrieval: true,
      },
      policy: {
        source_pipeline_contracts_unchanged: true,
        per_question_answer_logic_in_olympus: false,
      },
    });
    expect(answerPlan.retrieval.corpora).toEqual(['governance-jamie-docs']);

    const sourcePlan = planDomainSource({
      action: 'add',
      domainId: 'governance',
      sourceKind: 'blog_post',
      title: 'Vitalik governance essay',
      url: 'https://vitalik.eth.limo/general/governance-example',
      copyrightPosture: 'public web essay, cite and refresh',
    }) as Record<string, any>;
    expect(sourcePlan).toMatchObject({
      kind: 'domain_source_plan',
      source_record: {
        domain_id: 'governance',
        kind: 'blog_post',
        ingest_status: 'planned',
      },
    });
    expect(sourcePlan.ingest_pipeline).toContain('import into the selected Gemini Enterprise corpus');

    const corpusPlan = planRagCorpus({
      action: 'web_import',
      domainId: 'governance',
      corpusId: 'governance-jamie-docs',
      urls: ['https://www.youtube.com/watch?v=abc123'],
      transcriptMode: 'asr',
    }) as Record<string, any>;
    expect(corpusPlan).toMatchObject({
      kind: 'rag_corpus_plan',
      corpus: {
        corpus_id: 'governance-jamie-docs',
        web_import: {
          urls: ['https://www.youtube.com/watch?v=abc123'],
          transcript_mode: 'asr',
        },
      },
    });
    const notionCorpusPlan = planRagCorpus({
      action: 'notion_import',
      domainId: 'governance',
      corpusId: 'governance-jamie-docs',
      urls: ['https://notion.site/Solon-11111111111111111111111111111111'],
      pageIds: ['22222222222222222222222222222222'],
      databaseIds: ['33333333333333333333333333333333'],
      batchId: 'notion-batch',
    }) as Record<string, any>;
    expect(notionCorpusPlan).toMatchObject({
      kind: 'rag_corpus_plan',
      corpus: {
        corpus_id: 'governance-jamie-docs',
        notion_import: {
          urls: ['https://notion.site/Solon-11111111111111111111111111111111'],
          page_ids: ['22222222222222222222222222222222'],
          database_ids: ['33333333333333333333333333333333'],
          workspace_relative_path: 'castor-solon/sources/notion-imports/notion-batch',
          target_corpus_id: 'governance-jamie-docs',
        },
      },
    });
    const listFilesPlan = planRagCorpus({
      action: 'list_files',
      domainId: 'governance',
      corpusId: 'governance-jamie-docs',
      pageToken: 'next-page',
    }) as Record<string, any>;
    expect(listFilesPlan).toMatchObject({
      kind: 'rag_corpus_plan',
      action: 'list_files',
      corpus: {
        corpus_id: 'governance-jamie-docs',
        page_token: 'next-page',
      },
    });
    const deleteFilePlan = planRagCorpus({
      action: 'delete_file',
      domainId: 'governance',
      corpusId: 'governance-jamie-docs',
      ragFileName: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777/ragFiles/file-1',
    }) as Record<string, any>;
    expect(deleteFilePlan).toMatchObject({
      kind: 'rag_corpus_plan',
      action: 'delete_file',
      corpus: {
        corpus_id: 'governance-jamie-docs',
        rag_file_name: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777/ragFiles/file-1',
      },
    });
    expect(() => planRagCorpus({
      action: 'import',
      domainId: 'governance',
      gcsUri: 'gs://other-bucket/batch-1',
    })).toThrow('domain allowlisted prefixes');

    const docPlan = planDomainDoc({
      action: 'visual_insert',
      domainId: 'governance',
      documentId: 'doc-123',
      text: 'A visible proposed addition.',
    }) as Record<string, any>;
    expect(docPlan).toMatchObject({
      kind: 'domain_doc_plan',
      google_docs_posture: {
        native_suggestion_mode_created_by_api: false,
        direct_visual_edits_require_approval: true,
      },
      visual_review_style: {
        prefix_marker: '[Solon]',
      },
    });
    expect(() => planDomainDoc({
      action: 'visual_insert',
      domainId: 'governance',
      documentId: 'doc-123',
      text: 'Live edit.',
      dryRun: false,
    })).toThrow('requires approval_id');

    const importPlan = planAnnasArchiveImport({
      domainId: 'governance',
      annasArchiveId: 'md5:abc123',
      format: 'epub',
      copyrightPosture: 'operator-approved private research library import',
    }) as Record<string, any>;
    expect(importPlan).toMatchObject({
      kind: 'annas_archive_import_plan',
      status: 'dry_run_acquisition_ready',
      acquisition: {
        format: 'epub',
        destination: 'xanthos_books_folder',
      },
      rag_ingest: { status: 'not_requested' },
    });
    expect(() => planAnnasArchiveImport({
      domainId: 'governance',
      annasArchiveId: 'md5:abc123',
      copyrightPosture: 'operator-approved private research library import',
      dryRun: false,
    })).toThrow('requires approval_id');

    expect(operationToolSchema(domainDoc!)).toMatchObject({
      required: ['action', 'document_id'],
      properties: {
        action: { enum: ['read', 'comment', 'visual_insert', 'visual_replace', 'accept_visual_edits', 'reject_visual_edits'] },
      },
    });
  });

  test('email_index_sync delegates bounded admin parameters to private email lane', async () => {
    const emailIndexSync = operations.find((operation) => operation.name === 'email_index_sync');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        indexSync: async (options: unknown) => {
          calls.push(options);
          return {
            sync_run_id: 'sync-1',
            status: 'completed',
            provider: 'gmail',
            account: 'person@example.com',
            source_scope: 'newer_than_days:7;max:5',
            items_seen: 1,
            items_indexed: 1,
            threads_indexed: 1,
            checkpoint_recorded: true,
            store_path: '/tmp/email.sqlite',
            gaps: [],
            policy: { raw_email_exposed: false, local_only: true },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await emailIndexSync!.handler(ctx, {
      account: 'person@example.com',
      newer_than_days: 7,
      max_messages: 5,
      query: 'newer_than:7d',
    });

    expect(result).toMatchObject({ provider: 'gmail', items_indexed: 1 });
    expect(calls[0]).toEqual({
      account: 'person@example.com',
      newerThanDays: 7,
      maxMessages: 5,
      query: 'newer_than:7d',
    });
  });

  test('email_index_embed delegates bounded admin parameters to private email lane', async () => {
    const emailIndexEmbed = operations.find((operation) => operation.name === 'email_index_embed');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        indexEmbed: async (options: unknown) => {
          calls.push(options);
          return {
            semantic_run_id: 'semantic-run-1',
            status: 'completed',
            provider: 'gmail',
            account: 'person@example.com',
            model_id: 'local-embedding-model',
            embedding_provider: 'local-openai-compatible',
            embedding_dimension: 32,
            vector_backend: 'exact_scan',
            chunks_seen: 1,
            chunks_embedded: 1,
            chunks_skipped: 0,
            store_path: '/tmp/email.sqlite',
            policy: {
              raw_email_exposed: false,
              local_only: true,
              cloud_embedding_eligible: false,
              derived_private_data: true,
            },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await emailIndexEmbed!.handler(ctx, {
      account: 'person@example.com',
      model_id: 'local-embedding-model',
      force: true,
    });

    expect(result).toMatchObject({ provider: 'gmail', chunks_embedded: 1 });
    expect(calls[0]).toEqual({
      account: 'person@example.com',
      modelId: 'local-embedding-model',
      force: true,
    });
  });

  test('email_index_search delegates local index packet parameters to private email lane', async () => {
    const emailIndexSearch = operations.find((operation) => operation.name === 'email_index_search');
    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        indexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            packet: {
              kind: 'email_source_packet',
              packet_id: 'packet-1',
              source: 'gmail',
              items: [],
            },
            audit: {
              request_id: 'request-1',
              retrieval_source: 'local_index',
              queries_attempted: 1,
              retrieval_mode: 'hybrid',
              keyword_candidates: 1,
              vector_candidates: 1,
              fused_candidates: 1,
              metadata_hits: 0,
              items_returned: 0,
              threads_returned: 0,
              latency_ms: 1,
              sanitized_reads_attempted: 0,
              sanitized_reads_succeeded: 0,
              truncated: false,
              local_packet: true,
              raw_email_exposed: false,
            },
            policy: { raw_email_exposed: false, local_only: true, requires_local_session: true },
          };
        },
      } as unknown as OperationContext['email'],
    };

    const result = await emailIndexSearch!.handler(ctx, {
      query: 'school visit',
      retrieval_mode: 'hybrid',
      account: 'person@example.com',
      from: 'admissions@example.com',
      label: 'INBOX',
      max_messages: 5,
    });

    expect(result).toMatchObject({
      audit: { retrieval_source: 'local_index' },
      policy: { raw_email_exposed: false, local_only: true },
    });
    expect(calls[0]).toEqual({
      query: 'school visit',
      retrievalMode: 'hybrid',
      account: 'person@example.com',
      from: 'admissions@example.com',
      label: 'INBOX',
      maxMessages: 5,
    });
  });
});

function operationSearchItem(id: string, authoredAt: string): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: 'telegram',
      accountScope: 'telegram.personal',
      providerItemId: id,
      providerConversationId: 'chat-operation-test',
      localItemId: `telegram.personal:${id}`,
      sourceVersion: `${id}:v1`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: 'Typed tool stack fixture.' },
    metadata: Object.freeze({
      title: 'Operation test chat',
      authoredAt,
      updatedAt: authoredAt,
    }),
    fetchedAt: '2026-07-05T12:00:01.000Z',
  };
}
