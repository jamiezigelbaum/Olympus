import { mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import * as runtime from '../../src/workers/engine-split/runtime.ts';
import { setReadPoolObserverForTests } from '../../src/workers/connector-store/off-thread-reads.ts';
import { resolvePrivacyProfilePath } from '../../src/workers/classification/privacy-profile.ts';
import { frontLoopSqlHealth } from '../../src/core/front-loop-sql-guard.ts';
import * as starting from '../../src/core/worker-front-proxy.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';
import * as panel from '../../src/workers/engine/dashboard/dashboard-panel-tools.ts';
import * as cleanup from '../../src/workers/local-files/own-roots-cleanup.ts';

const gates = {
  cleanup: Promise.withResolvers<void>(),
  visibility: Promise.withResolvers<void>(),
  response: Promise.withResolvers<void>(),
  count: Promise.withResolvers<void>(),
};
process.on('message', (phase: keyof typeof gates | 'held-count') => {
  if (phase !== 'held-count') gates[phase].resolve();
});

const heldJob = /held-item-(?:count|status)|heldCount|heldSelection|currentHeldCountPlan/;
const countSql = /SELECT COUNT\(\*\) AS n FROM tier_items t|SELECT MIN\(seq\) FROM tier_visibility_changes|SELECT DISTINCT account_scope AS scope FROM items/;
let pool = 0;
setReadPoolObserverForTests(() => { if (heldJob.test(new Error().stack ?? '')) pool++; });
const countFs = [spyOn(fs, 'statSync'), spyOn(fs, 'readFileSync'), spyOn(fs, 'existsSync'), spyOn(asyncFs, 'stat')];
let countFsCalls = 0;
for (const spy of countFs) {
  const original = spy.getMockImplementation()!;
  (spy as unknown as { mockImplementation(fn: (...args: unknown[]) => unknown): void }).mockImplementation((...args) => {
    if (heldJob.test(new Error().stack ?? '')) countFsCalls++;
    return Reflect.apply(original, undefined, args);
  });
}
const BaseWorker = Worker;
globalThis.Worker = class extends BaseWorker {
  constructor(path: string | URL, options?: WorkerOptions) {
    super(path, options);
    if (!String(path).endsWith('/held-item-worker.ts')) return;
    const post = this.postMessage.bind(this);
    this.postMessage = (data) => {
      process.send!('count-blocked');
      void gates.count.promise.then(() => post(data));
    };
  }
};

const startStatus = runtime.startEngineBackgroundStatus;
mock.module('../../src/workers/engine-split/runtime.ts', () => ({
  ...runtime,
  startEngineBackgroundStatus(input: Parameters<typeof startStatus>[0]) {
    return startStatus({ ...input, collect: () => {
      const count = spyOn(Database.prototype, 'query');
      const beforeFs = countFsCalls;
      const beforePool = pool;
      try {
        const state = input.collect();
        process.send!({ kind: 'count-collection', held: state.held_items !== undefined,
          fs: countFsCalls - beforeFs, pool: pool - beforePool,
          sql: count.mock.calls.filter(([query]) => countSql.test(query)).length });
        return state;
      } finally { count.mockRestore(); }
    } });
  },
}));

const createPanelTools = panel.createDashboardPanelTools;
mock.module('../../src/workers/engine/dashboard/dashboard-panel-tools.ts', () => ({
  ...panel,
  createDashboardPanelTools(options: Parameters<typeof createPanelTools>[0]) {
    process.on('message', (message) => {
      if (message !== 'held-count') return;
      const profile = resolvePrivacyProfilePath();
      const beforePool = pool;
      const sql = spyOn(Database.prototype, 'query');
      const syncFs = countFs.slice(0, 3);
      const fsReads = () => syncFs.flatMap(spy => spy.mock.calls.map(([path]) => path))
        .filter(path => path !== profile).length;
      const beforeFs = fsReads();
      try {
        const frontStatements = () => frontLoopSqlHealth()?.statements ?? sql.mock.calls.length;
        const before = frontStatements();
        const dashboard = options.surface().privacy?.();
        const between = frontStatements();
        const afterDashboardFs = fsReads();
        const setup = options.setup.privacySettings();
        process.send!({
          kind: 'held-count', dashboard, setup, dashboard_fs: afterDashboardFs - beforeFs, setup_fs: fsReads() - afterDashboardFs,
          dashboard_sql: between - before, setup_sql: frontStatements() - between,
          count_fs: countFsCalls, pool: pool - beforePool,
        });
      } finally {
        sql.mockRestore();
      }
    });
    return createPanelTools(options);
  },
}));

if (process.env.OLYMPUS_WORKER_ENGINE_ROLE === 'front') {
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
}
