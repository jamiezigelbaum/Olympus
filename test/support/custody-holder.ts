/**
 * Child process for the custody tests: opens a store the way an opener does,
 * then idles. HOME is the account whose custody it takes. Modes: `lib` (the
 * bare shared hold), `store` (a connector store), `tier-ledger`, `x-usage`.
 */
import { holdStoreCustodyShared } from '../../src/core/store-custody.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';
import { TierSnifferStore } from '../../src/workers/classification/sniffer-store.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { LocalXBookmarksApiUsageStore } from '../../src/workers/x-bookmarks/live-control.ts';

const [mode, path] = process.argv.slice(2);
if (mode === 'lib') holdStoreCustodyShared();
else if (mode === 'store') new LocalConnectorStore({ dbPath: path!, corpusId: 'secure_local.custody.test', family: 'file', trustDomain: 'secure_local' } as never);
else if (mode === 'tier-ledger') new TierLedger({ dbPath: path! } as never);
else if (mode === 'sniffer') new TierSnifferStore({ dbPath: path! });
else if (mode === 'x-usage') new LocalXBookmarksApiUsageStore(path!);
else throw new Error(`unknown mode ${mode}`);
console.log('held');
setInterval(() => undefined, 1000);
