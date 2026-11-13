import { afterEach, expect, test } from 'bun:test';
import { cpSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { fixtureConnector, openTierFixture, JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import { assertEvalFileDescriptors, openEvalDataRoot, otherProcessesHolding } from '../eval/data-root.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { buildEvalPack, createEvalSourceLanes } from '../eval/retrieval.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'eval-root-')); dirs.push(dir); return dir; }
function hashes(dir: string): string[] { return (readdirSync(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort().map(file => createHash('sha256').update(readFileSync(file)).digest('hex')); }
async function seed(dir: string, family = 'file') {
  const path = join(dir, `${family}.sqlite`);
  const store = new LocalConnectorStore({ dbPath: path, corpusId: `internal.fixture.${family}`, family: 'file', trustDomain: 'internal', tierLedger: null });
  await store.syncFromConnector(fixtureConnector(() => [{ id: 'one', name: 'Synthetic', text: 'Kestrel invoices total forty seven dollars this month.' }]), { fetchContent: true });
  store.close();
  // Identity belongs to the synthetic store's family.
  const db = new Database(path); db.query('UPDATE items SET family = ?').run(family); db.close();
  return path;
}
test('opens all source families from a copy, searches read-only, original bytes unchanged', async () => {
  const original = temp();
  for (const family of ['email', 'file', 'chat', 'note', 'readwise', 'x', 'calendar', 'task']) await seed(original, family);
  Bun.gc(true);
  const copy = temp(); cpSync(original, copy, { recursive: true });
  const before = hashes(original);
  const opened = openEvalDataRoot({ dataRoot: copy, forbidRoots: [original] });
  try {
    expect(opened.stores).toHaveLength(8);
    const pack = await buildEvalPack({ question: 'Kestrel invoices', lanes: createEvalSourceLanes(opened), maxResults: 10, maxCharsPerCandidate: 2000 });
    expect(pack.pack.candidates.length).toBeGreaterThan(0);
    opened.checkFileDescriptors();
  } finally { opened.close(); }
  expect(hashes(original)).toEqual(before);
});
test('rejects an external store symlink before opening handles', async () => {
  const original = temp(); const copy = temp(); const path = await seed(original);
  symlinkSync(path, join(copy, 'linked.sqlite'));
  expect(() => openEvalDataRoot({ dataRoot: copy })).toThrow('outside');
});
test('rejects a recorded external ledger before mounting stores', async () => {
  const original = temp(); const copy = temp(); const path = await seed(copy);
  const db = new Database(path);
  db.query('INSERT INTO sync_runs(sync_run_id, corpus_id, connector_id, status, cursor, items_seen, items_indexed, started_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
    .run('tiered-store-set-binding', 'internal.fixture.file', 'tiered_store_set_binding', 'completed', JSON.stringify({ ledgerId: 'external', ledgerPath: join(original, 'external.sqlite') }), '2026-01-01');
  db.close();
  expect(() => openEvalDataRoot({ dataRoot: copy })).toThrow('outside');
});
test('checks every forbidden root and refuses unavailable proc unless explicitly waived', () => {
  const copy = temp(); const live = temp();
  const fd = openSync(join(live, 'live'), 'w');
  try { expect(() => assertEvalFileDescriptors({ dataRoot: copy, forbidRoots: [live] })).toThrow('forbidden'); }
  finally { closeSync(fd); }
  expect(() => assertEvalFileDescriptors({ dataRoot: copy, fdDirectory: join(copy, 'missing') })).toThrow('allow-no-fd-check');
  expect(() => assertEvalFileDescriptors({ dataRoot: copy, fdDirectory: join(copy, 'missing'), allowNoFdCheck: true })).not.toThrow();
});
test('incompatible stores are counted and skipped without upgrade', async () => {
  const root = temp(); const path = await seed(root);
  const db = new Database(path); db.exec('UPDATE schema_version SET version = 999, compatible_version = 999; PRAGMA wal_checkpoint(TRUNCATE);'); db.close();
  const before = readFileSync(path);
  const opened = openEvalDataRoot({ dataRoot: root, allowUnreadableStores: true });
  try { expect(opened.stores).toHaveLength(0); expect(opened.skipped).toHaveLength(1); } finally { opened.close(); }
  expect(readFileSync(path)).toEqual(before);
});

test('a store the run cannot open fails the open with SQLite\'s exact error, unless skips are allowed', async () => {
  const root = temp(); const path = await seed(root);
  Bun.gc(true);
  writeFileSync(path, 'not a database '.repeat(512));
  let failure: unknown;
  try { openEvalDataRoot({ dataRoot: root }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error & { code?: string }).code).toBe('EVAL_STORE_UNREADABLE');
  expect((failure as Error).message).toContain('1 of 1 store');
  expect((failure as Error).message).toContain('store_probe SQLITE_NOTADB 26 file is not a database');
  expect((failure as Error).message).not.toContain(root);
  const allowed = openEvalDataRoot({ dataRoot: root, allowUnreadableStores: true });
  try {
    expect(allowed.skipped).toEqual([{ store: 0, reason: 'unreadable_store', stage: 'store_probe', code: 'SQLITE_NOTADB', errno: 26, message: 'file is not a database' }]);
  } finally { allowed.close(); }
});

test('counts other processes holding a file under the copy open', () => {
  const root = temp(); const proc = temp();
  const pid = (name: string, targets: string[]) => {
    mkdirSync(join(proc, name, 'fd'), { recursive: true });
    targets.forEach((target, index) => symlinkSync(target, join(proc, name, 'fd', String(index))));
  };
  pid('101', [join(root, 'store.sqlite')]);
  pid('102', ['/dev/null']);
  pid(String(process.pid), [join(root, 'own.sqlite')]);
  expect(otherProcessesHolding(root, proc)).toBe(1);
  expect(otherProcessesHolding(root, join(proc, 'missing'))).toBeUndefined();
});

test('a complete bound tier set follows the copied ledger identity, never the old absolute hint', async () => {
  const original = temp();
  const world = openTierFixture(original, { embed: false, paths: { internal: join(original, 'sources/local.files/1/stores/internal.sqlite'), secure_local: join(original, 'sources/local.files/1/stores/secure_local.sqlite'), public_safe: join(original, 'sources/local.files/1/stores/public_safe.sqlite') } });
  await world.set.sync(fixtureConnector(() => [
    { id: 'p', name: 'public.txt', text: 'Public Kestrel invoices total forty seven dollars.', sharing: 'public_link' },
    { id: 'i', name: 'personal.txt', text: 'Personal Kestrel invoices total forty seven dollars.' },
  ]), { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
  const publicStore = world.set.store('public_safe', { create: true })!;
  await publicStore.syncFromConnector(fixtureConnector(() => [{ id: 'pub', name: 'public', text: 'Public Kestrel invoice document for the harbor.' }]), { fetchContent: true });
  publicStore.bindTierSet(world.ledger);
  world.close(); Bun.gc(true);
  const copy = temp(); cpSync(original, copy, { recursive: true });
  const before = hashes(original);
  const opened = openEvalDataRoot({ dataRoot: copy, forbidRoots: [original] });
  try {
    expect(opened.stores.length).toBe(3);
    expect(opened.scopes).toHaveLength(1);
    expect(opened.skipped).toHaveLength(0);
    expect(opened.scopes[0]!.ledger.dbPath.startsWith(copy)).toBe(true);
    const detail = await buildEvalPack({ question: 'Kestrel invoices', lanes: createEvalSourceLanes(opened), maxResults: 5, maxCharsPerCandidate: 2000 });
    expect(detail.pack.candidates.length).toBeGreaterThan(0);
    opened.checkFileDescriptors();
  } finally { opened.close(); }
  expect(hashes(original)).toEqual(before);
});
test('an external ledger symlink is refused before mounting', async () => {
  const root = temp(); const external = temp(); const path = await seed(root);
  const outside = await seed(external);
  symlinkSync(outside, tierLedgerPathForStore(path));
  expect(() => openEvalDataRoot({ dataRoot: root })).toThrow('outside');
});
test('recorded mount paths outside the copy are refused, including empty extension stores', async () => {
  const root = temp(); const outside = temp();
  const path = await seed(outside);
  expect(() => openEvalDataRoot({ dataRoot: root, mountDeclarations: [{ dbPath: path, corpusId: 'internal.x-fixture', family: 'note', trustDomain: 'internal' }] })).toThrow('outside');
});
test('a declaration identifies an empty extension store without relabelling populated rows', () => {
  const root = temp(); const path = join(root, 'extension.sqlite');
  const identity = { corpusId: 'internal.x-fixture', family: 'note' as const, trustDomain: 'internal' as const };
  const seed = new LocalConnectorStore({ dbPath: path, ...identity }); seed.close(); Bun.gc(true);
  const opened = openEvalDataRoot({ dataRoot: root, mountDeclarations: [{ dbPath: path, ...identity }] });
  try { expect(opened.stores).toHaveLength(1); expect(opened.storeCounts[0]!.rows).toBe(0); } finally { opened.close(); }
});

test('refuses the live data folder, a folder inside it, and a folder holding it, with no --forbid-root', async () => {
  const xdg = temp();
  const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OLYMPUS_DATA_DIR: process.env.OLYMPUS_DATA_DIR };
  process.env.XDG_DATA_HOME = xdg;
  delete process.env.OLYMPUS_DATA_DIR;
  try {
    const live = join(xdg, 'openclaw', 'olympus');
    const inside = join(live, 'accounts');
    mkdirSync(inside, { recursive: true });
    await seed(inside);
    for (const dataRoot of [live, inside, xdg]) expect(() => openEvalDataRoot({ dataRoot })).toThrow('live data folder');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
