// The live Evernote connector against the fake Evernote MCP server only: the
// two listings (cap splitting by date, notebook enumeration by name
// fragments), what a pass reads, moves, deletions only after both listings
// complete, a partial pass changing nothing, shared notes counted and not
// imported, and attachments (MD5 keys, MIME from bytes, MD5 mismatch refused).
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnectorListPage, StoredItemLookup } from '../src/core/contracts.ts';
import { McpCallPacer } from '../src/core/mcp-source/pacer.ts';
import { McpSourceSession } from '../src/core/mcp-source/session.ts';
import {
  EVERNOTE_READ_TOOLS,
  createEvernoteSourceConnector,
  evernoteAttachmentKeys,
  evernotePassWithUnfinished,
  evernoteUnfinishedWith,
  type EvernotePassRecord,
  type EvernoteSourceConnector,
} from '../src/workers/evernote/connector.ts';
import { EvernoteAccountChanged, EvernoteListingIncomplete } from '../src/workers/evernote/listing.ts';
import { FakeEvernoteServer, md5Hex } from './support/evernote-mcp-fake.ts';

let fake: FakeEvernoteServer | undefined;
afterEach(() => {
  fake?.stop();
  fake = undefined;
});

const day = (year: number, month = 1, date = 1): number => Date.UTC(year, month - 1, date, 12);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.4\nPRIVATE_EVERNOTE_MARKER\n%%EOF');

function connectorFor(server: FakeEvernoteServer, options: { callBudget?: number; previous?: () => EvernotePassRecord | undefined; readSoFar?: (notes: EvernotePassRecord['notes']) => void } = {}): EvernoteSourceConnector {
  return createEvernoteSourceConnector({
    accountScope: 'personal',
    session: () => new McpSourceSession({
      serverUrl: server.url,
      clientName: 'olympus-test',
      clientVersion: '1.0.0',
      readTools: EVERNOTE_READ_TOOLS,
      callBudget: options.callBudget ?? 5_000,
      pacer: new McpCallPacer({ minIntervalMs: 0 }),
      rateLimitBackoffMs: 1,
    }),
    ...(options.previous ? { previous: options.previous } : {}),
    ...(options.readSoFar ? { readSoFar: options.readSoFar } : {}),
    downloadHosts: ['127.0.0.1'],
  });
}

async function runPass(connector: EvernoteSourceConnector): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for await (const page of connector.listItems() as AsyncIterable<SourceConnectorListPage>) items.push(...page.items);
  return items;
}

/** Two passes in a row, the second seeing the first's record (as the live sync keeps it). */
function chained(server: FakeEvernoteServer): { pass: () => Promise<RawItem[]>; connector: () => EvernoteSourceConnector } {
  let record: EvernotePassRecord | undefined;
  let current: EvernoteSourceConnector | undefined;
  return {
    connector: () => current!,
    async pass() {
      current = connectorFor(server, { previous: () => record });
      const items = await runPass(current);
      record = current.lastOutcome()?.record;
      return items;
    },
  };
}

const notesOf = (items: readonly RawItem[]) => items.filter((item) => !item.identity.parent && item.metadata.deleted !== true);

describe('Evernote listing', () => {
  test('a total over the search cap is split by creation time until every slice fits', async () => {
    fake = new FakeEvernoteServer({ cap: 5 }).start();
    const book = fake.addNotebook('Work');
    for (let index = 0; index < 23; index += 1) fake.addNote({ title: `Note ${index}`, notebookId: book.id, created: day(2000 + index) });
    // Two notes before 1990, one far in the future: the open-ended slices.
    fake.addNote({ title: 'Old', notebookId: book.id, created: day(1975) });
    fake.addNote({ title: 'Older', notebookId: book.id, created: day(1980) });
    const connector = connectorFor(fake);
    const items = await runPass(connector);
    expect(notesOf(items)).toHaveLength(25);
    expect(connector.lastOutcome()?.counts.notes_listed).toBe(25);
    expect(fake.calls.search_notes).toBeGreaterThan(10);
  });

  test('a slice over the cap that cannot be split stops the pass before anything is emitted', async () => {
    fake = new FakeEvernoteServer({ cap: 2 }).start();
    const book = fake.addNotebook('Work');
    for (let index = 0; index < 3; index += 1) fake.addNote({ title: `Same second ${index}`, notebookId: book.id, created: day(2020) });
    const connector = connectorFor(fake);
    const pages: SourceConnectorListPage[] = [];
    const error = await (async () => {
      for await (const page of connector.listItems()) pages.push(page);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvernoteListingIncomplete);
    expect(pages).toHaveLength(0);
    expect(connector.lastOutcome()).toBeUndefined();
    expect(fake.calls.get_note).toBeUndefined();
  });

  test('more than 100 notebooks are found by name fragments', async () => {
    fake = new FakeEvernoteServer().start();
    const words = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Projects', 'Journal', 'Recipes', 'Travel', 'Taxes', 'Ζωή', 'Ünïcode'];
    for (let index = 0; index < 160; index += 1) {
      const book = fake.addNotebook(`${words[index % words.length]} ${index}`);
      fake.addNote({ title: `In ${book.label}`, notebookId: book.id, created: day(2010, 1 + (index % 12), 1 + (index % 28)) });
    }
    const connector = connectorFor(fake);
    const items = await runPass(connector);
    expect(connector.lastOutcome()?.counts.notebooks).toBe(160);
    const notes = notesOf(items);
    expect(notes).toHaveLength(160);
    // Every note carries its own notebook as its folder key.
    for (const note of notes) expect(note.metadata.folderKeys).toEqual([String(note.metadata.title).slice(3)]);
  });
});

describe('Evernote pass', () => {
  test('a note is its title, notebook, tags and body; notebook is its folder key and tags its labels', async () => {
    fake = new FakeEvernoteServer().start();
    const book = fake.addNotebook('Recipes');
    fake.addNote({ title: 'Bread', notebookId: book.id, created: day(2021), tags: ['baking', 'home'], body: 'Flour, water, PRIVATE_EVERNOTE_MARKER.' });
    const connector = connectorFor(fake);
    const [note] = await runPass(connector);
    expect(note!.identity).toMatchObject({ family: 'note', provider: 'evernote', accountScope: 'personal' });
    expect(note!.content.kind).toBe('text');
    const text = (note!.content as { text: string }).text;
    expect(text).toContain('Bread');
    expect(text).toContain('Notebook: Recipes');
    expect(text).toContain('Tags: baking, home');
    expect(text).toContain('PRIVATE_EVERNOTE_MARKER');
    expect(connector.classificationSignals(note!)).toEqual({ title: 'Bread', folderKeys: ['Recipes'], labels: ['baking', 'home'] });
    expect(await connector.fetchItem(note!.identity.localItemId)).toBe(note!);
  });

  test('an unchanged note is not read again; a newer one and a moved one are', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const home = fake.addNotebook('Home');
    const a = fake.addNote({ title: 'A', notebookId: work.id, created: day(2020) });
    const b = fake.addNote({ title: 'B', notebookId: work.id, created: day(2021) });
    fake.addNote({ title: 'C', notebookId: work.id, created: day(2022) });
    const run = chained(fake);
    expect(notesOf(await run.pass())).toHaveLength(3);
    expect(fake.calls.get_note).toBe(3);

    expect(await run.pass()).toHaveLength(0);
    expect(fake.calls.get_note).toBe(3);
    expect(run.connector().lastOutcome()?.counts.notes_unchanged).toBe(3);

    a.updated = day(2024);
    b.notebookId = home.id;
    const third = notesOf(await run.pass());
    expect(third.map((note) => note.metadata.title).sort()).toEqual(['A', 'B']);
    expect(third.find((note) => note.metadata.title === 'B')!.metadata.folderKeys).toEqual(['Home']);
    expect(run.connector().lastOutcome()?.counts.notes_moved).toBe(1);
    expect(fake.calls.get_note).toBe(5);
  });

  test('a stored note with no committed pass record is read again, with its attachments', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    fake.addNote({
      title: 'A', notebookId: work.id, created: day(2020),
      resources: [{ bytes: PNG, mime: 'image/png', name: 'a.png' }, { bytes: PNG, mime: 'image/png', name: 'b.png' }],
    });
    const first = connectorFor(fake);
    const [note] = await runPass(first);
    const stored = note!.identity.sourceVersion;
    // The pass stopped after the store wrote the note but before its record was committed.
    const second = connectorFor(fake);
    const items: RawItem[] = [];
    for await (const page of second.listItems({ storedItem: () => ({ version: stored!, hasContent: true }) })) items.push(...page.items);
    expect(fake.calls.get_note).toBe(2);
    expect(items.map((item) => item.identity.providerItemId).sort()).toEqual([
      note!.identity.providerItemId,
      `${note!.identity.providerItemId}#child:${md5Hex(PNG)}`,
      `${note!.identity.providerItemId}#child:${md5Hex(PNG)}.2`,
    ].sort());
  });

  test('the store\'s own version decides what is read when a committed record agrees', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    fake.addNote({ title: 'A', notebookId: work.id, created: day(2020) });
    let record: EvernotePassRecord | undefined;
    const first = connectorFor(fake, { previous: () => record });
    const [note] = await runPass(first);
    record = first.lastOutcome()?.record;
    const stored = note!.identity.sourceVersion;
    const server = fake;
    const read = async (storedItem: StoredItemLookup) => {
      const items: RawItem[] = [];
      for await (const page of connectorFor(server, { previous: () => record }).listItems({ storedItem })) items.push(...page.items);
      return items;
    };
    expect(await read(() => ({ version: stored!, hasContent: true }))).toHaveLength(0);
    expect(fake.calls.get_note).toBe(1);
    expect(notesOf(await read(() => ({ version: stored!, hasContent: true, tombstoned: true })))).toHaveLength(1);
    expect(fake.calls.get_note).toBe(2);
  });

  test('an attachment an unfinished pass saw stays recorded until a pass commits', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const note = fake.addNote({
      title: 'A', notebookId: work.id, created: day(2020),
      resources: [{ bytes: PNG, mime: 'image/png', name: 'a.png' }],
    });
    // A first pass stops after storing the note and its attachment.
    let unfinished: EvernotePassRecord['notes'] | undefined;
    const first = connectorFor(fake, { readSoFar: (notes) => { unfinished = evernoteUnfinishedWith(unfinished, notes); } });
    await runPass(first);
    // The attachment goes; a retry reads the note without it, and stops again before storing the deletion.
    note.resources = [];
    note.updated = day(2024);
    const retry = connectorFor(fake, {
      previous: () => evernotePassWithUnfinished(undefined, unfinished),
      readSoFar: (notes) => { unfinished = evernoteUnfinishedWith(unfinished, notes); },
    });
    await runPass(retry);
    // The next complete pass still deletes it.
    const final = connectorFor(fake, { previous: () => evernotePassWithUnfinished(undefined, unfinished) });
    const items = await runPass(final);
    expect(items.filter((item) => item.metadata.deleted === true).map((item) => item.identity.providerItemId))
      .toEqual([`${note.id}#child:${md5Hex(PNG)}`]);
  });

  test('another account behind the credential deletes nothing of the stored one', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    fake.addNote({ title: 'Mine', notebookId: work.id, created: day(2020) });
    let record: EvernotePassRecord | undefined;
    const first = connectorFor(fake, { previous: () => record });
    await runPass(first);
    record = first.lastOutcome()!.record;
    fake.stop();

    // The same credential now reaches another account: other notebooks, other notes.
    fake = new FakeEvernoteServer().start();
    const theirs = fake.addNotebook('Work');
    fake.addNote({ title: 'Theirs', notebookId: theirs.id, created: day(2021) });
    const next = connectorFor(fake, { previous: () => record });
    await expect(runPass(next)).rejects.toBeInstanceOf(EvernoteAccountChanged);
    expect(fake.calls.get_note ?? 0).toBe(0);
  });

  test('a deletion applies only when both listings completed', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const gone = fake.addNote({
      title: 'Gone soon', notebookId: work.id, created: day(2020),
      resources: [{ bytes: PNG, mime: 'image/png', name: 'a.png' }],
    });
    fake.addNote({ title: 'Stays', notebookId: work.id, created: day(2021) });
    const run = chained(fake);
    await run.pass();
    fake.notes.splice(fake.notes.indexOf(gone), 1);

    // The notebook listing fails: nothing is emitted, nothing deleted.
    fake.failTool = 'search_notebooks';
    await expect(run.pass()).rejects.toBeInstanceOf(EvernoteListingIncomplete);
    expect(run.connector().lastOutcome()).toBeUndefined();

    fake.failTool = undefined;
    const items = await run.pass();
    const deleted = items.filter((item) => item.metadata.deleted === true);
    expect(deleted.map((item) => item.identity.providerItemId)).toEqual([gone.id, `${gone.id}#child:${md5Hex(PNG)}`]);
    expect(run.connector().lastOutcome()?.counts.notes_deleted).toBe(1);
  });

  test('a note shared with the person is not imported, and is counted', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    fake.addNote({ title: 'Mine', notebookId: work.id, created: day(2020) });
    fake.addNote({ title: 'Shared', created: day(2021), body: 'PRIVATE_EVERNOTE_MARKER' });
    const run = chained(fake);
    const items = await run.pass();
    expect(items.map((item) => item.metadata.title)).toEqual(['Mine']);
    expect(run.connector().lastOutcome()?.counts.shared_not_imported).toBe(1);
    expect(JSON.stringify(run.connector().lastOutcome())).not.toContain('PRIVATE_EVERNOTE_MARKER');
    const calls = fake.calls.get_note;
    expect(await run.pass()).toHaveLength(0);
    expect(fake.calls.get_note).toBe(calls);
    expect(run.connector().lastOutcome()?.counts.shared_not_imported).toBe(1);
  });

  test('an imported note that becomes shared-only leaves the index with its attachments', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const note = fake.addNote({
      title: 'Was mine', notebookId: work.id, created: day(2020),
      resources: [{ bytes: PNG, mime: 'image/png', name: 'a.png' }],
    });
    const run = chained(fake);
    expect(notesOf(await run.pass())).toHaveLength(1);
    delete note.notebookId;
    note.updated = day(2024);
    const items = await run.pass();
    expect(items.filter((item) => item.metadata.deleted === true).map((item) => item.identity.providerItemId))
      .toEqual([note.id, `${note.id}#child:${md5Hex(PNG)}`]);
    expect(notesOf(items)).toHaveLength(0);
    expect(run.connector().lastOutcome()?.counts).toMatchObject({ notes_deleted: 1, shared_not_imported: 1 });
    expect(await run.pass()).toHaveLength(0);
  });

  test('a note moved to the trash leaves the index with its attachments', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const note = fake.addNote({
      title: 'Trashed', notebookId: work.id, created: day(2020),
      resources: [{ bytes: PNG, mime: 'image/png', name: 'a.png' }],
    });
    const run = chained(fake);
    await run.pass();
    note.trashed = true;
    note.updated = day(2024);
    const items = await run.pass();
    expect(items.filter((item) => item.metadata.deleted === true).map((item) => item.identity.providerItemId))
      .toEqual([note.id, `${note.id}#child:${md5Hex(PNG)}`]);
  });

  test('the call budget stops reading notes: what was read is kept, the rest is read next pass', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    for (let index = 0; index < 6; index += 1) fake.addNote({ title: `N${index}`, notebookId: work.id, created: day(2010 + index) });
    // Listing: tools/list, search_notes, search_notebooks, search_notes in the notebook = 4 calls; 2 notes then.
    let record: EvernotePassRecord | undefined;
    const first = connectorFor(fake, { callBudget: 6, previous: () => record });
    const items = await runPass(first);
    expect(notesOf(items)).toHaveLength(2);
    expect(first.lastOutcome()).toMatchObject({ stoppedBy: 'budget_exhausted', counts: { notes_read: 2, notes_not_read: 4 } });
    record = first.lastOutcome()!.record;
    const second = connectorFor(fake, { previous: () => record });
    expect(notesOf(await runPass(second))).toHaveLength(4);
    expect(second.lastOutcome()?.counts.notes_deleted).toBe(0);
  });

  test('a persisting rate limit while notes are read stops the pass the same way', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    fake.addNote({ title: 'One', notebookId: work.id, created: day(2010) });
    fake.addNote({ title: 'Two', notebookId: work.id, created: day(2011) });
    fake.rateLimitTool = 'get_note';
    const connector = connectorFor(fake);
    expect(await runPass(connector)).toHaveLength(0);
    expect(connector.lastOutcome()).toMatchObject({ stoppedBy: 'rate_limited', counts: { notes_read: 0, notes_not_read: 2, rate_limit_retries: 3 } });
    // Retried with backoff, then the pass stopped asking.
    expect(fake.calls.get_note).toBe(4);
  });
});

describe('Evernote attachments', () => {
  test('keys are the MD5, the n-th equal attachment `<md5>.<n>`', () => {
    expect(evernoteAttachmentKeys(['aa', 'bb', 'aa', 'aa'])).toEqual(['aa', 'bb', 'aa.2', 'aa.3']);
  });

  test('each attachment is a held child read later: bytes checked against the MD5, type from the bytes', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const note = fake.addNote({
      title: 'Receipts', notebookId: work.id, created: day(2022),
      resources: [
        // The listed type is wrong: the bytes say PDF.
        { bytes: PDF, mime: 'image/jpeg', name: 'receipt.jpg' },
        { bytes: PNG, mime: 'image/png', name: 'photo.png' },
        { bytes: PDF, mime: 'application/pdf', name: 'copy.pdf' },
      ],
    });
    const connector = connectorFor(fake);
    const items = await runPass(connector);
    const children = items.filter((item) => item.identity.parent);
    expect(children.map((child) => child.identity.providerItemId)).toEqual([
      `${note.id}#child:${md5Hex(PDF)}`,
      `${note.id}#child:${md5Hex(PNG)}`,
      `${note.id}#child:${md5Hex(PDF)}.2`,
    ]);
    for (const child of children) {
      expect(child.content.kind).toBe('metadata_only');
      expect(child.holdContentUntilJudged).toBe(true);
      expect(child.metadata.folderKeys).toEqual(['Work']);
      expect(connector.classificationSignals(child)).toEqual({ title: String(child.metadata.title), folderKeys: ['Work'] });
    }
    expect(fake.calls.get_attachment).toBeUndefined();

    const first = children[0]!;
    const read = await connector.fetchItemWithin(first.identity.localItemId, { maxBytes: 1_000_000, deferredBytes: { locator: first.deferredBytes!.locator } });
    expect(read.mimeType).toBe('application/pdf');
    expect(read.content.kind).toBe('bytes');
    expect(md5Hex((read.content as { bytes: Uint8Array }).bytes)).toBe(md5Hex(PDF));
    expect(fake.calls.get_attachment).toBe(1);

    await expect(connector.fetchItemWithin(first.identity.localItemId, { maxBytes: 10, deferredBytes: { locator: first.deferredBytes!.locator } }))
      .rejects.toMatchObject({ errorKind: 'source_too_large' });
    // A locator for another note's attachment is refused before anything is asked.
    await expect(connector.fetchItemWithin(first.identity.localItemId, { deferredBytes: { locator: `evernote-res1:other:${md5Hex(PDF)}` } }))
      .rejects.toMatchObject({ errorKind: 'source_content_unavailable' });
  });

  test('bytes that do not match the listed MD5 are refused', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    const listedHash = md5Hex(new TextEncoder().encode('something else'));
    fake.addNote({ title: 'Bad', notebookId: work.id, created: day(2022), resources: [{ bytes: PNG, mime: 'image/png', name: 'x.png', listedHash }] });
    const connector = connectorFor(fake);
    const child = (await runPass(connector)).find((item) => item.identity.parent)!;
    expect(child.identity.providerItemId.endsWith(listedHash)).toBe(true);
    await expect(connector.fetchItemWithin(child.identity.localItemId, { deferredBytes: { locator: child.deferredBytes!.locator } }))
      .rejects.toMatchObject({ errorKind: 'source_content_unavailable' });
  });

  test('a download link to a host the connector does not name is refused', async () => {
    fake = new FakeEvernoteServer().start();
    const work = fake.addNotebook('Work');
    fake.addNote({ title: 'X', notebookId: work.id, created: day(2022), resources: [{ bytes: PNG, mime: 'image/png', name: 'x.png' }] });
    const strict = createEvernoteSourceConnector({
      accountScope: 'personal',
      session: () => new McpSourceSession({ serverUrl: fake!.url, clientName: 't', clientVersion: '1', readTools: EVERNOTE_READ_TOOLS, callBudget: 100, pacer: new McpCallPacer({ minIntervalMs: 0 }) }),
    });
    const child = (await runPass(strict)).find((item) => item.identity.parent)!;
    await expect(strict.fetchItemWithin(child.identity.localItemId, { deferredBytes: { locator: child.deferredBytes!.locator } }))
      .rejects.toMatchObject({ errorKind: 'source_content_unavailable' });
  });
});
