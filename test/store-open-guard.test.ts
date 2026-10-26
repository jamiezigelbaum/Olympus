/**
 * Every store and tier sidecar in src/ and scripts/ is constructed by the
 * storage service (core/source-storage.ts), which refuses an account whose
 * registry state is not active (docs/design/source-storage.md, "Storage
 * service"). A construction outside it is a store a Delete in progress could
 * find open, so a new one fails here; the allowlist names each exception and
 * why it is safe. Adapted from #467's guard: the idea and the allowlist
 * shape, not its custody code.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { FORGET_STEPS, KEPT_SHARED_FILES, type ForgetStep, type KeptSharedFile } from '../src/core/source-forget-registry.ts';

const ROOT = join(import.meta.dir, '..');

// Each reason was checked against the code. The list only shrinks: an entry
// that no longer constructs anything fails too.
const ALLOWED: Record<string, string> = {
  'src/core/source-storage.ts': 'the storage service itself',
  'src/workers/connector-store/local-index.ts':
    'the store\'s own connections: the main one, the read-only vector-scan snapshot and the qualification fingerprint, plus its own and its bound set ledger',
  'src/workers/classification/tier-ledger.ts': 'the tier ledger class opening its own database',
  'src/workers/classification/secret-locations.ts': 'the secret-locations class opening its own database',
  'src/workers/classification/sniffer-store.ts': 'the sniffer store class opening its own database',
  'src/core/file-lease.ts': 'the lock databases themselves',
  'src/workers/apple-messages/connector.ts': 'reads the macOS Messages chat.db, never an Olympus store',
  'src/core/messaging-pairing.ts': 'copies and writes the Telegram login a pairing proves (telegram.session), never an Olympus store',
  // X's state outside the stores.
  'src/workers/x-bookmarks/reconcile-state.ts':
    'X\'s reconcile state: per-account state, not a tier store; it sits in the account\'s raw/ folder (beside the usage ledger for a legacy account) and goes with the account\'s folder on Delete',
  // Imported archives' state outside the stores.
  'src/workers/archive-import/media-bindings.ts':
    'the archives\' media bindings: per-archive state, not a tier store; it sits in the account\'s raw/ folder (beside the record for a legacy account), each archive\'s rows are forgotten when it is removed, and the file goes with the account\'s folder (accountStateSqlite) on Delete',
  // WhatsApp's capture spool state outside the stores.
  'src/workers/whatsapp/spool-index.ts':
    'WhatsApp\'s spool index: a cache of message positions, reactions and match digests (no text), not a tier store; it sits in the spool folder (raw/whatsapp/spool), is opened per listing and closed after, and goes with the account\'s folder on Delete',
  'src/workers/whatsapp/spool-resets.ts':
    'WhatsApp\'s spool reset counter: how many times the spool was found broken, and the index build last seen (two values, no content), not a tier store; it sits in the spool folder and goes with the account\'s raw state on Delete',
  'src/workers/whatsapp/media-fetch.ts':
    'WhatsApp\'s media waiting for disk space: per message its ids, version and the download fields its spool line carries (no text, no names), not a tier store; it sits in the spool folder, is opened per pull and closed after, and goes with the account\'s raw state on Delete',
  'src/data-lifecycle.ts': 'the deleter and exporter, which step 5 rebuilds on the registry',
  // Generic code that reopens sidecars of stores already opened through the
  // service, found by path: no source is in scope there.
  'src/workers/classification/sniffer-service.ts':
    'the worker\'s sniffer: reopens the ledgers, queues and secret-locations beside the stores the worker mounted',
  'src/workers/classification/installed-tier-classification.ts':
    'opens the sniffer cache and queue beside the tier ledger a store hands it',
  'src/workers/classification/tier-migration-cli.ts':
    'opens the sniffer queue beside a set ledger the migration lanes opened through the service',
  'src/workers/classification/tier-cli.ts':
    'the tier CLI\'s item lookup: reads every known store, its ledgers and sniffer queue by path; cli.ts holds the owner lock for it when free, and it goes through the worker in step 2b-ii',
  'src/workers/connector-store/secrets-disposition.ts':
    'clears or reads a Secret\'s queued sniffer questions beside the ledger that judged it',
  'src/workers/connector-store/tiered-store-set.ts':
    'the shared tier-set factory: opens a lane\'s set ledger by path beside its secure store when the caller hands none; the lane\'s stores come from the service, and the factory knows only a set id',
  'src/workers/source-index/status.ts': 'counts secret locations beside a mounted Private store, read-only',
  // Release testing, on a machine kept for it.
  'scripts/release-check/machine-agent.ts':
    'the release check\'s agent on a test machine: reads its stand-in Readwise and archive stores and ledger, read-only, at the paths the resolvers give, to compare an upgrade; it runs beside the engine under test by design, so it takes no owner lock',
  // Operator scripts on a database named on their command line; each holds
  // the owner lock for its run (core/data-owner-lock.ts), so it refuses
  // while Olympus runs.
  'scripts/x-relevance-probe.ts': 'an operator tool on the --db its command line names; holds the owner lock for its run',
  'scripts/embedding-identity-repair.ts': 'an operator tool on the --db its command line names; holds the owner lock for its run',
  'scripts/connector-store-locator-index.ts':
    'an operator tool on the --db its command line names (its schema-version read); holds the owner lock for its run',
  'scripts/vector-scan-bench.ts': 'an operator tool on the --db its command line names; holds the owner lock for its run',
  'scripts/whatsapp-identity-backfill.ts':
    'an operator tool on the --db and --session-db its command line names; holds the owner lock for its run',
};

// The shared SQLite files, outside any account's store. Each module here must
// own a forget step (FORGET_STEPS) or a kept entry (KEPT_SHARED_FILES) in
// core/source-forget-registry.ts, and each module a step or entry names must
// be here: a shared file's rows are forgotten with their source, or the file
// is declared to hold none. The list only shrinks, like the one above.
const SHARED_FILES: Record<string, string> = {
  'src/core/source-watch.ts': 'the shared source-watches database',
  'src/core/waiting-private-questions.ts': 'the shared waiting private questions database',
  'src/core/remote-connections.ts': 'the shared remote-connections database',
  'src/workers/source-dashboard.ts': 'the shared dashboard history database',
  'src/workers/source-ingestion-ledger.ts': 'the shared dashboard database the ingestion ledger reads and writes',
  'src/workers/source-scheduler-state.ts': 'the shared scheduler database',
  'src/workers/file-extraction/job-store.ts': 'the shared extraction job ledger',
  'src/workers/file-extraction/job-names.ts': 'the shared extraction job ledger, opened to clear or restore captured names',
  'src/workers/google-connectors/request-budget.ts': 'the shared Google request-budget ledger',
  'src/workers/x-bookmarks/live-control.ts':
    'X\'s API usage ledger: the quota ledger, kept when X is deleted, so it stays in the data folder; the deleted account\'s sync positions are forgotten',
};

const GUARDED_CLASSES = ['LocalConnectorStore', 'TierLedger', 'SecretLocationsIndex', 'TierSnifferStore'];
// `Database`, `DatabaseSync`, `BunDatabase`: any class named like a database.
const guarded = (name: string) => GUARDED_CLASSES.includes(name) || /Database/.test(name);

/** The class a `new` names: `new X(`, `new ns.X(`, `new ns['X'](`, `new (X)(`. */
function constructedName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  if (ts.isParenthesizedExpression(expression)) return constructedName(expression.expression);
  return undefined;
}

// Walks the parsed file, so a comment neither counts as a construction nor
// hides one, and a namespace (`new tiers.TierLedger(`) or a guarded class
// imported under another name is seen too.
function constructsStore(source: string): boolean {
  const file = ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isNewExpression(node)) {
      const name = constructedName(node.expression);
      if (name && guarded(name)) found = true;
    } else if (ts.isImportSpecifier(node) && node.propertyName && !node.isTypeOnly
      && !node.parent.parent.isTypeOnly && guarded(node.propertyName.text)) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The two ways the shared-file list and the forget registry can disagree: a
 * shared module that neither owns a step nor is kept (its rows would outlive a
 * delete unnoticed), and a step or kept entry that names a module that is not a
 * shared module (a stale claim about who opens the file).
 */
function sharedFileDisagreements(
  shared: readonly string[],
  steps: ReadonlyArray<Pick<ForgetStep, 'modules'>>,
  kept: ReadonlyArray<Pick<KeptSharedFile, 'modules'>>,
): { unregistered: string[]; unknown: string[] } {
  const registered = new Set([...steps, ...kept].flatMap((entry) => entry.modules));
  return {
    unregistered: shared.filter((path) => !registered.has(path)).sort(),
    unknown: [...registered].filter((path) => !shared.includes(path)).sort(),
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [path] : [];
  });
}

describe('store open guard', () => {
  test('the guard sees every spelling of a construction', () => {
    for (const spelling of [
      'const store = new LocalConnectorStore({ dbPath, corpusId, family, trustDomain });',
      'const ledger = new TierLedger({ dbPath });',
      'const index = new SecretLocationsIndex({ dbPath, readOnly: true });',
      'const sniffer = new TierSnifferStore({ dbPath });',
      "const db = new Database(path, { readonly: true });",
      'const db = new DatabaseSync(path);',
      'const db = new BunDatabase(path);',
      'const store = new\n  LocalConnectorStore(\n  options,\n);',
      'const store = new /* reopened */ LocalConnectorStore(options);',
      "import { Database as Db } from 'bun:sqlite';",
      "import { type SourceTrustDomain, TierLedger as LedgerClass } from './tier-ledger.ts';",
      "import {\n  LocalConnectorStore as Store,\n} from './local-index.ts';",
      "import * as tiers from './tier-ledger.ts';\nconst ledger = new tiers.TierLedger(options);",
      'const db = new sqlite.Database(path);',
      'const store = new (LocalConnectorStore)(options);',
      "import * as tiers from './tier-ledger.ts';\nconst ledger = new tiers['TierLedger'](options);",
      'const ledger = new tiers[`TierLedger`](options);',
    ]) expect(constructsStore(spelling), spelling).toBe(true);
  });

  test('the guard ignores comments, the service and type-only names', () => {
    for (const spelling of [
      '// const store = new LocalConnectorStore(options);',
      '/* new Database(path) */ const x = 1;',
      '/**\n * Never `new TierLedger(` here.\n */\nexport const y = 2;',
      'const store = openConnectorStore({ sourceId }, options);',
      'let store: LocalConnectorStore | undefined;',
      "import { type TierLedger as Ledger } from './tier-ledger.ts';",
      "import type { TierLedger as Ledger } from './tier-ledger.ts';",
      'const map = new Map<string, TierLedger>();',
    ]) expect(constructsStore(spelling), spelling).toBe(false);
  });

  test('no store or sidecar is constructed outside the service and the allowlist', () => {
    const matching = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]
      .filter((path) => constructsStore(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
      .sort();
    const allowed = { ...ALLOWED, ...SHARED_FILES };
    const unexpected = matching.filter((path) => !(path in allowed));
    const stale = Object.keys(allowed).filter((path) => !matching.includes(path));
    expect({ unexpected, stale }, 'open stores through openConnectorStore() and its sidecar twins in core/source-storage.ts').toEqual({ unexpected: [], stale: [] });
  });

  test('every shared module owns a forget step or is declared to hold no per-source data', () => {
    expect(sharedFileDisagreements(Object.keys(SHARED_FILES), FORGET_STEPS, KEPT_SHARED_FILES))
      .toEqual({ unregistered: [], unknown: [] });
  });

  test('a shared module with neither a step nor a kept entry fails', () => {
    expect(sharedFileDisagreements(
      ['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts'],
      [{ modules: ['src/core/a.ts'] }],
      [{ modules: ['src/core/b.ts'] }],
    )).toEqual({ unregistered: ['src/core/c.ts'], unknown: [] });
  });

  test('a step or kept entry naming a module that is not a shared module fails', () => {
    expect(sharedFileDisagreements(
      ['src/core/a.ts'],
      [{ modules: ['src/core/a.ts', 'src/core/gone.ts'] }],
      [{ modules: ['src/core/also-gone.ts'] }],
    )).toEqual({ unregistered: [], unknown: ['src/core/also-gone.ts', 'src/core/gone.ts'] });
  });

  test('a step and a kept entry never claim the same file', () => {
    const claimed = [...FORGET_STEPS, ...KEPT_SHARED_FILES].flatMap((entry) => entry.modules);
    expect(claimed.filter((path, index) => claimed.indexOf(path) !== index)).toEqual([]);
  });

  test('step ids are unique and every kept entry says why', () => {
    const ids = FORGET_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of KEPT_SHARED_FILES) expect(entry.reason.trim().length, entry.file).toBeGreaterThan(20);
  });
});
