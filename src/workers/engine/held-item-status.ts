import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { heldCountFileIdentity, heldItemCountQuery, TIER_LEDGER_ID_SQL, type HeldItemCorpus, type TierLedger } from '../classification/tier-ledger.ts';
import { accountFromGoogleHandle } from '../google-connectors/classification.ts';
import type { EngineStatusRead, HeldCountScope, HeldItemStatus } from '../engine-split/snapshot.ts';
import { startPacedStatusRecount } from './status-recount.ts';

type LedgerOwner = Pick<TierLedger, 'dbPath' | 'statusMount' | 'onClose' | 'visibilityChangesSince'>;
type Corpus = HeldItemCorpus & {
  file: string | null;
  path?: string;
  generation: string | null;
  /** The selection shared by both roles, when the writer resolves a retained item scope. */
  selection?: string;
  current: () => boolean;
  mounted: () => boolean;
};

export interface HeldCountPlan {
  scope: HeldCountScope;
  jobs: Array<{ path: string; file: string; ledgerId: string; sql: string; params: string[] }>;
  ledgers: LedgerOwner[];
  files: ReadonlyMap<string, string | null>;
  cursors(): string;
  mountsCurrent(): boolean;
  current(): boolean;
}

const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function heldGoogleAccount(
  handle: { handle: string; accountRole?: string } | undefined,
  retainedScope?: (handle: { handle: string; accountRole?: string }) => string,
): string | undefined {
  if (!handle) return undefined;
  return retainedScope?.(handle) ?? (handle.accountRole?.trim() || accountFromGoogleHandle(handle.handle));
}

export function heldSourceMountsComplete<Lane extends { id: string; enabled: boolean; mountBlocked?: boolean }>(
  lanes: readonly Lane[],
  mounted: ReadonlySet<string>,
  openable: (sourceId: string) => boolean,
  hasInventory: (lane: Lane) => boolean,
): boolean {
  // Repairing the registry does not re-enable a lane disabled at boot.
  return !lanes.some(lane => openable(lane.id)
    && (lane.mountBlocked || (lane.enabled && !mounted.has(lane.id) && hasInventory(lane))));
}

/** Check the actual mounted paths on the front's existing asynchronous mount tick. */
export async function heldCountFilesCurrent(files: HeldCountPlan['files']): Promise<boolean> {
  const matched = await Promise.all([...files].map(async ([path, expected]) => {
    try {
      const file = await stat(path, { bigint: true });
      return file.isFile() && `${file.dev}:${file.ino}:${file.birthtimeNs}` === expected;
    } catch (error) {
      return expected === null && (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }));
  return matched.every(Boolean);
}

export function heldCountPlan(
  lanes: readonly { ledger: LedgerOwner; corpusIds: ReadonlySet<string> }[],
  corpus: (id: string) => Corpus | undefined,
  selection: string,
  emptyInstall = false,
): HeldCountPlan | undefined {
  if (!lanes.length && !emptyInstall) return undefined;
  const groups = new Map<string, {
    ledger: LedgerOwner; ledgerId: string; mounts: Set<string>; corpora: Map<string, Corpus>;
  }>();
  const checks: Array<() => boolean> = [];
  const files = new Map<string, string | null>();
  const mountsCurrent: Array<() => boolean> = [];
  for (const { ledger, corpusIds } of lanes) {
    const mount = ledger.statusMount;
    if (!mount || heldCountFileIdentity(ledger.dbPath) !== mount.file || !corpusIds.size) return undefined;
    files.set(ledger.dbPath, mount.file);
    mountsCurrent.push(() => ledger.statusMount?.generation === mount.generation);
    checks.push(() => heldCountFileIdentity(ledger.dbPath) === mount.file);
    let group = groups.get(mount.file);
    if (!group) {
      group = { ledger, ledgerId: mount.ledgerId, mounts: new Set(), corpora: new Map() };
      groups.set(mount.file, group);
    }
    if (group.ledgerId !== mount.ledgerId) return undefined;
    group.mounts.add(mount.generation);
    for (const id of corpusIds) {
      if (group.corpora.has(id)) continue;
      const selected = corpus(id);
      if (!selected) return undefined;
      group.corpora.set(id, selected);
      if (selected.path) files.set(selected.path, selected.file);
      checks.push(selected.current);
      mountsCurrent.push(selected.mounted);
    }
  }
  const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([file, group]) => ({
    ...group, file, corpora: [...group.corpora.values()].sort((a, b) => a.corpusId.localeCompare(b.corpusId)),
  }));
  const view = digest([selection, ordered.map(({ file, ledgerId, corpora }) => [
    file, ledgerId, corpora.map(c => [c.corpusId, c.file, c.selection ?? c.accountScope]),
  ])]);
  const generation = digest([view, ordered.map(({ mounts, corpora }) => [
    [...mounts].sort(), corpora.map(c => [c.generation, c.accountScope]),
  ])]);
  return {
    scope: { view, generation },
    jobs: ordered.map(({ ledger, file, ledgerId, corpora }) => ({
      path: ledger.dbPath, file, ledgerId, ...heldItemCountQuery(corpora),
    })),
    ledgers: [...new Set(lanes.map(lane => lane.ledger))],
    files,
    cursors: () => JSON.stringify(ordered.map(({ ledger }) => ledger.visibilityChangesSince().cursor)),
    mountsCurrent: () => mountsCurrent.every(check => check()),
    current: () => mountsCurrent.every(check => check()) && checks.every(check => check()),
  };
}

/** The front's request reads only the observation already accepted for its mounted view. */
export function frontHeldItems(
  read: EngineStatusRead | undefined,
  expected: HeldCountScope | undefined,
): { pendingCount: number; pendingCountObservedAt: string } | undefined {
  const held = read?.snapshot.held_items;
  if (!held || read?.stale || !expected || held.scope?.view !== expected.view
    || held.scope.generation !== expected.generation || !Number.isSafeInteger(held.count)
    || held.count < 0 || !Number.isFinite(Date.parse(held.observed_at))) return undefined;
  return { pendingCount: held.count, pendingCountObservedAt: held.observed_at };
}

export function startHeldItemStatus(options: {
  plan: () => HeldCountPlan | undefined;
  holds: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  measure?: (plan: HeldCountPlan, signal: AbortSignal) => Promise<number>;
  log?: (line: string) => void;
}) {
  const now = options.now ?? Date.now;
  const measure = options.measure ?? measureHeldItems;
  let stopped = false;
  let active: AbortController | undefined;
  let mounted: HeldCountPlan | undefined;
  let releases: Array<() => void> = [];
  let lastCursor: string | undefined;
  let checkedCursor: string | undefined;
  let held: HeldItemStatus | undefined;
  const clear = () => {
    active?.abort();
    mounted = held = undefined;
    lastCursor = checkedCursor = undefined;
    for (const release of releases.splice(0)) release();
  };
  const wake = () => pace.soon();
  const invalidate = () => { clear(); wake(); };
  const pace = startPacedStatusRecount({
    holds: options.holds,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.log ? { log: options.log } : {}),
    recount: async () => {
      const plan = options.plan();
      if (mounted?.scope.generation !== plan?.scope.generation) clear();
      if (!plan || !plan.current()) { clear(); return; }
      if (!mounted) {
        mounted = plan;
        releases = plan.ledgers.map(ledger => ledger.onClose(invalidate));
      }
      const controller = new AbortController();
      active = controller;
      try {
        const cursor = plan.cursors();
        checkedCursor = cursor;
        if (held && lastCursor === cursor) return;
        const observed_at = new Date(now()).toISOString();
        const count = await measure(plan, controller.signal);
        if (stopped || controller.signal.aborted) return;
        const current = plan.current() ? options.plan() : undefined;
        if (stopped || controller.signal.aborted) return;
        if (plan.scope.generation !== current?.scope.generation) { clear(); return; }
        lastCursor = cursor;
        held = { count, observed_at, writer_pid: process.pid, scope: plan.scope };
      } catch (error) {
        if (controller.signal.aborted) return;
        clear();
        throw error;
      } finally {
        if (active === controller) active = undefined;
      }
    },
  });
  return {
    observation: () => held,
    /** Check the visibility feed at the background's existing status heartbeat. */
    check: () => {
      if (!mounted) return;
      try {
        if (!mounted.current()) { invalidate(); return; }
        const cursor = mounted.cursors();
        if (checkedCursor !== cursor) { checkedCursor = cursor; wake(); }
      } catch {
        // An unreadable feed cannot validate an observation.
        invalidate();
      }
    },
    soon: wake,
    invalidate,
    stop: () => { stopped = true; clear(); pace.stop(); },
  };
}

// A background-owned thread reads each ledger once. A slow SQLite read
// finishes unless the owner closes the ledger or shuts down.
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
    // The owner publishes absence for any failed ledger.
    postMessage(null);
  }
};
`;

export async function measureHeldItems(plan: HeldCountPlan, signal?: AbortSignal, WorkerType = Worker): Promise<number> {
  signal?.throwIfAborted();
  if (plan.jobs.length === 0) return 0;
  const url = URL.createObjectURL(new Blob([HELD_COUNT_WORKER], { type: 'text/javascript' }));
  let worker: Worker | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      worker = new WorkerType(url);
      const failed = () => reject(new Error('Held-item count unavailable'));
      cancel = () => {
        reject(signal?.reason);
        worker?.terminate();
        worker = undefined;
      };
      signal?.addEventListener('abort', cancel, { once: true });
      worker.addEventListener('close', failed, { once: true });
      worker.onmessageerror = failed;
      worker.onerror = (event) => { event.preventDefault(); failed(); };
      worker.onmessage = ({ data }) => {
        if (Number.isSafeInteger(data) && data >= 0) resolve(data as number);
        else failed();
      };
      worker.postMessage(plan.jobs);
    });
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
}
