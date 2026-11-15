// The image sweep on the loop (family 3, loop-stall step-back): an image it
// can't raise yet (a move in flight, a failure) is held and tried again
// before the sweep records itself done, so a raise to Private is delayed but
// never lost. Stripping unrouted copies doesn't wait on held images.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { SourceConnector } from '../src/core/contracts.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { sweepImageContentToPrivateOffThread } from '../src/workers/connector-store/tier-image-content-sweep.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  shutdownReadPool();
});

function imageConnector(specs: FixtureSpec[]): SourceConnector {
  const base = fixtureConnector(() => specs);
  const asImage = <T extends { mimeType?: string }>(item: T): T => ({ ...item, mimeType: 'image/png' });
  return {
    ...base,
    listItems: () => (async function* () {
      for await (const page of base.listItems()) yield { ...page, items: page.items.map(asImage) };
    })(),
    fetchItem: async (id) => asImage(await base.fetchItem(id)),
  };
}

const content = (fixture: ReturnType<typeof openTierFixture>, id: string) => {
  const row = fixture.ledger.getCurrent(identityOf(id))!;
  return row.state === 'moving' ? row.targetContentTier : row.contentTier;
};

test('a moving or failing image is held, and the sweep is done only once it is raised', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const ids = ['photo-a', 'photo-b', 'photo-c'];
  const specs: FixtureSpec[] = ids.map((id) => ({ id, name: `${id}.png`, text: `text read from ${id}` }));
  await fixture.set.sync(imageConnector(specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Start each one Public, as an image placed before the image default was.
  for (const id of ids) {
    await moveTieredItem({
      set: fixture.set, identity: identityOf(id), target: { metadataTier: 'public', contentTier: 'public' },
      vectorIdentities: { public_safe: fixture.cloud },
      embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
    });
    expect(fixture.ledger.getCurrent(identityOf(id))).toMatchObject({ contentTier: 'public', state: 'current' });
  }
  const ledger = fixture.ledger;
  // The sweep a sync ran already passed these: start it again, as an upgrade does.
  ledger.deleteMeta('image_content_private_sweep');
  // photo-a is mid-move when the loop reaches it; photo-b's copies can't be read once.
  const a = ledger.getCurrent(identityOf('photo-a'))!;
  const moving = ledger.beginMove(identityOf('photo-a'), { metadataTier: 'public', contentTier: 'public' }, a.generation);
  const copies = ledger.copies.bind(ledger);
  let failures = 1;
  ledger.copies = ((identity: Parameters<typeof copies>[0]) => {
    if (identity.providerItemId === 'photo-b' && failures > 0) { failures -= 1; throw new Error('busy'); }
    return copies(identity);
  }) as typeof ledger.copies;

  const first = await sweepImageContentToPrivateOffThread({ set: fixture.set });
  expect(first).toMatchObject({ scanned: 3, raised: 1, complete: false });
  expect(content(fixture, 'photo-c')).toBe('secure');
  expect(content(fixture, 'photo-b')).toBe('public');

  // photo-b is raised on the retry; photo-a stays held while it moves.
  const second = await sweepImageContentToPrivateOffThread({ set: fixture.set });
  expect(second).toMatchObject({ raised: 1, complete: false });
  expect(content(fixture, 'photo-b')).toBe('secure');

  // The move ends where it began (Public): the held image is raised and the sweep is done.
  ledger.abandonMove(identityOf('photo-a'), { expectedGeneration: moving.generation });
  expect(ledger.getCurrent(identityOf('photo-a'))).toMatchObject({ contentTier: 'public', state: 'current' });
  const third = await sweepImageContentToPrivateOffThread({ set: fixture.set });
  expect(third).toMatchObject({ raised: 1, complete: true });
  expect(content(fixture, 'photo-a')).toBe('secure');
  expect(await sweepImageContentToPrivateOffThread({ set: fixture.set })).toMatchObject({ scanned: 0, raised: 0, complete: true });
});
