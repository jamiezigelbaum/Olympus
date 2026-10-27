// The release check's import-beside-live cases (scripts/release-check/archive-fixtures.ts, SOURCE_INPUT_FORMATS), run through the
// product: the live records first, then the export, through the real approval, import, stores and intake rule. What the source holds
// after is what the case says, from the case's own numbers.

import { afterEach, describe, expect, test } from 'bun:test';
import { googleAccountIdFromAddress } from '../src/core/provider-account-identity.ts';
import { SOURCE_INPUT_FORMATS, fixtureToken } from '../scripts/release-check/archive-fixtures.ts';
import { gmailArchiveHarness } from './support/gmail-archive-harness.ts';
import { OWNER_ADDRESS } from './support/archive-fixtures-gmail.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('import beside live', () => {
  test('the Gmail Takeout case: the export joins the live mail, each message once, and counts what was already there', async () => {
    const spec = SOURCE_INPUT_FORMATS.gmail_takeout!;
    const token = fixtureToken('seed', 'beside-live', spec.id);
    const built = spec.small(token);
    const h = gmailArchiveHarness(cleanups);
    h.connectLive(googleAccountIdFromAddress(OWNER_ADDRESS));
    h.window.contentAfterMs = Date.parse('2020-01-01T00:00:00.000Z');
    h.mailbox.messages = [...built.live];
    await h.pullLive();

    const text = Buffer.from(built.bytes).toString('utf8');
    const result = await h.approve(`rc-beside-live${spec.extension}`, text, { confirmAccount: true });
    if (!result.ok || result.status !== 'started') throw new Error(JSON.stringify(result));
    const outcome = await h.importAll(result.archive_id);
    expect(outcome.record?.status).toBe('imported');
    expect(outcome.record?.target?.source_id).toBe(spec.sourceId);

    const active = h.rows().filter((row) => row.tombstoned === 0);
    expect(new Set(active.map((row) => row.id)).size).toBe(built.items);
    const [card] = h.dashboard.sourceImports();
    expect(card?.imports[0]).toMatchObject({ read: built.read, alreadyThere: built.alreadyThere });
    expect(outcome.record?.date_range).toEqual({
      earliest: expect.stringContaining(built.expect.earliest),
      latest: expect.stringContaining(built.expect.latest),
    });
    for (const entry of built.expect.notImported) expect(outcome.record?.findings.skipped[entry.kind] ?? outcome.record?.findings.gaps[entry.kind]).toBe(entry.count);
    // The word is found in what only the export brought: the message live held by name only, and the new one.
    const withToken = [...new Set(active.map((row) => row.id))].filter((id) => h.textOf(id).includes(token));
    expect(withToken).toHaveLength(2);
  });
});
