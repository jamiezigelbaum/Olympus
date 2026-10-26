// The release check's Telegram import beside a live input, run against the real product here (no machine): the live seed hook sets
// the account and the live input up, and the fixture's export of that account joins the Telegram source with the counts the leg
// expects (scripts/release-check/archive-fixtures.ts, `besideLive`). The Archives case's export is another account's and stays apart.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TELEGRAM_SOURCE_ID } from '../src/core/olympus-layout.ts';
import { formatSpec, legFixture } from '../scripts/release-check/archive-fixtures.ts';
import { liveSeedHook } from '../scripts/release-check/archive-live-seeds.ts';
import '../scripts/release-check/archive-live-seed-hooks.ts';
import { telegramOneDatasetHarness } from './support/telegram-one-dataset-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('Telegram beside its live input, as the release check runs it', () => {
  test('the seed stores the live input, and the export joins the source with the expected counts', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    const seeded = await liveSeedHook('telegram').seed({ env: h.env, home: h.home });
    expect(seeded).toMatchObject({ ok: true, liveItems: 2 });
    const fx = legFixture('beside', 'seed-beside', 'telegram_json');
    const dir = join(h.exportsDir, 'Telegram Desktop beside');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), fx.bytes);
    const started = await h.startImport(dir);
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    const { record } = { record: (await h.importAll(started.archive_id)).record! };
    expect(record.target?.source_id).toBe(TELEGRAM_SOURCE_ID);
    expect(record.intake).toMatchObject({ read: fx.beside!.read, already_there: fx.beside!.alreadyThere });
    // The word is in the source's stores (held Private until judged).
    expect(h.rows().some((row) => h.textOf(row.conversation, row.id).includes(fx.token))).toBe(true);
  });

  test('the Archives case\'s export is another account\'s, so beside the seeded source it stays apart', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    await liveSeedHook('telegram').seed({ env: h.env, home: h.home });
    const fx = legFixture('agent', 'seed-apart', 'telegram_json');
    const dir = join(h.exportsDir, 'Telegram Desktop other');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), fx.bytes);
    const started = await h.startImport(dir);
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    expect(h.runtime.state.get(started.archive_id)?.target).toBeUndefined();
    expect(formatSpec('telegram_json').besideLive?.sourceId).toBe(TELEGRAM_SOURCE_ID);
  });
});
