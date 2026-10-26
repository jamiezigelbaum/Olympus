// Review round 1 on Gmail's attachment children (archive-live-one-dataset.md,
// step 6): every child is held until it is judged, from either input; a live
// read re-checks the parent's scope and the approval before each request,
// bounds the part by its declared and its decoded size, and reads only the
// child its locator names; unnamed parts and forwarded messages are children
// under the same part keys from both inputs, a forward's text its own; and
// mail stored before children existed gets its children once, resumably.
// Synthetic mail only.

import { afterEach, describe, expect, test } from 'bun:test';
import { googleAccountIdFromAddress } from '../src/core/provider-account-identity.ts';
import { FileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import { heldUntilJudged } from '../src/workers/classification/tier-classifier.ts';
import type { GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import { gmailAttachmentConnector } from '../src/workers/google-connectors/gmail-attachment-extraction.ts';
import { ACCOUNT, gmailArchiveHarness, type GmailArchiveHarness } from './support/gmail-archive-harness.ts';
import { OWNER_ADDRESS, apiMessage, mail } from './support/archive-fixtures-gmail.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const LEASE_TEXT = 'fixtureleaseword: the lease runs for two years from the first of March.';
const FORWARDED_TEXT = 'fixtureforwardword: the forwarded note says the keys are with the neighbour.';
const PDF_BYTES = '%PDF-1.4 fixture';
const PNG_BYTES = 'fixture-png-bytes';
const message = mail(401, { body: 'A picture, a forward and a file.' });
const decimal = (hex: string): string => BigInt(`0x${hex}`).toString(10);
const b64 = (text: string): string => Buffer.from(text).toString('base64');
const b64url = (text: string): string => Buffer.from(text).toString('base64url');
const childOf = (part: string, parent = message.id) => `${parent}#child:${part}`;

/** As Takeout writes it: an inline picture (part 1), a forwarded message (part 2) holding text and a PDF (2.1). */
function takeoutWithForward(): string {
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
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    message.body,
    '--outer',
    'Content-Type: image/png',
    'Content-ID: <logo@example.test>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PNG_BYTES),
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'From: Friend <friend@example.test>',
    'Subject: The keys',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    FORWARDED_TEXT,
    '--inner',
    'Content-Type: application/pdf; name="inner.pdf"',
    'Content-Disposition: attachment; filename="inner.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF_BYTES),
    '--inner--',
    '--outer--',
    '',
  ].join('\n');
}

/** The same message as the Gmail API returns it. */
function liveWithForward(): GmailMessage {
  const base = apiMessage(message);
  return {
    ...base,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: base.payload!.headers!,
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64url(message.body) } },
        {
          partId: '1', mimeType: 'image/png', filename: '',
          headers: [{ name: 'Content-ID', value: '<logo@example.test>' }, { name: 'Content-Disposition', value: 'inline' }],
          body: { attachmentId: 'att-logo', size: PNG_BYTES.length },
        },
        {
          partId: '2', mimeType: 'message/rfc822', filename: '',
          headers: [{ name: 'Content-Type', value: 'message/rfc822' }],
          body: { size: 400 },
          parts: [
            { partId: '2.0', mimeType: 'text/plain', filename: '', body: { data: b64url(FORWARDED_TEXT), size: FORWARDED_TEXT.length } },
            {
              partId: '2.1', mimeType: 'application/pdf', filename: 'inner.pdf',
              headers: [{ name: 'Content-Disposition', value: 'attachment; filename="inner.pdf"' }],
              body: { attachmentId: 'att-pdf', size: PDF_BYTES.length },
            },
          ],
        },
      ],
    },
  };
}

/** A live message with one named attachment (part 1) whose body is fetched by id. */
function liveWithLease(index = 402, size = LEASE_TEXT.length): GmailMessage {
  const one = mail(index, { body: `Lease ${index} attached.` });
  const base = apiMessage(one);
  return {
    ...base,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: base.payload!.headers!,
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64url(one.body) } },
        { partId: '1', mimeType: 'text/plain', filename: 'lease.txt', body: { attachmentId: `att-lease-${index}`, size } },
      ],
    },
  };
}

const activeIds = (h: GmailArchiveHarness): string[] => [...new Set(h.rows().filter((row) => row.tombstoned === 0).map((row) => row.id))].sort();

function heldChildren(h: GmailArchiveHarness, ids: readonly string[]): boolean[] {
  return ids.map((id) => heldUntilJudged(h.set.ledger.getCurrent({ provider: 'gmail', accountScope: ACCOUNT, providerItemId: id })?.reasons));
}

describe('attachment children, review round 1', () => {
  test('unnamed parts and forwarded messages are children under the same keys from live Gmail and Takeout, each held until judged, and the forward\'s text is its own', async () => {
    const live = gmailArchiveHarness(cleanups, { build: { children: true } });
    live.connectLive(googleAccountIdFromAddress(OWNER_ADDRESS));
    live.mailbox.messages = [liveWithForward()];
    await live.pullLive();
    const expected = [message.id, childOf('1'), childOf('2'), childOf('2.1')].sort();
    expect(activeIds(live)).toEqual(expected);
    expect(heldChildren(live, [childOf('1'), childOf('2'), childOf('2.1')])).toEqual([true, true, true]);
    expect(live.textOf(message.id)).not.toContain('fixtureforwardword');

    const imported = gmailArchiveHarness(cleanups, { build: { children: true } });
    const started = await imported.approve('takeout.mbox', takeoutWithForward());
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    await imported.importAll(started.archive_id);
    expect(activeIds(imported)).toEqual(expected);
    expect(heldChildren(imported, [childOf('1'), childOf('2'), childOf('2.1')])).toEqual([true, true, true]);
    expect(imported.textOf(message.id)).not.toContain('fixtureforwardword');

    // The forward is read as the message it is: its text, not its own attachment's bytes.
    const reader = gmailAttachmentConnector({ account: ACCOUNT, imports: imported.runtime.state, live: () => undefined });
    const forward = await reader.fetchItemWithin(`${ACCOUNT}:${childOf('2')}`, {
      deferredBytes: { locator: `mbox-part1:${started.archive_id}:0:0:${message.id}:2` },
      maxBytes: 100_000,
    });
    expect(forward.content.kind).toBe('bytes');
    const text = forward.content.kind === 'bytes' ? Buffer.from(forward.content.bytes).toString() : '';
    expect(forward.mimeType).toBe('text/plain');
    expect(text).toContain('Subject: The keys');
    expect(text).toContain('fixtureforwardword');
    expect(text).not.toContain('%PDF');
    const pdf = await reader.fetchItemWithin(`${ACCOUNT}:${childOf('2.1')}`, {
      deferredBytes: { locator: `mbox-part1:${started.archive_id}:0:0:${message.id}:2.1` },
      maxBytes: 100_000,
    });
    expect(pdf.content.kind === 'bytes' ? Buffer.from(pdf.content.bytes).toString() : '').toBe(PDF_BYTES);
  });

  test('a live read re-checks the parent against the current scope and the approval before each request', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const lease = liveWithLease();
    h.mailbox.messages = [lease];
    h.mailbox.attachments[`att-lease-402`] = b64url(LEASE_TEXT);
    const child = `${ACCOUNT}:${childOf('1', lease.id)}`;
    const locator = `gmail-part1:${lease.id}:1`;

    const read = await h.liveReader({ scope: {} }).fetchItemWithin(child, { deferredBytes: { locator }, maxBytes: 10_000 });
    expect(read.content.kind === 'bytes' ? Buffer.from(read.content.bytes).toString() : '').toBe(LEASE_TEXT);

    // Its label is now skipped: the parent is outside the scope, and the part is never asked for.
    h.mailbox.calls.length = 0;
    const outside = h.liveReader({ scope: { skippedLabelIds: ['INBOX'] } }).fetchItemWithin(child, { deferredBytes: { locator }, maxBytes: 10_000 });
    await expect(outside).rejects.toMatchObject({ errorKind: 'source_permission_denied' });
    expect(h.mailbox.calls.some((call) => call.startsWith('attachment:'))).toBe(false);

    // The approval changes between the message and the part: the part is never asked for.
    h.mailbox.calls.length = 0;
    let asked = 0;
    const revoked = h.liveReader({
      scope: {},
      beforeEachRequest: () => {
        asked += 1;
        if (asked > 1) throw new Error('the mail approval is no longer current');
      },
    }).fetchItemWithin(child, { deferredBytes: { locator }, maxBytes: 10_000 });
    await expect(revoked).rejects.toThrow('no longer current');
    expect(h.mailbox.calls).toEqual([`message:${lease.id}`]);
  });

  test('a live part is bounded by its declared size before it is fetched, and by its decoded size when the declaration understated it', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const declaredBig = liveWithLease(403, 50_000);
    const understated = liveWithLease(404, 10);
    h.mailbox.messages = [declaredBig, understated];
    h.mailbox.attachments['att-lease-403'] = b64url('y'.repeat(50_000));
    h.mailbox.attachments['att-lease-404'] = b64url('z'.repeat(5_000));

    const big = h.liveReader({ scope: {} }).fetchItemWithin(`${ACCOUNT}:${childOf('1', declaredBig.id)}`, { deferredBytes: { locator: `gmail-part1:${declaredBig.id}:1` }, maxBytes: 1_000 });
    await expect(big).rejects.toMatchObject({ errorKind: 'source_too_large' });
    expect(h.mailbox.calls.some((call) => call.startsWith('attachment:'))).toBe(false);

    const under = h.liveReader({ scope: {} }).fetchItemWithin(`${ACCOUNT}:${childOf('1', understated.id)}`, { deferredBytes: { locator: `gmail-part1:${understated.id}:1` }, maxBytes: 1_000 });
    await expect(under).rejects.toMatchObject({ errorKind: 'source_too_large' });
  });

  test('a live locator is bound to its child: read for another child, it fails closed without a request', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const lease = liveWithLease();
    h.mailbox.messages = [lease];
    h.mailbox.attachments['att-lease-402'] = b64url(LEASE_TEXT);
    const wrong = h.liveReader({ scope: {} }).fetchItemWithin(`${ACCOUNT}:${childOf('2', lease.id)}`, { deferredBytes: { locator: `gmail-part1:${lease.id}:1` }, maxBytes: 10_000 });
    await expect(wrong).rejects.toBeInstanceOf(FileExtractionSourceError);
    await expect(wrong).rejects.toMatchObject({ errorKind: 'source_content_unavailable' });
    const another = mail(405).id;
    const elsewhere = h.liveReader({ scope: {} }).fetchItemWithin(`${ACCOUNT}:${childOf('1', another)}`, { deferredBytes: { locator: `gmail-part1:${lease.id}:1` }, maxBytes: 10_000 });
    await expect(elsewhere).rejects.toMatchObject({ errorKind: 'source_content_unavailable' });
    expect(h.mailbox.calls).toEqual([]);
  });

  test('mail stored before children existed gets its children once, a bounded pass at a time, resuming where a stopped pass left off', async () => {
    const build = {};
    const h = gmailArchiveHarness(cleanups, { build });
    h.connectLive(googleAccountIdFromAddress(OWNER_ADDRESS));
    const first = liveWithLease(406);
    const second = liveWithLease(407);
    const plain = apiMessage(mail(408));
    h.mailbox.messages = [first, second, plain];
    await h.pullLive();
    // Stored without children, as mail was before this change.
    expect(h.rows().filter((row) => row.parent !== null)).toEqual([]);

    h.build.children = true;
    // A pass stopped by a changed approval lists nothing and keeps its place.
    let revoked = true;
    const stopped = h.syncHandler({ assertScopeCurrent: () => { if (revoked) throw new Error('the mail approval is no longer current'); } });
    await expect(stopped.backfillChildren!({})).rejects.toThrow('no longer current');
    expect(h.rows().filter((row) => row.parent !== null)).toEqual([]);
    revoked = false;

    h.mailbox.calls.length = 0;
    const handler = h.syncHandler();
    const one = await handler.backfillChildren!({ max_items: 1 });
    expect(one).toMatchObject({ examined: 1, listed: 1, done: false });
    const two = await handler.backfillChildren!({ max_items: 1 });
    expect(two).toMatchObject({ examined: 1, listed: 1, done: false });
    const three = await handler.backfillChildren!({ max_items: 1 });
    expect(three).toMatchObject({ examined: 0, listed: 0, done: true });
    // Only messages whose stored text names an attachment were asked for, each once; the plain one never.
    expect(h.mailbox.calls.sort()).toEqual([`message:${first.id}`, `message:${second.id}`].sort());
    const children = activeIds(h).filter((id) => id.includes('#child:'));
    expect(children).toEqual([childOf('1', first.id), childOf('1', second.id)].sort());
    expect(heldChildren(h, children)).toEqual([true, true]);
    for (const row of h.rows().filter((entry) => entry.id.includes('#child:'))) expect(row.parent).toBe(`${ACCOUNT}:${row.id.split('#child:')[0]}`);

    // Done is done: no more requests.
    h.mailbox.calls.length = 0;
    expect(await handler.backfillChildren!({})).toEqual({ listed: 0, examined: 0, done: true });
    expect(h.mailbox.calls).toEqual([]);
  });
});
