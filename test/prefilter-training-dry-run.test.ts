// Synthetic install only; no model or network requests.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { classifyItemTiers, contentDigestReason, contentJudgeVerdictReason } from '../src/workers/classification/tier-classifier.ts';
import { EMBEDDING_PREFILTER_DIMENSIONS as D, EMBEDDING_PREFILTER_MODEL_ID as MODEL } from '../src/workers/classification/embedding-logistic.ts';
import { runPrefilterTrainingDryRun } from '../src/workers/classification/prefilter-training-dry-run.ts';

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

async function fixture(root: string, name: string) {
  const dbPath = join(root, `${name}.sqlite`);
  const ledger = new TierLedger({ dbPath: join(root, `${name}.tier-ledger.sqlite`) });
  const store = new LocalConnectorStore({ dbPath, corpusId: `secure_local.${name}`, family: 'file', trustDomain: 'secure_local', tierLedger: null });
  const text = 'Synthetic picnic sandwiches for Sunday.';
  const judge = 'synthetic-judge';
  const items = Array.from({ length: 7 }, (_, n) => ({
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
    const tier = n === 1 ? 'secure' : 'private';
    const reasons = [reason, digest, contentJudgeVerdictReason(reason, tier, digest)];
    if (n === 2) reasons.splice(1, 1); // real label, missing digest receipt
    if (n === 3) reasons.pop(); // digest is valid, judge tier receipt absent
    if (n === 4) reasons.push('content:unknown:synthetic');
    const decision = { ...classifyItemTiers({ subject, signals: {}, text }), state: 'current' as const, decidedBy: 'sniffer' as const,
      modelId: 'fixture-model', metadataTier: 'private' as const, contentTier: tier as 'private' | 'secure',
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
  return { ledger, store, sql, judge, close() { sql.close(); store.close(); ledger.close(); } };
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
      expect(ledger.rows_read).toBe(7);
      expect(ledger).toMatchObject({ examples: { personal: 1, private: 1 } });
      expect(ledger.rejections).toMatchObject({ digest_missing: 1, verdict_missing: 1, content_reason_unknown: 1, vector_count: 1, copy_missing: 1 });
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
});

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
      expect(child.stdout.toString().trim()).toBe('{"ledgers":[],"errors":1}');
    }
    expect(files(root)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
