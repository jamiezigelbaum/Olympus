import { mock } from 'bun:test';
import * as starting from '../../src/core/worker-front-proxy.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';
import * as cleanup from '../../src/workers/local-files/own-roots-cleanup.ts';
import { startMainThreadSqlSiteCount } from '../../src/workers/connector-store/main-thread-sql-trace.ts';
import { createDashboardHeldRead } from '../../src/workers/dashboard/held-read.ts';

const gates = {
  cleanup: Promise.withResolvers<void>(),
  visibility: Promise.withResolvers<void>(),
  response: Promise.withResolvers<void>(),
};
let trace: ReturnType<typeof startMainThreadSqlSiteCount> | undefined;
const sendToWorker = Worker.prototype.postMessage;
const delayed: Array<() => void> = [];
let holdDashboardReads = true;
let dashboardTime: number | undefined;
const createHeldRead = createDashboardHeldRead;
mock.module('../../src/workers/dashboard/held-read.ts', () => ({
  createDashboardHeldRead: <T>(refreshMs: number, reportError: (error: unknown) => void) =>
    createHeldRead<T>(refreshMs, reportError, () => dashboardTime ??= Date.now()),
}));

Worker.prototype.postMessage = function (message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
  const send = () => Reflect.apply(sendToWorker, this, options === undefined ? [message] : [message, options]);
  const { sql, params } = (message ?? {}) as { sql?: string; params?: unknown[] };
  const read = sql?.includes('FROM source_dashboard_samples')
    ? (sql.includes('COUNT(*)') ? 'history count' : 'history progress')
    : sql?.includes('FROM source_dashboard_movement') ? 'history movement'
    : sql?.includes('SELECT COUNT(*) AS n FROM tier_items t') && sql.includes('metadata_pending = 1') ? 'held items'
    : sql?.startsWith('SELECT reconciled_at, drift FROM store_totals_state') ? 'totals state'
    : sql === 'SELECT name, n FROM store_totals' ? 'totals rows'
    : sql?.includes('AS has_content') && sql.includes('ORDER BY i.item_pk') ? 'exclusion debt'
    : undefined;
  if (read) {
    process.send!({ dashboardRead: read, key: params?.[0] });
    if (holdDashboardReads) {
      delayed.push(send);
      return;
    }
  }
  send();
};

process.on('message', (phase: string) => {
  if (phase === 'trace-start') {
    trace = startMainThreadSqlSiteCount(8);
    process.send!('trace-started');
  } else if (phase.startsWith('trace-stop:')) {
    process.send!({ dashboardTrace: phase, sites: trace?.sites() });
    trace?.stop();
  } else if (phase === 'release-dashboard-reads') {
    holdDashboardReads = false;
    for (const send of delayed.splice(0)) send();
  } else if (phase === 'hold-dashboard-refresh') {
    holdDashboardReads = true;
    dashboardTime = (dashboardTime ?? Date.now()) + 61_000;
    process.send!('dashboard-refresh-held');
  } else {
    gates[phase as keyof typeof gates]?.resolve();
  }
});

const createRecovery = cleanup.createLocalFilesOwnRootsRecovery;
mock.module('../../src/workers/local-files/own-roots-cleanup.ts', () => ({
  ...cleanup,
  createLocalFilesOwnRootsRecovery(options: Parameters<typeof createRecovery>[0]) {
    const recovery = createRecovery(options);
    return {
      ...recovery,
      // Signal when main awaits cleanup, which is later than when it starts it.
      initial: {
        then(resolve: () => void, reject: (error: unknown) => void) {
          process.send!('cleanup');
          void Promise.all([recovery.initial, gates.cleanup.promise]).then(() => resolve(), reject);
        },
      },
    };
  },
}));

const keepVisibilityCurrent = LocalConnectorStore.prototype.keepVisibilityCurrentInTurns;
LocalConnectorStore.prototype.keepVisibilityCurrentInTurns = async function () {
  LocalConnectorStore.prototype.keepVisibilityCurrentInTurns = keepVisibilityCurrent;
  process.send!('visibility');
  await gates.visibility.promise;
  await keepVisibilityCurrent.call(this);
};

const startingResponse = starting.engineStartingResponse;
mock.module('../../src/core/worker-front-proxy.ts', () => ({
  ...starting,
  engineStartingResponse(request: Request, env: Parameters<typeof startingResponse>[1]) {
    const response = startingResponse(request, env);
    if (!request.headers.has('x-test-hold-starting-response')) return response;
    process.send!('response');
    return gates.response.promise.then(() => response);
  },
}));
