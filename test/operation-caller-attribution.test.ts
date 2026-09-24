// Calling-agent attribution: every surface names the calling agent, the
// identity rides the worker HTTP boundary as an optional validated field, and
// the answer's audit ledger entry records it. Release semantics are untouched
// (test/opsec.test.ts and the analyst-answer suites prove that unchanged).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import plugin from '../src/native-plugin.ts';
import { mcpOperationCaller } from '../src/mcp/server.ts';
import {
  parseOperationCallerWire,
  sanitizeCallerDisplayName,
} from '../src/core/operation-caller.ts';
import { evaluateReleaseGate, isCallingAgentDestination } from '../src/core/opsec.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type {
  SourceAnswerLatencyLedgerRecord,
  SourceAnswerLatencyRecord,
  SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

function workerWithLedger() {
  const ledger: SourceAnswerLatencyLedgerRecord[] = [];
  const worker = createEmailSourceWorker({
    sourceAnswer: { async answer() { return answerFixture(); } },
    sourceAnswerLatencyLog: { record(entry) { ledger.push(entry); } },
  });
  const callers = () => ledger.map((record) => record.caller);
  const v1 = () => ledger.find((r): r is SourceAnswerLatencyRecord => r.kind === 'source_answer_latency');
  const v2 = () => ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
  return { worker, ledger, callers, v1, v2 };
}

describe('release destination generalization', () => {
  test('calling_agent is exactly the castor destination', () => {
    expect(isCallingAgentDestination('calling_agent')).toBe(true);
    expect(isCallingAgentDestination('castor')).toBe(true);
    expect(isCallingAgentDestination('argus')).toBe(false);
    const secureFact = {
      factId: 'f1',
      claim: 'bounded claim',
      sourceProvenance: [{} as never],
      sensitivity: { trustTier: 'S4', trustDomain: 'secure_local' } as never,
      confidence: 'high' as never,
      extractionKind: 'analyst_claim' as never,
      sourceInstructionFlags: [],
    };
    const expected = { local_only: 'needs_approval', castor_answer: 'allow', user_review: 'allow' } as const;
    for (const releaseSurface of ['local_only', 'castor_answer', 'user_review'] as const) {
      const facts = [{ ...secureFact, releaseSurface } as never];
      const viaCastor = evaluateReleaseGate({ facts, draftAnswer: 'x', destination: 'castor', action: 'answer', caller: 'worker' });
      const viaCallingAgent = evaluateReleaseGate({ facts, draftAnswer: 'x', destination: 'calling_agent', action: 'answer', caller: 'worker' });
      expect(viaCallingAgent).toEqual(viaCastor);
      expect(viaCallingAgent.decision).toBe(expected[releaseSurface]);
    }
  });
});

describe('caller wire validation', () => {
  test('accepts the declared shape and rejects anything else', () => {
    expect(parseOperationCallerWire(undefined)).toEqual({ ok: true, caller: undefined });
    expect(parseOperationCallerWire({ surface: 'remote', connection_id: 'conn_abc-1', display_name: 'Grok' }))
      .toEqual({ ok: true, caller: { surface: 'remote', connection_id: 'conn_abc-1', display_name: 'Grok' } });
    expect(parseOperationCallerWire('native').ok).toBe(false);
    expect(parseOperationCallerWire({ surface: 'telepathy' }).ok).toBe(false);
    expect(parseOperationCallerWire({ surface: 'mcp', extra: 1 }).ok).toBe(false);
    expect(parseOperationCallerWire({ surface: 'remote', connection_id: 'has space' }).ok).toBe(false);
    expect(parseOperationCallerWire({ surface: 'remote', connection_id: 'x'.repeat(129) }).ok).toBe(false);
    expect(parseOperationCallerWire({ surface: 'mcp', display_name: '   ' }).ok).toBe(false);
  });

  test('display names lose control and bidi characters and are bounded', () => {
    expect(sanitizeCallerDisplayName('Claude\u202e\nCode')).toBe('Claude Code');
    expect(sanitizeCallerDisplayName('x'.repeat(200))?.length).toBe(80);
    expect(sanitizeCallerDisplayName(42)).toBeUndefined();
  });

  test('the worker refuses a malformed caller before answering', async () => {
    const { worker, v2 } = workerWithLedger();
    const response = await worker.fetch(new Request('http://worker.test/v1/source/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'q', caller: { surface: 'root' } }),
    }));
    expect(response.status).toBe(400);
    expect(v2()?.outcome).toBe('parse_error');
    expect(v2()?.caller).toBeUndefined();
  });

  test('a request without a caller is still answered and recorded without one', async () => {
    const { worker, ledger, callers } = workerWithLedger();
    const response = await worker.fetch(new Request('http://worker.test/v1/source/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    }));
    expect(response.status).toBe(200);
    expect(ledger).toHaveLength(2);
    expect(callers()).toEqual([undefined, undefined]);
  });
});

describe('attribution flows from each surface to the audit ledger', () => {
  test('native OpenClaw tools', async () => {
    const { worker, callers, v1, v2 } = workerWithLedger();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(input, init))) as typeof fetch;
    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
    plugin.register({
      pluginConfig: { email: { enabled: true, baseUrl: 'http://source-worker.test/v1' }, worker: { authToken: 't' } },
      registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never);
    await tools.get('source_answer')!.execute('call-1', { question: 'q' });
    expect(v1()?.caller).toEqual({ surface: 'native', display_name: 'OpenClaw' });
    expect(v2()?.caller).toEqual({ surface: 'native', display_name: 'OpenClaw' });
    expect(callers()).toHaveLength(2);
  });

  describe('subprocess surfaces', () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    let home: string | undefined;
    afterEach(() => {
      server?.stop(true);
      server = undefined;
      if (home) rmSync(home, { recursive: true, force: true });
      home = undefined;
    });

    function start() {
      const harness = workerWithLedger();
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => harness.worker.fetch(request) });
      home = mkdtempSync(join(tmpdir(), 'olympus-caller-attribution-'));
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        OLYMPUS_CONFIG: join(home, 'missing-config.json'),
        OLYMPUS_EMAIL_ENABLED: 'true',
        OLYMPUS_EMAIL_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        OLYMPUS_SOURCE_INDEX_ENABLED: 'true',
        OLYMPUS_WORKER_AUTH_TOKEN: 'test-token',
      };
      return { ...harness, env };
    }

    test('the CLI', async () => {
      const { env, v1, v2 } = start();
      const child = Bun.spawn(['bun', 'src/cli.ts', 'source', 'answer', 'what changed?'], {
        cwd: join(import.meta.dir, '..'),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      expect({ exitCode, stderr: await new Response(child.stderr).text() }).toMatchObject({ exitCode: 0 });
      expect(v1()?.caller).toEqual({ surface: 'cli', display_name: 'Olympus CLI' });
      expect(v2()?.caller).toEqual({ surface: 'cli', display_name: 'Olympus CLI' });
    }, 30_000);

    test('stdio MCP, labelled with the client-reported name', async () => {
      const { env, v1, v2 } = start();
      const transport = new StdioClientTransport({
        command: 'bun',
        args: ['src/cli.ts', 'serve'],
        cwd: join(import.meta.dir, '..'),
        env,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'attribution-test-client', version: '1.0.0' });
      await client.connect(transport);
      try {
        await client.callTool({ name: 'source_answer', arguments: { question: 'what changed?' } });
      } finally {
        await client.close();
      }
      expect(v1()?.caller).toEqual({ surface: 'mcp', display_name: 'attribution-test-client' });
      expect(v2()?.caller).toEqual({ surface: 'mcp', display_name: 'attribution-test-client' });
    }, 30_000);
  });

  test('stdio MCP without a usable client name is still attributed to the surface', () => {
    expect(mcpOperationCaller(undefined)).toEqual({ surface: 'mcp' });
    expect(mcpOperationCaller('\u0000')).toEqual({ surface: 'mcp' });
  });
});
