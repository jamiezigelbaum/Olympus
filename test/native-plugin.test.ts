import { afterEach, describe, expect, test } from 'bun:test';
import plugin, {
  handleSourceWatchDeliveryGatewayRequest,
  sendOpenClawSourceWatchDelivery,
  sourceWatchRouteFromToolContext,
} from '../src/native-plugin.ts';
import manifest from '../openclaw.plugin.json';
import pkg from '../package.json';
import {
  V0_4_PUBLIC_NATIVE_TOOLS,
  V0_4_PUBLIC_SOURCE_IDS,
} from '../src/core/public-surface.ts';

const originalFetch = globalThis.fetch;

interface NativeTool {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

function materializeTool(tool: NativeTool): NativeTool {
  if (typeof tool !== 'function') return tool;
  return (tool as unknown as (context: Record<string, unknown>) => NativeTool)({
    agentId: 'castor',
    sessionId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
    requesterSenderId: 'owner-1',
    senderIsOwner: true,
    deliveryContext: { channel: 'telegram', to: '123456789', accountId: 'castor' },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected schema object.');
  }
  return value as Record<string, unknown>;
}

function configSchemaProperties(path: readonly string[] = []): Record<string, unknown> {
  let node = asRecord(manifest.configSchema);
  for (const segment of path) {
    const properties = asRecord(node.properties);
    node = asRecord(properties[segment]);
  }
  return asRecord(node.properties);
}

function registeredToolNames(pluginConfig: unknown, apiExtra: Record<string, unknown> = {}): string[] {
  const names: string[] = [];
  plugin.register({
    ...apiExtra,
    pluginConfig,
    registerTool(tool: NativeTool) {
      names.push(materializeTool(tool).name);
    },
  });
  return names;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('native OpenClaw plugin adapter', () => {
  test('derives watch ownership only from authenticated caller context', () => {
    const first = sourceWatchRouteFromToolContext({
      agentId: 'castor', requesterSenderId: 'owner-1', senderIsOwner: true,
      deliveryContext: { channel: 'telegram', to: '12345' },
    });
    const second = sourceWatchRouteFromToolContext({
      agentId: 'castor', requesterSenderId: 'owner-2', senderIsOwner: true,
      deliveryContext: { channel: 'telegram', to: '67890' },
    });
    expect(first).toMatchObject({ routeKind: 'openclaw_channel', routeTargetId: 'telegram:12345' });
    expect(first?.ownerId).not.toBe(second?.ownerId);
    expect(sourceWatchRouteFromToolContext({
      requesterSenderId: 'owner-1', senderIsOwner: false,
      deliveryContext: { channel: 'telegram', to: '12345' },
    })).toBeUndefined();
  });

  test('binds watch delivery to the durable SDK with an evidence-pointer-only Telegram payload', async () => {
    const calls: Record<string, unknown>[] = [];
    const idempotencyKey = 'a'.repeat(64);
    const result = await sendOpenClawSourceWatchDelivery({
      openClawConfig: { gateway: { port: 18789 } },
      route: { kind: 'openclaw_channel', targetId: 'telegram:12345', accountId: 'castor' },
      downstreamIdempotencyKey: idempotencyKey,
      payload: {
        headline: 'Olympus watch matched newly indexed evidence.',
        watch_id: 'watch-native',
        corpus_id: 'internal.telegram.messages',
        query_text: 'pineapple',
        watch_mode: 'one_shot',
        match_count: 1,
        items: [{
          local_item_id: 'message-1',
          source_version: '2026-07-22T09:50:00.000Z',
          matched_at: '2026-07-22T10:00:00.000Z',
        }],
      },
      sendDurableMessageBatch: async (params) => {
        calls.push(params);
        return {
          status: 'sent',
          receipt: { platformMessageIds: ['telegram-platform-1'], sentAt: 1_753_178_400_000 },
        };
      },
    });

    expect(calls).toEqual([expect.objectContaining({
      cfg: { gateway: { port: 18789 } },
      channel: 'telegram',
      to: '12345',
      accountId: 'castor',
      durability: 'required',
      bestEffort: false,
      payloads: [{
        text: [
          'Olympus: your watch for "pineapple" matched 1 newly indexed item in internal.telegram.messages.',
          'Item authored 2026-07-22 09:50 UTC; indexed and matched 2026-07-22 10:00 UTC.',
          'This was a one-shot watch — it is now complete.',
          'ref: watch watch-na · item message-1',
        ].join('\n'),
      }],
    })]);
    expect(JSON.stringify(calls[0])).not.toContain(idempotencyKey);
    expect(result).toEqual({
      status: 'sent',
      downstream_idempotency_key: idempotencyKey,
      downstream_idempotency: 'unsupported_by_openclaw_sdk',
      receipt: {
        platform_message_ids: ['telegram-platform-1'],
        sent_at_ms: 1_753_178_400_000,
      },
    });
  });

  test('protects the worker-to-gateway delivery route with shared bearer auth and strict targets', async () => {
    let sends = 0;
    const body = JSON.stringify({
      route: {
        ownerId: 'owner:hash',
        kind: 'openclaw_channel',
        targetId: 'telegram:12345',
        accountId: 'castor',
      },
      downstream_idempotency_key: 'b'.repeat(64),
      payload: {
        headline: 'Olympus watch matched newly indexed evidence.',
        watch_id: 'watch-route',
        corpus_id: 'internal.telegram.messages',
        query_text: 'pineapple',
        watch_mode: 'continuous',
        match_count: 1,
        items: [{
          local_item_id: 'message-1',
          source_version: '2026-07-22T09:50:00.000Z',
          matched_at: '2026-07-22T10:00:00.000Z',
        }],
      },
    });
    const sendDurableMessageBatch = async () => {
      sends += 1;
      return { status: 'sent' as const, receipt: { platformMessageIds: ['message-1'] } };
    };

    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer wrong', body,
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 401, body: { error_kind: 'unauthorized' } });
    expect(sends).toBe(0);

    const invalidTarget = JSON.parse(body) as { route: { targetId: string } };
    invalidTarget.route.targetId = 'email:12345';
    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body: JSON.stringify(invalidTarget),
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 400, body: { error_kind: 'invalid_request' } });
    expect(sends).toBe(0);

    const unknownPayloadField = JSON.parse(body) as { payload: Record<string, unknown> };
    unknownPayloadField.payload.source_text = 'must stay out';
    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body: JSON.stringify(unknownPayloadField),
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 400, body: { error_kind: 'invalid_request' } });
    expect(sends).toBe(0);

    const overLengthQuery = JSON.parse(body) as { payload: { query_text: string } };
    overLengthQuery.payload.query_text = 'x'.repeat(4_097);
    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body: JSON.stringify(overLengthQuery),
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 400, body: { error_kind: 'invalid_request' } });
    expect(sends).toBe(0);

    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body,
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({
      status: 200,
      body: {
        status: 'sent',
        downstream_idempotency: 'unsupported_by_openclaw_sdk',
        receipt: { platform_message_ids: ['message-1'] },
      },
    });
    expect(sends).toBe(1);
  });

  test('registers the native durable delivery route when hosted by OpenClaw', () => {
    const routes: Array<Record<string, unknown>> = [];
    plugin.register({
      config: {},
      pluginConfig: { worker: { authToken: 'shared-worker-token' } },
      registerTool() {},
      registerHttpRoute(route) {
        routes.push(route as unknown as Record<string, unknown>);
      },
    });
    expect(routes).toEqual([expect.objectContaining({
      path: '/plugins/olympus/watch-delivery',
      auth: 'plugin',
      match: 'exact',
      handler: expect.any(Function),
    })]);
  });

  test('uses a built JavaScript runtime entrypoint for OpenClaw installation', () => {
    expect(pkg.openclaw.extensions).toEqual(['./dist/index.js']);
    expect(pkg.openclaw.runtimeExtensions).toEqual(['./dist/index.js']);
    expect(pkg.openclaw.runtimeExtensions).toEqual(pkg.openclaw.extensions);
  });

  test('packaged OpenClaw runtime entrypoint imports and registers tools', async () => {
    const extensionPath = pkg.openclaw.extensions[0];
    if (!extensionPath) throw new Error('Missing OpenClaw extension entrypoint.');
    const packaged = await import(`../${extensionPath.replace(/^\.\//, '')}`) as { default: typeof plugin };
    const names: string[] = [];

    packaged.default.register({
      pluginConfig: {},
      registerTool(tool: NativeTool) {
        names.push(materializeTool(tool).name);
      },
    });

    expect(names).toEqual(registeredToolNames({}));
  });

  test('keeps source-checkout licensing and release version metadata aligned', () => {
    expect(pkg).toMatchObject({ name: 'olympus-source-checkout', private: true });
    expect(pkg.license).toBe('MIT');
    expect(pkg.version).toBe('0.4.0');
    expect(manifest.version).toBe(pkg.version);
  });

  test('declares runtime-supported config fields in the OpenClaw schema', () => {
    expect(Object.keys(configSchemaProperties())).toEqual(expect.arrayContaining([
      'identity',
      'worker',
      'sourceIndex',
    ]));
    expect(Object.keys(configSchemaProperties(['identity']))).toEqual(expect.arrayContaining([
      'ownerName',
      'assistantName',
    ]));
    expect(Object.keys(configSchemaProperties(['worker']))).toEqual(expect.arrayContaining([
      'authToken',
      'scheduler',
    ]));
    expect(Object.keys(configSchemaProperties(['worker', 'scheduler']))).toEqual(expect.arrayContaining([
      'enabled',
      'sourceIds',
      'tickSeconds',
      'syncIntervalSeconds',
      'freshnessThresholdHours',
      'errorBackoffSeconds',
      'maxTransientRetries',
    ]));
    expect(asRecord(configSchemaProperties(['worker', 'scheduler']).sourceIds)).toMatchObject({
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [...V0_4_PUBLIC_SOURCE_IDS],
      },
    });
    expect(Object.keys(configSchemaProperties(['argus', 'lanes', 'fast']))).toEqual(expect.arrayContaining([
      'baseUrl',
      'model',
      'secretRef',
    ]));
    expect(Object.keys(configSchemaProperties(['argus', 'lanes', 'deep']))).toEqual(expect.arrayContaining([
      'baseUrl',
      'model',
      'secretRef',
    ]));
    const argusModelProfile = asRecord(asRecord(manifest.configSchema).$defs).argusModelProfile;
    const argusModelProfileProperties = asRecord(asRecord(argusModelProfile).properties);
    expect(Object.keys(argusModelProfileProperties)).toEqual(expect.arrayContaining([
      'baseUrl',
      'model',
      'secretRef',
      'purpose',
    ]));
    expect(Object.keys(argusModelProfileProperties)).not.toContain('apiKey');
    expect(Object.keys(argusModelProfileProperties)).not.toContain('clientSecret');
    expect(Object.keys(configSchemaProperties(['sourceIndex']))).toEqual(expect.arrayContaining([
      'enabled',
      'corpusRegistry',
      'corpora',
      'ingestionPolicies',
    ]));
    expect(asRecord(configSchemaProperties(['sourceIndex']).corpusRegistry).$ref).toBe('#/$defs/sourceCorpusRegistry');
    expect(asRecord(asRecord(configSchemaProperties(['sourceIndex']).corpora).items).$ref).toBe('#/$defs/sourceCorpus');
    expect(Object.keys(configSchemaProperties(['sourceIndex', 'ingestionPolicies', 'dropboxPersonal']))).toEqual(expect.arrayContaining([
      'policyPath',
      'policy',
      'schemaVersion',
      'source',
      'corpusId',
      'roots',
      'rules',
      'sync',
      'content',
    ]));
  });

  test('loads at gateway startup so agent runtime tools are callable', () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  test('keeps domain tools outside the public surface regardless of internal gates', () => {
    const names = registeredToolNames({
      domainExpert: {
        enabled: false,
        liveToolsEnabled: true,
      },
    });

    expect(names).not.toContain('domain_agent');
    expect(names).not.toContain('domain_ask');

    const liveNames = registeredToolNames({
      domainExpert: {
        enabled: true,
        liveToolsEnabled: true,
      },
    });
    expect(liveNames).not.toContain('domain_agent');
    expect(liveNames).not.toContain('domain_ask');
  });

  test('declares the native tool contract required by current OpenClaw', () => {
    const registeredToolNames: string[] = [];

    plugin.register({
      pluginConfig: {},
      registerTool(tool: NativeTool) {
        registeredToolNames.push(materializeTool(tool).name);
      },
    });

    expect(manifest.contracts.tools).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    expect(registeredToolNames).toEqual([
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
  });

  test('keeps the Hire Broker bridge outside the public surface', () => {
    expect(Object.keys(configSchemaProperties())).not.toContain('hireBroker');
    expect(registeredToolNames({})).not.toContain('expert_hire');
    expect(registeredToolNames({})).not.toContain('expert_report');

    const names = registeredToolNames({
      hireBroker: {
        enabled: true,
        socketPath: '/tmp/olympus-hire-broker-test.sock',
        requestTimeoutSeconds: 1,
      },
    });
    expect(names).not.toContain('expert_hire');
    expect(names).not.toContain('expert_report');
  });

  test('can disable promoted source-index read tools while preserving legacy proof compatibility', () => {
    const disabled = registeredToolNames({
      sourceIndex: {
        enabled: false,
      },
    });
    expect(disabled).not.toContain('source_answer');
    expect(disabled).not.toContain('source_index_status');
    expect(disabled).not.toContain('source_index_search');

    const names = registeredToolNames({
      sourceIndex: {
        enabled: false,
        answerDevEnabled: true,
      },
    });

    expect(names).toContain('source_answer');
    expect(names).toContain('source_index_status');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('xanthos_file_deliver');
    expect(names).not.toContain('castor_workspace');
    expect(names).not.toContain('email_answer');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
  });

  test('keeps private email packet tools outside the public surface', () => {
    const names = registeredToolNames({
      email: {
        localPacketsDevEnabled: true,
      },
    });

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
  });

  test('keeps bounded Xanthos file delivery outside the public surface', () => {
    const names = registeredToolNames({
      fileDelivery: {
        enabled: true,
        baseUrl: 'http://xanthos-delivery.test/v1',
      },
    });

    expect(names).not.toContain('xanthos_file_deliver');
  });

  test('keeps delegated Castor Workspace outside the public surface', () => {
    const names = registeredToolNames({
      castorWorkspace: {
        enabled: true,
        baseUrl: 'http://xanthos-workspace.test/v1',
      },
    });

    expect(names).not.toContain('castor_workspace');
  });

  test('keeps email index admin tools outside the public surface', () => {
    const names = registeredToolNames({
      email: {
        indexAdminDevEnabled: true,
      },
    });

    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
    expect(names).not.toContain('source_index_sync');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
  });

  test('does not let dev toggles widen the public surface', () => {
    const names = registeredToolNames({
      email: {
        localPacketsDevEnabled: true,
        indexAdminDevEnabled: true,
      },
    });

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_answer');
  });

  test('hides private and admin tools when active-model guard is enabled without metadata', () => {
    const names = registeredToolNames({
      email: {
        localPacketsDevEnabled: true,
        indexAdminDevEnabled: true,
        requireLocalActiveModelForPrivateTools: true,
      },
    });

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_answer');
  });

  test('hides private and admin tools for cloud active model metadata', () => {
    const names = registeredToolNames(
      {
        email: {
          localPacketsDevEnabled: true,
          indexAdminDevEnabled: true,
          requireLocalActiveModelForPrivateTools: true,
        },
      },
      {
        activeModel: {
          provider: 'openai-codex',
          modelId: 'gpt-5.5',
        },
      },
    );

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_answer');
  });

  test('does not let local-model metadata widen the public surface', () => {
    const names = registeredToolNames(
      {
        argus: {
          lanes: {
            fast: {
              model: 'local-qwen-fast',
            },
          },
        },
        email: {
          localPacketsDevEnabled: true,
          indexAdminDevEnabled: true,
          requireLocalActiveModelForPrivateTools: true,
        },
      },
      {
        context: {
          activeModel: {
            provider: 'olympus-local',
            modelId: 'local-qwen-fast',
          },
        },
      },
    );

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_answer');
  });

  test('accepts future active model metadata from a second registration argument', () => {
    const names: string[] = [];
    plugin.register(
      {
        pluginConfig: {
          argus: {
            lanes: {
              deep: {
                model: 'local-qwen-deep',
              },
            },
          },
          email: {
            localPacketsDevEnabled: true,
            requireLocalActiveModelForPrivateTools: true,
          },
        },
        registerTool(tool: NativeTool) {
          names.push(materializeTool(tool).name);
        },
      },
      {
        activeModel: {
          providerId: 'olympus-local',
          modelId: 'local-qwen-deep',
        },
      },
    );

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_answer');
  });

  test('accepts provider-qualified local model refs without separate provider metadata', () => {
    const names = registeredToolNames(
      {
        argus: {
          lanes: {
            fast: {
              model: 'local-qwen-fast',
            },
          },
        },
        email: {
          localPacketsDevEnabled: true,
          requireLocalActiveModelForPrivateTools: true,
        },
      },
      {
        toolContext: {
          activeModel: {
            modelRef: 'olympus-local/local-qwen-fast',
          },
        },
      },
    );

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_answer');
  });

  test('uses nested argus plugin config for tool execution', async () => {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(
        JSON.stringify({
          model: 'configured-fast-model',
          choices: [{ message: { content: 'configured response' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tools = new Map<string, NativeTool>();
    plugin.register({
      pluginConfig: {
        argus: {
          defaultLane: 'fast',
          lanes: {
            fast: {
              baseUrl: 'http://gateway-local.test/v1',
              model: 'configured-fast-model',
            },
          },
        },
      },
      registerTool(tool: NativeTool) {
        const materialized = materializeTool(tool);
        tools.set(materialized.name, materialized);
      },
    });

    const result = await tools.get('argus_complete')?.execute('tool-call-1', { prompt: 'hello' });

    expect(calls[0]?.url).toBe('http://gateway-local.test/v1/chat/completions');
    expect(JSON.parse(calls[0]?.body ?? '{}').model).toBe('configured-fast-model');
    expect(result).toMatchObject({
      details: {
        text: 'configured response',
        profile: 'default_chat',
        model: 'configured-fast-model',
      },
    });
  });

  test('renders source_answer as compact answer-ready text while preserving details', async () => {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(
        JSON.stringify({
          answer: 'LDL is elevated, while the Telegram source discusses ApoB as a biomarker. [1][2]',
          evidence: [
            {
              corpus_id: 'secure_local.dropbox.files',
              trust_domain: 'secure_local',
              family: 'dropbox',
              provider: 'dropbox',
              provider_item_id: 'hashed-dropbox-item',
              title: 'Recent Labs.pdf',
              source_label: 'Recent Labs',
              updated_at: '2026-06-01T10:00:00Z',
            },
            {
              corpus_id: 'internal.telegram.messages',
              trust_domain: 'internal',
              family: 'telegram',
              provider: 'telegram',
              provider_item_id: 'hashed-telegram-message',
              source_label: 'Happy Fourth Crypto Bear',
              authored_at: '2026-05-15T12:00:00Z',
            },
          ],
          audit: {
            searched_corpora: ['secure_local.dropbox.files', 'internal.telegram.messages'],
            skipped_corpora: [
              {
                corpus_id: 'internal.email',
                trust_domain: 'internal',
                reason: 'not_requested',
              },
            ],
            lane_audits: [
              {
                laneName: 'source_answer:retrieval',
                diagnostic_blob: 'large machine-only audit text that should stay in details',
              },
            ],
            answer_synthesis: {
              analyst_backend: 'local',
              private_context_used: true,
              secure_local_items_consulted: 1,
              internal_items_consulted: 1,
              raw_source_exposed: false,
            },
            latency_ms: 14500,
            phase_timings: {
              lane_setup_ms: 10,
              bulk_gate_ms: 20,
              evidence_pack_ms: 2100,
              analyst_ms: 12100,
              release_gate_ms: 100,
              total_ms: 14500,
            },
            raw_source_exposed: false,
          },
          policy: {
            raw_source_exposed: false,
            source_packets_exposed: false,
            internal_content_exposed: true,
            secure_local_content_exposed: true,
            castor_safe_bridge: true,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tools = new Map<string, NativeTool>();
    plugin.register({
      pluginConfig: {
        email: {
          enabled: true,
          baseUrl: 'http://source-worker.test',
        },
        sourceIndex: {
          answerDevEnabled: true,
        },
      },
      registerTool(tool: NativeTool) {
        const materialized = materializeTool(tool);
        tools.set(materialized.name, materialized);
      },
    });

    const result = await tools.get('source_answer')?.execute('tool-call-1', {
      question: 'What do my latest labs and Telegram biomarker messages say?',
      corpus_ids: ['secure_local.dropbox.files', 'internal.telegram.messages'],
      include_secure_local: true,
    }) as { content: Array<{ text: string }>; details: Record<string, unknown> } | undefined;

    expect(calls[0]?.url).toBe('http://source-worker.test/v1/source/answer');
    expect(JSON.parse(calls[0]?.body ?? '{}').corpus_ids).toEqual([
      'secure_local.dropbox.files',
      'internal.telegram.messages',
    ]);
    expect(result?.content[0]?.text).toContain('Answer:\nLDL is elevated');
    expect(result?.content[0]?.text).toContain('1. Recent Labs [secure_local.dropbox.files]');
    expect(result?.content[0]?.text).toContain('Timing: 14500ms total, 2100ms retrieval, 12100ms analyst');
    expect(result?.content[0]?.text).toContain('Policy: raw_source_exposed=false, source_packets_exposed=false, castor_safe_bridge=true');
    expect(result?.content[0]?.text).not.toContain('large machine-only audit text');
    expect(result?.details).toMatchObject({
      audit: {
        lane_audits: [
          {
            diagnostic_blob: 'large machine-only audit text that should stay in details',
          },
        ],
      },
    });
  });

  test('keeps compatibility with flat v0.1 config keys', async () => {
    globalThis.fetch = (async (url) => {
      expect(String(url)).toBe('http://legacy-local.test/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'legacy-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const tools = new Map<string, NativeTool>();
    plugin.register({
      pluginConfig: {
        argus_default_lane: 'fast',
        argus_fast_base_url: 'http://legacy-local.test/v1',
      },
      registerTool(tool: NativeTool) {
        const materialized = materializeTool(tool);
        tools.set(materialized.name, materialized);
      },
    });

    const result = await tools.get('argus_list_models')?.execute('tool-call-1', {});

    expect(result).toMatchObject({
      details: {
        profile: 'default_chat',
        models: [{ id: 'legacy-model' }],
      },
    });
  });
});
