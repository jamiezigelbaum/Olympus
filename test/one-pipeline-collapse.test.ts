// Per-item collapse of a page and the read-back that gates the cursor (contract 2.2.0, step 2): one regression
// per review finding, and a seeded property test over random record sequences, page sizes and crashes.
// Synthetic data only.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';
import { inputConnector, type IntakeObservingInput } from '../src/core/source-inputs.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import {
  FIXTURE_ACCOUNT_SCOPE, fixtureBuilder, onePipelineHarness, type FxRecord, type OnePipelineHarness,
} from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const KEY_MARKER = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
const judgedOrdinary: TierSniffer = { id: 'scripted', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };
const rec = (id: string, version: number, body: string | undefined, extra: Partial<FxRecord> = {}): FxRecord => ({
  id, version, subject: `Subject ${id}`, ...(body !== undefined ? { body } : {}), ...extra,
});
const kid = { key: 'k1', name: 'photo.jpg', text: 'bytes' };

function inputOf(records: readonly FxRecord[], extra: Partial<IntakeObservingInput<FxRecord>> = {}): IntakeObservingInput<FxRecord> {
  return {
    inputId: 'archive.collapse',
    kind: 'archive',
    async *records() { await Promise.resolve(); yield { records, done: true }; },
    ...extra,
  };
}

async function listed(records: readonly FxRecord[], storedItem?: Parameters<NonNullable<ReturnType<typeof inputConnector>['listItems']>>[0] extends infer O ? (O extends { storedItem?: infer S } ? S : never) : never): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const pages: SourceConnectorListPage[] = [];
  for await (const page of inputConnector(fixtureBuilder, inputOf(records)).listItems(storedItem ? { storedItem } : {})) pages.push(page);
  for (const page of pages) items.push(...page.items);
  return items;
}
const label = (item: RawItem): string => `${item.identity.providerItemId}@${item.identity.sourceVersion ?? '-'}${item.metadata['deleted'] === true ? ':deleted' : item.content.kind === 'metadata_only' ? ':names' : ':body'}`;

describe('a page is reduced per item', () => {
  test('a child a superseded parent first brought is kept when the winning parent lists it again', async () => {
    const items = await listed([
      rec('p', 5, undefined, { children: [kid] }),
      rec('p', 5, 'the body now', { children: [kid] }),
    ]);
    expect(items.map(label).sort()).toEqual(['p#child:k1@5:names', 'p@5:body'].sort());
  });

  test('an unversioned record that supplies content keeps the version the store holds, and an older record after it is refused', async () => {
    const stored = () => ({ version: '9', hasContent: false });
    const items = await listed([
      rec('a', 1, 'content without a version', { unversioned: true }),
      rec('a', 5, 'older content'),
    ], stored);
    expect(items.map(label)).toEqual(['a@9:body']);
  });

  test('a deletion beats a content record of the same version in one page, in either order', async () => {
    const first = await listed([rec('a', 9, undefined, { deleted: true }), rec('a', 9, 'content')]);
    expect(first.map(label)).toEqual(['a@9:deleted']);
    const second = await listed([rec('a', 9, 'content'), rec('a', 9, undefined, { deleted: true })]);
    expect(second.map(label)).toEqual(['a@9:deleted']);
  });
});

function textIn(h: OnePipelineHarness): string {
  const found: string[] = [];
  for (const domain of ['internal', 'secure_local'] as const) {
    const db = new Database(h.storePaths[domain], { readonly: true });
    try {
      found.push(...(db.query('SELECT c.text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?').all(FIXTURE_ACCOUNT_SCOPE) as Array<{ text: string }>).map((row) => row.text));
    } catch {
      // A store with no chunk table holds no text.
    } finally {
      db.close();
    }
  }
  return found.join('\n');
}

/** Pulls, one item at a time, until the import is done; a pass that throws is a crash the next one recovers from. */
async function drive(h: OnePipelineHarness, id: string, maxItems = 1, passes = 40): Promise<void> {
  for (let pass = 0; pass < passes && h.runtime.state.get(id)?.status !== 'imported'; pass += 1) {
    await h.pull(id, { maxItems }).catch(() => undefined);
  }
}

describe('the cursor passes a page only once the stores hold what it accepted', () => {
  test('a Secret version whose deletion was cut off is finished on replay: nothing of the old body stays', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    await h.importAll(await h.startImport('v1.mbox', [rec('a', 1, 'the old readable words')]));
    expect(h.textOf('a')).toContain('old readable');
    const id = await h.startImport('v2.mbox', [rec('a', 2, `key\n${KEY_MARKER}`)]);
    const store = h.set.store('internal', { create: true })!;
    const original = store.advanceItemVersion.bind(store);
    let crashed = false;
    store.advanceItemVersion = ((...args: Parameters<typeof original>) => {
      original(...args);
      if (!crashed) { crashed = true; throw new Error('injected crash after the version update'); }
    }) as typeof original;
    await h.pull(id).catch(() => undefined);
    expect(crashed).toBe(true);
    await drive(h, id);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
    expect(textIn(h)).not.toContain('old readable');
    expect(textIn(h)).not.toContain('PRIVATE KEY');
  });

  test('a names-only newer record over stored content is accepted: the import completes, the text stays, an older body cannot overwrite it', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    h.live.records = [rec('a', 1, 'the live words')];
    await h.pullLive();
    const names = await h.startImport('names.mbox', [rec('a', 9, undefined)]);
    await drive(h, names);
    expect(h.runtime.state.get(names)?.status).toBe('imported');
    const older = await h.startImport('older.mbox', [rec('a', 5, 'an older body')]);
    await drive(h, older);
    expect(h.runtime.state.get(older)?.status).toBe('imported');
    expect(h.textOf('a')).toContain('the live words');
    expect(h.textOf('a')).not.toContain('older body');
  });

  test('ordinary v1 stored, then Secret v2 and ordinary v3 on separate pages, cut off right after the Secret version update: v3 ends stored', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary, pageSize: 1 });
    h.connectLive();
    await h.importAll(await h.startImport('first.mbox', [rec('a', 1, 'first words')]));
    const id = await h.startImport('later.mbox', [rec('a', 2, `key\n${KEY_MARKER}`), rec('a', 3, 'third words')]);
    const store = h.set.store('internal', { create: true })!;
    const original = store.advanceItemVersion.bind(store);
    let crashed = false;
    store.advanceItemVersion = ((...args: Parameters<typeof original>) => {
      original(...args);
      if (!crashed) { crashed = true; throw new Error('injected crash after the version update'); }
    }) as typeof original;
    await drive(h, id, 2);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
    expect(h.textOf('a')).toContain('third words');
    expect(textIn(h)).not.toContain('PRIVATE KEY');
  });
});

// ---- a seeded property test ------------------------------------------------------------------------------

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'ordinary' | 'secret' | 'deleted' | 'names' | 'unversioned';

describe('random sequences settle on the newest accepted state', () => {
  // PROPERTY_SEEDS widens the run on demand; the default is a fixed, quick set.
  for (const seed of Array.from({ length: Number(process.env['PROPERTY_SEEDS'] ?? 24) }, (_, at) => at + 1)) {
    test(`seed ${seed}`, async () => {
      const random = prng(seed);
      const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
      const kinds: Kind[] = ['ordinary', 'ordinary', 'secret', 'deleted', 'names', 'unversioned'];
      const length = 2 + Math.floor(random() * 5);
      const records: FxRecord[] = [];
      const plan: Kind[] = [];
      let version = 0;
      for (let at = 0; at < length; at += 1) {
        // Names alone and a record without a version only matter over a stored body: they must not erase it.
        const wanted = pick(kinds);
        const kind: Kind = (wanted === 'names' || wanted === 'unversioned') && plan.length > 0 && !['ordinary', 'names', 'unversioned'].includes(plan[plan.length - 1]!) ? 'ordinary' : wanted === 'names' || wanted === 'unversioned' ? (plan.length === 0 ? 'ordinary' : wanted) : wanted;
        plan.push(kind);
        if (kind === 'unversioned') {
          records.push(rec('a', version, `unversioned body ${at}`, { unversioned: true }));
          continue;
        }
        version += 1 + Math.floor(random() * 3);
        const children = kind === 'ordinary' && random() < 0.5 ? [kid] : undefined;
        records.push(kind === 'secret' ? rec('a', version, `key ${at}\n${KEY_MARKER}`)
          : kind === 'deleted' ? rec('a', version, undefined, { deleted: true })
          : kind === 'names' ? rec('a', version, undefined)
          : rec('a', version, `body ${at}`, children ? { children } : {}));
      }
      // The newest accepted state, record by record (a record older than the state, or an unversioned one that the
      // state already covers, changes nothing).
      let state: { kind: 'none' | 'body' | 'names' | 'secret' | 'deleted'; body?: string } = { kind: 'none' };
      records.forEach((record, at) => {
        const kind = plan[at]!;
        if (kind === 'unversioned') {
          if (state.kind === 'names' || state.kind === 'none') state = { kind: 'body', body: `unversioned body ${at}` };
          return;
        }
        if (kind === 'ordinary') state = { kind: 'body', body: `body ${at}` };
        else if (kind === 'secret') state = { kind: 'secret' };
        else if (kind === 'deleted') state = { kind: 'deleted' };
        else if (state.kind === 'none' || state.kind === 'secret' || state.kind === 'deleted') state = { kind: 'names' };
      });

      const pageSize = 1 + Math.floor(random() * 3);
      const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary, pageSize });
      h.connectLive();
      try {
        const id = await h.startImport('random.mbox', records);
        // A crash at a random step of a random pass.
        const crashAt = Math.floor(random() * 4);
        const hook = Math.floor(random() * 3);
        let passes = 0;
        let armed = true;
        const fire = (): void => { if (armed && passes >= crashAt) { armed = false; throw new Error('injected crash'); } };
        const internal = h.set.store('internal', { create: true })!;
        const origAdvance = internal.advanceItemVersion.bind(internal);
        const origWithdraw = h.set.withdrawCopies.bind(h.set);
        const origRemove = h.set.ledger.removeCopies.bind(h.set.ledger);
        if (hook === 0) internal.advanceItemVersion = ((...args: Parameters<typeof origAdvance>) => { origAdvance(...args); fire(); }) as typeof origAdvance;
        if (hook === 1) h.set.withdrawCopies = ((...args: Parameters<typeof origWithdraw>) => { fire(); origWithdraw(...args); }) as typeof origWithdraw;
        if (hook === 2) h.set.ledger.removeCopies = ((...args: Parameters<typeof origRemove>) => { fire(); return origRemove(...args); }) as typeof origRemove;
        const per = 1 + Math.floor(random() * 3);
        for (let pass = 0; pass < 60 && h.runtime.state.get(id)?.status !== 'imported'; pass += 1) {
          passes += 1;
          await h.pull(id, { maxItems: per }).catch(() => undefined);
        }
        expect(h.runtime.state.get(id)?.status).toBe('imported');
        expect(textIn(h)).not.toContain('PRIVATE KEY');
        const text = h.textOf('a');
        if (state.kind === 'body') expect(text).toContain(state.body!);
        else expect(text).toBe('');
        if (state.kind === 'secret' || state.kind === 'deleted') {
          expect(h.rows().filter((row) => row.providerItemId === 'a' && row.tombstoned === 0 && row.chunks > 0)).toEqual([]);
        }
        // Every child that is still served has its parent present.
        const rows = h.rows();
        for (const child of state.kind === 'body' || state.kind === 'names' ? rows.filter((row) => row.parent !== null && row.tombstoned === 0) : []) {
          expect(rows.some((row) => `${FIXTURE_ACCOUNT_SCOPE}:${row.providerItemId}` === child.parent && row.tombstoned === 0)).toBe(true);
        }
      } catch (error) {
        throw new Error(`property test failed for seed ${seed} (expected ${JSON.stringify(state)}, stored ${JSON.stringify(h.rows().filter((r) => r.providerItemId === 'a').map((r) => [r.domain, r.version, r.tombstoned, r.chunks]))}, text ${JSON.stringify(h.textOf('a'))}) (records ${JSON.stringify(records.map((r) => [r.version, r.unversioned ? 'u' : '', r.deleted ? 'd' : '', r.body === undefined ? 'n' : r.body.includes('PRIVATE') ? 's' : 'b']))}): ${String(error instanceof Error ? error.message : error)}`);
      }
    });
  }
});
