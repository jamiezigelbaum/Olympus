/**
 * The seeded states of the sources besides Readwise, for the control exploration (explore.ts).
 *
 * Each source the machine can drive has a driver that brings it to one of the install's seeded states (populated, failed,
 * disconnected with its data kept, empty) through the dashboard's own routes, the way the owner's page does, and reads the card back to
 * check it got there:
 * - Files on this computer (Linux): a real folder of text files made on the machine, chosen with the picker's own tools.
 *
 * Telegram and WhatsApp are not driven: a paired session is a credential-broker handle for a local Telethon or whatsmeow reader, so a stand-in
 * would need a test-only hook in the product (see explore-inventory.ts). A source that cannot reach a state it has is reported (`failedSources`), the other sources are still pressed, and the run's
 * `explore.sources` check fails: a source the machine claims to drive has to be driven. A state a source cannot be in (a chat app
 * cannot be "failed" here) is simply the state it is in.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Seed } from './explore.ts';
import type { SeedId } from './explore-kinds.ts';

type Reply = { status: number; json: any; text: string };
export interface SeedContext {
  call(method: string, path: string, body?: unknown): Promise<Reply>;
  /** The dashboard's card for a provider (`readwise`, `telegram`, `whatsapp_personal`, `local_files`), tried again while the engine restarts. */
  cardOf(provider: string): Promise<any>;
  sleep(ms: number): Promise<void>;
  now(): number;
  home: string;
  env: Record<string, string | undefined>;
}

export interface StateResult { ok: boolean; detail: string }
export interface SourceDriver {
  /** The name the report uses for the source. */
  label: string;
  /** The states this source can be in; a state it has no entry for is left as it is. */
  states: Partial<Record<SeedId, () => Promise<StateResult>>>;
}

const NOT_CONNECTED = ['not_connected', 'needs_setup', 'awaiting_consent', 'reauth_required'];
const connected = (card: any): boolean => !!card && !NOT_CONNECTED.includes(String(card.connection?.state ?? 'not_connected'));
const items = (card: any): number => Number(card?.coverage?.indexed_items ?? 0);
const summary = (card: any): string => `connection ${String(card?.connection?.state ?? '?')} (${String(card?.connection?.label ?? '?').slice(0, 60)}), ${String(card?.coverage?.indexed_items ?? '?')} indexed`;
const flat = (text: unknown): string => String(text ?? '').replace(/\s+/g, ' ').slice(0, 160);

export function helpers(ctx: SeedContext) {
  const until = async <T>(read: () => Promise<T | undefined>, timeoutMs: number, everyMs = 2_000): Promise<T | undefined> => {
    const stop = ctx.now() + timeoutMs;
    for (;;) {
      const got = await read().catch(() => undefined);
      if (got !== undefined) return got;
      if (ctx.now() >= stop) return undefined;
      await ctx.sleep(everyMs);
    }
  };
  /** A mutating route, asked again for a minute while the source is busy (409). */
  const ask = async (path: string, body: unknown): Promise<Reply> => {
    let reply = await ctx.call('POST', path, body);
    for (let attempt = 0; attempt < 12 && reply.status === 409; attempt += 1) {
      await ctx.sleep(5_000);
      reply = await ctx.call('POST', path, body);
    }
    return reply;
  };
  return { until, ask };
}

// ---------------------------------------------------------------------------
// Files on this computer (Linux)

export const LOCAL_FILES_FOLDER = 'rc-files';

export function localFilesDriver(ctx: SeedContext): SourceDriver {
  const { until, ask } = helpers(ctx);
  const folder = join(ctx.home, LOCAL_FILES_FOLDER);
  const away = `${folder}.away`;
  const meta = (reply: Reply): any => reply.json?._meta?.['olympus/scope'] ?? reply.json?.result?._meta?.['olympus/scope'];
  const makeFolder = (): void => {
    if (existsSync(away) && !existsSync(folder)) renameSync(away, folder);
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of [['trip-notes.txt', 'Packing list for the lake trip: tent, stove, two jackets.'], ['recipes.txt', 'Lentil soup: onion, carrot, lentils, stock, forty minutes.'], ['budget.txt', 'October budget check: groceries, transport, books.']] as const) {
      writeFileSync(join(folder, name), `${text}\n`);
    }
  };
  /** The folder is approved through the picker's own two tools: list the top level, save the selection. */
  const approve = async (): Promise<string | undefined> => {
    const listed = await ctx.call('POST', '/dashboard/tools/call', { name: 'olympus_scope_list', arguments: { source_id: 'local.files' } });
    const list = meta(listed);
    const node = (list?.nodes ?? []).find((entry: any) => entry?.name === LOCAL_FILES_FOLDER);
    if (!list || !node) return `the picker did not list the folder ${LOCAL_FILES_FOLDER} (answered ${listed.status}, ${(list?.nodes ?? []).length} folder(s) listed)`;
    const saved = await ctx.call('POST', '/dashboard/tools/call', { name: 'olympus_scope_set', arguments: { source_id: 'local.files', account_generation: list.account_generation, scope_revision: list.scope_revision, selections: [{ key: node.key, state: 'ingest' }] } });
    return saved.status === 200 && saved.json?.isError !== true ? undefined : `saving the folder answered ${saved.status}: ${flat(saved.text)}`;
  };
  const populated = async (strict = true): Promise<StateResult> => {
    makeFolder();
    let card = await ctx.cardOf('local_files');
    if (!connected(card)) {
      const reply = await ask('/dashboard/connect/this-computer', { source: 'local.files' });
      if (reply.status !== 200) return { ok: false, detail: `connect answered ${reply.status}: ${flat(reply.text)}` };
    }
    card = await ctx.cardOf('local_files');
    if (card?.scope_selection?.status !== 'approved') {
      const problem = await approve();
      if (problem) return { ok: false, detail: problem };
    }
    await ctx.call('POST', '/dashboard/sync-now', { source: 'local.files' });
    card = await until(async () => { const now = await ctx.cardOf('local_files'); // `synced`, not `syncing`: while the read is under way the row offers fewer actions, and the page would change under the first presses.
      return connected(now) && now?.connection?.state === 'synced' && items(now) > 0 && (!strict || (now?.schedule?.missing_folders?.length ?? 0) === 0) ? now : undefined; }, strict ? 300_000 : 120_000, 3_000);
    return card ? { ok: true, detail: `Files on this computer: ${summary(card)}${(card?.schedule?.missing_folders?.length ?? 0) > 0 ? ` (card still lists ${card.schedule.missing_folders.length} missing folder(s) although the folder is back)` : ''}` } : { ok: false, detail: `Files on this computer: the folder was not indexed (${summary(await ctx.cardOf('local_files'))}; schedule ${JSON.stringify((await ctx.cardOf('local_files'))?.schedule ?? null).slice(0, 600)})` };
  };
  const disconnect = async (): Promise<StateResult> => {
    const reply = await ask('/dashboard/disconnect', { source_id: 'local.files', acknowledge: true });
    if (reply.status !== 200) return { ok: false, detail: `disconnect answered ${reply.status}: ${flat(reply.text)}` };
    const card = await until(async () => { const now = await ctx.cardOf('local_files'); return now && !connected(now) ? now : undefined; }, 60_000);
    return card ? { ok: true, detail: `Files on this computer: ${summary(card)}` } : { ok: false, detail: `Files on this computer did not read as disconnected: ${summary(await ctx.cardOf('local_files'))}` };
  };
  return {
    label: 'Files on this computer',
    states: {
      populated,
      // The chosen folder is gone: the source cannot read it, and the row has to say so and offer a way to fix it.
      failed: async () => {
        const first = await populated();
        if (!first.ok) return first;
        renameSync(folder, away);
        let card: any;
        for (let round = 0; round < 6 && !card; round += 1) {
          await ctx.call('POST', '/dashboard/sync-now', { source: 'local.files' }).catch(() => undefined);
          card = await until(async () => { const now = await ctx.cardOf('local_files'); return (now?.schedule?.missing_folders?.length ?? 0) > 0 || now?.schedule?.degraded_reason === 'scope_root_missing' ? now : undefined; }, 30_000, 3_000);
        }
        return card ? { ok: true, detail: `Files on this computer, folder gone: ${summary(card)}` } : { ok: false, detail: `Files on this computer: with its folder moved away the card never reported a missing folder (${summary(await ctx.cardOf('local_files'))})` };
      },
      disconnected: async () => {
        // Only the disconnect matters here, so a card still reporting a folder that came back does not stop it.
        const first = await populated(false);
        return first.ok ? await disconnect() : first;
      },
      empty: async () => {
        let card = await ctx.cardOf('local_files');
        if (connected(card)) {
          const done = await disconnect();
          if (!done.ok) return done;
        }
        card = await ctx.cardOf('local_files');
        if (items(card) > 0) {
          const reply = await ask('/dashboard/delete-source-data', { source_id: 'local.files', acknowledge: true });
          if (reply.status !== 200) return { ok: false, detail: `delete-source-data answered ${reply.status}: ${flat(reply.text)}` };
          card = await until(async () => { const now = await ctx.cardOf('local_files'); return items(now) === 0 && !connected(now) ? now : undefined; }, 120_000, 3_000);
        }
        return card && items(card) === 0 ? { ok: true, detail: `Files on this computer: ${summary(card)}` } : { ok: false, detail: `Files on this computer did not read as empty: ${summary(await ctx.cardOf('local_files'))}` };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Putting them together

/**
 * The primary seeds (Readwise's: the stand-in API) with every other driven source brought to the same state. The primary's own result
 * stays the seed's result; another source that cannot reach the state is listed in `failedSources` and the seed is still pressed.
 */
/** The longest one source may take to reach one state. */
const STATE_BOUND_MS = 420_000;

export function composeSeeds(primary: readonly Seed[], drivers: readonly SourceDriver[]): Seed[] {
  return primary.map((seed) => ({
    ...seed,
    apply: async () => {
      const first = await seed.apply();
      if (!first.ok) return first;
      const details = [first.detail];
      const failedSources: Array<{ source: string; detail: string }> = [];
      for (const driver of drivers) {
        const state = driver.states[seed.id];
        if (!state) continue;
        const started = Date.now();
        // A source that does not come to its state in this time is reported as not produced, so one slow source cannot take the whole exploration.
        const bound = new Promise<StateResult>((done) => setTimeout(() => done({ ok: false, detail: `${driver.label} did not reach its state within ${STATE_BOUND_MS / 1000} s` }), STATE_BOUND_MS));
        const result = await Promise.race([state(), bound]).catch((error: unknown): StateResult => ({ ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }));
        details.push(`${result.ok ? result.detail : `${driver.label} NOT PRODUCED`} (${Math.round((Date.now() - started) / 1000)} s)`);
        if (!result.ok) failedSources.push({ source: driver.label, detail: result.detail });
      }
      return { ok: true, detail: details.join('; '), ...(failedSources.length > 0 ? { failedSources } : {}) };
    },
  }));
}
