import { heldCountFileIdentity, heldItemCountQuery, TIER_LEDGER_ID_SQL, type HeldItemCorpus, type TierLedger } from '../classification/tier-ledger.ts';
import type { EngineStatusRead } from '../engine-split/snapshot.ts';
import { startPacedStatusRecount } from './status-recount.ts';

export interface HeldCountLedger {
  ledgerId: string;
  file: string;
  corpora: Array<HeldItemCorpus & { mount: string | null }>;
}

export interface HeldCountScope {
  /** Revision of the account selection and placement records. */
  selection: string;
  ledgers: HeldCountLedger[];
}

export interface HeldItemStatus {
  count: number;
  observed_at: string;
  writer_pid: number;
  scope: HeldCountScope;
}

export interface HeldCountPlan {
  scope: HeldCountScope;
  paths: string[];
}

export function heldCountPlan(
  lanes: readonly { ledger: Pick<TierLedger, 'dbPath' | 'statusMount'>; corpusIds: ReadonlySet<string> }[],
  corpus: (id: string) => HeldCountLedger['corpora'][number] | undefined,
  selection: string,
): HeldCountPlan | undefined {
  const groups = new Map<string, { path: string; scope: HeldCountLedger; corpora: Set<string> }>();
  for (const { ledger, corpusIds } of lanes) {
    const mount = ledger.statusMount;
    if (!mount || heldCountFileIdentity(ledger.dbPath) !== mount.file) return undefined;
    let group = groups.get(mount.file);
    if (!group) {
      group = { path: ledger.dbPath, scope: { ...mount, corpora: [] }, corpora: new Set() };
      groups.set(mount.file, group);
    }
    if (group.scope.ledgerId !== mount.ledgerId) return undefined;
    for (const id of corpusIds) {
      if (group.corpora.has(id)) continue;
      const selected = corpus(id);
      if (!selected) return undefined;
      group.corpora.add(id);
      group.scope.corpora.push(selected);
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.scope.file.localeCompare(b.scope.file));
  for (const { scope } of ordered) scope.corpora.sort((a, b) => a.corpusId.localeCompare(b.corpusId));
  return { scope: { selection, ledgers: ordered.map(group => group.scope) }, paths: ordered.map(group => group.path) };
}

/** Both privacy callers consume the same completed observation. Scope and paths stay inside the engine. */
export function frontHeldItems(read: EngineStatusRead | undefined, expected: () => HeldCountPlan | undefined): {
  pendingCount: number;
  pendingCountObservedAt: string;
} | undefined {
  const held = read?.snapshot.held_items;
  if (!held || read?.stale || !Number.isSafeInteger(held.count) || held.count < 0
    || !Number.isFinite(Date.parse(held.observed_at))) return undefined;
  const plan = expected();
  if (!plan || JSON.stringify(plan.scope) !== JSON.stringify(held.scope)) return undefined;
  return { pendingCount: held.count, pendingCountObservedAt: held.observed_at };
}

export function startHeldItemStatus(options: {
  plan: () => HeldCountPlan | undefined;
  holds: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  measure?: (plan: HeldCountPlan) => Promise<number>;
  log?: (line: string) => void;
}) {
  const now = options.now ?? Date.now;
  const measure = options.measure ?? measureHeldItems;
  let held: HeldItemStatus | undefined;
  const pace = startPacedStatusRecount({
    holds: options.holds,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.log ? { log: options.log } : {}),
    recount: async () => {
      const observed_at = new Date(now()).toISOString();
      const plan = options.plan();
      if (JSON.stringify(held?.scope) !== JSON.stringify(plan?.scope)) held = undefined;
      if (!plan) return;
      try {
        const count = await measure(plan);
        if (JSON.stringify(plan) !== JSON.stringify(options.plan())) {
          held = undefined;
          return;
        }
        held = { count, observed_at, writer_pid: process.pid, scope: plan.scope };
      } catch (error) {
        held = undefined;
        throw error;
      }
    },
  });
  return { observation: () => held, soon: pace.soon, stop: pace.stop };
}

// A background-owned thread reads each ledger once. It cannot delay status
// collection or the background command loop, and a slow SQLite read finishes.
const HELD_COUNT_WORKER = `
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
const fileIdentity = path => {
  const file = statSync(path, { bigint: true });
  return \`\${file.dev}:\${file.ino}:\${file.birthtimeNs}\`;
};
self.onmessage = ({ data }) => {
  try {
    let count = 0;
    for (const { path, file, ledgerId, sql, params } of data) {
      if (fileIdentity(path) !== file) throw new Error('Ledger replaced');
      const db = new Database(path, { readonly: true, create: false });
      try {
        db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
        count += db.transaction(() => {
          const observedId = db.query(${JSON.stringify(TIER_LEDGER_ID_SQL)}).get()?.value;
          if (observedId !== ledgerId) throw new Error('Ledger identity changed');
          return db.query(sql).get(...params).n;
        })();
        if (fileIdentity(path) !== file) throw new Error('Ledger replaced');
      } finally {
        db.close();
      }
    }
    postMessage(count);
  } catch {
    // The main process publishes absence for any failed ledger, never a partial sum.
    postMessage(null);
  }
};
`;

export async function measureHeldItems(plan: HeldCountPlan): Promise<number> {
  if (plan.scope.ledgers.length === 0) return 0;
  const jobs = plan.scope.ledgers.map(({ ledgerId, file, corpora }, index) => ({
    path: plan.paths[index], ledgerId, file, ...heldItemCountQuery(corpora),
  }));
  const url = URL.createObjectURL(new Blob([HELD_COUNT_WORKER], { type: 'text/javascript' }));
  let worker: Worker | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      worker = new Worker(url);
      const failed = () => reject(new Error('Held-item count unavailable'));
      worker.addEventListener('close', failed, { once: true });
      worker.onmessageerror = failed;
      worker.onerror = (event) => { event.preventDefault(); failed(); };
      worker.onmessage = ({ data }) => {
        if (Number.isSafeInteger(data) && data >= 0) resolve(data as number);
        else failed();
      };
      worker.postMessage(jobs);
    });
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
}
