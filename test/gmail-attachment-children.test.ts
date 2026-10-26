// Gmail's attachments are child items of their message (docs/design/child-items.md;
// archive-live-one-dataset.md, step 6): listed by name from both inputs under one
// child id (the part's MIME path), each judged on its own, and read later by the one
// attachment extraction lane whatever input listed them. A readable attachment's text
// lands; one over the read bound keeps its names and is a file Olympus could not read.
// Synthetic mail only.

import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { googleAccountIdFromAddress } from '../src/core/provider-account-identity.ts';
import type { GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import {
  createGmailAttachmentExtractionRuntime,
  gmailAttachmentConnector,
  gmailAttachmentLanes,
} from '../src/workers/google-connectors/gmail-attachment-extraction.ts';
import { readMboxPart } from '../src/workers/archive-import/mbox/part-reader.ts';
import { FileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import { ACCOUNT, gmailArchiveHarness } from './support/gmail-archive-harness.ts';
import { OWNER_ADDRESS, apiMessage, mail } from './support/archive-fixtures-gmail.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const LEASE_TEXT = 'fixtureleaseword: the lease runs for two years from the first of March.';
const BIG_TEXT = 'x'.repeat(4_000);
const message = mail(301, { body: 'Two files are attached.' });

const decimal = (hex: string): string => BigInt(`0x${hex}`).toString(10);

/** The message as Takeout writes it, with two attachments (parts 1 and 2). */
function takeoutWithTwoAttachments(extra = ''): string {
  return [
    `From ${decimal(message.id)}@xxx Mon Mar 04 12:00:00 +0000 2024`,
    `X-GM-THRID: ${decimal(message.threadId)}`,
    'X-Gmail-Labels: Inbox,Opened',
    `Delivered-To: ${OWNER_ADDRESS}`,
    `Message-ID: <${message.messageId}>`,
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date(message.date).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b2"',
    '',
    '--b2',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    message.body,
    '--b2',
    'Content-Type: text/plain; name="lease.txt"',
    'Content-Disposition: attachment; filename="lease.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(LEASE_TEXT).toString('base64'),
    '--b2',
    'Content-Type: text/plain; name="big.txt"',
    'Content-Disposition: attachment; filename="big.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(BIG_TEXT).toString('base64'),
    '--b2--',
    '',
    extra,
  ].join('\n');
}

/** The same message as the Gmail API returns it: parts 0 (body), 1 and 2. */
function liveWithTwoAttachments(): GmailMessage {
  const base = apiMessage(message);
  return {
    ...base,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: base.payload!.headers!,
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: Buffer.from(message.body).toString('base64url') } },
        { partId: '1', mimeType: 'text/plain', filename: 'lease.txt', body: { attachmentId: 'att-lease', size: LEASE_TEXT.length } },
        { partId: '2', mimeType: 'text/plain', filename: 'big.txt', body: { attachmentId: 'att-big', size: BIG_TEXT.length } },
      ],
    },
  };
}

const childOf = (part: string) => `${message.id}#child:${part}`;

describe('attachments are children of their message, one dataset', () => {
  test('a Takeout message with two attachments gives two children, each judged on its own; the readable one\'s text lands, the one over the bound keeps its names', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const started = await h.approve('takeout.mbox', takeoutWithTwoAttachments());
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    const outcome = await h.importAll(started.archive_id);
    expect(outcome.record?.status).toBe('imported');
    const children = h.rows().filter((row) => row.parent !== null && row.tombstoned === 0);
    expect([...new Set(children.map((row) => row.id))].sort()).toEqual([childOf('1'), childOf('2')]);
    for (const row of children) expect(row.parent).toBe(`${ACCOUNT}:${message.id}`);
    // Each child has a judgment of its own in the ledger.
    const lease = h.set.ledger.getCurrent({ provider: 'gmail', accountScope: ACCOUNT, providerItemId: childOf('1') });
    const big = h.set.ledger.getCurrent({ provider: 'gmail', accountScope: ACCOUNT, providerItemId: childOf('2') });
    expect(lease).toBeDefined();
    expect(big).toBeDefined();
    expect(lease).not.toBe(big);
    // Imported attachments are no longer counted as not read: they are items.
    expect(outcome.record?.findings.gaps.attachments_not_read).toBeUndefined();

    // The one attachment lane reads them; here a read bound of 1,000 bytes stands in for the readers' limits.
    const runtime = createGmailAttachmentExtractionRuntime({
      stores: [h.stores.internal, h.stores.secure],
      set: h.set,
      accountScope: () => ACCOUNT,
      connector: (accountScope) => {
        const reader = gmailAttachmentConnector({ account: accountScope, imports: h.runtime.state, live: () => undefined });
        return { ...reader, fetchItemWithin: (id, options) => reader.fetchItemWithin(id, { ...options, maxBytes: Math.min(options.maxBytes ?? Number.POSITIVE_INFINITY, 1_000) }) };
      },
      env: h.env,
      jobsDbPath: join(h.home, 'file-extraction-jobs.sqlite'),
      warn: () => {},
    })!;
    cleanups.push(() => runtime.close());
    let candidates = 0;
    let indexed = 0;
    let tooLarge = 0;
    for (const lane of gmailAttachmentLanes(ACCOUNT)) {
      const plan = await runtime.runner.plan({ ...lane, limit: 50, policyDecision: 'index_allowed' });
      candidates += plan.candidates;
      const run = await runtime.runner.run({ ...lane, limit: 10 });
      indexed += run.counts.indexed;
      tooLarge += run.counts.skipped_too_large;
    }
    // Only the two children are candidates, never the message.
    expect(candidates).toBe(2);
    expect(indexed).toBe(1);
    expect(tooLarge).toBe(1);
    expect(h.textOf(childOf('1'))).toContain('fixtureleaseword');
    expect(h.textOf(childOf('2'))).toBe('');
    expect(h.rows().some((row) => row.id === childOf('2') && row.tombstoned === 0)).toBe(true);
  });

  test('an import of the same message again adds no children', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const first = await h.approve('takeout.mbox', takeoutWithTwoAttachments());
    if (!first.ok || first.status !== 'started') throw new Error(JSON.stringify(first));
    await h.importAll(first.archive_id);
    const before = h.rows().filter((row) => row.tombstoned === 0).map((row) => `${row.domain}:${row.id}`).sort();
    // A second export holding the same message (and another).
    const second = await h.approve('takeout-2.mbox', takeoutWithTwoAttachments(`From ${decimal(mail(302).id)}@xxx Mon Mar 04 12:00:00 +0000 2024\nX-GM-THRID: 1\nX-Gmail-Labels: Inbox\nDelivered-To: ${OWNER_ADDRESS}\nFrom: a@example.test\nSubject: other\n\nother body\n`), { confirmAccount: true });
    if (!second.ok || second.status !== 'started') throw new Error(JSON.stringify(second));
    await h.importAll(second.archive_id);
    const after = h.rows().filter((row) => row.tombstoned === 0 && row.id.startsWith(message.id)).map((row) => `${row.domain}:${row.id}`).sort();
    expect(after).toEqual(before.filter((key) => key.includes(message.id)));
    const ids = h.rows().filter((row) => row.tombstoned === 0).map((row) => `${row.domain}:${row.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('live Gmail then the Takeout import of the same message: one set of children', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    h.connectLive(googleAccountIdFromAddress(OWNER_ADDRESS));
    h.mailbox.messages = [liveWithTwoAttachments()];
    await h.pullLive();
    const live = [...new Set(h.rows().filter((row) => row.tombstoned === 0).map((row) => row.id))].sort();
    expect(live).toEqual([message.id, childOf('1'), childOf('2')].sort());
    const started = await h.approve('takeout.mbox', takeoutWithTwoAttachments(), { confirmAccount: true });
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    await h.importAll(started.archive_id);
    const after = h.rows().filter((row) => row.tombstoned === 0);
    expect([...new Set(after.map((row) => row.id))].sort()).toEqual(live);
    const keys = after.map((row) => `${row.domain}:${row.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a part is read from the import\'s own files, bounded before it is decoded, only for the source it joined and only for its own child', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const started = await h.approve('takeout.mbox', takeoutWithTwoAttachments());
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    await h.importAll(started.archive_id);
    const locatorOf = (part: string, parent = message.id) => `mbox-part1:${started.archive_id}:0:0:${parent}:${part}`;
    const read = (locator: string, child: string, more: { sourceId?: string; maxBytes?: number } = {}) => readMboxPart({
      state: h.runtime.state,
      sourceId: more.sourceId ?? 'gmail.email',
      locator,
      childProviderItemId: child,
      ...(more.maxBytes !== undefined ? { maxBytes: more.maxBytes } : {}),
    });
    expect(Buffer.from((await read(locatorOf('1'), childOf('1'))).bytes).toString()).toBe(LEASE_TEXT);
    await expect(read(locatorOf('2'), childOf('2'), { maxBytes: 1_000 })).rejects.toBeInstanceOf(FileExtractionSourceError);
    await expect(read(locatorOf('1'), childOf('1'), { sourceId: 'telegram.messages' })).rejects.toBeInstanceOf(FileExtractionSourceError);
    await expect(read(locatorOf('9'), childOf('9'))).rejects.toBeInstanceOf(FileExtractionSourceError);
    // A locator is bound to its child: another child's locator, or one naming another message, fails closed.
    await expect(read(locatorOf('2'), childOf('1'))).rejects.toBeInstanceOf(FileExtractionSourceError);
    const other = mail(302).id;
    await expect(read(locatorOf('1', other), `${other}#child:1`)).rejects.toBeInstanceOf(FileExtractionSourceError);
  });
});
