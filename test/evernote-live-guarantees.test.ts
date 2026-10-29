// What the live Evernote source promises the person, each proved end to end
// against the fake Evernote MCP server (no network, no real account):
//
// 1. Sign-in asks for `read` alone; the tokens live in the secret store and
//    nowhere else on disk.
// 2. Only the four read tools are ever called (the server's write tools never).
// 3. Notes shared with the person are not imported, and are counted.
// 4. Nothing is deleted unless both listings of a pass completed.
// 5. A notebook's name is the folder key of its notes and their attachments.
// 6. Attachments are keyed by their MD5 exactly as an ENEX export keys them
//    (`<md5>`, then `<md5>.<n>`), and bytes are checked against it.
// 7. No note title, body, tag or notebook name reaches the logs.
import { readdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { EVERNOTE_ENEX_ARCHIVE_FORMAT } from '../src/core/archive-formats.ts';
import { CHILD_ITEM_ID_SEPARATOR } from '../src/core/child-item-id.ts';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';
import { McpCallPacer } from '../src/core/mcp-source/pacer.ts';
import { McpSourceSession } from '../src/core/mcp-source/session.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { createEvernoteArchiveConnector } from '../src/workers/archive-import/evernote/connector.ts';
import { EVERNOTE_READ_TOOLS, createEvernoteSourceConnector, type EvernotePassRecord } from '../src/workers/evernote/connector.ts';
import { startEvernoteSignIn } from '../src/workers/evernote/live-sync.ts';
import { createEvernoteRuntime } from '../src/workers/evernote/runtime.ts';
import { enexExport, pngBytes } from './support/archive-fixtures-evernote.ts';
import { listAll, openConnector, writeExport } from './support/archive-notes-harness.ts';
import { FakeEvernoteServer, md5Hex } from './support/evernote-mcp-fake.ts';

let fake: FakeEvernoteServer | undefined;
const cleanups: Array<() => void> = [];
afterEach(() => {
  fake?.stop();
  fake = undefined;
  while (cleanups.length) cleanups.pop()!();
});

const day = (year: number, month = 1, date = 1): number => Date.UTC(year, month - 1, date, 12);
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF');

function memorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  return {
    label: 'memory',
    async get(key) { return secrets.get(key); },
    getSync(key) { return secrets.get(key); },
    async set(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
    async list() { return [...secrets.keys()].sort(); },
  };
}

function home(): { base: string; env: Record<string, string>; registryPath: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'evernote-guarantees-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return {
    base,
    env: { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') },
    registryPath: join(base, 'handles.json'),
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Distinct words a log line could leak: titles, body text, tags, notebook names. */
const PRIVATE = {
  notebook: 'Quillfeather Notebook',
  secret: 'Secret Zanzibar Vault',
  title: 'Marmalade Expedition Plans',
  body: 'the gondola code is ochre-seventeen',
  tag: 'tangerine-ledger',
  sharedTitle: 'Somebody Elses Wombat Memo',
  sharedBody: 'borrowed pelican paragraph',
  photoTitle: 'Harbour photo note',
};

function seed(server: FakeEvernoteServer) {
  const book = server.addNotebook(PRIVATE.notebook);
  const secret = server.addNotebook(PRIVATE.secret);
  const plain = server.addNote({ title: PRIVATE.title, created: day(2024), notebookId: book.id, body: PRIVATE.body, tags: [PRIVATE.tag] });
  const photo = pngBytes(7);
  const withFiles = server.addNote({
    title: PRIVATE.photoTitle,
    created: day(2024, 2),
    notebookId: secret.id,
    body: 'the photo, the scan, and the photo again',
    resources: [
      { bytes: photo, mime: 'image/png', name: 'harbour.png' },
      { bytes: PDF, mime: 'application/pdf', name: 'scan.pdf' },
      { bytes: photo, mime: 'image/png', name: 'harbour copy.png' },
    ],
  });
  const shared = server.addNote({ title: PRIVATE.sharedTitle, created: day(2024, 3), body: PRIVATE.sharedBody });
  return { book, secret, plain, withFiles, shared, photo };
}

async function connected(server: FakeEvernoteServer) {
  const { base, env, registryPath } = home();
  const secretStore = memorySecretStore();
  const signIn = await startEvernoteSignIn({
    serverUrl: server.url,
    authorizationHosts: ['127.0.0.1'],
    redirectUri: 'http://127.0.0.1:9/oauth/callback/evernote',
    state: 'state-1',
    secretStore,
    registryPath,
  });
  const authorization = new URL(signIn.authorizationUrl);
  const handle = await signIn.complete('good-code');
  const runtime = createEvernoteRuntime({
    env,
    secretStore: () => secretStore,
    registryPath,
    serverUrl: server.url,
    downloadHosts: ['127.0.0.1'],
    pacer: new McpCallPacer({ minIntervalMs: 0 }),
  });
  return { base, env, registryPath, secretStore, handle, runtime, authorization, sync: runtime.liveSync(handle) };
}

function connectorFor(server: FakeEvernoteServer, previous?: () => EvernotePassRecord | undefined) {
  return createEvernoteSourceConnector({
    accountScope: 'personal',
    session: () => new McpSourceSession({
      serverUrl: server.url,
      clientName: 'olympus-test',
      clientVersion: '1.0.0',
      readTools: EVERNOTE_READ_TOOLS,
      callBudget: 5_000,
      pacer: new McpCallPacer({ minIntervalMs: 0 }),
      rateLimitBackoffMs: 1,
    }),
    ...(previous ? { previous } : {}),
    downloadHosts: ['127.0.0.1'],
  });
}

async function pass(connector: ReturnType<typeof connectorFor>): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for await (const page of connector.listItems() as AsyncIterable<SourceConnectorListPage>) items.push(...page.items);
  return items;
}

const childKey = (item: RawItem): string => item.identity.providerItemId.split(CHILD_ITEM_ID_SEPARATOR)[1] ?? '';

/** Everything written to the console, stdout and stderr while `work` runs. */
async function capturingLogs(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const saved = methods.map((name) => console[name]);
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const keep = (...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })())).join(' ')); };
  for (const name of methods) console[name] = keep;
  process.stdout.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await work();
  } finally {
    methods.forEach((name, index) => { console[name] = saved[index]!; });
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
  return lines.join('\n');
}

describe('the live Evernote source', () => {
  test('1. sign-in asks for read alone, and the tokens stay in the secret store', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    seed(fake);
    const { base, secretStore, authorization, sync } = await connected(fake);
    expect(authorization.searchParams.get('scope')).toBe('read');
    expect(fake.registeredScopes).toEqual(['read']);
    await sync.pass();
    const stored = JSON.parse((await secretStore.get('evernote.personal.mcp_credential'))!) as { tokens: { access_token: string; refresh_token: string }; scope: string };
    expect(stored.scope).toBe('read');
    expect(stored.tokens.access_token).toBe(fake.accessToken);
    // No file Olympus wrote (registry, stores, pass record) holds a token.
    const files = filesUnder(base);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file).toString('latin1');
      expect(text.includes(stored.tokens.access_token)).toBe(false);
      expect(text.includes(stored.tokens.refresh_token)).toBe(false);
    }
  });

  test('2. a pass and an attachment read call only the four read tools', async () => {
    fake = new FakeEvernoteServer().start();
    const { withFiles } = seed(fake);
    const connector = connectorFor(fake);
    const items = await pass(connector);
    const child = items.find((item) => item.identity.parent?.providerItemId === withFiles.id)!;
    await connector.fetchItemWithin(child.identity.localItemId, { deferredBytes: child.deferredBytes! });
    expect(Object.keys(fake.calls).sort()).toEqual([...EVERNOTE_READ_TOOLS].sort());
    expect(fake.calls.create_note).toBeUndefined();
    expect(fake.calls.delete_note).toBeUndefined();
  });

  test('3. a note shared with the person is not imported, and is counted', async () => {
    fake = new FakeEvernoteServer().start();
    const { shared } = seed(fake);
    const connector = connectorFor(fake);
    const items = await pass(connector);
    expect(items.some((item) => item.identity.providerItemId === shared.id)).toBe(false);
    expect(connector.lastOutcome()?.counts.shared_not_imported).toBe(1);
  });

  test('4. a pass that cannot finish both listings deletes nothing; a complete one deletes', async () => {
    fake = new FakeEvernoteServer().start();
    const { plain } = seed(fake);
    let record: EvernotePassRecord | undefined;
    const first = connectorFor(fake, () => record);
    await pass(first);
    record = first.lastOutcome()!.record;

    fake.notes.splice(fake.notes.indexOf(plain), 1);
    for (const failing of ['search_notes', 'search_notebooks']) {
      fake.failTool = failing;
      const partial = connectorFor(fake, () => record);
      const emitted: RawItem[] = [];
      await expect((async () => { for await (const page of partial.listItems() as AsyncIterable<SourceConnectorListPage>) emitted.push(...page.items); })()).rejects.toThrow();
      expect(emitted).toEqual([]);
      expect(partial.lastOutcome()).toBeUndefined();
    }
    fake.failTool = undefined;
    const complete = connectorFor(fake, () => record);
    const items = await pass(complete);
    expect(items.filter((item) => item.metadata.deleted === true).map((item) => item.identity.providerItemId)).toEqual([plain.id]);
  });

  test('5 and 6. notebook names are folder keys; attachment keys and folder keys match an ENEX export of the same note', async () => {
    fake = new FakeEvernoteServer().start();
    const { withFiles, photo } = seed(fake);
    const connector = connectorFor(fake);
    const live = await pass(connector);
    const note = live.find((item) => item.identity.providerItemId === withFiles.id)!;
    const children = live.filter((item) => item.identity.parent?.providerItemId === withFiles.id);
    const liveKeys = children.map(childKey);
    expect(liveKeys).toEqual([md5Hex(photo), md5Hex(PDF), `${md5Hex(photo)}.2`]);
    // The notebook's name first, as the export gives it; the live note adds the notebook's id.
    for (const item of [note, ...children]) expect(connector.classificationSignals(item).folderKeys).toEqual([PRIVATE.secret, String(note.metadata.notebookId)]);

    // The same note exported from that notebook (Evernote names the file after it).
    const file = writeExport(cleanups, `${PRIVATE.secret}.enex`, enexExport([{
      title: PRIVATE.photoTitle,
      enml: '<div>the photo, the scan, and the photo again</div>',
      created: '20240201T120000Z',
      resources: [
        { mime: 'image/png', fileName: 'harbour.png', bytes: photo },
        { mime: 'application/pdf', fileName: 'scan.pdf', bytes: PDF },
        { mime: 'image/png', fileName: 'harbour copy.png', bytes: photo },
      ],
    }]));
    const enex = openConnector(cleanups, file.dir, [`${PRIVATE.secret}.enex`], EVERNOTE_ENEX_ARCHIVE_FORMAT, createEvernoteArchiveConnector).connector;
    const exported = (await listAll(enex)).items;
    expect(exported.slice(1).map(childKey)).toEqual(liveKeys);
    for (const item of exported) expect(enex.classificationSignals(item).folderKeys).toEqual([PRIVATE.secret]);

    // Bytes are read through a fresh link and checked against the key's MD5.
    const read = await connector.fetchItemWithin(children[1]!.identity.localItemId, { deferredBytes: children[1]!.deferredBytes! });
    expect(read.mimeType).toBe('application/pdf');
    fake.notes.find((entry) => entry.id === withFiles.id)!.resources![1]!.listedHash = md5Hex(PDF);
    fake.notes.find((entry) => entry.id === withFiles.id)!.resources![1]!.bytes = new TextEncoder().encode('%PDF-1.4 tampered');
    await expect(connector.fetchItemWithin(children[1]!.identity.localItemId, { deferredBytes: children[1]!.deferredBytes! }))
      .rejects.toThrow('source_content_unavailable');
  });

  test('7. no note title, body, tag or notebook name reaches the logs', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const { plain } = seed(fake);
    const { sync, runtime, handle } = await connected(fake);
    const logs = await capturingLogs(async () => {
      await sync.pass();
      // A note changes, one is deleted, and the listing then fails: every path that might say something.
      plain.updated = day(2025);
      await sync.pass();
      fake!.notes.splice(fake!.notes.indexOf(plain), 1);
      fake!.failTool = 'search_notebooks';
      await sync.pass().catch(() => undefined);
      fake!.failTool = undefined;
      await sync.pass();
      // The attachment reads, as the scheduler runs them.
      const source = runtime.schedulerSource({
        config: { worker: { scheduler: { syncIntervalSeconds: 3600, freshnessThresholdHours: 26 } } } as never,
        handle,
        notebookGate: () => () => 'ingest',
      assertNotebookChoiceCurrent: () => undefined,
      scope: { accountGeneration: 'a'.repeat(64), scopeRevision: '00000000-0000-4000-8000-000000000000' },
      });
      for (const task of source.tasks.slice(1)) await task.run({} as never).catch(() => undefined);
    });
    expect(fake.calls.get_attachment ?? 0).toBeGreaterThan(0);
    for (const words of Object.values(PRIVATE)) expect(logs.toLowerCase()).not.toContain(words.toLowerCase());
  });
});
