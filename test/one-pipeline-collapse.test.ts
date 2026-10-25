// Per-item collapse of a page and the read-back that gates the cursor (contract 2.2.0, step 2): one regression
// per review finding, and a seeded property test over random record sequences, page sizes and crashes.
// Synthetic data only.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';
import { connectorStoreItemText } from '../src/workers/connector-store/local-index.ts';
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

describe('what was judged decides the plan, deleted text stays gone, and a refused item is told', () => {
  const tierOf = (h: OnePipelineHarness, id: string) => h.rows().filter((row) => row.providerItemId === id && row.tombstoned === 0).map((row) => `${row.domain}:${row.trustTier}`);

  test('two live records of one version with different bodies are judged apart: the one with a key is never left readable', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary, pageSize: 1 });
    h.connectLive();
    h.live.records = [rec('a', 9, 'an ordinary body'), rec('a', 9, `key\n${KEY_MARKER}`)];
    await h.pullLive();
    expect(textIn(h)).not.toContain('PRIVATE KEY');
    expect(tierOf(h, 'a').join(',')).not.toContain('internal:S3');
  });

  test('content v1, a deletion v2, then names v3 on one page: the names do not bring v1 back', async () => {
    const items = await listed([rec('a', 1, 'the old words'), rec('a', 2, undefined, { deleted: true }), rec('a', 3, undefined)]);
    expect(items.map(label)).toEqual(['a@3:deleted']);
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    await h.importAll(await h.startImport('three.mbox', [rec('a', 1, 'the old words'), rec('a', 2, undefined, { deleted: true }), rec('a', 3, undefined)]));
    expect(h.textOf('a')).toBe('');
  });

  test('a names-only record over a Secret keeps it a Secret and moves the version, so an older body cannot come back', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    await h.importAll(await h.startImport('s5.mbox', [rec('a', 5, `key\n${KEY_MARKER}`)]));
    await h.importAll(await h.startImport('n7.mbox', [rec('a', 7, undefined)]));
    expect(h.textOf('a')).toBe('');
    await h.importAll(await h.startImport('o6.mbox', [rec('a', 6, 'an older body')]));
    expect(h.textOf('a')).toBe('');
    expect(textIn(h)).not.toContain('PRIVATE KEY');
  });

  test('an item the store refuses is a gap the owner sees, not a silent skip', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    const id = await h.startImport('refused.mbox', [rec('a', 9, undefined)]);
    await h.importAll(id);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
    expect(h.runtime.state.get(id)?.findings.gaps['item_refused']).toBe(1);
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

type Kind = 'ordinary' | 'secret' | 'deleted' | 'names' | 'unversioned' | 'sameVersion';

describe('a crash between legs and a cut between items lose nothing', () => {
  const crashOnce = (h: OnePipelineHarness): void => {
    const store = h.stores.secure_local;
    const orig = store.syncFromConnector.bind(store);
    let thrown = false;
    store.syncFromConnector = (async (...args: Parameters<typeof orig>) => {
      if (!thrown) { thrown = true; throw new Error('injected crash'); }
      return orig(...args);
    }) as typeof orig;
  };
  const drain = async (h: OnePipelineHarness, id: string, maxItems: number): Promise<void> => {
    for (let pass = 0; pass < 12 && h.runtime.state.get(id)?.status !== 'imported'; pass += 1) await h.pull(id, { maxItems }).catch(() => undefined);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
  };

  test('a names-only update does not hide a body that one leg has not written: replay lands it', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 1 });
    h.connectLive();
    await h.importAll(await h.startImport('one.mbox', [rec('a', 1, 'first')]));
    const id = await h.startImport('two.mbox', [rec('a', 2, 'second'), rec('a', 3, undefined)]);
    crashOnce(h);
    await drain(h, id, 3);
    expect(h.textOf('a')).toContain('second');
    expect(h.rows().filter((row) => row.providerItemId === 'a').map((row) => row.version)).toEqual(['3', '3']);
  });

  test('a deletion cut off after one leg is finished by the same deletion on replay', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 1 });
    h.connectLive();
    await h.importAll(await h.startImport('one.mbox', [rec('a', 1, 'doomed words')]));
    const id = await h.startImport('del.mbox', [rec('a', 2, undefined, { deleted: true })]);
    crashOnce(h);
    await drain(h, id, 3);
    expect(h.textOf('a')).toBe('');
    expect(h.rows().filter((row) => row.providerItemId === 'a' && row.tombstoned === 0)).toEqual([]);
  });

  test('children survive a budget cut before the replacement parent, for names-only and for content', async () => {
    const kids = [{ key: 'c1', name: 'a.jpg', text: 'one' }, { key: 'c2', name: 'b.jpg', text: 'two' }];
    for (const second of [undefined, 'second']) {
      const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary, pageSize: 2 });
      h.connectLive();
      const id = await h.startImport('kids.mbox', [rec('p', 1, 'first', { children: kids }), rec('p', 2, second)]);
      await drain(h, id, 2);
      expect(h.rows().filter((row) => row.parent !== null && row.tombstoned === 0).length).toBe(2);
    }
  });

  test('a cut never loses the body an item still needs: A, B with bodies, A and B names-only later, limit 1', async () => {
    const records = [rec('A', 1, 'body A'), rec('B', 1, 'body B'), rec('A', 2, undefined), rec('C', 1, 'body C'), rec('B', 2, undefined)];
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary, pageSize: 5 });
    h.connectLive();
    await drain(h, await h.startImport('abc.mbox', records), 1);
    expect(h.textOf('A')).toContain('body A');
    expect(h.textOf('B')).toContain('body B');
    expect(h.textOf('C')).toContain('body C');
  });

  test('over random records and budgets, a parent is emitted before its children and every cut resumes before what is still owed', async () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = prng(seed);
      const ids = ['A', 'B', 'C'];
      const records: FxRecord[] = [];
      const versions = new Map<string, number>();
      for (let at = 0, length = 3 + Math.floor(random() * 6); at < length; at += 1) {
        const id = ids[Math.floor(random() * ids.length)]!;
        const version = (versions.get(id) ?? 0) + 1 + Math.floor(random() * 2);
        versions.set(id, version);
        const body = random() < 0.6 ? `body ${id}${version}` : undefined;
        records.push(rec(id, version, body, body !== undefined && random() < 0.5 ? { children: [kid] } : {}));
      }
      const pageSize = 1 + Math.floor(random() * 4);
      // A small stand-in for the store: what a pass emitted is what is stored afterwards (a names-only item keeps its body).
      const drainWith = async (budget: number | undefined): Promise<string[]> => {
        const stored = new Map<string, { version: string; body: string }>();
        let cursor: string | undefined;
        for (let pass = 0; pass < 60; pass += 1) {
          const input = { ...inputOf(records), async *records() { await Promise.resolve(); for (let from = 0; from < records.length; from += pageSize) yield { records: records.slice(from, from + pageSize), done: from + pageSize >= records.length }; } };
          const emitted: RawItem[] = [];
          let next: string | undefined;
          let done = false;
          const lookup = ((identity: { localItemId?: string; providerItemId: string }) => {
            const held = stored.get(identity.providerItemId);
            return held ? { version: held.version, hasContent: held.body !== '' } : undefined;
          }) as never;
          for await (const page of inputConnector(fixtureBuilder, input).listItems({ ...(budget !== undefined ? { limit: budget } : {}), ...(cursor !== undefined ? { cursor } : {}), storedItem: lookup })) {
            emitted.push(...page.items);
            // Within a page a parent is emitted before every child of it.
            const firstOf = new Map<string, number>();
            page.items.forEach((item, at) => { if (!firstOf.has(item.identity.providerItemId)) firstOf.set(item.identity.providerItemId, at); });
            page.items.forEach((item, at) => {
              if (!item.identity.providerItemId.includes('#child:')) return;
              const parentAt = firstOf.get(item.identity.providerItemId.split('#child:')[0]!);
              if (parentAt !== undefined) expect(parentAt <= at, `seed ${seed}: parent before its child`).toBe(true);
            });
            next = page.nextCursor;
            done = page.done;
          }
          for (const item of emitted) {
            const key = item.identity.providerItemId;
            const text = item.content.kind === 'metadata_only' ? '' : connectorStoreItemText(item) ?? '';
            stored.set(key, { version: item.identity.sourceVersion ?? '', body: text !== '' ? text : stored.get(key)?.body ?? '' });
          }
          if (done) break;
          cursor = next;
        }
        return [...stored].map(([key, value]) => `${key}@${value.version}:${value.body}`).sort();
      };
      const whole = await drainWith(undefined);
      for (const budget of [1, 2, 3]) expect(await drainWith(budget), `seed ${seed} budget ${budget} page ${pageSize}`).toEqual(whole);
    }
  });
});

describe('random sequences settle on the newest accepted state', () => {
  // PROPERTY_SEEDS widens the run on demand; the default is a fixed, quick set.
  for (const seed of process.env['PROPERTY_ONLY'] ? [Number(process.env['PROPERTY_ONLY'])] : Array.from({ length: Number(process.env['PROPERTY_SEEDS'] ?? 24) }, (_, at) => at + 1)) {
    test(`seed ${seed}`, async () => {
      const random = prng(seed);
      const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
      const kinds: Kind[] = ['ordinary', 'ordinary', 'secret', 'deleted', 'names', 'unversioned', 'sameVersion'];
      const length = 2 + Math.floor(random() * 5);
      const records: FxRecord[] = [];
      const plan: Kind[] = [];
      let version = 0;
      for (let at = 0; at < length; at += 1) {
        // A deletion of an item never stored leaves nothing to remember it by (a known residual), so it never opens a sequence.
        const drawn = pick(kinds);
        const kind = at === 0 && ['deleted', 'unversioned', 'sameVersion'].includes(drawn) ? 'ordinary' : drawn;
        plan.push(kind);
        if (kind === 'unversioned') {
          records.push(rec('a', version, `unversioned body ${at}`, { unversioned: true }));
          continue;
        }
        if (kind === 'sameVersion') {
          // Another body of the version just before: a tie, which an archive does not override.
          records.push(rec('a', version, `same version body ${at}`));
          continue;
        }
        version += 1 + Math.floor(random() * 3);
        const children = kind === 'ordinary' && random() < 0.5 ? [kid] : undefined;
        records.push(kind === 'secret' ? rec('a', version, `key ${at}\n${KEY_MARKER}`)
          : kind === 'deleted' ? rec('a', version, undefined, { deleted: true })
          : kind === 'names' ? rec('a', version, undefined)
          : rec('a', version, `body ${at}`, children ? { children } : {}));
      }
      // The newest accepted state, record by record. A record older than the state changes nothing; names alone
      // never take a body away and never bring a deleted item or a Secret back; a tie keeps what is stored.
      let state: { kind: 'none' | 'body' | 'names' | 'secret' | 'deleted'; body?: string; unversioned?: boolean } = { kind: 'none' };
      // A deletion of an item no pass ever stored (it can share a page with the only record that stored it) leaves
      // nothing to remember it by, so a later tie or unversioned body may legitimately be stored: a known residual.
      const forgotten: string[] = [];
      records.forEach((_record, at) => {
        const kind = plan[at]!;
        // An unversioned body and a same-version body of one version: in one page the later wins, across pages the stored one.
        if (state.kind === 'body' && state.unversioned === true && kind === 'sameVersion') forgotten.push(`same version body ${at}`);
        if (state.kind === 'body' && state.unversioned === true && kind === 'unversioned') forgotten.push(state.body!);
        if (state.kind === 'deleted' && (kind === 'unversioned' || kind === 'sameVersion')) forgotten.push(kind === 'unversioned' ? `unversioned body ${at}` : `same version body ${at}`);
        if (kind === 'unversioned') {
          if (state.kind === 'names' || state.kind === 'none' || (state.kind === 'body' && state.unversioned === true)) state = { kind: 'body', body: `unversioned body ${at}`, unversioned: true };
          return;
        }
        if (kind === 'sameVersion') {
          if (state.kind === 'none' || state.kind === 'names') state = { kind: 'body', body: `same version body ${at}` };
          return;
        }
        if (kind === 'ordinary') state = { kind: 'body', body: `body ${at}` };
        else if (kind === 'secret') state = { kind: 'secret' };
        else if (kind === 'deleted') state = { kind: 'deleted' };
        else if (state.kind === 'none') state = { kind: 'names' };
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
          const out = await h.pull(id, { maxItems: per }).catch((error) => String(error));
        }
        expect(h.runtime.state.get(id)?.status).toBe('imported');
        expect(textIn(h)).not.toContain('PRIVATE KEY');
        const text = h.textOf('a');
        const forgot = state.kind === 'deleted' && forgotten.some((body) => text.includes(body));
        if (state.kind === 'body') expect(forgotten.some((body) => text.includes(body)) || text.includes(state.body!)).toBe(true);
        else if (!forgot) expect(text).toBe('');
        if ((state.kind === 'secret' || state.kind === 'deleted') && !forgot) {
          expect(h.rows().filter((row) => row.providerItemId === 'a' && row.tombstoned === 0 && row.chunks > 0)).toEqual([]);
        }
        // The tier it is stored in is the one the verdict gave: ordinary text is served from the internal store only.
        expect([...new Set(h.rows().filter((row) => row.providerItemId === 'a' && row.tombstoned === 0 && row.chunks > 0).map((row) => row.domain))].filter((domain) => domain !== 'internal')).toEqual([]);
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
