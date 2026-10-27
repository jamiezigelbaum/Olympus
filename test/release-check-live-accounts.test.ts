import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  corpusRows, mcpCallScript, parseRpc, runLiveAccounts, searchCheck, statusCheck,
  type CorpusRow, type EngineMcp, type LiveSourceSpec,
} from '../scripts/release-check/live-accounts.ts';

const statusOf = (checks: Array<{ id: string; status: string }>) => Object.fromEntries(checks.map((check) => [check.id, check.status]));
const NOW = Date.parse('2026-10-28T08:00:00Z');
const corpus = (label: string, extra: Partial<CorpusRow> = {}): CorpusRow => ({
  corpus_id: `${label.toLowerCase()}.items`, label, configured: true, retrieval: { mode: 'hybrid', state: 'ready' },
  last_refresh: { status: 'completed', completed_at: '2026-10-28T07:40:00Z' }, counts: { indexed_items: 12 }, ...extra,
});

describe('live accounts: what each source is held to', () => {
  test('connected and syncing: set up, holding items, refreshed recently and not failing', () => {
    const gmail: LiveSourceSpec = { id: 'gmail', label: 'Gmail' };
    expect(statusCheck(gmail, [corpus('Gmail')], NOW).status).toBe('pass');
    expect(statusCheck(gmail, [corpus('Dropbox')], NOW)).toMatchObject({ status: 'fail', detail: 'Olympus has no Gmail source set up (it has Dropbox)' });
    expect(statusCheck(gmail, [corpus('Gmail', { counts: { indexed_items: 0 } })], NOW).detail).toContain('nothing indexed yet');
    expect(statusCheck(gmail, [corpus('Gmail', { last_refresh: { status: 'failed', completed_at: '2026-10-28T07:40:00Z' } })], NOW).detail).toContain('every refresh failed');
    expect(statusCheck(gmail, [corpus('Gmail', { last_refresh: { status: 'completed', completed_at: '2026-10-26T07:40:00Z' } })], NOW).detail).toContain('more than 24 h ago');
    // A refresh that is running now is syncing, however long ago the last one finished.
    expect(statusCheck(gmail, [corpus('Gmail', { last_refresh: { status: 'completed', completed_at: '2026-10-26T07:40:00Z' } }), corpus('Gmail', { corpus_id: 'gmail.private', last_refresh: { status: 'running' } })], NOW).status).toBe('pass');
    expect(statusCheck(gmail, [corpus('Gmail', { retrieval: { mode: 'keyword', state: 'degraded' } })], NOW).status).toBe('warn');
  });

  test('a search passes only on an item of that source holding every expected string', () => {
    const structured = { evidence: [
      { id: 'E1', source: 'Gmail', title: 'Your trip to Santa Fe is booked', excerpt: 'Confirmation K7Q2ZX, departs 7:05' },
      { id: 'E2', source: 'Telegram', title: 'Nina Park', excerpt: 'I can bring Leo home at 5:15' },
    ] };
    expect(searchCheck('x', 't', 'Gmail', ['k7q2zx', '7:05'], { ok: true, structured }).status).toBe('pass');
    expect(searchCheck('x', 't', 'Telegram', ['K7Q2ZX'], { ok: true, structured })).toMatchObject({ status: 'fail', detail: '2 item(s) came back, 1 labelled Telegram, none holding all 1 expected string(s); sources: Gmail, Telegram' });
    expect(searchCheck('x', 't', 'Gmail', ['a'], { ok: false, structured: null, error: 'HTTP 401' }).detail).toBe('the search failed: HTTP 401');
  });

  test('a planted item is searched until it shows, and a plant that could not be made is inconclusive', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let searchesForWord = 0;
    const planted: Record<string, string> = {};
    const engine: EngineMcp = {
      call: async (tool, args) => {
        calls.push([tool, args]);
        if (tool === 'source_index_status') return { ok: true, text: '', structured: { kind: 'source_index_status', corpora: [corpus('Gmail'), corpus('Telegram')] } };
        const question = String(args.question);
        if (question === planted.gmail) {
          searchesForWord += 1;
          return { ok: true, text: '', structured: { evidence: searchesForWord >= 3 ? [{ source: 'Gmail', title: `Release canary ${question}`, excerpt: '' }] : [] } };
        }
        return { ok: true, text: '', structured: { evidence: [{ source: 'Telegram', title: 'Nina Park', excerpt: 'bring Leo home at 5:15' }] } };
      },
      close: async () => {},
    };
    const checks = await runLiveAccounts(engine, {
      sources: [
        { id: 'gmail', label: 'Gmail', plant: { argv: ['plant-mail'], withinS: 60 } },
        { id: 'telegram', label: 'Telegram', known: { question: 'when does Nina bring Leo home', expect: ['5:15'] }, plant: { argv: ['plant-telegram'] } },
      ],
      sleep: async () => {}, pollMs: 1,
      runPlant: (argv, env) => {
        if (argv[0] === 'plant-telegram') return { code: 1, output: 'no bot token' };
        planted.gmail = env.OLYMPUS_CANARY_WORD!;
        expect(env.OLYMPUS_CANARY_SUBJECT).toBe(`Release canary ${env.OLYMPUS_CANARY_WORD}`);
        return { code: 0, output: '' };
      },
    });
    expect(statusOf(checks)).toEqual({
      'live.gmail.status': 'pass', 'live.telegram.status': 'pass', 'live.telegram.known': 'pass', 'live.telegram.fresh': 'skip', 'live.gmail.fresh': 'pass',
    });
    expect(planted.gmail).toMatch(/^olycanary[0-9a-f]{10}$/);
    expect(searchesForWord).toBe(3);
    expect(checks.find((check) => check.id === 'live.telegram.fresh')!.detail).toBe('Inconclusive: the plant command failed (exit 1): no bot token');
  });

  test('a failed status read fails every source, and the corpora are read from the remote shape', async () => {
    const engine: EngineMcp = { call: async () => ({ ok: false, text: '', structured: null, error: 'HTTP 401' }), close: async () => {} };
    const checks = await runLiveAccounts(engine, { sources: [{ id: 'gmail', label: 'Gmail' }] });
    expect(checks).toEqual([{ id: 'live.gmail.status', title: 'Gmail: connected and syncing', status: 'fail', detail: 'source_index_status failed: HTTP 401' }]);
    expect(corpusRows({ corpora: [corpus('Gmail'), { label: 'x' }] }).map((row) => row.label)).toEqual(['Gmail']);
    expect(parseRpc('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{}}\n')).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});

describe('live accounts: the MCP request as it runs on a Linux machine', () => {
  const home = mkdtempSync(join(tmpdir(), 'live-accounts-home-'));
  const runtime = join(home, 'run');
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('initialize, then the call, over the worker socket with the run\'s token; no session header when none is issued', async () => {
    mkdirSync(join(runtime, 'olympus'), { recursive: true });
    mkdirSync(join(home, '.olympus-canary'));
    writeFileSync(join(home, '.olympus-canary', 'mcp-token'), 'olympus_conn_test');
    const seen: Array<{ auth: string | null; session: string | null; method: string }> = [];
    const server = Bun.serve({
      unix: join(runtime, 'olympus', 'worker.sock'),
      fetch: async (request) => {
        const body = await request.json() as { method: string; id?: number };
        seen.push({ auth: request.headers.get('authorization'), session: request.headers.get('mcp-session-id'), method: body.method });
        if (body.method === 'tools/call') return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        return Response.json({ jsonrpc: '2.0', id: body.id ?? null, result: {} });
      },
    });
    try {
      const script = mcpCallScript('linux', '.olympus-canary/mcp-token', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'olympus_search', arguments: { question: "Maya's car seat" } } });
      const ran = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        // Run in a child so the server here keeps answering while curl waits on it.
        const child = Bun.spawn(['bash', '-c', script], { env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime }, stdout: 'pipe', stderr: 'pipe' });
        void Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, status]) => resolve({ status, stdout, stderr }));
      });
      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      expect(parseRpc(ran.stdout).result.content[0].text).toBe('ok');
      expect(seen).toEqual([
        { auth: 'Bearer olympus_conn_test', session: null, method: 'initialize' },
        { auth: 'Bearer olympus_conn_test', session: null, method: 'notifications/initialized' },
        { auth: 'Bearer olympus_conn_test', session: null, method: 'tools/call' },
      ]);
    } finally {
      server.stop(true);
    }
    expect(spawnSync('bash', ['-n', '-c', mcpCallScript('macos', 't', {})]).status).toBe(0);
  }, 30_000);
});
