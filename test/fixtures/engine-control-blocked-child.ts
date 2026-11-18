// A stand-in for the split's background engine, for
// test/engine-control-plane.test.ts: the real command socket and status
// publisher (runtime.ts), one forwarded-command handler that records each
// command it applies, and a loop that, when told to, sits in one synchronous
// SQLite call for as long as the test holds the database's write lock.
//
// argv: the socket path, the database path, the folder for its files.
// FIXTURE_TOKEN is the worker bearer; HOME and XDG_DATA_HOME place the status
// snapshot. `ready` is written once it serves; `block` (written by the test)
// starts the hold; `released` is written when the loop turns again.
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { forwardedRequestToRequest, responseToForwarded, type EngineForwardedRequest } from '../../src/workers/engine-split/commands.ts';
import { createBackgroundVisibilityBoot, engineStatusSnapshotPath, startEngineBackgroundServer, startEngineBackgroundStatus } from '../../src/workers/engine-split/runtime.ts';
import { createOwnerTierItems } from '../../src/workers/classification/tier-owner-items.ts';
import { createEmailSourceWorker } from '../../src/workers/engine/index.ts';
import { setVisibilityBootWait } from '../../src/workers/connector-store/local-index.ts';

const [socketPath, dbPath, folder, ...storePaths] = process.argv.slice(2) as [string, string, string, ...string[]];
mkdirSync(dirname(engineStatusSnapshotPath(process.env)), { recursive: true });
const privacy = storePaths.length ? createEmailSourceWorker({ ownerTierItems: createOwnerTierItems({ storePaths }) }) : undefined;
const visibilityBoot = process.env.FIXTURE_WAIT_FOR_VISIBILITY === '1'
  ? createBackgroundVisibilityBoot({ env: process.env, step: step => writeFileSync(join(folder, 'visibility-step'), step ?? '') })
  : undefined;
if (visibilityBoot) setVisibilityBootWait(visibilityBoot.pending);

let applied = 0;
let collected = 0;
const commands = startEngineBackgroundServer({
  socketPath,
  authToken: process.env.FIXTURE_TOKEN!,
  instanceId: 'blocked-loop-fixture',
  handlers: {
    front_visibility_finished: ({ frontPid }) => { visibilityBoot?.frontFinished(frontPid); },
    tier_override: ({ request }: { request: EngineForwardedRequest }) => {
      if (privacy && request.path === '/dashboard/privacy/items/set') {
        return privacy.fetch(forwardedRequestToRequest('http://olympus-worker.internal', request)).then(responseToForwarded);
      }
      applied += 1;
      appendFileSync(join(folder, 'applied'), `${request.body}\n`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ applied }) };
    },
  },
});
const status = startEngineBackgroundStatus({
  env: process.env,
  instanceId: commands.instanceId,
  collect: () => ({ scheduler: null, judge: { backlog: null, pending: ++collected, spending: null }, captures: null }),
});
commands.markReady();
void visibilityBoot?.start(async () => { writeFileSync(join(folder, 'visibility-building'), ''); });
writeFileSync(join(folder, 'ready'), commands.servedBy());

const watch = setInterval(() => {
  if (!existsSync(join(folder, 'block'))) return;
  clearInterval(watch);
  // The test holds the write lock: this waits inside SQLite, on this loop,
  // until the lock is released (class 5 of the freeze report, a lock wait).
  const db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 600000');
  db.exec('BEGIN IMMEDIATE');
  db.exec('INSERT INTO held (at) VALUES (1)');
  db.exec('COMMIT');
  db.close();
  writeFileSync(join(folder, 'released'), '');
}, 50);

process.once('SIGTERM', () => {
  visibilityBoot?.stop();
  status.stop();
  commands.stop();
  process.exit(0);
});
