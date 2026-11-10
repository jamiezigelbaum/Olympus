// `olympus data restore` (#1065): an export from one computer goes back onto
// a fresh install with its stores, its privacy judgments and the owner's
// rules, and never over data that is already there.
import { lifecycleViews } from './helpers/lifecycle-view.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { exportOlympusData, lifecycleEnv } from '../src/data-lifecycle.ts';
import { restoreOlympusData } from '../src/data-restore.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { resolveTierRulesPath } from '../src/workers/classification/tier-rules.ts';

function seed(path: string, table: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`);
  db.query(`INSERT INTO ${table} (value) VALUES (?)`).run(value);
  db.close();
}

function rows(path: string, table: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try { return db.query(`SELECT value FROM ${table}`).all(); } finally { db.close(); }
}

const storeOf = (homeDir: string) => lifecycleViews().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({ homeDir })[0]!;

describe('data restore', () => {
  test('brings stores, judgments and owner rules back onto a fresh install, then refuses a second time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-'));
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const backup = join(dir, 'backup');
    try {
      const storeA = storeOf(homeA);
      seed(storeA, 'rows', 'a bookmark');
      seed(tierLedgerPathForStore(storeA), 'judgments', 'Private');
      const rulesA = resolveTierRulesPath({ env: lifecycleEnv({ homeDir: homeA }) });
      mkdirSync(dirname(rulesA), { recursive: true });
      writeFileSync(rulesA, JSON.stringify({ schema_version: 1, rules: [{ id: 'r1', tier: 'private', match: { sender: 'x@example.com' } }] }));

      const exported = exportOlympusData({ destination: backup, homeDir: homeA });
      const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe(3);
      expect(exported.artifacts.some((artifact) => artifact.role === 'tier_sidecar' && artifact.sidecar === 'tier_ledger')).toBe(true);
      expect(exported.artifacts.some((artifact) => artifact.role === 'owner_rules' && artifact.ownerFile === 'tier_rules')).toBe(true);

      const dry = restoreOlympusData({ input: backup, homeDir: homeB, dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(existsSync(storeOf(homeB))).toBe(false);

      const restored = restoreOlympusData({ input: backup, homeDir: homeB });
      const storeB = storeOf(homeB);
      expect(rows(storeB, 'rows')).toEqual([{ value: 'a bookmark' }]);
      expect(rows(tierLedgerPathForStore(storeB), 'judgments')).toEqual([{ value: 'Private' }]);
      const rulesB = resolveTierRulesPath({ env: lifecycleEnv({ homeDir: homeB }) });
      expect(JSON.parse(readFileSync(rulesB, 'utf8')).rules[0].id).toBe('r1');
      expect(restored.signInAgain).toContain('x.bookmarks');
      expect(restored.notes.join(' ')).not.toContain('judges the restored items again');
      // Nothing in a backup is a sign-in.
      expect(readFileSync(join(backup, 'manifest.json'), 'utf8')).toContain('"secrets_excluded": true');

      expect(() => restoreOlympusData({ input: backup, homeDir: homeB })).toThrow('already holds Olympus data for x.bookmarks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a backup whose files fail verification, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-tamper-'));
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const backup = join(dir, 'backup');
    try {
      seed(storeOf(homeA), 'rows', 'a bookmark');
      const exported = exportOlympusData({ destination: backup, homeDir: homeA });
      const store = exported.artifacts.find((artifact) => artifact.role === 'connector_store')!;
      writeFileSync(join(backup, store.relativePath), 'tampered');
      expect(() => restoreOlympusData({ input: backup, homeDir: homeB })).toThrow('failed verification');
      expect(existsSync(storeOf(homeB))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('data restore across tier stores', () => {
  const storesOf = (homeDir: string) => lifecycleViews().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({ homeDir });

  test('a ledger beside a store that was never created still travels, and lands beside the same store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-lane-'));
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const backup = join(dir, 'backup');
    try {
      const [secureA, otherA] = storesOf(homeA);
      expect(otherA).toBeDefined();
      seed(otherA!, 'rows', 'a routed bookmark');
      seed(tierLedgerPathForStore(secureA!), 'judgments', 'Personal');
      expect(existsSync(secureA!)).toBe(false);
      exportOlympusData({ destination: backup, homeDir: homeA });
      restoreOlympusData({ input: backup, homeDir: homeB });
      const [secureB, otherB] = storesOf(homeB);
      expect(rows(otherB!, 'rows')).toEqual([{ value: 'a routed bookmark' }]);
      expect(rows(tierLedgerPathForStore(secureB!), 'judgments')).toEqual([{ value: 'Personal' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses when this computer holds another of the source\'s stores, even one the backup lacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-other-'));
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const backup = join(dir, 'backup');
    try {
      seed(storesOf(homeA)[1]!, 'rows', 'from the backup');
      exportOlympusData({ destination: backup, homeDir: homeA });
      const secureB = storesOf(homeB)[0]!;
      seed(secureB, 'rows', 'already here');
      expect(() => restoreOlympusData({ input: backup, homeDir: homeB })).toThrow('already holds Olympus data for x.bookmarks');
      expect(existsSync(storesOf(homeB)[1]!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('refuses a store bound to a ledger the backup does not hold, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-bound-'));
  const homeA = join(dir, 'a');
  const homeB = join(dir, 'b');
  const backup = join(dir, 'backup');
  try {
    const store = storeOf(homeA);
    mkdirSync(dirname(store), { recursive: true });
    const db = new Database(store, { create: true });
    db.exec('CREATE TABLE sync_runs (sync_run_id TEXT, connector_id TEXT, cursor TEXT);');
    db.query('INSERT INTO sync_runs VALUES (?, ?, ?)').run('tiered-store-set-binding', 'tiered_store_set_binding', JSON.stringify({ ledgerId: 'l1', ledgerPath: '/x' }));
    db.close();
    exportOlympusData({ destination: backup, homeDir: homeA });
    expect(() => restoreOlympusData({ input: backup, homeDir: homeB })).toThrow('not the judgments themselves');
    expect(existsSync(storeOf(homeB))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bound store\'s ledger hint points at where this computer keeps the restored ledger', async () => {
  const { TierLedger } = await import('../src/workers/classification/tier-ledger.ts');
  const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-hint-'));
  const homeA = join(dir, 'a');
  const homeB = join(dir, 'b');
  const backup = join(dir, 'backup');
  const views = () => lifecycleViews().find((entry) => entry.sourceId === 'x.bookmarks')!;
  try {
    const [secureA, otherA] = views().connectorStorePaths!({ homeDir: homeA });
    mkdirSync(dirname(secureA!), { recursive: true });
    const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(secureA!) });
    const ledgerId = ledger.ledgerId();
    ledger.close();
    const db = new Database(otherA!, { create: true });
    db.exec('CREATE TABLE sync_runs (sync_run_id TEXT, connector_id TEXT, cursor TEXT);');
    db.query('INSERT INTO sync_runs VALUES (?, ?, ?)').run('tiered-store-set-binding', 'tiered_store_set_binding', JSON.stringify({ ledgerId, ledgerPath: '/another/computer/old-name.sqlite' }));
    db.close();
    exportOlympusData({ destination: backup, homeDir: homeA });
    restoreOlympusData({ input: backup, homeDir: homeB });
    const [secureB, otherB] = views().connectorStorePaths!({ homeDir: homeB });
    const restored = new Database(otherB!, { readonly: true });
    const cursor = JSON.parse((restored.query('SELECT cursor FROM sync_runs').get() as { cursor: string }).cursor);
    restored.close();
    expect(cursor).toEqual({ ledgerId, ledgerPath: tierLedgerPathForStore(secureB!) });
    expect(TierLedger.readLedgerId(tierLedgerPathForStore(secureB!))).toBe(ledgerId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('data restore keeps which account a source\'s items came from', () => {
  // The finding on #1098: a restored Dropbox, Drive, Gmail or X source came
  // back with no account on record, so signing in again to the SAME account
  // was taken for a change and the account guard asked for a purge.
  test('a same-account sign-in resumes sync; another account is still caught', async () => {
    const { lifecycleAccountFiles, lifecycleHandleRegistryPath } = await import('../src/data-lifecycle.ts');
    const { placeOwnedAccount, recordProviderAccount } = await import('../src/core/source-storage.ts');
    const { recordedProviderAccount } = await import('../src/core/provider-account-history.ts');
    const binding = await import('../src/core/source-account-binding.ts');
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-account-'));
    const homeA = join(dir, 'a');
    const backup = join(dir, 'backup');
    const account = 'dbid:main-account';
    const source = 'dropbox.files';
    try {
      const envA = lifecycleEnv({ homeDir: homeA });
      placeOwnedAccount({ sourceId: source }, envA);
      seed(lifecycleAccountFiles(source, { homeDir: homeA }).stores[0]!, 'rows', 'a file');
      expect(recordProviderAccount({ sourceId: source }, account, envA)).toBe('recorded');
      binding.updateSourceAccountBinding(binding.sourceAccountBindingsPath(lifecycleHandleRegistryPath({ homeDir: homeA })), source, () => ({
        provider_account_id: account,
        bound_at: '2026-11-01T00:00:00.000Z',
        bound_grant: '2026-11-01T00:00:00.000Z',
      }));
      exportOlympusData({ destination: backup, homeDir: homeA });
      const manifest = readFileSync(join(backup, 'manifest.json'), 'utf8');
      expect(JSON.parse(manifest).accounts.find((entry: { source_id: string }) => entry.source_id === source))
        .toEqual(expect.objectContaining({ provider_account_hash: account, account_binding: { provider_account_id: account } }));
      // The grant that confirmed the account belongs to the old computer.
      expect(manifest).not.toContain('bound_grant');

      const signIn = (home: string, providerAccountId: string) => {
        const registryPath = lifecycleHandleRegistryPath({ homeDir: home });
        const now = new Date('2026-11-10T00:00:00.000Z');
        binding.recordFileSourceConnectIntent({ registryPath, provider: 'dropbox', previousAccountId: undefined, now });
        const outcome = binding.recordFileSourceConnect({ registryPath, provider: 'dropbox', providerAccountId, now });
        const read = binding.readSourceAccountBindings(binding.sourceAccountBindingsPath(registryPath));
        const decision = binding.decideSourceAccountAction({
          binding: read.kind === 'ok' ? read.bindings.sources[source] : undefined,
          grantAccountId: providerAccountId,
          grantConnectedAt: now.toISOString(),
          tokenAccountId: providerAccountId,
          laneHoldsItems: true,
          now,
        });
        return { outcome, decision };
      };

      const same = join(dir, 'same');
      const restored = restoreOlympusData({ input: backup, homeDir: same });
      expect(restored.notes.join(' ')).toContain('sign in to that same account');
      expect(recordedProviderAccount({ sourceId: source }, lifecycleEnv({ homeDir: same }))).toBe(account);
      const sameAccount = signIn(same, account);
      expect(sameAccount.outcome).toBe('same_account');
      expect(sameAccount.decision.action).toBe('proceed');

      const other = join(dir, 'other');
      restoreOlympusData({ input: backup, homeDir: other });
      const otherAccount = signIn(other, 'dbid:someone-else');
      expect(otherAccount.outcome).toBe('purge_required');
      expect(otherAccount.decision).toEqual({ action: 'purge', reason: 'account_changed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses, writing nothing, when this computer is bound to another account for the source', async () => {
    const { lifecycleAccountFiles, lifecycleHandleRegistryPath } = await import('../src/data-lifecycle.ts');
    const binding = await import('../src/core/source-account-binding.ts');
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-account-other-'));
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const backup = join(dir, 'backup');
    const source = 'dropbox.files';
    const bindingsPath = (home: string) => binding.sourceAccountBindingsPath(lifecycleHandleRegistryPath({ homeDir: home }));
    try {
      seed(lifecycleAccountFiles(source, { homeDir: homeA }).stores[0]!, 'rows', 'a file');
      binding.updateSourceAccountBinding(bindingsPath(homeA), source, () => ({ provider_account_id: 'dbid:main-account' }));
      exportOlympusData({ destination: backup, homeDir: homeA });
      binding.updateSourceAccountBinding(bindingsPath(homeB), source, () => ({ provider_account_id: 'dbid:someone-else' }));
      expect(() => restoreOlympusData({ input: backup, homeDir: homeB })).toThrow('already connected to another account for dropbox.files');
      expect(existsSync(lifecycleAccountFiles(source, { homeDir: homeB }).stores[0]!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
