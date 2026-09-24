// Remote MCP endpoint with bearer connections (hosted agents slice 2).
//
// Assembled exactly the way the worker server assembles it: `/mcp` goes to the
// connection-token handler, every other route to the worker-bearer wrapper.
// A real MCP SDK client talks Streamable HTTP to it over loopback.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';
import { V0_4_HERMES_MCP_TOOLS } from '../src/core/public-surface.ts';
import {
  openRemoteConnectionStore,
  REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS,
  type RemoteConnectionStore,
} from '../src/core/remote-connections.ts';
import { runConnectionsCommand } from '../src/cli.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  createInProcessOperationContext,
  createRemoteMcpHandler,
  withRemoteMcpRoute,
} from '../src/workers/remote-mcp.ts';
import type {
  SourceAnswerLatencyLedgerRecord,
  SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-mcp-tests-0123456789';

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

let dir: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let ledger: SourceAnswerLatencyLedgerRecord[];
let answered: number;
let base: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-remote-mcp-'));
  store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  ledger = [];
  answered = 0;
  const worker = createEmailSourceWorker({
    sourceAnswer: { async answer() { answered += 1; return answerFixture(); } },
    sourceAnswerLatencyLog: { record(entry) { ledger.push(entry); } },
    sourceIndexStatus: { async status() { return statusFixture() as never; } },
  });
  const fetch = withRemoteMcpRoute(
    createRemoteMcpHandler({
      connections: () => store,
      makeOperationContext: (caller) => createInProcessOperationContext({
        config: defaultConfig(),
        sourceIndexReadEnabled: true,
        workerFetch: worker.fetch,
        caller,
      }),
    }),
    withWorkerBearerAuth(worker.fetch, { authToken: WORKER_TOKEN }),
  );
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connectClient(token: string): Promise<Client> {
  const client = new Client({ name: 'remote-mcp-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId).
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return client;
}

function mcpInitialize(authorization?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    }),
  });
}

describe('remote operation surface', () => {
  test('exposes exactly the Hermes tool list', () => {
    const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
    expect(exposedOperations(operations, { config, surface: 'remote' }).map((op) => op.name))
      .toEqual([...V0_4_HERMES_MCP_TOOLS]);
  });
});

describe('remote MCP over loopback with a connection token', () => {
  test('an MCP SDK client lists exactly two tools, reads status, and answers attributed to the connection', async () => {
    const { connection, token } = store.create('Muse');
    const client = await connectClient(token);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['source_answer', 'source_index_status']);

      const status = await client.callTool({ name: 'source_index_status', arguments: {} });
      const statusText = (status.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(JSON.parse(statusText)).toMatchObject({ kind: 'source_index_status', corpora: [] });

      await client.callTool({ name: 'source_answer', arguments: { question: 'what changed?' } });
      expect(answered).toBe(1);
      const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
      expect(trace?.caller).toEqual({ surface: 'remote', connection_id: connection.id, display_name: 'Muse' });
      expect(ledger.every((record) => record.caller?.connection_id === connection.id)).toBe(true);

      // A tool off the remote list is refused even though MCP-stdio has it.
      const refused = await client.callTool({ name: 'source_index_search', arguments: { query: 'x', corpus_id: 'internal.email' } })
        .then((result) => ({ isError: result.isError === true }), () => ({ isError: true }));
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(store.list()[0]!.lastUsedAt).not.toBeNull();
  });

  test('missing, malformed, unknown, and revoked tokens get 401 with a Bearer challenge', async () => {
    const missing = await mcpInitialize();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer realm="olympus"');

    const { connection, token } = store.create('Grok');
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const authorization of ['Bearer not-a-connection-token', `Bearer ${tampered}`, `Basic ${token}`]) {
      const response = await mcpInitialize(authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate') ?? '').toStartWith('Bearer realm="olympus"');
    }

    expect((await mcpInitialize(`Bearer ${token}`)).status).toBe(200);
    store.revoke(connection.id);
    const revoked = await mcpInitialize(`Bearer ${token}`);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    expect(answered).toBe(0);
  });

  test('the worker bearer does not open /mcp, and a connection token opens no other route', async () => {
    const { token } = store.create('Claude');
    expect((await mcpInitialize(`Bearer ${WORKER_TOKEN}`)).status).toBe(401);

    const answer = (authorization: string) => fetch(`${base}/v1/source/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ question: 'q' }),
    });
    expect((await answer(`Bearer ${token}`)).status).toBe(401);
    for (const path of ['/v1/source/index/status', '/v1/health/dependencies', '/dashboard.json']) {
      const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
    }
    expect(answered).toBe(0);
    // Control: the worker bearer still works on its own routes.
    expect((await answer(`Bearer ${WORKER_TOKEN}`)).status).toBe(200);
  });

  test('a stateless endpoint answers GET with 405 after authenticating', async () => {
    const { token } = store.create('Scripted');
    expect((await fetch(`${base}/mcp`)).status).toBe(401);
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
  });
});

describe('connection store', () => {
  test('stores only a digest of the token and never returns it again', () => {
    const { connection, token } = store.create('Muse');
    expect(token).toStartWith(`olympus_conn_${connection.id}_`);
    expect(token.length).toBeGreaterThanOrEqual(70);
    const secret = token.slice(`olympus_conn_${connection.id}_`.length);
    store.close();
    const stateDir = join(dir, 'state');
    for (const file of readdirSync(stateDir)) {
      expect(readFileSync(join(stateDir, file)).includes(Buffer.from(secret))).toBe(false);
    }
    store = openRemoteConnectionStore(join(stateDir, 'remote-connections.sqlite'));
    expect(JSON.stringify(store.list())).not.toContain(secret);
    expect(store.verifyToken(token)).toMatchObject({ ok: true, connection: { id: connection.id, displayName: 'Muse' } });
  });

  test('revocation is durable and idempotent; unknown ids are refused', () => {
    const { connection, token } = store.create('Grok');
    const first = store.revoke(connection.id);
    const second = store.revoke(connection.id);
    expect(second.revokedAt).toBe(first.revokedAt);
    expect(store.verifyToken(token)).toEqual({ ok: false, reason: 'revoked' });
    expect(() => store.revoke('0123456789abcdef01')).toThrow('No remote connection');
    expect(() => store.revoke('../etc')).toThrow('Connection id');
  });

  test('last use is recorded at a bounded resolution', () => {
    let nowMs = Date.parse('2026-09-24T12:00:00.000Z');
    const clockStore = openRemoteConnectionStore(join(dir, 'clock', 'c.sqlite'), { now: () => new Date(nowMs) });
    try {
      const { token } = clockStore.create('Clock');
      expect(clockStore.list()[0]!.lastUsedAt).toBeNull();
      clockStore.verifyToken(token);
      const firstUse = clockStore.list()[0]!.lastUsedAt;
      expect(firstUse).toBe('2026-09-24T12:00:00.000Z');
      nowMs += REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS - 1;
      clockStore.verifyToken(token);
      expect(clockStore.list()[0]!.lastUsedAt).toBe(firstUse);
      nowMs += 1;
      clockStore.verifyToken(token);
      expect(clockStore.list()[0]!.lastUsedAt).not.toBe(firstUse);
    } finally {
      clockStore.close();
    }
  });
});

describe('olympus connections CLI', () => {
  test('add prints the URL and token once; list and revoke never show it', () => {
    const env = {
      XDG_DATA_HOME: join(dir, 'xdg'),
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
      OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8123/v1',
    };
    const added = runConnectionsCommand(['add', 'muse'], env) as {
      connection: { id: string; name: string; status: string };
      url: string;
      token: string;
    };
    expect(added.url).toBe('http://127.0.0.1:8123/mcp');
    expect(added.connection).toMatchObject({ name: 'muse', status: 'active' });
    expect(added.token).toStartWith('olympus_conn_');

    const listed = runConnectionsCommand(['list'], env);
    expect(JSON.stringify(listed)).not.toContain(added.token.slice(-20));
    expect(listed).toMatchObject({ connections: [{ id: added.connection.id, name: 'muse', status: 'active' }] });

    expect(runConnectionsCommand(['revoke', added.connection.id], env))
      .toMatchObject({ connection: { id: added.connection.id, status: 'revoked' } });
    expect(() => runConnectionsCommand(['add'], env)).toThrow('Usage: olympus connections add <name>');
  });
});
