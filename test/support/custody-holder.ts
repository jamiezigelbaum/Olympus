/** Child process for the store-custody tests: takes shared custody the way an opener does, then idles. */
import { holdStoreCustodyShared } from '../../src/core/store-custody.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';

const [mode, path] = process.argv.slice(2);
if (mode === 'lib') holdStoreCustodyShared([path!]);
else if (mode === 'store') new LocalConnectorStore({ dbPath: path!, corpusId: 'secure_local.custody.test', family: 'file', trustDomain: 'secure_local' } as never);
else throw new Error(`unknown mode ${mode}`);
console.log('held');
setInterval(() => undefined, 1000);
