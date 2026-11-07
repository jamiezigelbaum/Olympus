// Synthetic install only; no model or network requests.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SourceConnector } from '../src/core/contracts.ts';
import { createStorageSnapshotReaders } from '../src/core/source-storage.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { snifferId } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { classifyItemTiers, contentDigestReason, contentJudgeVerdictReason, normalizedContentHash } from '../src/workers/classification/tier-classifier.ts';
import { EMBEDDING_PREFILTER_DIMENSIONS as D, EMBEDDING_PREFILTER_MODEL_ID as MODEL } from '../src/workers/classification/embedding-logistic.ts';
import { runPrefilterTrainingDryRun, snapshotPrefilterDatabase } from '../src/workers/classification/prefilter-training-dry-run.ts';

function files(root: string): Record<string, { hash: string; mtime: string; mode: number }> {
  const result: ReturnType<typeof files> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = statSync(path, { bigint: true });
    result[path] = { hash: entry.isDirectory() ? '' : createHash('sha256').update(readFileSync(path)).digest('hex'),
      mtime: String(stat.mtimeNs), mode: Number(stat.mode) };
    if (entry.isDirectory()) Object.assign(result, files(path));
  }
  return result;
}

async function fixture(root: string, name: string, extra = 0) {
  const dbPath = join(root, `${name}.sqlite`);
  const ledger = new TierLedger({ dbPath: join(root, `${name}.tier-ledger.sqlite`) });
  const sniffer = new TierSnifferStore({ dbPath: tierSnifferPathForLedger(ledger.dbPath) });
  const store = new LocalConnectorStore({ dbPath, corpusId: `secure_local.${name}`, family: 'file', trustDomain: 'secure_local', tierLedger: null });
  const text = 'Synthetic picnic sandwiches for Sunday.';
  const judge = snifferId({ kind: 'local', modelId: 'fixture-model' });
  const items = Array.from({ length: 11 + extra }, (_, n) => ({
    identity: { family: 'file' as const, provider: 'fixture', accountScope: 'fixture-account', providerItemId: String(n), localItemId: String(n) },
    mimeType: 'text/plain', content: { kind: 'text' as const, text }, metadata: { title: 'fixture-name' }, fetchedAt: new Date().toISOString(),
  }));
  const connector: SourceConnector = {
    id: 'fixture', family: 'file', async authenticate() {},
    async *listItems() { yield { items, done: true }; },
    async fetchItem(id) { return items[Number(id)]!; }, classificationSignals() { return {}; },
  };
  await store.syncFromConnector(connector, { fetchContent: true });
  store.bindTierSet(ledger);
  const sql = new Database(dbPath);
  const vector = new Float32Array(D); vector[0] = 1;
  sql.query(`INSERT INTO chunk_embeddings (item_pk, chunk_pk, model_id, content_hash, embedding, embedded_at)
    SELECT item_pk, chunk_pk, ?, embedding_input_hash, ?, ? FROM chunks`).run(MODEL, new Uint8Array(vector.buffer), new Date().toISOString());
  for (let n = 0; n < items.length; n++) {
    const subject = items[n]!.identity;
    const copy = store.exportItemCopy(subject)!;
    const digest = contentDigestReason(copy.chunks.map(chunk => chunk.boundedText).join(''));
    const reason = `content:sniffer:${judge}:other:1.00`;
    const tier = n === 1 || (n >= 11 && n % 2 === 0) ? 'secure' : 'private';
    const reasons = [reason, digest, contentJudgeVerdictReason(reason, tier, digest)];
    if (n === 2) reasons.splice(1, 1); // real label, missing digest receipt
    if (n === 3 || (n >= 7 && n <= 10)) reasons.pop(); // production legacy reason shape
    if (n >= 7 && n <= 10) sniffer.putVerdict({ materialHash: `synthetic-${n}`, modelId: 'fixture-model', promptVersion: 'fixture', mapRevision: 'none' },
      { tier: n === 8 ? 'private' : 'personal', category: 'fixture', confidence: 1, failSafe: false }, subject);
    if (n === 7 || n === 10) sniffer.markFinalModelContent({ materialHash: `synthetic-${n}`,
      modelId: 'fixture-model', promptVersion: 'fixture', mapRevision: 'none' }, normalizedContentHash(n === 7 ? text : 'Different body'));
    if (n === 8 || n === 9) reasons.push(`metadata:sniffer:${judge}:other:1.00`);
    if (n === 4) reasons.push('content:unknown:synthetic');
    const decision = { ...classifyItemTiers({ subject, signals: {}, text }), state: 'current' as const, decidedBy: 'sniffer' as const,
      modelId: 'fixture-model', metadataTier: 'private' as const, contentTier: (n === 8 || n === 9 ? 'secure' : tier) as 'private' | 'secure',
      contentRead: true, contentPending: false, metadataPending: false, reasons };
    ledger.recordRoutedPlacement(subject, decision, { copies: [{ corpusId: store.corpusId, trustDomain: 'secure_local', layers: 'both' }], embedHold: false });
    ledger.markJudged(subject, { engineVersion: 'fixture', snifferId: judge });
  }
  // model_id is stamped by the verdict writer, separately from placement.
  const ledgerSql = new Database(ledger.dbPath);
  ledgerSql.query('UPDATE tier_items SET model_id = ?').run('fixture-model');
  ledgerSql.close();
  sql.query('DELETE FROM chunk_embeddings WHERE item_pk = (SELECT item_pk FROM items WHERE provider_item_id = ?)').run('5');
  sql.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('6');
  // Simulate an older cache with no new index. The diagnostic must not migrate it.
  const sniffSql = new Database(sniffer.dbPath);
  sniffSql.exec('DROP INDEX sniffer_training_subject');
  sniffSql.close();
  return { ledger, store, sql, judge, close() { sql.close(); store.close(); sniffer.close(); ledger.close(); } };
}

test('counts exact training decisions, includes live WAL rows, and changes no install file or directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-install-'));
  const a = await fixture(root, 'a');
  const b = await fixture(root, 'b');
  const state = new TierLedger({ dbPath: join(root, 'state.tier-ledger.sqlite') });
  state.writeMeta('embedding-prefilter:training-v1', JSON.stringify({ judge: a.judge }));
  writeFileSync(join(root, 'sentinel.txt'), 'synthetic file untouched');
  const before = files(root);
  try {
    // The writers remain open: committed source and ledger rows are still in WAL.
    expect(Object.keys(before).some(path => path.endsWith('-wal'))).toBe(true);
    const report = runPrefilterTrainingDryRun({ dataDir: root });
    expect(report.errors).toBe(0);
    expect(report.ledgers).toHaveLength(2);
    for (const ledger of report.ledgers) {
      expect(ledger.rows_read).toBe(11);
      expect(ledger).toMatchObject({ examples: { personal: 2, private: 1 }, provenance: { judge_receipt: 2, legacy_sniffer: 1 } });
      expect(ledger.rejections).toMatchObject({ digest_missing: 1, legacy_verdict_missing: 1, legacy_verdict_tier: 1, legacy_verdict_content: 2, content_reason_unknown: 1, vector_count: 1, copy_missing: 1 });
      expect(ledger.examples.personal + ledger.examples.private + Object.values(ledger.rejections).reduce((a, b) => a + b, 0)).toBe(ledger.rows_read);
    }
    const limited = runPrefilterTrainingDryRun({ dataDir: root, rowLimit: 1 });
    expect(limited.ledgers.map(ledger => ledger.rows_read)).toEqual([1, 1]);
    expect(files(root)).toEqual(before);
    const child = Bun.spawnSync([process.execPath, resolve(process.env.OLYMPUS_PREFILTER_TEST_ENTRY ?? 'src/cli.ts'),
      'prefilter-training-dry-run', '--data-dir', root], { stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe('');
    expect(JSON.parse(child.stdout.toString())).toEqual(report);
    expect(child.stdout.toString()).not.toMatch(/fixture|synthetic|sqlite|picnic|sandwich|secure_local|fixture-model/);
    expect(files(root)).toEqual(before);
  } finally { state.close(); b.close(); a.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('CLI errors never echo arguments, paths or exception text, and leave the install unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-invalid-'));
  const db = new Database(join(root, 'broken.sqlite'));
  db.exec('CREATE TABLE fixture(x)');
  db.close();
  const before = files(root);
  try {
    for (const args of [['--data-dir', root], ['--data-dir', root, '--row-limit', 'private-name'], ['--data-dir', root, '--row-limit', '0']]) {
      const child = Bun.spawnSync([process.execPath, resolve(process.env.OLYMPUS_PREFILTER_TEST_ENTRY ?? 'src/cli.ts'), 'prefilter-training-dry-run', ...args], { stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toBe('');
      const report = JSON.parse(child.stdout.toString());
      expect(report).toMatchObject({ ledgers: [], errors: 1, snapshot_retries: 0 });
      expect(report.error_reasons[args.length === 2 ? 'training_judge' : 'arguments_or_install']).toBe(1);
      expect(Object.values(report.error_reasons).reduce((a, b) => Number(a) + Number(b), 0)).toBe(1);
    }
    expect(files(root)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('busy snapshots retry from clean copies, and persistent refusals have a safe named reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-busy-'));
  const source = join(root, 'source.sqlite'), target = join(root, 'snapshot.sqlite');
  writeFileSync(source, 'synthetic database bytes');
  let retries = 0, copies = 0;
  try {
    snapshotPrefilterDatabase(source, target, () => { retries++; }, (from, to) => {
      copyFileSync(from, to);
      if (++copies === 1) {
        writeFileSync(source, 'synthetic changed bytes');
        writeFileSync(`${target}-wal`, 'stale scratch WAL');
      }
    });
    expect(retries).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('synthetic changed bytes');
    expect(readdirSync(root)).not.toContain('snapshot.sqlite-wal');
    retries = 0; copies = 0;
    expect(() => snapshotPrefilterDatabase(source, target, () => { retries++; }, (from, to) => {
      copyFileSync(from, to);
      writeFileSync(source, `synthetic busy ${++copies}`);
    })).toThrow('snapshot_busy');
    expect(retries).toBe(3);
    expect(copies).toBe(4);
    retries = 0;
    expect(() => snapshotPrefilterDatabase(source, target, () => { retries++; }, () => {
      throw Object.assign(new Error('private path'), { code: 'EACCES' });
    })).toThrow('snapshot_io');
    expect(retries).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('snapshot readers refuse original paths outside their own private scratch root', () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-original-'));
  const readers = createStorageSnapshotReaders();
  const original = join(root, 'original.sqlite');
  writeFileSync(original, 'synthetic original bytes');
  try {
    for (const open of [readers.database, readers.ledger, readers.sniffer, (path: string) => readers.store(path, 'fixture')])
      expect(() => open(original)).toThrow('Not a storage snapshot');
    expect(statSync(readers.directory).mode & 0o777).toBe(0o700);
    expect(readFileSync(original, 'utf8')).toBe('synthetic original bytes');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(readers.directory, { recursive: true, force: true }); }
});

test('latest subject/model answers exclude fail-safes, expose ties and later times in live and old readonly caches', () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-verdicts-'));
  let now = new Date('2026-11-01T00:00:00.000Z');
  const writer = new TierSnifferStore({ dbPath: join(root, 'cache.sqlite'), now: () => now });
  const subject = { provider: 'fixture', accountScope: 'a', providerItemId: '1', providerConversationId: 'chat' };
  const key = { modelId: 'model', promptVersion: 'prompt', mapRevision: 'none' };
  const put = (id: string, tier: 'personal' | 'private', failSafe = false, modelId = 'model', who = subject) =>
    writer.putVerdict({ ...key, modelId, materialHash: id }, { tier, category: 'fixture', confidence: 1, failSafe }, who);
  try {
    put('old', 'private');
    now = new Date('2026-11-02T00:00:00.000Z');
    put('latest', 'personal');
    now = new Date('2026-11-03T00:00:00.000Z');
    put('failsafe', 'private', true);
    put('other-model', 'private', false, 'different');
    put('other-subject', 'private', false, 'model', { ...subject, providerConversationId: 'other' });
    expect(writer.trainingVerdict(subject, 'model')).toEqual({ tier: 'personal', decidedAt: '2026-11-02T00:00:00.000Z', ambiguous: false });
    expect(writer.trainingVerdict({ ...subject, accountScope: 'other' }, 'model')).toBeUndefined();
    now = new Date('2026-11-02T00:00:00.000Z');
    put('tied', 'private');
    expect(writer.trainingVerdict(subject, 'model')?.ambiguous).toBe(true);
    const boundSubject = { ...subject, providerItemId: 'bound' };
    put('bound', 'personal', false, 'model', boundSubject);
    writer.markFinalModelContent({ ...key, materialHash: 'bound' }, 'body-hash');
    expect(writer.trainingVerdict(boundSubject, 'model')?.contentHash).toBe('body-hash');
    // Same-time, same-tier metadata answers cannot borrow a content binding.
    put('metadata-tie', 'personal', false, 'model', boundSubject);
    expect(writer.trainingVerdict(boundSubject, 'model')?.contentHash).toBeUndefined();
    const conflictSubject = { ...subject, providerItemId: 'conflict' };
    for (const [id, hash] of [['one', 'body-hash'], ['two', 'different-hash']] as const) {
      put(id, 'personal', false, 'model', conflictSubject);
      writer.markFinalModelContent({ ...key, materialHash: id }, hash);
    }
    expect(writer.trainingVerdict(conflictSubject, 'model')?.contentHash).toBeUndefined();
    const stableSubject = { ...subject, providerItemId: 'stable' };
    for (const id of ['stable-one', 'stable-two']) {
      put(id, 'private', false, 'model', stableSubject);
      writer.markFinalModelContent({ ...key, materialHash: id }, 'same-body-hash');
    }
    expect(writer.trainingVerdict(stableSubject, 'model')?.contentHash).toBe('same-body-hash');
    const sql = new Database(writer.dbPath);
    sql.exec('DROP INDEX sniffer_training_subject');
    sql.close();
    const reader = new TierSnifferStore({ dbPath: writer.dbPath, readOnly: true });
    try {
      for (const who of [subject, boundSubject, conflictSubject, stableSubject])
        expect(reader.trainingVerdict(who, 'model')).toEqual(writer.trainingVerdict(who, 'model'));
    }
    finally { reader.close(); }
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); }
});


test('offline CLI writes only --out, leaves all live WAL files and meta unchanged, and never enables clearing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-offline-'));
  const output = mkdtempSync(join(tmpdir(), 'prefilter-weights-'));
  const a = await fixture(root, 'a', 4000);
  a.ledger.writeMeta('embedding-prefilter:training-v1', JSON.stringify({ judge: a.judge }));
  const before = files(root);
  const out = join(output, 'offline.json');
  try {
    const child = Bun.spawnSync([process.execPath, resolve(process.env.OLYMPUS_PREFILTER_TEST_ENTRY ?? 'src/cli.ts'),
      'prefilter-train-offline', '--data-dir', root, '--out', out], { stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe('');
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ outcome: 'trained',
      per_source: { other: { personal: 2002, private: 2001 } } });
    expect(child.stdout.toString()).not.toMatch(/fixture|synthetic|sqlite|picnic|sandwich|secure_local|fixture-model/);
    expect(files(root)).toEqual(before);
    expect(readdirSync(output)).toEqual(['offline.json']);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['judge', 'model', 'revisions', 'trainedAt', 'version']);
    expect(saved.model.weights).toHaveLength(D);
    expect(Number.isFinite(saved.model.bias)).toBe(true);
    expect(saved.judge).toBe(a.judge);
  } finally { a.close(); rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
}, 120_000);

test('offline CLI refuses install outputs, existing outputs and invalid arguments without writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-offline-refuse-'));
  const output = mkdtempSync(join(tmpdir(), 'prefilter-existing-'));
  const a = await fixture(root, 'a');
  a.ledger.writeMeta('embedding-prefilter:training-v1', JSON.stringify({ judge: a.judge }));
  const existing = join(output, 'existing.json');
  writeFileSync(existing, 'synthetic sentinel');
  const before = files(root), outside = files(output);
  try {
    for (const args of [[], ['--out', join(root, 'weights.json')], ['--out', existing],
      ['--out', join(output, 'too-few.json')], ['--out', existing, '--unknown', 'sensitive-name']]) {
      const child = Bun.spawnSync([process.execPath, resolve(process.env.OLYMPUS_PREFILTER_TEST_ENTRY ?? 'src/cli.ts'),
        'prefilter-train-offline', '--data-dir', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toBe('');
      expect(JSON.parse(child.stdout.toString()).outcome).toMatch(/^(failed|too_few)$/);
      expect(child.stdout.toString()).not.toMatch(/fixture|synthetic|sensitive-name|sqlite/);
      expect(files(root)).toEqual(before);
      expect(files(output)).toEqual(outside);
    }
  } finally { a.close(); rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
}, 30_000);

test('a failed unrelated snapshot preserves dry-run counts but refuses offline fitting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-partial-'));
  const output = mkdtempSync(join(tmpdir(), 'prefilter-partial-output-'));
  const a = await fixture(root, 'a');
  a.ledger.writeMeta('embedding-prefilter:training-v1', JSON.stringify({ judge: a.judge }));
  writeFileSync(join(root, 'broken.sqlite'), 'not a database');
  const before = files(root);
  try {
    const report = runPrefilterTrainingDryRun({ dataDir: root });
    expect(report.errors).toBe(1);
    expect(report.ledgers).toHaveLength(1);
    expect(report.ledgers[0]!.examples).toEqual({ personal: 2, private: 1 });
    const child = Bun.spawnSync([process.execPath, resolve(process.env.OLYMPUS_PREFILTER_TEST_ENTRY ?? 'src/cli.ts'),
      'prefilter-train-offline', '--data-dir', root, '--out', join(output, 'weights.json')]);
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toBe('');
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ outcome: 'failed', per_source: {} });
    expect(readdirSync(output)).toEqual([]);
    expect(files(root)).toEqual(before);
  } finally { a.close(); rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
}, 30_000);
