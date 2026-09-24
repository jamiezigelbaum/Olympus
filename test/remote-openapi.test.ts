// OpenAPI view of the remote surface (hosted agents slice 3, for Muse).
//
// Assembled the way the worker server assembles it: the OpenAPI routes, then
// `/mcp`, then the worker-bearer wall. Plain HTTP over loopback, as Muse's
// generated client would call it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// ajv ships with the MCP SDK (a dev dependency); its 2020-12 build validates
// both the OpenAPI 3.1 document schema and each operation's JSON Schema.
import Ajv2020 from 'ajv/dist/2020.js';
import { defaultConfig, type OlympusConfig } from '../src/core/config.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';
import { V0_4_PUBLIC_REMOTE_MCP_TOOLS } from '../src/core/public-surface.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { runConnectionsCommand } from '../src/cli.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  createInProcessOperationContext,
  createRemoteMcpHandler,
  withRemoteMcpRoute,
} from '../src/workers/remote-mcp.ts';
import {
  buildRemoteOpenApiSpec,
  createRemoteOpenApiHandler,
  REMOTE_OPENAPI_MAX_BODY_BYTES,
  withRemoteOpenApiRoutes,
} from '../src/workers/remote-openapi.ts';
import type {
  SourceAnswerLatencyLedgerRecord,
  SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-openapi-tests-0123456789';

function answerFixture(): SourceIndexAnswerResult {
  return {
    answer: 'released answer',
    evidence: [],
    audit: {
      searched_corpora: ['internal.email'],
      skipped_corpora: [],
      lane_audits: [],
      answer_synthesis: {
        analyst_backend: 'local',
        private_context_used: false,
        secure_local_items_consulted: 0,
        internal_items_consulted: 0,
        raw_source_exposed: false,
      },
      latency_ms: 5,
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: false,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
    opsec: {
      structured_evidence: [],
      release_decision: { decision: 'allow', reasons: ['release_gate_passed'] },
      raw_source_exposed: false,
    },
  } as unknown as SourceIndexAnswerResult;
}

function statusFixture() {
  return {
    kind: 'source_index_status',
    generated_at: '2026-09-24T00:00:00.000Z',
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

function ownerConfig(): OlympusConfig {
  const config = defaultConfig();
  return { ...config, identity: { ownerName: 'Jamie Private', assistantName: 'Castor Private' } };
}

let dir: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let ledger: SourceAnswerLatencyLedgerRecord[];
let answered: number;
let answerFailure: Error | undefined;
let base: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-remote-openapi-'));
  store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  ledger = [];
  answered = 0;
  answerFailure = undefined;
  const worker = createEmailSourceWorker({
    sourceAnswer: {
      async answer() {
        if (answerFailure) throw answerFailure;
        answered += 1;
        return answerFixture();
      },
    },
    sourceAnswerLatencyLog: { record(entry) { ledger.push(entry); } },
    sourceIndexStatus: { async status() { return statusFixture() as never; } },
  });
  const remote = {
    connections: () => store,
    makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) =>
      createInProcessOperationContext({
        config: ownerConfig(),
        sourceIndexReadEnabled: true,
        workerFetch: worker.fetch,
        caller,
        signal,
      }),
  };
  const fetch = withRemoteOpenApiRoutes(
    createRemoteOpenApiHandler(remote),
    withRemoteMcpRoute(
      createRemoteMcpHandler(remote),
      withWorkerBearerAuth(worker.fetch, { authToken: WORKER_TOKEN }),
    ),
  );
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(name: string, authorization: string | undefined, body: unknown = {}, method = 'POST'): Promise<Response> {
  return fetch(`${base}/api/v1/tools/${name}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function getSpec(): Promise<Record<string, any>> {
  const response = await fetch(`${base}/openapi.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  return response.json() as Promise<Record<string, any>>;
}

describe('OpenAPI document', () => {
  test('validates against the OpenAPI 3.1 schema, and every operation schema is valid JSON Schema 2020-12', async () => {
    const spec = await getSpec();
    // The official OAS 3.1 document schema, vendored. Its Schema Object slots
    // use `$dynamicRef: "#meta"`, which ajv resolves against the document root
    // instead of the `meta` anchor, so they are pointed at that anchor's
    // definition directly (the same target, with no dialect override in play).
    // Schema Objects themselves are then checked against the 2020-12
    // meta-schema below.
    const oasSchemaText = readFileSync(join(import.meta.dir, 'fixtures', 'openapi', 'oas-3.1-schema-2022-10-07.json'), 'utf8')
      .replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"');
    const oasSchema = JSON.parse(oasSchemaText);
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(oasSchema);
    const valid = validate(spec);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);

    for (const pathItem of Object.values(spec.paths as Record<string, any>)) {
      for (const schema of [
        pathItem.post.requestBody.content['application/json'].schema,
        pathItem.post.responses['200'].content['application/json'].schema,
      ]) {
        expect(ajv.validateSchema(schema)).toBe(true);
        expect(() => ajv.compile(schema)).not.toThrow();
      }
    }
    expect(ajv.validateSchema(spec.components.schemas.Error)).toBe(true);
    // Every local $ref resolves.
    const refs = JSON.stringify(spec).match(/"\$ref":"([^"]+)"/g) ?? [];
    for (const ref of refs) {
      const pointer = /"\$ref":"#\/(.+)"/.exec(ref)![1]!.split('/');
      let node: any = spec;
      for (const part of pointer) node = node?.[part];
      expect({ ref, resolved: node !== undefined }).toEqual({ ref, resolved: true });
    }
  });

  test('lists exactly the remote surface, with stable operationIds and bearer security', async () => {
    const spec = await getSpec();
    const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
    const remote = exposedOperations(operations, { config, surface: 'remote' }).map((op) => op.name);
    expect(remote).toEqual([...V0_4_PUBLIC_REMOTE_MCP_TOOLS]);
    expect(Object.keys(spec.paths).sort()).toEqual(remote.map((name) => `/api/v1/tools/${name}`).sort());
    expect(Object.values(spec.paths as Record<string, any>).map((item) => Object.keys(item))).toEqual(remote.map(() => ['post']));
    expect(Object.values(spec.paths as Record<string, any>).map((item) => item.post.operationId).sort()).toEqual([...remote].sort());
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.security).toEqual([{ connectionToken: [] }]);
    expect(spec.components.securitySchemes.connectionToken).toMatchObject({ type: 'http', scheme: 'bearer' });

    const answer = spec.paths['/api/v1/tools/source_answer'].post;
    expect(answer.requestBody.required).toBe(true);
    expect(answer.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['question'],
      additionalProperties: false,
    });
    // caller is set by the worker from the token, never a parameter.
    expect(answer.requestBody.content['application/json'].schema.properties.caller).toBeUndefined();
  });

  test('servers never come from the Host header; a configured public base URL wins', async () => {
    const spec = await getSpec();
    expect(spec.servers).toEqual([{ url: '/' }]);
    const status = await rawRequest(server.port!, 'GET', '/openapi.json', { Host: 'attacker.example' });
    expect(status.status).toBe(200);
    expect(status.body).not.toContain('attacker.example');
    expect(status.body).not.toContain('127.0.0.1');

    const configured = buildRemoteOpenApiSpec(defaultConfig(), { serverUrl: 'https://abc.connect.olympusplugin.ai' });
    expect(configured.servers).toEqual([{ url: 'https://abc.connect.olympusplugin.ai' }]);
    expect(() => createRemoteOpenApiHandler({
      connections: () => store,
      makeOperationContext: () => { throw new Error('unused'); },
      publicBaseUrl: 'http://abc.example',
    })).toThrow('https');
  });

  test('is served without a token and names no owner, assistant, or secret', async () => {
    const response = await fetch(`${base}/openapi.json`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('Jamie Private');
    expect(text).not.toContain('Castor Private');
    expect(text).not.toContain(WORKER_TOKEN);
    expect(text).not.toContain('olympus_conn_0');
    // A token is ignored on the spec, not required.
    const { token } = store.create('Muse');
    expect((await fetch(`${base}/openapi.json`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${base}/openapi.json`, { method: 'HEAD' })).status).toBe(200);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const refused = await fetch(`${base}/openapi.json`, { method });
      expect({ method, status: refused.status }).toEqual({ method, status: 405 });
    }
  });
});

describe('REST call path', () => {
  test('answers and reads status with a connection token, attributed to the connection', async () => {
    const { connection, token } = store.create('Muse');
    const status = await call('source_index_status', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ kind: 'source_index_status', corpora: [] });

    const answer = await call('source_answer', `Bearer ${token}`, { question: 'what changed?' });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ answer: 'released answer' });
    expect(answered).toBe(1);
    const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
    expect(trace?.caller).toEqual({ surface: 'remote', connection_id: connection.id, display_name: 'Muse' });
    expect(ledger.every((record) => record.caller?.connection_id === connection.id)).toBe(true);
    expect(store.list()[0]!.lastUsedAt).not.toBeNull();
  });

  test('missing, malformed, unknown, revoked, and worker-bearer tokens get the /mcp 401', async () => {
    const missing = await call('source_answer', undefined, { question: 'q' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer realm="olympus"');

    const { connection, token } = store.create('Muse');
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const authorization of ['Bearer not-a-connection-token', `Bearer ${tampered}`, `Basic ${token}`, `Bearer ${WORKER_TOKEN}`]) {
      const response = await call('source_answer', authorization, { question: 'q' });
      expect({ authorization: authorization.slice(0, 12), status: response.status })
        .toEqual({ authorization: authorization.slice(0, 12), status: 401 });
      expect(response.headers.get('WWW-Authenticate') ?? '').toStartWith('Bearer realm="olympus"');
      expect(await response.text()).not.toContain(token);
    }
    // An unauthenticated probe learns nothing about which tools exist.
    expect((await call('no_such_tool', undefined)).status).toBe(401);
    expect((await call('source_index_search', `Bearer ${WORKER_TOKEN}`)).status).toBe(401);

    expect((await call('source_index_status', `Bearer ${token}`)).status).toBe(200);
    store.revoke(connection.id);
    const revoked = await call('source_answer', `Bearer ${token}`, { question: 'q' });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    expect(answered).toBe(0);
  });

  test('a connection token opens no other route, and the worker bearer still does', async () => {
    const { token } = store.create('Muse');
    const workerAnswer = (authorization: string) => fetch(`${base}/v1/source/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ question: 'q' }),
    });
    expect((await workerAnswer(`Bearer ${token}`)).status).toBe(401);
    for (const path of ['/v1/source/index/status', '/v1/health/dependencies', '/dashboard.json', '/api/v1/tools', '/api/v1/tools/', '/api/v1/source_answer']) {
      const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
    expect(answered).toBe(0);
    expect((await workerAnswer(`Bearer ${WORKER_TOKEN}`)).status).toBe(200);
  });

  test('path variants never carry a connection token to a source route', async () => {
    const { token } = store.create('Probe');
    const variants = [
      '/api/v1/tools/../../../v1/source/answer',
      '/api/v1/tools/%2e%2e/%2e%2e/%2e%2e/v1/source/answer',
      '/api/v1/tools/source_answer/../../../../v1/source/answer',
      '/api/v1/tools/source_answer/',
      '/api/v1/tools/source_answer%2f',
      '/api/v1/tools/SOURCE_ANSWER',
      '/API/v1/tools/source_answer',
      '//api/v1/tools/source_answer',
      '/api/v1/tools/source_answer;x',
      '/api/v1/tools/source%5Fanswer',
      '/openapi.json/../v1/source/answer',
      '/v1/source/answer?/api/v1/tools/source_answer',
      '/v1/source/answer#/api/v1/tools/source_answer',
    ];
    for (const path of variants) {
      const response = await rawRequest(server.port!, 'POST', path, { Authorization: `Bearer ${token}` }, JSON.stringify({ question: 'q' }));
      // Anything but the exact tool path lands on the worker-bearer wall (401),
      // or, for an exact-shaped name the remote surface lacks, a 404.
      expect({ path, ok: response.status === 401 || response.status === 404 }).toEqual({ path, ok: true });
    }
    expect(answered).toBe(0);
    expect(ledger).toHaveLength(0);
  });

  test('only POST calls a tool; other methods are refused with and without a token', async () => {
    const { token } = store.create('Methods');
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call('source_index_status', undefined, {}, method)).status).toBe(401);
      const authed = await call('source_index_status', `Bearer ${token}`, {}, method);
      expect({ method, status: authed.status }).toEqual({ method, status: 405 });
      expect(authed.headers.get('Allow')).toBe('POST');
    }
    expect(answered).toBe(0);
  });

  test('non-remote and unknown tools are 404 after authentication', async () => {
    const { token } = store.create('Tools');
    for (const name of ['source_index_search', 'argus_ping', 'argus_complete', 'olympus_doctor', 'source_watch_create', 'no_such_tool']) {
      const response = await call(name, `Bearer ${token}`, { query: 'x' });
      expect({ name, status: response.status }).toEqual({ name, status: 404 });
      expect(await response.json()).toMatchObject({ error: 'unknown_operation' });
    }
    expect(answered).toBe(0);
  });

  test('parameters are validated like /mcp, and caller cannot be passed', async () => {
    const { token } = store.create('Params');
    const cases: Array<[unknown, number, string]> = [
      [{}, 400, 'invalid_params'],
      [{ question: '' }, 400, 'invalid_params'],
      [{ question: 'q', caller: { surface: 'native', display_name: 'OpenClaw' } }, 400, 'invalid_request'],
      [{ question: 'q', not_a_param: 1 }, 400, 'invalid_request'],
      ['[1,2]', 400, 'invalid_request'],
      ['{not json', 400, 'invalid_request'],
    ];
    for (const [body, status, error] of cases) {
      const response = await call('source_answer', `Bearer ${token}`, body);
      expect({ body, status: response.status }).toEqual({ body, status });
      expect(await response.json()).toMatchObject({ error });
    }
    const huge = await call('source_answer', `Bearer ${token}`, { question: 'x'.repeat(REMOTE_OPENAPI_MAX_BODY_BYTES) });
    expect(huge.status).toBe(413);
    expect(answered).toBe(0);
  });

  test('worker failures are shaped errors that leak no internals', async () => {
    const { token } = store.create('Errors');
    answerFailure = new Error('boom at /Users/secret/path with token sk-live-123');
    const response = await call('source_answer', `Bearer ${token}`, { question: 'q' });
    expect(response.status).toBeGreaterThanOrEqual(500);
    const text = await response.text();
    const body = JSON.parse(text) as { error: string; message: string };
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    for (const leak of ['/Users/secret', 'sk-live-123', 'olympus-worker.internal', WORKER_TOKEN, token, 'stack']) {
      expect({ leak, found: text.includes(leak) }).toEqual({ leak, found: false });
    }
  });

  test('the worker bearer cannot claim a remote caller through the REST shape either', async () => {
    const response = await fetch(`${base}/v1/source/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({ question: 'q', caller: { surface: 'remote', connection_id: 'abcdef', display_name: 'Muse' } }),
    });
    expect(response.status).toBe(400);
    expect(answered).toBe(0);
  });
});

describe('olympus connections CLI', () => {
  test('add and list show the OpenAPI URL alongside the MCP URL', () => {
    const env = {
      HOME: join(dir, 'home-without-worker-env'),
      XDG_DATA_HOME: join(dir, 'xdg'),
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
      OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8123/v1',
    };
    const added = runConnectionsCommand(['add', 'muse'], env);
    expect(added).toMatchObject({ url: 'http://127.0.0.1:8123/mcp', openapi_url: 'http://127.0.0.1:8123/openapi.json' });
    expect(runConnectionsCommand(['list'], env)).toMatchObject({ openapi_url: 'http://127.0.0.1:8123/openapi.json' });
  });
});

/** A raw HTTP/1.1 request, so the path and Host reach the server exactly as written. */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('end', () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (!match) reject(new Error(`no status line for ${path}: ${data.slice(0, 80)}`));
      else resolve({ status: Number(match[1]), body: data.slice(data.indexOf('\r\n\r\n') + 4) });
    });
    const lines = [
      `${method} ${path} HTTP/1.1`,
      ...(headers.Host ? [] : ['Host: 127.0.0.1']),
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ];
    socket.write(lines.join('\r\n'));
  });
}
