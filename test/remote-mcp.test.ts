// Remote MCP endpoint with bearer connections (hosted agents slice 2).
//
// Assembled exactly the way the worker server assembles it: `/mcp` goes to the
// connection-token handler, every other route to the worker-bearer wrapper.
// A real MCP SDK client talks Streamable HTTP to it over loopback.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
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
  lazyRemoteConnectionStore,
  withRemoteMcpRoute,
} from '../src/workers/remote-mcp.ts';
import { deleteOlympusData, exportOlympusData } from '../src/data-lifecycle.ts';
import { isInProcessRemoteRequest } from '../src/core/operation-caller.ts';
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
      makeOperationContext: (caller, signal) => createInProcessOperationContext({
        config: defaultConfig(),
        sourceIndexReadEnabled: true,
        workerFetch: worker.fetch,
        caller,
        signal,
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
  test('an MCP SDK client lists exactly the remote tools, reads status, and answers attributed to the connection', async () => {
    const { connection, token } = store.create('Muse');
    const client = await connectClient(token);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['source_answer', 'source_answer_result', 'source_index_status']);

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
      HOME: join(dir, 'home-without-worker-env'),
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

describe('review fixes', () => {
  function writeWorkerEnv(home: string, body: string): void {
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    const path = join(home, '.config', 'olympus', 'worker.env');
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  test('the CLI resolves the database the managed worker uses, and list prints it', () => {
    const home = join(dir, 'home');
    const workerXdg = join(dir, 'worker-xdg');
    writeWorkerEnv(home, `XDG_DATA_HOME=${workerXdg}\n`);
    const env = {
      HOME: home,
      XDG_DATA_HOME: join(dir, 'shell-xdg'),
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
    };
    const expected = join(workerXdg, 'openclaw', 'olympus', 'remote-connections.sqlite');
    const added = runConnectionsCommand(['add', 'muse'], env) as { db_path: string };
    expect(added.db_path).toBe(expected);
    expect(runConnectionsCommand(['list'], env)).toMatchObject({ db_path: expected });
    expect(existsSync(join(dir, 'shell-xdg'))).toBe(false);

    // An explicit path in worker.env is what the worker uses, so the CLI does too.
    const pinned = join(dir, 'pinned', 'rc.sqlite');
    writeWorkerEnv(home, `XDG_DATA_HOME=${workerXdg}\nOLYMPUS_REMOTE_CONNECTIONS_DB_PATH=${pinned}\n`);
    expect(runConnectionsCommand(['list'], env)).toMatchObject({ db_path: pinned });
    // And an explicit shell path is the owner naming the database outright.
    const shellPinned = join(dir, 'shell-pinned', 'rc.sqlite');
    expect(runConnectionsCommand(['list'], { ...env, OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: shellPinned }))
      .toMatchObject({ db_path: shellPinned });
  });

  test('data delete --all removes the connection database, revoking every token; export names it as left behind', () => {
    const home = join(dir, 'lifecycle-home');
    mkdirSync(home, { recursive: true });
    const dbPath = join(dir, 'outside-roots', 'remote-connections.sqlite');
    const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: dbPath };
    const outside = openRemoteConnectionStore(dbPath);
    const { token } = outside.create('Muse');
    outside.close();

    const exported = exportOlympusData({ destination: join(dir, 'export'), homeDir: home, env });
    expect(exported.skipped).toContain(dbPath);
    expect(JSON.stringify(exported.files)).not.toContain('remote-connections');

    const preview = deleteOlympusData({ all: true, dryRun: true, homeDir: home, env });
    expect(preview.removed).toContain(dbPath);
    deleteOlympusData({ all: true, homeDir: home, env });
    expect(existsSync(dbPath)).toBe(false);
    const reopened = openRemoteConnectionStore(dbPath);
    try {
      expect(reopened.verifyToken(token)).toEqual({ ok: false, reason: 'unknown' });
    } finally {
      reopened.close();
    }
  });

  test('a disconnecting remote client aborts its in-process worker request', async () => {
    const seen: Request[] = [];
    const controller = new AbortController();
    const ctx = createInProcessOperationContext({
      config: defaultConfig(),
      sourceIndexReadEnabled: true,
      caller: { surface: 'remote', connectionId: 'abc', displayName: 'Muse' },
      signal: controller.signal,
      workerFetch: (request) => {
        seen.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      },
    });
    const pending = ctx.email.sourceAnswer({ question: 'q' });
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
    expect(isInProcessRemoteRequest(seen[0]!)).toBe(true);
    expect(seen[0]!.signal.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(seen[0]!.signal.aborted).toBe(true);
  });

  test('ordinary worker-bearer callers cannot claim a remote connection on the ledger', async () => {
    const post = (caller: unknown) => fetch(`${base}/v1/source/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({ question: 'q', caller }),
    });
    expect((await post({ surface: 'remote', connection_id: 'abcdef', display_name: 'Grok' })).status).toBe(400);
    expect((await post({ surface: 'remote' })).status).toBe(400);
    expect((await post({ surface: 'mcp', connection_id: 'abcdef' })).status).toBe(400);
    expect(answered).toBe(0);
    expect((await post({ surface: 'mcp', display_name: 'claude-code' })).status).toBe(200);
    expect(ledger.find((r) => r.kind === 'source_answer_latency')?.caller)
      .toEqual({ surface: 'mcp', display_name: 'claude-code' });
  });

  test('no probe creates the connection database', async () => {
    const dbPath = join(dir, 'never', 'remote-connections.sqlite');
    const handler = createRemoteMcpHandler({
      connections: lazyRemoteConnectionStore(() => dbPath, openRemoteConnectionStore),
      makeOperationContext: () => { throw new Error('must not build a context'); },
    });
    const wellFormed = `olympus_conn_${'a'.repeat(18)}_${'b'.repeat(43)}`;
    for (const authorization of [undefined, 'Bearer junk', `Bearer ${wellFormed}`]) {
      const response = await handler(new Request('http://worker.test/mcp', {
        method: 'POST',
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
      }));
      expect(response.status).toBe(401);
    }
    expect(existsSync(join(dir, 'never'))).toBe(false);
  });

  test('path variants never carry a connection token to a source route', async () => {
    const { token } = store.create('Probe');
    const variants = [
      '/mcp/../v1/source/answer',
      '/mcp/%2e%2e/v1/source/answer',
      '/mcp/%2E%2E/v1/source/index/status',
      '/mcp/',
      '/MCP',
      '/mcpX',
      '//mcp',
      '/mcp;x',
      '/mcp%2f',
      '/mcp%2F..%2Fv1%2Fsource%2Fanswer',
      '/v1/source/answer?/mcp',
      '/v1/source/answer#/mcp',
      '/./mcp/./../v1/source/answer',
    ];
    for (const path of variants) {
      const status = await rawPost(server.port!, path, token);
      // Only the exact path `/mcp` is the remote endpoint; every variant lands
      // on the worker bearer wall, which a connection token does not pass.
      expect({ path, status }).toEqual({ path, status: 401 });
    }
    expect(answered).toBe(0);
    expect(ledger).toHaveLength(0);
  });

  test('HEAD, OPTIONS, PUT and DELETE are refused with and without a token', async () => {
    const { token } = store.create('Methods');
    for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
      expect((await fetch(`${base}/mcp`, { method })).status).toBe(401);
      const authed = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${token}` } });
      expect({ method, status: authed.status }).toEqual({ method, status: 405 });
    }
    expect(answered).toBe(0);
  });

  test('non-remote and unknown tools are refused, and caller is not a tool argument', async () => {
    const { token } = store.create('Tools');
    const client = await connectClient(token);
    try {
      for (const name of ['source_index_search', 'argus_ping', 'argus_complete', 'olympus_doctor', 'source_watch_create', 'no_such_tool']) {
        const outcome = await client.callTool({ name, arguments: {} })
          .then((result) => result.isError === true, () => true);
        expect({ name, refused: outcome }).toEqual({ name, refused: true });
      }
      const spoof = await client.callTool({
        name: 'source_answer',
        arguments: { question: 'q', caller: { surface: 'native', display_name: 'OpenClaw' } },
      }).then((result) => result.isError === true, () => true);
      expect(spoof).toBe(true);
    } finally {
      await client.close();
    }
    expect(answered).toBe(0);
  });
});

/** A raw HTTP/1.1 request, so the path reaches the server exactly as written. */
function rawPost(port: number, path: string, token: string): Promise<number> {
  const body = JSON.stringify({ question: 'q' });
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('end', () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (!match) reject(new Error(`no status line for ${path}: ${data.slice(0, 80)}`));
      else resolve(Number(match[1]));
    });
    socket.write([
      `POST ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      `Authorization: Bearer ${token}`,
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'));
  });
}
