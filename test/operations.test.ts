import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { operations, operationDescription, operationToolSchema } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

describe('operations', () => {
  test('defines the current operation surface', () => {
    expect(operations.map((operation) => operation.name)).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'source_answer',
      'source_index_status',
      'source_index_search',
      'source_watch_create',
      'source_watches',
      'source_watch_cancel',
      'olympus_doctor',
    ]);
    expect(operations.find((operation) => operation.name === 'olympus_doctor')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'olympus_doctor')?.nativeExposure).toBe('always');
    expect(operations.find((operation) => operation.name === 'source_index_status')?.mutating).toBe(false);
    expect(operations.find((operation) => operation.name === 'source_answer')?.nativeExposure).toBe('sourceIndexEnabledOnly');
    expect(operations.find((operation) => operation.name === 'source_index_status')?.nativeExposure).toBe('sourceIndexEnabledOnly');
    expect(operations.find((operation) => operation.name === 'source_index_search')?.nativeExposure).toBe('sourceIndexEnabledOnly');
    expect(operations.filter((operation) => operation.requiresOpenClawSessionRoute).map((operation) => operation.name))
      .toEqual(['source_watch_create', 'source_watches', 'source_watch_cancel']);
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
    // Both worker-facing lanes deliberately off, so this asserts the walk's
    // shape without reaching a worker over the network. The email lane is on by
    // default now: an install whose worker is not running is a red doctor, and
    // that behaviour is covered in doctor.test.ts.
    config.email.enabled = false;
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
