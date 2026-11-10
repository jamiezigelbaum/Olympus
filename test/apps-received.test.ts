/**
 * What AI apps received (#1061): every request an AI app or agent makes is
 * recorded where its result leaves, by name only; the list is kept like
 * Private data and served only to the local dashboard's unlocked session.
 */
import { recordScriptedSearch, scriptedSearchReleaseCheck } from './helpers/scripted-search-release.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appConnectionOf,
  createReleaseCapture,
  forgetJobQuestions,
  notePrivateAnswerCompleted,
  recordAppRequest,
  runWithReleaseCapture,
  setAppReleaseRecorder,
  type AppRequestRecord,
} from '../src/core/app-release-capture.ts';
import { appReleaseLogDbPath, forgetAppReleaseItems, openAppReleaseLog } from '../src/core/app-release-log.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';
import { defaultConfig } from '../src/core/config.ts';
import { findOperationByName } from '../src/core/operations.ts';
import { SourceAnswerJobRegistry, type SourceAnswerPending } from '../src/core/source-answer-jobs.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';
import { DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { deleteOlympusData, exportOlympusData } from '../src/data-lifecycle.ts';
import { APPS_RECEIVED_ITEM_GONE, createAppsReceived } from '../src/workers/apps-received.ts';
import { agentAnswerReceipt, recordAgentAnswerReceipt } from '../src/core/app-release-agent.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { recordReleaseManifest } from '../src/core/release-manifest.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { clearInstalledTierClassification, configureInstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { runTierSetOnRecordedItem } from '../src/workers/classification/tier-cli.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { SEARCH_TOOL, callChatGptTool, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { answerToolResult, searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { renderDashboardAppsReceivedPage } from '../src/workers/dashboard/pages/apps-received.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  setAppReleaseRecorder(undefined);
  forgetJobQuestions();
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-apps-received-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): AppRequestRecord[] {
  const records: AppRequestRecord[] = [];
  setAppReleaseRecorder((record) => records.push(record));
  return records;
}

const PERSONAL = { corpus_id: 'internal.gmail', provider_item_id: 'msg-1', trust_domain: 'internal', family: 'email', provider: 'gmail', title: 'Appointment confirmed: Leo', excerpt: 'SENTINEL_ITEM_TEXT dentist at 10' };
const PRIVATE = { corpus_id: 'secure_local.gmail', provider_item_id: 'msg-2', trust_domain: 'secure_local', family: 'email', provider: 'gmail', title: 'SENTINEL_PRIVATE_TITLE', excerpt: 'SENTINEL_PRIVATE_TEXT' };

describe('the output builders note what a result carries, by name only', () => {
  test('a search notes its Public and Personal items and counts the Private ones held back', () => {
    const noted = createReleaseCapture();
    runWithReleaseCapture(noted, () => searchToolResult({ evidence: [PERSONAL, PRIVATE], withheld: 1, coverage: {} }));
    expect(noted.items).toEqual([{ source: 'Gmail', title: 'Appointment confirmed: Leo', tier: 'personal', corpusId: 'internal.gmail', provider: 'gmail', providerItemId: 'msg-1' }]);
    expect(noted.heldBack).toBe(2);
    expect(JSON.stringify(noted)).not.toContain('SENTINEL');
  });

  test('an answer written from Private items notes nothing shared and says it was withheld', () => {
    const noted = createReleaseCapture();
    runWithReleaseCapture(noted, () => answerToolResult({
      answer: 'x', evidence: [PERSONAL], audit: { answer_synthesis: { private_context_used: true, secure_local_items_consulted: 2 } },
    }));
    expect(noted.items).toEqual([]);
    expect(noted.withheld).toBe(true);
    expect(noted.heldBack).toBe(2);
  });

  test('a remote source answer notes its released citations, and a withheld one notes none', () => {
    const answered = createReleaseCapture();
    runWithReleaseCapture(answered, () => remoteOperationOutput('source_answer', { answer: 'Saturday.', evidence: [PERSONAL] }));
    expect(answered.items?.map((item) => [item.source, item.title, item.tier])).toEqual([['Gmail', 'Appointment confirmed: Leo', 'personal']]);
    const withheld = createReleaseCapture();
    runWithReleaseCapture(withheld, () => remoteOperationOutput('source_answer', { answer: 'password: hunter2hunter2hunter2', evidence: [PERSONAL] }));
    expect(withheld.items).toEqual([]);
    expect(withheld.withheld).toBe(true);
  });

  test('outside a capture a builder notes nothing and records nothing', () => {
    const records = capture();
    searchToolResult({ evidence: [PERSONAL], coverage: {} });
    expect(records).toEqual([]);
  });
});

describe('who asked', () => {
  test('a remote connection is named by its app, an agent by its own name, the owner\'s command line not at all', () => {
    expect(appConnectionOf({ surface: 'remote', connectionId: 'c1', displayName: 'My phone', provider: 'openai' })).toEqual({ id: 'c1', name: 'ChatGPT', kind: 'app' });
    expect(appConnectionOf({ surface: 'remote', provider: 'anthropic' })?.name).toBe('Claude');
    expect(appConnectionOf({ surface: 'remote', provider: 'xai' })?.name).toBe('Grok');
    expect(appConnectionOf({ surface: 'remote', displayName: 'Work laptop', provider: 'other' })?.name).toBe('Work laptop');
    expect(appConnectionOf({ surface: 'native', displayName: 'Muse' })).toEqual({ name: 'Muse', kind: 'agent' });
    expect(appConnectionOf({ surface: 'cli' })).toBeUndefined();
  });
});

describe('the release exits record each request', () => {
  test('ChatGPT\'s search is recorded with the question, the app and the items it got', async () => {
    const records = capture();
    const options = {
      dashboardView: async () => ({ sources: [] }) as never,
      evidenceSearch: async () => recordScriptedSearch({ evidence: [PERSONAL, PRIVATE], coverage: {} }),
      privateMatchProbe: async () => ({ count: 0, evidence: [] }),
    } as unknown as ChatGptSurfaceOptions;
    const ctx = { releaseCheck: scriptedSearchReleaseCheck, caller: { surface: 'remote', connectionId: 'conn-gpt', provider: 'openai' } } as OperationContext;
    await callChatGptTool(SEARCH_TOOL.name, { question: 'When is Leo\'s dentist appointment?' }, ctx, options);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      connection: { id: 'conn-gpt', name: 'ChatGPT', kind: 'app' },
      question: 'When is Leo\'s dentist appointment?',
      heldBack: 1,
      answeredPrivately: false,
      withheld: false,
    });
    expect(records[0]!.items.map((item) => item.title)).toEqual(['Appointment confirmed: Leo']);
    expect(JSON.stringify(records)).not.toContain('SENTINEL');
  });

  test('a search whose release cannot be verified records the items as held back, none shared', async () => {
    const records = capture();
    const options = {
      evidenceSearch: async () => ({ evidence: [PERSONAL], coverage: {} }),
      privateMatchProbe: async () => ({ count: 0, evidence: [] }),
    } as unknown as ChatGptSurfaceOptions;
    await callChatGptTool(SEARCH_TOOL.name, { question: 'Leo?' }, { caller: { surface: 'remote', provider: 'openai' } } as OperationContext, options);
    expect(records).toHaveLength(1);
    expect(records[0]!.items).toEqual([]);
    expect(records[0]!.withheld).toBe(true);
  });

  test('an agent on this computer is recorded at its tool result', async () => {
    const records = capture();
    recordAgentAnswerReceipt(agentAnswerReceipt('Which invoices are unpaid?', { surface: 'native', display_name: 'Muse' }, { answer: 'Two.', evidence: [PERSONAL, PRIVATE] })!, false);
    expect(records[0]).toMatchObject({ connection: { name: 'Muse', kind: 'agent' }, question: 'Which invoices are unpaid?' });
    expect(records[0]!.items.map((item) => [item.title, item.tier])).toEqual([['Appointment confirmed: Leo', 'personal'], ['SENTINEL_PRIVATE_TITLE', 'private']]);
  });

  test('no recorder, no question or no caller records nothing and never throws', () => {
    const noted = { items: [], heldBack: 0 };
    expect(() => recordAppRequest({ caller: { surface: 'remote' }, question: 'x', capture: noted })).not.toThrow();
    const records = capture();
    recordAppRequest({ caller: undefined, question: 'x', capture: noted });
    recordAppRequest({ caller: { surface: 'remote' }, question: '  ', capture: noted });
    recordAppRequest({ caller: { surface: 'cli' }, question: 'x', capture: noted });
    setAppReleaseRecorder(() => { throw new Error('disk full'); });
    expect(() => recordAppRequest({ caller: { surface: 'remote' }, question: 'x', capture: noted })).not.toThrow();
    expect(records).toEqual([]);
  });
});

function sample(at: number, question = 'When is Leo\'s dentist appointment?'): AppRequestRecord {
  return {
    at,
    connection: { id: 'conn-gpt', name: 'ChatGPT', kind: 'app' },
    question,
    items: [
      { source: 'Gmail', title: 'Appointment confirmed: Leo', tier: 'personal', corpusId: 'internal.gmail', provider: 'gmail', providerItemId: 'msg-1', locator: 'gmail://msg-1' },
      { source: 'Dropbox', title: 'calendar.pdf', tier: 'personal', corpusId: 'internal.dropbox.files', provider: 'dropbox', providerItemId: 'id:2' },
    ],
    heldBack: 1,
    answeredPrivately: false,
    withheld: false,
  };
}

describe('the log', () => {
  test('is an owner-only file beside the remote connections, kept 30 days by default', () => {
    const clock = createTestClock(Date.parse('2026-11-10T10:00:00Z'));
    const path = appReleaseLogDbPath(join(tempDir(), 'data', 'remote-connections.sqlite'));
    const store = openAppReleaseLog(path, { now: () => clock.now() });
    cleanups.push(() => store.close());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.retentionDays()).toBe(30);
    store.record(sample(clock.now() - 31 * 86_400_000, 'Old?'));
    store.record(sample(clock.now()));
    expect(store.list().map((entry) => entry.question)).toEqual(['When is Leo\'s dentist appointment?']);
    const [entry] = store.list();
    expect(entry).toMatchObject({ connection: { name: 'ChatGPT', kind: 'app' }, heldBack: 1, answeredPrivately: false });
    expect(entry!.items.map((item) => [item.source, item.title])).toEqual([['Gmail', 'Appointment confirmed: Leo'], ['Dropbox', 'calendar.pdf']]);
    // The list served to the page carries names only, never identifiers.
    expect(JSON.stringify(store.list())).not.toContain('msg-1');
  });

  test('7 days drops older rows, "don\'t keep" clears and stops recording, Clear empties it', () => {
    const clock = createTestClock(Date.parse('2026-11-10T10:00:00Z'));
    const store = openAppReleaseLog(join(tempDir(), 'data', 'app-release-log.sqlite'), { now: () => clock.now() });
    cleanups.push(() => store.close());
    store.record(sample(clock.now() - 8 * 86_400_000, 'Eight days?'));
    store.record(sample(clock.now()));
    store.setRetentionDays(7);
    expect(store.list()).toHaveLength(1);
    expect(store.clear()).toBe(1);
    expect(store.list()).toEqual([]);
    store.record(sample(clock.now()));
    store.setRetentionDays(0);
    expect(store.list()).toEqual([]);
    expect(store.record(sample(clock.now()))).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test('a deleted source\'s titles go with it', () => {
    const path = join(tempDir(), 'data', 'app-release-log.sqlite');
    const store = openAppReleaseLog(path);
    store.record(sample(Date.now()));
    store.close();
    expect(forgetAppReleaseItems(path, { corpusIds: ['internal.gmail'] }, { dryRun: true })).toBe(1);
    expect(forgetAppReleaseItems(path, { corpusIds: ['internal.gmail'] })).toBe(1);
    const reopened = openAppReleaseLog(path);
    cleanups.push(() => reopened.close());
    expect(reopened.list()[0]!.items.map((item) => item.source)).toEqual(['Dropbox']);
  });

  test('Delete all removes it and export names it as left behind', async () => {
    const homeDir = join(tempDir(), 'home');
    const env = { HOME: homeDir } as Record<string, string>;
    const { resolveRemoteConnectionsDbPath } = await import('../src/core/remote-connections.ts');
    const path = appReleaseLogDbPath(resolveRemoteConnectionsDbPath(env));
    const store = openAppReleaseLog(path);
    store.record(sample(Date.now()));
    store.close();
    const exported = exportOlympusData({ destination: join(homeDir, '..', 'export'), homeDir, env });
    expect(exported.skipped).toContain(path);
    expect(exported.files.some((file) => file.includes('app-release-log'))).toBe(false);
    deleteOlympusData({ all: true, homeDir, env });
    expect(existsSync(path)).toBe(false);
  });
});

describe('the dashboard route', () => {
  function setup(refuse = false) {
    const dir = tempDir();
    const changed: Array<Record<string, unknown>> = [];
    const apps = createAppsReceived({
      dbPath: join(dir, 'data', 'app-release-log.sqlite'),
      setItemPrivate: async (item) => {
        changed.push(item);
        if (refuse) throw new Error('No stored item matches that locator.');
      },
    });
    cleanups.push(() => apps.close());
    return { apps, changed };
  }

  test('lists, sets retention, clears, and marks the recorded item Private by its full identity', async () => {
    const { apps, changed } = setup();
    recordAgentAnswerReceipt(agentAnswerReceipt('Which invoices are unpaid?', { surface: 'native', display_name: 'Muse' }, { answer: 'Two.', evidence: [{ ...PERSONAL, uri: 'gmail://msg-1', provider_conversation_id: 'thread-9' }] })!, false);
    const listed = await apps.handle({ action: 'list' });
    const requests = listed.body.requests as Array<{ id: string; items: Array<{ position: number; madePrivate: boolean }> }>;
    expect(requests).toHaveLength(1);
    expect(listed.body.retentionDays).toBe(30);
    const made = await apps.handle({ action: 'make_private', request: requests[0]!.id, item: 0 });
    expect(made).toEqual({ status: 200, body: { ok: true, madePrivate: true } });
    expect(changed).toEqual([{ locator: 'gmail://msg-1', provider: 'gmail', providerItemId: 'msg-1', providerConversationId: 'thread-9' }]);
    const after = (await apps.handle({ action: 'list' })).body.requests as typeof requests;
    expect(after[0]!.items[0]!.madePrivate).toBe(true);
    expect((await apps.handle({ action: 'make_private', request: 'apr_missing', item: 0 })).status).toBe(404);
    expect((await apps.handle({ action: 'retention', days: 12 })).status).toBe(400);
    expect((await apps.handle({ action: 'retention', days: 90 })).body.retentionDays).toBe(90);
    expect((await apps.handle({ action: 'clear' })).body.removed).toBe(1);
    expect((await apps.handle({ action: 'list' })).body.requests).toEqual([]);
  });

  test('when the full locator no longer resolves, the correction is refused plainly with no bare-id retry', async () => {
    const { apps, changed } = setup(true);
    recordAgentAnswerReceipt(agentAnswerReceipt('Which invoices are unpaid?', { surface: 'native', display_name: 'Muse' }, { answer: 'Two.', evidence: [{ ...PERSONAL, uri: 'gmail://msg-1' }] })!, false);
    const [request] = (await apps.handle({ action: 'list' })).body.requests as Array<{ id: string }>;
    const refused = await apps.handle({ action: 'make_private', request: request!.id, item: 0 });
    expect(refused).toEqual({ status: 409, body: { ok: false, error: { code: 'item_gone', message: APPS_RECEIVED_ITEM_GONE } } });
    // One attempt, by the recorded locator and identity: never the provider item id alone.
    expect(changed).toEqual([{ locator: 'gmail://msg-1', provider: 'gmail', providerItemId: 'msg-1' }]);
    const after = (await apps.handle({ action: 'list' })).body.requests as Array<{ items: Array<{ madePrivate: boolean }> }>;
    expect(after[0]!.items[0]!.madePrivate).toBe(false);
    // An item recorded without a locator is refused without any attempt.
    recordAgentAnswerReceipt(agentAnswerReceipt('Anything else?', { surface: 'native', display_name: 'Muse' }, { answer: 'No.', evidence: [PERSONAL] })!, false);
    const [latest] = (await apps.handle({ action: 'list' })).body.requests as Array<{ id: string }>;
    expect((await apps.handle({ action: 'make_private', request: latest!.id, item: 0 })).status).toBe(409);
    expect(changed).toHaveLength(1);
  });
});

describe('the per-item override, bound to the recorded item', () => {
  function item(n: number, path: string, providerItemId: string): RawItem {
    return {
      identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId, localItemId: `personal:${providerItemId}`, sourceVersion: 'v1' },
      mimeType: 'text/plain',
      content: { kind: 'text', text: `note ${n}` },
      metadata: { name: path.split('/').pop()!, pathDisplay: path, locatorUri: `fixture://files${path}` },
      fetchedAt: '2026-09-23T00:00:00.000Z',
    };
  }
  function connectorFor(items: readonly RawItem[], family: SourceConnector['family'] = 'file'): SourceConnector {
    return {
      id: 'fixture',
      family,
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* () { yield { items, done: true }; })();
      },
      async fetchItem(localItemId) {
        const found = items.find((entry) => entry.identity.localItemId === localItemId);
        if (!found) throw new Error('missing');
        return found;
      },
      classificationSignals(raw) {
        return { title: String(raw.metadata['name'] ?? ''), path: String(raw.metadata['pathDisplay'] ?? '') };
      },
    };
  }

  test('a chat message found by search keeps its conversation, so its correction goes through', async () => {
    const dir = tempDir();
    const env = {
      OLYMPUS_TIER_RULES_PATH: join(dir, 'tier-rules.json'),
      OLYMPUS_CLASSIFICATION_LEDGER_PATH: join(dir, 'classification-ledger.jsonl'),
    };
    const dbPath = join(dir, 'chat.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.telegram.chat', family: 'chat', trustDomain: 'internal' });
    cleanups.push(() => { store.close(); clearInstalledTierClassification(); });
    configureInstalledTierClassification({ env });
    const message: RawItem = {
      identity: { family: 'chat', provider: 'telegram', accountScope: 'personal', providerItemId: 'msg-7', providerConversationId: 'chat-3', localItemId: 'personal:chat-3:msg-7', sourceVersion: 'v1' },
      mimeType: 'text/plain',
      content: { kind: 'text', text: 'The violet turnips are ready for Saturday.' },
      metadata: { name: 'Garden chat', pathDisplay: '/chats/garden', locatorUri: 'telegram://chat/chat-3/msg-7' },
      fetchedAt: '2026-09-23T00:00:00.000Z',
    };
    await store.syncFromConnector(connectorFor([message], 'chat'), { fetchContent: true });
    const lanes = () => ({
      registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain })]),
      adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store }) },
      contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) },
    });
    const raw = await searchReleasedEvidence({ lanes: lanes as never, question: 'violet turnips Saturday' });
    expect(raw.evidence[0]).toMatchObject({ provider_item_id: 'msg-7', provider_conversation_id: 'chat-3' });
    const noted = createReleaseCapture();
    runWithReleaseCapture(noted, () => searchToolResult(raw));
    const recorded = noted.items![0]!;
    expect(recorded).toMatchObject({ source: 'Telegram', provider: 'telegram', providerItemId: 'msg-7', providerConversationId: 'chat-3' });
    const context = { storePaths: [dbPath], env };
    runTierSetOnRecordedItem(recorded.locator!, 'private', {
      provider: recorded.provider!,
      providerItemId: recorded.providerItemId!,
      ...(recorded.providerConversationId ? { providerConversationId: recorded.providerConversationId } : {}),
    }, context);
    expect(store.tierLedger()!.getOverride({ provider: 'telegram', accountScope: 'personal', providerItemId: 'msg-7', providerConversationId: 'chat-3' })).toBeDefined();
    // The check still binds the conversation: the same message id without it is refused.
    expect(() => runTierSetOnRecordedItem(recorded.locator!, 'private', { provider: 'telegram', providerItemId: 'msg-7' }, context))
      .toThrow('no longer names the item');
  });

  test('a locator that now names another item, or nothing, changes nothing; the recorded item is raised', async () => {
    const dir = tempDir();
    const env = {
      OLYMPUS_TIER_RULES_PATH: join(dir, 'tier-rules.json'),
      OLYMPUS_CLASSIFICATION_LEDGER_PATH: join(dir, 'classification-ledger.jsonl'),
    };
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    cleanups.push(() => { store.close(); clearInstalledTierClassification(); });
    configureInstalledTierClassification({ env });
    await store.syncFromConnector(connectorFor([item(1, '/notes/a.txt', 'file-1'), item(2, '/notes/b.txt', 'file-2')]), { fetchContent: true });
    const ledger = store.tierLedger()!;
    const context = { storePaths: [dbPath], env };

    // The recorded item was file-1, but its locator now resolves to file-2: refused, nothing written.
    expect(() => runTierSetOnRecordedItem('fixture://files/notes/b.txt', 'private', { provider: 'fixture', providerItemId: 'file-1' }, context))
      .toThrow('no longer names the item');
    expect(ledger.getOverride({ provider: 'fixture', accountScope: 'personal', providerItemId: 'file-2' })).toBeUndefined();
    // A locator that resolves to nothing is refused too.
    expect(() => runTierSetOnRecordedItem('fixture://files/notes/gone.txt', 'private', { provider: 'fixture', providerItemId: 'file-9' }, context))
      .toThrow('No stored item');
    // The recorded item itself is raised.
    runTierSetOnRecordedItem('fixture://files/notes/a.txt', 'private', { provider: 'fixture', providerItemId: 'file-1' }, context);
    expect(ledger.getOverride({ provider: 'fixture', accountScope: 'personal', providerItemId: 'file-1' })).toEqual({ kind: 'tier', tier: 'secure' });
  });
});

describe('a Private match is not a Private answer', () => {
  test('a ChatGPT search with Private matches but no model ready records the items held back, not answered', async () => {
    const records = capture();
    const options = {
      dashboardView: async () => ({ sources: [] }) as never,
      evidenceSearch: async () => recordScriptedSearch({ evidence: [PERSONAL], coverage: {} }),
      privateMatchProbe: async () => ({ count: 2, evidence: [] }),
    } as unknown as ChatGptSurfaceOptions;
    const ctx = { releaseCheck: scriptedSearchReleaseCheck, caller: { surface: 'remote', connectionId: 'conn-gpt', provider: 'openai' } } as OperationContext;
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: 'When is Leo\'s dentist appointment?' }, ctx, options);
    expect((result._meta as Record<string, { count: number; state: string }>)['olympus/privateAnswer']).toMatchObject({ count: 2, state: 'no_model' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ heldBack: 2, answeredPrivately: false });
  });

  test('a handed-off ChatGPT answer keeps its waiting question when collected', async () => {
    const records = capture();
    const { openWaitingPrivateQuestionStore } = await import('../src/core/waiting-private-questions.ts');
    const waiting = openWaitingPrivateQuestionStore(join(tempDir(), 'data', 'waiting.sqlite'));
    cleanups.push(() => waiting.close());
    const refs: string[] = [];
    let finish!: (value: unknown) => void;
    const finished = new Promise((resolve) => { finish = resolve; });
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    const jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, resultWaitMs: 30 } });
    const ctx = {
      config,
      caller: { surface: 'remote', connectionId: 'conn-gpt', provider: 'openai' },
      email: { sourceAnswer: () => finished },
      sourceAnswerJobs: { registry: jobs, owner: 'remote:conn-gpt' },
    } as unknown as OperationContext;
    const options = {
      dashboardView: async () => ({ sources: [] }) as never,
      answerModelAvailable: () => true,
      privateMatchProbe: async () => ({ count: 1, evidence: [] }),
      waitingQuestions: () => ({
        ticket: (connectionId: string) => waiting.ticket(connectionId),
        record: (...args: Parameters<typeof waiting.record>) => { const ref = waiting.record(...args); if (ref) refs.push(`${ref.id}#${ref.generation}`); return ref; },
      }),
    } as unknown as ChatGptSurfaceOptions;
    const handedOff = await callChatGptTool('source_answer', { question: 'When is Leo\'s dentist appointment?' }, ctx, options);
    const jobId = (handedOff.structuredContent as { job_id: string }).job_id;
    expect(jobId).toBeString();
    expect(records).toEqual([]);
    finish({ answer: 'Saturday.', evidence: [PERSONAL] });
    await callChatGptTool('source_answer_result', { job_id: jobId }, ctx, options);
    expect(records).toHaveLength(1);
    expect(refs).toHaveLength(1);
    expect(records[0]!.privateQuestionKey).toBe(refs[0]);
  });

  test('the row says answered privately only once its waiting question\'s answer completes', async () => {
    const clock = createTestClock(Date.parse('2026-11-10T10:00:00Z'));
    const apps = createAppsReceived({ dbPath: join(tempDir(), 'data', 'app-release-log.sqlite'), setItemPrivate: async () => undefined, now: () => clock.now() });
    cleanups.push(() => apps.close());
    const caller = { surface: 'remote' as const, provider: 'openai' as const };
    const leo = { id: 'wq_leo', generation: 1 };
    const noted = { items: [], heldBack: 1, privateQuestion: leo };
    recordAppRequest({ caller, question: 'When is Leo\'s dentist appointment?', capture: noted, now: () => clock.now() });
    const read = async () => ((await apps.handle({ action: 'list' })).body.requests as Array<{ question: string; answeredPrivately: boolean }>);
    expect((await read())[0]).toMatchObject({ answeredPrivately: false });
    notePrivateAnswerCompleted({ id: 'wq_other', generation: 1 });
    expect((await read())[0]).toMatchObject({ answeredPrivately: false });
    notePrivateAnswerCompleted(leo);
    expect((await read())[0]).toMatchObject({ answeredPrivately: true });
    // An answer that completed before its request's result left is known when the row is written.
    recordAppRequest({ caller, question: 'Again?', capture: { items: [], heldBack: 1, privateQuestion: leo }, now: () => clock.now() });
    expect((await read()).find((row) => row.question === 'Again?')).toMatchObject({ answeredPrivately: true });
  });

  test('an earlier answer of a waiting question never completes a later ask of the same question', async () => {
    const clock = createTestClock(Date.parse('2026-11-10T10:00:00Z'));
    const apps = createAppsReceived({ dbPath: join(tempDir(), 'data', 'app-release-log.sqlite'), setItemPrivate: async () => undefined, now: () => clock.now() });
    cleanups.push(() => apps.close());
    const { openWaitingPrivateQuestionStore, WAITING_QUESTION_LIMITS } = await import('../src/core/waiting-private-questions.ts');
    const waiting = openWaitingPrivateQuestionStore(join(tempDir(), 'data', 'waiting.sqlite'), { now: () => clock.now() });
    cleanups.push(() => waiting.close());
    const caller = { surface: 'remote' as const, connectionId: 'conn-a', provider: 'openai' as const };
    const read = async () => ((await apps.handle({ action: 'list' })).body.requests as Array<{ question: string; answeredPrivately: boolean }>);
    const row = async (question: string) => (await read()).find((entry) => entry.question === question);
    const answered = { status: 'answered' as const, answer: 'In the drawer.', citations: [], unanswered: [], leftOut: [], read: [] };

    const first = waiting.record(waiting.ticket('conn-a'), { question: 'Where is the lease?', surface: 'remote', state: 'waiting' })!;
    recordAppRequest({ caller, question: 'Where is the lease?', capture: { items: [], heldBack: 1, privateQuestion: first }, now: () => clock.now() });
    expect(waiting.saveAnswer(first, answered)).toBe(true);
    expect(await row('Where is the lease?')).toMatchObject({ answeredPrivately: true });

    // Asked again once the answer is too old to hand back: the same waiting
    // question, a new generation, its answer not yet made.
    await clock.advance(WAITING_QUESTION_LIMITS.reanswerAfterMs + 60_000);
    const second = waiting.record(waiting.ticket('conn-a'), { question: 'Where is the lease?', surface: 'remote', state: 'waiting' })!;
    expect(second.id).toBe(first.id);
    expect(second.generation).toBe(first.generation + 1);
    recordAppRequest({ caller, question: 'Where is the lease now?', capture: { items: [], heldBack: 1, privateQuestion: second }, now: () => clock.now() });
    expect(await row('Where is the lease now?')).toMatchObject({ answeredPrivately: false });
    // A late note of the first answer marks nothing new.
    notePrivateAnswerCompleted(first);
    expect(await row('Where is the lease now?')).toMatchObject({ answeredPrivately: false });
    // Its own answer does.
    expect(waiting.saveAnswer(second, answered)).toBe(true);
    expect(await row('Where is the lease now?')).toMatchObject({ answeredPrivately: true });
  });

  test('a saved local answer completes its waiting question', async () => {
    const completed: string[] = [];
    const { setPrivateAnswerCompletionHook } = await import('../src/core/app-release-capture.ts');
    setPrivateAnswerCompletionHook((id) => completed.push(id));
    cleanups.push(() => setPrivateAnswerCompletionHook(undefined));
    const { openWaitingPrivateQuestionStore } = await import('../src/core/waiting-private-questions.ts');
    const store = openWaitingPrivateQuestionStore(join(tempDir(), 'data', 'waiting.sqlite'));
    cleanups.push(() => store.close());
    const ref = store.record(store.ticket('conn-a'), { question: 'Where is the lease?', surface: 'remote', state: 'waiting' })!;
    store.saveAnswer(ref, { status: 'failed', citations: [], unanswered: [], leftOut: [], read: [] });
    expect(completed).toEqual([]);
    const second = store.record(store.ticket('conn-a'), { question: 'Who signed it?', surface: 'remote', state: 'waiting' })!;
    store.saveAnswer(second, { status: 'answered', answer: 'Alice.', citations: [], unanswered: [], leftOut: [], read: [] });
    expect(completed).toEqual([`${second.id}#${second.generation}`]);
  });
});

// ---- the worker: only a local control session reads the list ------------------

const ORIGIN = 'http://127.0.0.1:28193';
const TOKEN = 'worker-secret';

function worker(appsReceived: { handle: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }> }) {
  const dir = tempDir();
  const created = createEmailSourceWorker({
    sourceIndexStatus: { async status() { return { kind: 'source_index_status', corpora: [] } as unknown as SourceIndexStatusResult; } },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
      registryPath: join(dir, 'handles.json'),
      registryAdoptionIntervalMs: 0,
      appsReceived,
    },
  });
  cleanups.push(() => created.close?.());
  return withWorkerBearerAuth((request: Request) => created.fetch(request), { authToken: TOKEN, launchTickets: new DashboardLaunchTickets() });
}

describe('the worker serves the list only inside a local control session', () => {
  test('the bearer, a bearer-minted session, a dash_ reader and the relay get nothing; a local session reads it', async () => {
    const calls: string[] = [];
    const fetcher = worker({
      handle: async (body) => {
        calls.push(String(body.action));
        return { status: 200, body: { ok: true, requests: [{ question: 'SENTINEL_QUESTION' }] } };
      },
    });
    const post = (headers: Record<string, string>) => fetcher(new Request(`${ORIGIN}/dashboard/apps-received`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action: 'list' }),
    }));
    const bearer = await post({ Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN });
    expect(bearer.status).toBe(403);
    expect(await bearer.text()).not.toContain('SENTINEL');
    const mint = await fetcher(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
    const bearerSession = { cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await mint.json()) as { csrf_token: string }).csrf_token };
    const minted = await post({ Cookie: bearerSession.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': bearerSession.csrf });
    expect(minted.status).toBe(403);
    expect(((await minted.json()) as { error: { code: string } }).error.code).toBe('mac_dashboard_only');
    expect((await post({ Authorization: 'Bearer dash_reader', Origin: ORIGIN })).status).toBe(401);
    expect((await post({ Origin: 'https://chatgpt.com' })).status).toBe(401);
    expect((await post({ Origin: ORIGIN })).status).toBe(401);
    // A forged grade header is stripped at the boundary.
    expect((await post({ Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'X-Olympus-Control-Session-Grade': 'local', 'X-Olympus-Control-Session-CSRF': 'x' })).status).toBe(403);
    expect(calls).toEqual([]);

    // The local session is minted as the owner's browser does it: from the control session its launch opened (#1153).
    const local = await ownerLocalMint(fetcher, ORIGIN, TOKEN);
    const session = { cookie: local.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await local.json()) as { csrf_token: string }).csrf_token };
    const ok = await post({ Cookie: session.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': session.csrf });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.text()).toContain('SENTINEL_QUESTION');
    expect(calls).toEqual(['list']);
  });

  test('the page carries no request; a locked or bearer-grade reader gets only the way to unlock', async () => {
    const fetcher = worker({ handle: async () => ({ status: 200, body: { ok: true, requests: [] } }) });
    const bearer = await (await fetcher(new Request(`${ORIGIN}/dashboard?apps-received`, { headers: { Authorization: `Bearer ${TOKEN}` } }))).text();
    expect(bearer).toContain('data-ar-locked');
    expect(bearer).not.toContain('<ul class="arlist"');
    expect(bearer).toContain('What AI apps received');
    const local = renderDashboardAppsReceivedPage({ controlSessionCsrfToken: 'csrf', outsideHelpLocalSession: true, appsReceivedAvailable: true });
    expect(local).toContain('<ul class="arlist"');
    expect(local).toContain('aria-current="page" href="/dashboard?apps-received"');
    const remote = renderDashboardAppsReceivedPage({ controlSessionCsrfToken: 'csrf', outsideHelpLocalSession: false, appsReceivedAvailable: true });
    expect(remote).toContain('data-ar-unlock');
    expect(remote).not.toContain('<ul class="arlist"');
  });

  test('no agent or remote tool can read the list', async () => {
    const { readFileSync } = await import('node:fs');
    const { Glob } = await import('bun');
    // The only readers: the store, the worker's dashboard handler and its wiring. No tool, relay or remote surface.
    const readers: string[] = [];
    for (const file of new Glob('{src,connect-relay}/**/*.ts').scanSync({ cwd: join(import.meta.dir, '..') })) {
      const text = readFileSync(join(import.meta.dir, '..', file), 'utf8');
      if (/openAppReleaseLog\(|createAppsReceived\(|sourceDashboard\??\.appsReceived\b/.test(text)) readers.push(file);
    }
    expect(readers.sort()).toEqual([
      'src/core/app-release-log.ts',
      'src/workers/apps-received.ts',
      'src/workers/email-source/index.ts',
      'src/workers/email-source/server.ts',
    ]);
  });
});

describe('a local agent\'s answer is recorded only at its tool result', () => {
  // The real path: the operation, the agent's EmailClient, and the worker that keeps the log.
  // A worker answer as the agent's client accepts it.
  const answered = (evidence: unknown[]) => ({
    answer: 'Two.',
    evidence,
    audit: { raw_source_exposed: false, searched_corpora: [], skipped_corpora: [], lane_audits: [], latency_ms: 1 },
    policy: { raw_source_exposed: false, source_packets_exposed: false, secure_local_content_exposed: false, castor_safe_bridge: true },
  });
  function engine(answer: () => Promise<unknown>, options: { withhold?: boolean } = {}) {
    const worker = createEmailSourceWorker({
      // An answer from no source item: its (empty) manifest passes the release check.
      sourceAnswer: { answer: async () => {
        recordReleaseManifest({ inputs: [], constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } });
        return answer();
      } } as never,
      sourceAnswerReleaseCheck: { inputs: () => [], secureDerivativeDefault: () => 'allow' } as never,
    });
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = true;
    const posted: string[] = [];
    const transport = new DirectHttpEmailTransport((url, init) => {
      posted.push(new URL(String(url)).pathname);
      if (options.withhold && String(url).endsWith('/source/answer/release')) {
        return Promise.resolve(Response.json({ withheld: 'Olympus withheld this answer because an item became Private.' }));
      }
      return worker.fetch(new Request(url, init));
    });
    return { email: new EmailClient(config, transport), config, posted };
  }
  function context(surface: 'mcp' | 'native' | 'cli', email: EmailClient, config: ReturnType<typeof defaultConfig>, jobs?: SourceAnswerJobRegistry): OperationContext {
    return {
      config,
      caller: { surface, displayName: 'Muse' },
      email,
      ...(jobs ? { sourceAnswerJobs: { registry: jobs, owner: `${surface}:test` } } : {}),
    } as unknown as OperationContext;
  }

  test('a handed-off job is recorded when collected, not when the worker finishes, and with its question', async () => {
    const records = capture();
    let finish!: (value: unknown) => void;
    const finished = new Promise((resolve) => { finish = resolve; });
    const { email, config, posted } = engine(() => finished);
    const jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, resultWaitMs: 30 } });
    const ctx = context('mcp', email, config, jobs);
    const pending = await findOperationByName('source_answer')!.handler(ctx, { question: 'Which invoices are unpaid?' }) as SourceAnswerPending;
    expect(pending.status).toBe('working');
    finish(answered([PERSONAL]));
    // The job finishes in the background, through the worker: still nothing listed.
    await waitFor(() => posted.some((path) => path.endsWith('/source/answer/release')));
    await flushMicrotasks();
    expect(records).toEqual([]);
    const collected = await findOperationByName('source_answer_result')!.handler(ctx, { job_id: pending.job_id }) as { answer: string };
    expect(collected.answer).toBe('Two.');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ connection: { name: 'Muse', kind: 'agent' }, question: 'Which invoices are unpaid?', withheld: false });
    expect(records[0]!.items.map((item) => item.title)).toEqual(['Appointment confirmed: Leo']);
    // Collected again, it is not listed twice.
    await findOperationByName('source_answer_result')!.handler(ctx, { job_id: pending.job_id }).catch(() => undefined);
    expect(records).toHaveLength(1);
  });

  test('an answer the release check withholds is recorded as withheld, with no items', async () => {
    const records = capture();
    const { email, config } = engine(async () => answered([PERSONAL]), { withhold: true });
    const released = await findOperationByName('source_answer')!.handler(context('mcp', email, config), { question: 'Which invoices are unpaid?' });
    expect(JSON.stringify(released)).not.toContain('Appointment confirmed');
    expect(records).toHaveLength(1);
    expect(records[0]!.withheld).toBe(true);
    expect(records[0]!.items).toEqual([]);
  });

  test('an OpenClaw tool is recorded at its result; the owner\'s command line is not', async () => {
    const records = capture();
    const { email, config, posted } = engine(async () => answered([PERSONAL]));
    await findOperationByName('source_answer')!.handler(context('native', email, config), { question: 'Which invoices are unpaid?' });
    expect(records).toHaveLength(1);
    await findOperationByName('source_answer')!.handler(context('cli', email, config), { question: 'Which invoices are unpaid?' });
    expect(records).toHaveLength(1);
    expect(posted.filter((path) => path.endsWith('/source/answer/received'))).toHaveLength(1);
  });

  test('the worker records only what it kept, once, and nothing for an unknown ticket', async () => {
    const records = capture();
    const worker = createEmailSourceWorker({ sourceAnswer: { answer: async () => ({ answer: 'Two.', evidence: [PERSONAL] }) } as never });
    const post = (path: string, body: unknown) => worker.fetch(new Request(`http://worker.test/v1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const answered = await (await post('/source/answer', { question: 'Which invoices are unpaid?', caller: { surface: 'mcp', display_name: 'Muse' } })).json() as { _release_ticket: string };
    // The answer route itself records nothing.
    expect(records).toEqual([]);
    expect((await post('/source/answer/received', { ticket: 'not-a-ticket', withheld: false })).status).toBe(200);
    expect(records).toEqual([]);
    await post('/source/answer/received', { ticket: answered._release_ticket, withheld: false });
    await post('/source/answer/received', { ticket: answered._release_ticket, withheld: false });
    expect(records).toHaveLength(1);
    expect(records[0]!.question).toBe('Which invoices are unpaid?');
  });
});
