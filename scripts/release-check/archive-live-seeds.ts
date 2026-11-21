/**
 * The machine-side hooks of the archive leg's import beside a live input (archive-leg.ts, `besideLive` in archive-fixtures.ts): for a
 * source with a live connector, each sets up a synthetic live input and the account it reads on the fresh machine, the way pairing or
 * connecting would leave them, so an export of that account then joins the source instead of staying under Archives.
 *
 * A hook seeds through the source's own connector path (the records its live reader would write, read by its own pull) or through a
 * fake of its provider (readwise-fake.ts is the precedent). It never writes the source's stores itself. Every record is synthetic.
 *
 * A source registers its hook here with `registerLiveSeedHook`, beside its fixture's `besideLive.seedHook` name.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';
import type { StoreView } from './archive-leg.ts';

export interface LiveSeedContext {
  /** The engine's environment on the machine (its home and data folders). */
  env: Record<string, string | undefined>;
  home: string;
}

export interface LiveSeedResult {
  ok: boolean;
  detail: string;
  /** Records of the live input the source's own pull stored. */
  liveItems: number;
}

export interface LiveSeedHook {
  /** Sets the source's account and live input up. */
  seed(context: LiveSeedContext): Promise<LiveSeedResult>;
  /** The source's own stores, by tier, read-only: what the checks look in. */
  stores(context: LiveSeedContext): Array<{ tier: StoreView['tier']; path: string }>;
  /** The provider the source's items carry in its stores. */
  provider: string;
}

const HOOKS = new Map<string, LiveSeedHook>();

export function registerLiveSeedHook(name: string, hook: LiveSeedHook): void {
  HOOKS.set(name, hook);
}

export function liveSeedHook(name: string): LiveSeedHook {
  const hook = HOOKS.get(name);
  if (!hook) throw new Error(`no live seed hook "${name}" is registered (known: ${[...HOOKS.keys()].join(', ') || 'none'})`);
  return hook;
}

export async function seedSpoolRecords(options: {
  path: string;
  records: Array<{ id: string; line: string }>;
  provider: string;
  accountScope: string;
  providerConversationId: string;
  stores: () => Array<LocalConnectorStore | undefined>;
  pull: () => Promise<unknown>;
}): Promise<LiveSeedResult> {
  const { records, path, provider, accountScope, providerConversationId } = options;
  // Per record, how many stores hold it untombstoned: one is stored, more is a duplicate.
  const holders = () => {
    const stores = options.stores();
    return records.map(({ id }) => stores.filter((store) =>
      store?.storedItemState({ provider, accountScope, providerConversationId, providerItemId: id })?.tombstoned === false,
    ).length);
  };
  const countStored = () => holders().filter((n) => n > 0).length;

  const alreadyStored = countStored();
  const spool = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const existing = new Set(spool.split(/\r?\n/u));
  const missing = records.filter(({ line }) => !existing.has(line.trimEnd()));
  if (missing.length) {
    const separator = spool && !spool.endsWith('\n') ? '\n' : '';
    appendFileSync(path, separator + missing.map(({ line }) => line).join(''), { mode: 0o600 });
  }
  await options.pull();
  const after = holders();
  const liveItems = after.filter((n) => n > 0).length;
  const duplicated = after.filter((n) => n > 1).length;
  return {
    ok: liveItems === records.length && duplicated === 0,
    liveItems,
    detail: `${liveItems} of ${records.length} live record(s) stored (${alreadyStored} already stored by an earlier seed)`
      + (duplicated ? `; ${duplicated} stored in more than one store` : ''),
  };
}
