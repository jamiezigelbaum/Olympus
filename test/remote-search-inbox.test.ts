// A remote agent's evidence search reaches the Inbox (owner decision 2026-10-14,
// the 1.1.0 headline). On a standard install no answer model is set up, so an
// agent that is not ChatGPT is offered `olympus_search` and not `source_answer`
// (workers/remote-search.ts). Its search must do what source_answer does for
// the Private part: a metadata-only local probe over the same question; on a
// match one waiting question for the computer's built-in model, and one fixed
// sentence with an Open link in the result; otherwise nothing about Private.
//
// The expectations are written out here, not read back from the product: the
// sentence, the link's shape (22 URL-safe characters), the row's fields and the
// invariants of core/remote-private-part.ts's header.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.ts';
import { parseOlympusOpenUrl } from '../src/core/open-targets.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { createRemotePrivateParts, type PrivateMatchVerdict } from '../src/core/remote-private-part.ts';
import { recordReleaseManifest, type ReleaseCheck } from '../src/core/release-manifest.ts';
import { REMOTE_OUTPUT_SCHEMAS } from '../src/core/remote-result.ts';
import { openWaitingPrivateQuestionStore, type WaitingQuestionStore } from '../src/core/waiting-private-questions.ts';
import { SEARCH_TOOL } from '../src/workers/chatgpt/mcp-surface.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createLocalPrivateAnswers } from '../src/workers/email-source/local-private-answers.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  createInProcessOperationContext,
  createRemoteMcpHandler,
  withRemoteMcpRoute,
  type RemoteMcpHandlerOptions,
} from '../src/workers/remote-mcp.ts';
import { REMOTE_SEARCH_TOOL, remoteSearchExtension } from '../src/workers/remote-search.ts';
import type { McpServerExtension } from '../src/mcp/server.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-search-inbox-0123456789';
const QUESTION = 'When does the lease end?';
const SENTENCE = 'Your answer is in Olympus on your computer.';
const NOTE_WITH_LINK = /^Your answer is in Olympus on your computer\. \[Open answer\]\(olympus:\/\/open\/private\/([A-Za-z0-9_-]{22})\)$/;
const PERSONAL_EXCERPT = 'The lease renews on 1 March.';

type Verdict = PrivateMatchVerdict | 'hang' | 'throw';

let dir: string;
let connections: RemoteConnectionStore;
let waiting: WaitingQuestionStore;
let server: ReturnType<typeof Bun.serve> | undefined;
let base: string;
/** Every request the probe was asked, in order, exactly as it received it. */
let probes: Array<Record<string, unknown>>;
/** Order of the events of one call, to show the probe runs beside the search. */
let events: string[];
let verdict: Verdict;
let probeHeld: Promise<void> | undefined;
let searchHeld: Promise<void> | undefined;
let searchStarted: (() => void) | undefined;
/** Set: the search's retrieval rejects with it, after the probe has been asked. */
let searchFails: Error | undefined;
/** The tier the one Personal input has now (the search's own manifest names it). */
let inputTier: 'public_or_personal' | 'private';
let searches: Array<{ question: string; limit?: number }>;

const isActive = (id: string): boolean => connections.list().some((connection) => connection.id === id && connection.revokedAt === null);

function sdkClient(token: string, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'remote-search-inbox-test', version: '1.0.0' });
  return client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }) as unknown as Parameters<Client['connect']>[0]).then(() => client);
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

async function search(client: Client, question = QUESTION, extra: Record<string, unknown> = {}): Promise<ToolResult> {
  return await client.callTool({ name: 'olympus_search', arguments: { question, ...extra } }) as unknown as ToolResult;
}

function serve(options: Partial<RemoteMcpHandlerOptions> = {}, parts = partsFor()): void {
  const worker = createEmailSourceWorker({});
  const release: ReleaseCheck = {
    inputs: (inputs) => inputs.map(() => ({ tier: inputTier, gone: false })),
    secureDerivativeDefault: () => 'approval',
  };
  const handler = createRemoteMcpHandler({
    connections: () => connections,
    makeOperationContext: (caller, signal) => ({
      ...createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
      releaseCheck: release,
      ...(caller.connectionId ? { remotePrivatePart: parts.forConnection(caller.connectionId) } : {}),
    }),
    search: {
      evidenceSearch: async (input) => {
        searches.push(input);
        events.push('search-start');
        searchStarted?.();
        if (searchHeld) await searchHeld;
        if (searchFails) throw searchFails;
        events.push('search-end');
        // As searchReleasedEvidence does: the one Personal item it released is named in a manifest.
        recordReleaseManifest({
          inputs: [{ corpusId: 'personal.fixture.mail', provider: 'fixture_mail', accountScope: 'personal', providerItemId: 'lease', privateAtAnswer: false }],
          constraints: { secureDerivativeDefault: 'approval', includeSecureLocalContent: false },
        });
        return {
          evidence: [{ trust_domain: 'internal', provider: 'test-mail', family: 'email', title: 'Lease renewal', excerpt: PERSONAL_EXCERPT, authored_at: '2026-09-01T10:00:00Z' }],
          withheld: 0,
          coverage: { searched_corpora: 1 },
        };
      },
      answerModelAvailable: () => false,
    },
    ...options,
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: withRemoteMcpRoute(handler, withWorkerBearerAuth(worker.fetch, { authToken: WORKER_TOKEN })) });
  base = `http://127.0.0.1:${server.port}`;
}

function partsFor(probeTimeoutMs = 2_000) {
  return createRemotePrivateParts({
    probe: async (request) => {
      probes.push(request);
      events.push('probe-start');
      if (verdict === 'throw') throw new Error('probe failed');
      if (verdict === 'hang') return new Promise<PrivateMatchVerdict>(() => {});
      if (probeHeld) await probeHeld;
      events.push('probe-end');
      return verdict;
    },
    store: () => waiting,
    isActive,
    probeTimeoutMs,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-remote-search-inbox-'));
  connections = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  waiting = openWaitingPrivateQuestionStore(join(dir, 'state', 'waiting-private-questions.sqlite'), { isActive });
  probes = [];
  events = [];
  verdict = 'match';
  probeHeld = undefined;
  searchHeld = undefined;
  searchStarted = undefined;
  searchFails = undefined;
  inputTier = 'public_or_personal';
  searches = [];
  server = undefined;
});

afterEach(() => {
  server?.stop(true);
  waiting.close();
  connections.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a standard install: olympus_search records a Private match for the Inbox', () => {
  test('a match: one Inbox row (remote, exact selectors) and the note with a valid Open link, beside the evidence', async () => {
    serve();
    const { connection, token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const result = await search(client);
      expect(result.isError).toBeFalsy();
      const note = (result.structuredContent as { private_note?: string }).private_note!;
      const id = NOTE_WITH_LINK.exec(note)?.[1];
      expect(id).toBeDefined();
      // The product's own link reader takes it as a Private-answer link to that id.
      expect(parseOlympusOpenUrl(note.slice(note.indexOf('olympus://')).replace(/\)$/, ''))).toEqual({ kind: 'private_answers', answerId: id! });

      // The row: this connection, the remote surface, waiting, exactly the question and the one selector the search ran with.
      expect(waiting.list().questions).toEqual([expect.objectContaining({
        id,
        connectionId: connection.id,
        surface: 'remote',
        state: 'waiting',
        question: QUESTION,
        selectors: { retrieval_mode: 'hybrid' },
      })]);
      // The probe saw the question and that selector only: no limit, no evidence.
      expect(probes).toEqual([{ question: QUESTION, retrieval_mode: 'hybrid' }]);

      // The agent still has its evidence, and the note on a line of its own in the text, after an instruction to pass it on.
      const text = result.content[0]!.text;
      expect(result.content).toHaveLength(1);
      expect(text).toContain(PERSONAL_EXCERPT);
      expect(text.split('\n').filter((line) => line === note)).toHaveLength(1);
      expect(text).toContain(`Pass this on to the user as written:\n${note}`);
      expect((result.structuredContent as { status: string }).status).toBe('found');
    } finally {
      await client.close();
    }
  });

  test('the note is held to the same pattern as the source_answer schema', async () => {
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const note = ((await search(client)).structuredContent as { private_note: string }).private_note;
      const answerSchema = (REMOTE_OUTPUT_SCHEMAS.source_answer as { oneOf: Array<{ properties?: { private_note?: unknown } }> }).oneOf[0]!.properties!.private_note!;
      const ajv = new Ajv2020({ strict: false });
      expect(ajv.compile(answerSchema as object)(note)).toBe(true);
      expect(ajv.compile(answerSchema as object)(`${SENTENCE} Private items: Lease.pdf`)).toBe(false);
    } finally {
      await client.close();
    }
  });

  test('the tool tells the agent to pass the note and link on as written', () => {
    expect(REMOTE_SEARCH_TOOL.description).toContain('private_note');
    expect(REMOTE_SEARCH_TOOL.description).toContain('exactly as written');
    expect(REMOTE_SEARCH_TOOL.description).toContain('Open link');
    // ChatGPT's own olympus_search listing is not this tool's: it carries no such note.
    expect(SEARCH_TOOL.description).not.toContain('private_note');
  });

  test('no match: no row, no note, and a result the same as without a Private part', async () => {
    verdict = 'no_match';
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const result = await search(client);
      expect(waiting.list().questions).toEqual([]);
      expect(Object.keys(result.structuredContent!).sort()).toEqual(['coverage', 'evidence', 'notes', 'status']);
      expect(JSON.stringify(result)).not.toContain('private_note');
      expect(JSON.stringify(result)).not.toContain('on your computer');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toContain(PERSONAL_EXCERPT);
    } finally {
      await client.close();
    }
  });

  for (const how of ['unknown', 'hang', 'throw'] as const) {
    test(`${how}: a "couldn't check yet" row, and the agent is told nothing about Private`, async () => {
      verdict = how;
      server?.stop(true);
      serve({}, partsFor(40));
      const { token } = connections.create('Claude');
      const client = await sdkClient(token);
      try {
        const started = Date.now();
        const result = await search(client);
        // Bounded by the probe's own limit (40 ms here), not by anything the probe does.
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result)).not.toContain('private_note');
        expect(JSON.stringify(result)).not.toContain('on your computer');
        expect(waiting.list().questions).toEqual([expect.objectContaining({ surface: 'remote', state: 'unchecked', question: QUESTION, selectors: { retrieval_mode: 'hybrid' } })]);
      } finally {
        await client.close();
      }
    });
  }

  test('a recording the store refuses (a question over its byte bound) gives the agent no note', async () => {
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      // 700 three-byte characters: inside the search's 2,000-character bound, over the store's 2,048 bytes.
      const result = await search(client, '€'.repeat(700));
      expect(result.isError).toBeFalsy();
      expect(probes).toHaveLength(1);
      expect(waiting.list().questions).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('private_note');
    } finally {
      await client.close();
    }
  });

  test('the probe is asked as the call begins and does not wait for the search', async () => {
    let release!: () => void;
    searchHeld = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { searchStarted = resolve; });
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const pending = search(client);
      await started;
      // The search is still running and the probe has already been asked, and has answered.
      expect(events).toEqual(['probe-start', 'probe-end', 'search-start']);
      release();
      const result = await pending;
      expect((result.structuredContent as { private_note?: string }).private_note).toMatch(NOTE_WITH_LINK);
    } finally {
      await client.close();
    }
  });

  test('the search does not wait for the probe; the result does, for as long as the probe is allowed', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      let answered = false;
      const pending = search(client).then((result) => { answered = true; return result; });
      for (let tries = 0; tries < 200 && !events.includes('search-end'); tries += 1) await Bun.sleep(5);
      // The search has finished while the probe has not: nothing has been sent back yet.
      expect(events).toEqual(['probe-start', 'search-start', 'search-end']);
      await Bun.sleep(50);
      expect(answered).toBe(false);
      release();
      const result = await pending;
      expect((result.structuredContent as { private_note?: string }).private_note).toMatch(NOTE_WITH_LINK);
      expect(result.content[0]!.text).toContain(PERSONAL_EXCERPT);
    } finally {
      await client.close();
    }
  });

  test('a search with an invalid question probes and records nothing', async () => {
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const bad = await client.callTool({ name: 'olympus_search', arguments: { question: '   ' } }) as unknown as ToolResult;
      expect(bad.isError).toBe(true);
      expect(probes).toEqual([]);
      expect(waiting.list().questions).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test('a search whose retrieval fails after the probe was asked records nothing, even when the probe then says match', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    searchFails = new Error('the index could not be read');
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const failed = await search(client);
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toContain('private_note');
      // The probe was asked as the call began, and it is still deciding.
      expect(probes).toHaveLength(1);
      release();
      await Bun.sleep(50);
      expect(waiting.list().questions).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test('over the wire: an agent that hangs up while the probe is deciding leaves no row', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    serve();
    const { token } = connections.create('Claude');
    const hangUp = new AbortController();
    const pending = fetch(`${base}/mcp`, {
      method: 'POST',
      signal: hangUp.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'olympus_search', arguments: { question: QUESTION } } }),
    }).catch((error: unknown) => error);
    for (let tries = 0; tries < 200 && !events.includes('search-end'); tries += 1) await Bun.sleep(5);
    expect(events).toEqual(['probe-start', 'search-start', 'search-end']);
    hangUp.abort();
    await pending;
    // Let the hang-up reach the server, then let the probe say match.
    await Bun.sleep(100);
    release();
    await Bun.sleep(100);
    expect(waiting.list().questions).toEqual([]);
  });

  test('asking again does not make a second row, and the link is the same', async () => {
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const first = ((await search(client)).structuredContent as { private_note: string }).private_note;
      const second = ((await search(client, `  ${QUESTION}  `)).structuredContent as { private_note: string }).private_note;
      expect(second).toBe(first);
      expect(waiting.list().questions).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

describe('a revoked connection gets no row and no note', () => {
  test('revoked before the call: refused at the door, nothing probed or recorded', async () => {
    serve();
    const { connection, token } = connections.create('Claude');
    connections.revoke(connection.id);
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'olympus_search', arguments: { question: QUESTION } } }),
    });
    expect(response.status).toBe(401);
    expect(probes).toEqual([]);
    expect(searches).toEqual([]);
    expect(waiting.list().questions).toEqual([]);
  });

  test('revoked while the search runs: an error, no row, no note, no evidence', async () => {
    let release!: () => void;
    searchHeld = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { searchStarted = resolve; });
    serve();
    const { connection, token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const pending = search(client);
      await started;
      connections.revoke(connection.id);
      release();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: 'invalid_token' });
      expect(JSON.stringify(result)).not.toContain(PERSONAL_EXCERPT);
      expect(JSON.stringify(result)).not.toContain('private_note');
      expect(waiting.list().questions).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test('revoked while the probe is still deciding: an error, no row, no note', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    serve();
    const { connection, token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const pending = search(client);
      for (let tries = 0; tries < 200 && !events.includes('search-end'); tries += 1) await Bun.sleep(5);
      // The search is done and the probe has not answered: the connection goes now.
      expect(events).toEqual(['probe-start', 'search-start', 'search-end']);
      connections.revoke(connection.id);
      release();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: 'invalid_token' });
      expect(JSON.stringify(result)).not.toContain('private_note');
      expect(JSON.stringify(result)).not.toContain(PERSONAL_EXCERPT);
      expect(waiting.list().questions).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('the Private part for the search, on its own', () => {
  // These connection ids belong to no connection store, so the store here vouches for every one.
  let unit: WaitingQuestionStore;
  beforeEach(() => { unit = openWaitingPrivateQuestionStore(join(dir, 'state', 'unit.sqlite')); });
  afterEach(() => { unit.close(); });

  function parts(options: { verdict?: Verdict; active?: (id: string) => boolean; timeoutMs?: number } = {}) {
    return createRemotePrivateParts({
      probe: async (request) => {
        probes.push(request);
        const found = options.verdict ?? 'match';
        if (found === 'throw') throw new Error('probe failed');
        if (found === 'hang') return new Promise<PrivateMatchVerdict>(() => {});
        if (probeHeld) await probeHeld;
        return found;
      },
      store: () => unit,
      ...(options.active ? { isActive: options.active } : {}),
      probeTimeoutMs: options.timeoutMs ?? 30,
    });
  }

  test('the probe starts with the call, before anything settles, with the question and the retrieval mode only', () => {
    const call = parts().forConnection('conn-a').start('olympus_search', { question: `  ${QUESTION}  `, limit: 5, extra: 'ignored' });
    expect(call).toBeDefined();
    expect(probes).toEqual([{ question: QUESTION, retrieval_mode: 'hybrid' }]);
  });

  test('a connection that is not active when the call begins is never probed or recorded', async () => {
    const call = parts({ active: () => false }).forConnection('conn-a').start('olympus_search', { question: QUESTION })!;
    expect(await call.settle(undefined, undefined)).toBe(false);
    expect(probes).toEqual([]);
    expect(unit.list().questions).toEqual([]);
  });

  test('a connection that is unreadable counts as not active', async () => {
    const call = parts({ active: () => { throw new Error('store locked'); } }).forConnection('conn-a').start('olympus_search', { question: QUESTION })!;
    expect(await call.settle(undefined, undefined)).toBe(false);
    expect(probes).toEqual([]);
    expect(unit.list().questions).toEqual([]);
  });

  test('a connection that is revoked while the probe waits records nothing, even though the probe said match', async () => {
    let live = true;
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    const call = parts({ active: () => live, timeoutMs: 1_000 }).forConnection('conn-a').start('olympus_search', { question: QUESTION })!;
    const settled = call.settle(undefined, undefined);
    live = false;
    release();
    expect(await settled).toBe(false);
    expect(unit.list().questions).toEqual([]);
  });

  test('a revocation ticket read at the start refuses a record made after it', async () => {
    const call = parts().forConnection('conn-a').start('olympus_search', { question: QUESTION })!;
    unit.revokeConnection('conn-a');
    expect(await call.settle(undefined, undefined)).toBe(false);
    expect(unit.list().questions).toEqual([]);
  });

  test('close stops a settle that is waiting: nothing is recorded after it', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    const closing = parts({ timeoutMs: 1_000 });
    const call = closing.forConnection('conn-a').start('olympus_search', { question: QUESTION })!;
    const settled = call.settle(undefined, undefined);
    closing.close();
    release();
    expect(await settled).toBe(false);
    expect(unit.list().questions).toEqual([]);
  });

  test('no question, or one the store cannot hold exactly: not probed or recorded', async () => {
    const hook = parts().forConnection('conn-a');
    expect(await hook.start('olympus_search', {})!.settle(undefined, undefined)).toBe(false);
    expect(await hook.start('olympus_search', { question: '   ' })!.settle(undefined, undefined)).toBe(false);
    expect(probes).toEqual([]);
    expect(unit.list().questions).toEqual([]);
  });

  test('the sentence is promised only for a match that was recorded; unknown records "couldn\'t check yet"', async () => {
    const match = parts({ verdict: 'match' }).forConnection('conn-a').start('olympus_search', { question: QUESTION })!;
    expect(await match.settle(undefined, undefined)).toBe(true);
    expect(match.answerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const unknown = parts({ verdict: 'unknown' }).forConnection('conn-b').start('olympus_search', { question: QUESTION })!;
    // Recorded, but no sentence is promised: settle is what the search reads.
    expect(await unknown.settle(undefined, undefined)).toBe(false);
    expect(unit.list().questions.map((row) => [row.connectionId, row.state]).sort()).toEqual([['conn-a', 'waiting'], ['conn-b', 'unchecked']]);
  });
});

describe('a search the agent cancels records nothing', () => {
  const CALL = { params: { name: 'olympus_search', arguments: { question: QUESTION } } };
  const notTheSearch = async (): Promise<never> => { throw new Error('the search is answered by the extension'); };
  let controller: AbortController;
  let connectionId: string;
  let parts: ReturnType<typeof partsFor>;
  let extension: McpServerExtension;
  /** Runs inside retrieval, just before it returns. */
  let onRetrieved: (() => void) | undefined;

  beforeEach(() => {
    controller = new AbortController();
    onRetrieved = undefined;
    parts = partsFor(2_000);
    connectionId = connections.create('Claude').connection.id;
    extension = remoteSearchExtension(
      {
        // Retrieval finishes on its own and does not look at the signal, as a search already past its reads would.
        evidenceSearch: async (input) => {
          searches.push(input);
          events.push('search-end');
          onRetrieved?.();
          return { evidence: [], withheld: 0, coverage: { searched_corpora: 1 } };
        },
        answerModelAvailable: () => false,
      },
      () => (isActive(connectionId) ? 'active' : 'revoked'),
      { privatePart: parts.forConnection(connectionId) },
    );
  });
  afterEach(() => { parts.close(); });

  /** The computer's answerer over the same store, counting every question it is asked. */
  function answerer(asked: string[]) {
    return createLocalPrivateAnswers({
      store: () => waiting,
      isActive,
      connectionName: () => 'Claude',
      eligible: async (items) => items.map(() => true),
      answer: async (input) => {
        asked.push(input.question);
        return { status: 'answered', answer: 'An answer.', citations: [], unanswered: [], leftOut: [], read: [] };
      },
    });
  }

  test('control: the same call, not cancelled, records one row and carries the note', async () => {
    const result = await extension.call(CALL, notTheSearch, controller.signal);
    expect((result.structuredContent as { private_note?: string }).private_note).toMatch(NOTE_WITH_LINK);
    expect(waiting.list().questions).toEqual([expect.objectContaining({ connectionId, surface: 'remote', state: 'waiting', question: QUESTION })]);
  });

  test('cancelled after retrieval and before the probe answers: it stops waiting, then no row, no automatic answer and no budget used', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    const started = Date.now();
    const pending = extension.call(CALL, notTheSearch, controller.signal);
    for (let tries = 0; tries < 200 && !events.includes('search-end'); tries += 1) await Bun.sleep(5);
    // Retrieval is done; the probe has been asked and has not answered.
    expect(events).toEqual(['probe-start', 'search-end']);
    controller.abort();
    // The call ends on the cancel, well before the probe's own two seconds, with nothing about Private.
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(JSON.stringify(result)).not.toContain('private_note');
    expect(JSON.stringify(result)).not.toContain('on your computer');
    // The late verdict arrives and is ignored.
    release();
    await Bun.sleep(50);
    expect(events).toEqual(['probe-start', 'search-end', 'probe-end']);
    expect(waiting.list().questions).toEqual([]);

    // The computer has nothing to answer.
    const asked: string[] = [];
    const inbox = answerer(asked);
    try {
      await inbox.tick();
      expect(asked).toEqual([]);
      // And the connection's five automatic answers an hour are all still there: five other questions are all answered.
      const others = ['one', 'two', 'three', 'four', 'five'].map((word) => `Another question about ${word}?`);
      for (const question of others) {
        expect(waiting.record(waiting.ticket(connectionId), { question, surface: 'remote', state: 'waiting', selectors: { retrieval_mode: 'hybrid' } })).toBeDefined();
      }
      await inbox.tick();
      expect([...asked].sort()).toEqual([...others].sort());
    } finally {
      inbox.close();
    }
  });

  test('cancelled just as retrieval ends, with the probe already saying match: nothing is recorded', async () => {
    onRetrieved = () => controller.abort();
    const result = await extension.call(CALL, notTheSearch, controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private_note');
    await Bun.sleep(30);
    expect(waiting.list().questions).toEqual([]);
  });

  test('cancelled before the call begins: nothing is even probed or recorded', async () => {
    controller.abort();
    const result = await extension.call(CALL, notTheSearch, controller.signal);
    expect(JSON.stringify(result)).not.toContain('private_note');
    expect(probes).toEqual([]);
    expect(waiting.list().questions).toEqual([]);
  });

  test('a cancel that lands after the verdict but before the record step writes nothing', async () => {
    // A signal whose cancel arrives with no event of its own: the flag turns on as the probe hands back its verdict.
    let cancelled = false;
    const signal = { get aborted() { return cancelled; }, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as AbortSignal;
    const hook = createRemotePrivateParts({
      probe: async () => { cancelled = true; return 'match'; },
      store: () => waiting,
      isActive,
      probeTimeoutMs: 1_000,
    });
    try {
      const call = hook.forConnection(connectionId).start('olympus_search', { question: QUESTION }, { signal })!;
      expect(await call.settle(undefined, undefined)).toBe(false);
      expect(call.answerId).toBeUndefined();
      expect(waiting.list().questions).toEqual([]);
    } finally {
      hook.close();
    }
  });

  test('no abort listener outlives the wait, whether the search is cancelled or not', async () => {
    const done = new AbortController();
    const finished = parts.forConnection(connectionId).start('olympus_search', { question: QUESTION }, { signal: done.signal })!;
    expect(await finished.settle(undefined, undefined)).toBe(true);
    await Bun.sleep(0);
    expect(getEventListeners(done.signal, 'abort')).toHaveLength(0);

    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    const cancelled = new AbortController();
    const waited = parts.forConnection(connectionId).start('olympus_search', { question: 'Another question?' }, { signal: cancelled.signal })!;
    const settling = waited.settle(undefined, undefined);
    await Bun.sleep(0);
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(1);
    cancelled.abort();
    expect(await settling).toBe(false);
    release();
    await Bun.sleep(30);
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0);
    expect(waiting.list().questions.map((row) => row.question)).toEqual([QUESTION]);
  });
});

describe('other agents are unchanged', () => {
  test('a demo grant (a shared password) searches without a probe, a row or a note', async () => {
    serve({ demoGrant: () => true });
    const { token } = connections.create('Reviewer');
    const client = await sdkClient(token);
    try {
      const result = await search(client);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain(PERSONAL_EXCERPT);
      expect(JSON.stringify(result)).not.toContain('private_note');
      expect(probes).toEqual([]);
      expect(waiting.list().questions).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test('ChatGPT: its olympus_search keeps its own path (surface chatgpt, no remote probe, no note in the result)', async () => {
    serve({
      chatgpt: {
        servesRequest: () => true,
        dashboardView: async () => { throw new Error('unused'); },
        evidenceSearch: async () => ({ evidence: [], coverage: {} }),
        privateMatchProbe: async () => ({ count: 1, evidence: [{ title: 'Lease.pdf', trust_domain: 'secure_local' }] }),
        waitingQuestions: () => waiting,
      },
    });
    const { connection, token } = connections.create('ChatGPT');
    const client = await sdkClient(token);
    try {
      const result = await search(client);
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain('private_note');
      expect(JSON.stringify(result)).not.toContain('olympus://open/private');
      // Its own row, recorded by its own probe; the remote Private part was never started.
      expect(waiting.list().questions).toEqual([expect.objectContaining({ connectionId: connection.id, surface: 'chatgpt', state: 'waiting', question: QUESTION })]);
      expect(probes).toEqual([]);
      expect(searches).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('the tiers are read again after the probe\'s wait', () => {
  test('Personal evidence that became Private while the probe was deciding is withheld, and the row and note stand', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const pending = search(client);
      for (let tries = 0; tries < 200 && !events.includes('search-end'); tries += 1) await Bun.sleep(5);
      // The search released the item as Personal; the owner moves it to Private before the probe answers.
      inputTier = 'private';
      release();
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(PERSONAL_EXCERPT);
      expect(JSON.stringify(result)).not.toContain('Lease renewal');
      expect((result.structuredContent as { evidence: unknown[] }).evidence).toEqual([]);
      // The search still ran over the one source it reported; only its evidence is withheld.
      expect((result.structuredContent as { coverage: { searchedSources: number } }).coverage.searchedSources).toBe(1);
      expect((result.structuredContent as { private_note: string }).private_note).toMatch(NOTE_WITH_LINK);
    } finally {
      await client.close();
    }
  });

  test('unchanged evidence stays readable after the same wait', async () => {
    let release!: () => void;
    probeHeld = new Promise<void>((resolve) => { release = resolve; });
    serve();
    const { token } = connections.create('Claude');
    const client = await sdkClient(token);
    try {
      const pending = search(client);
      for (let tries = 0; tries < 200 && !events.includes('search-end'); tries += 1) await Bun.sleep(5);
      release();
      const result = await pending;
      expect(result.content[0]!.text).toContain(PERSONAL_EXCERPT);
    } finally {
      await client.close();
    }
  });
});

describe('the computer answers the row and the link opens it', () => {
  test('the local answerer answers the recorded question; the link\'s id reads that answer, from the connection that asked', async () => {
    serve();
    const { connection, token } = connections.create('Claude');
    const client = await sdkClient(token);
    let linkId: string;
    try {
      const note = ((await search(client)).structuredContent as { private_note: string }).private_note;
      linkId = NOTE_WITH_LINK.exec(note)![1]!;
    } finally {
      await client.close();
    }
    const asked: Array<{ question: string; selectors: unknown }> = [];
    const inbox = createLocalPrivateAnswers({
      store: () => waiting,
      isActive,
      connectionName: (id) => (id === connection.id ? 'Claude' : undefined),
      eligible: async (items) => items.map(() => true),
      answer: async (input) => {
        asked.push({ question: input.question, selectors: input.selectors });
        return { status: 'answered', answer: 'The lease ends on 31 May.', citations: [{ title: 'Lease.pdf', source: 'Files' }], unanswered: [], leftOut: [], read: [] };
      },
    });
    try {
      // It is listed as waiting, from the asking connection, under the link's id.
      expect(inbox.waiting()?.questions).toEqual([expect.objectContaining({ id: linkId, question: QUESTION, from: 'Claude' })]);
      await inbox.tick();
      // The computer's model was given the question and the exact selectors, nothing wider.
      expect(asked).toEqual([{ question: QUESTION, selectors: { retrieval_mode: 'hybrid' } }]);
      // The link's own reader gives the id the Inbox opens; reading it returns the answer.
      const target = parseOlympusOpenUrl(`olympus://open/private/${linkId}`);
      expect(target).toEqual({ kind: 'private_answers', answerId: linkId });
      const read = await inbox.handle({ action: 'read', id: linkId }, 'session-1');
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ ok: true, status: 'answered', answer: 'The lease ends on 31 May.' });
      expect(inbox.waiting()?.questions).toEqual([expect.objectContaining({ id: linkId, state: 'answered' })]);
    } finally {
      inbox.close();
    }
  });
});
