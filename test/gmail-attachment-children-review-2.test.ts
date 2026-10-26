// Review round 2 on Gmail's attachment children (archive-live-one-dataset.md,
// step 6), four consent and scope boundaries, each reproduced:
// 1. a retried request asks the approval again before every attempt;
// 2. a cached parent is checked against its current labels before a part;
// 3. an mbox part is read only from the message whose bytes the import
//    recorded at that place, whatever form its parent's id takes;
// 4. a queued read of a child whose parent was deleted is never read or landed.
// Synthetic mail only.

import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { FileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import { readMboxPart } from '../src/workers/archive-import/mbox/part-reader.ts';
import { GoogleGmailSourceConnector, type GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import {
  createGmailAttachmentExtractionRuntime,
  gmailAttachmentConnector,
  gmailAttachmentLanes,
} from '../src/workers/google-connectors/gmail-attachment-extraction.ts';
import { ACCOUNT, gmailArchiveHarness } from './support/gmail-archive-harness.ts';
import { OWNER_ADDRESS, apiMessage, mail } from './support/archive-fixtures-gmail.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const LEASE_TEXT = 'fixtureleaseword: the lease runs for two years from the first of March.';
const OTHER_TEXT = 'fixtureotherword: a different letter entirely.';
const b64 = (text: string): string => Buffer.from(text).toString('base64');
const b64url = (text: string): string => Buffer.from(text).toString('base64url');
const childOf = (parent: string, part: string) => `${parent}#child:${part}`;
const decimal = (hex: string): string => BigInt(`0x${hex}`).toString(10);

/** A live message with two named attachments (parts 1 and 2), each fetched by id. */
function liveWithTwo(index: number): GmailMessage {
  const one = mail(index, { body: `Two files ${index}.` });
  const base = apiMessage(one);
  return {
    ...base,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: base.payload!.headers!,
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64url(one.body) } },
        { partId: '1', mimeType: 'text/plain', filename: 'lease.txt', body: { attachmentId: `att-a-${index}`, size: LEASE_TEXT.length } },
        { partId: '2', mimeType: 'text/plain', filename: 'other.txt', body: { attachmentId: `att-b-${index}`, size: OTHER_TEXT.length } },
      ],
    },
  };
}

function bearerBroker(): CredentialBroker {
  return {
    async issueSession() {
      return {
        kind: 'bearer_token',
        handle: 'gmail.personal',
        provider: 'gmail',
        capability: 'gmail.email.sync',
        token: 'gmail-test-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        audit: {
          handle: 'gmail.personal',
          provider: 'gmail',
          capability: 'gmail.email.sync',
          trustDomain: 'secure_local',
          scopes: ['gmail.email.sync'],
          outcome: 'issued',
          issuedAt: '2026-07-27T00:00:00.000Z',
          rawCredentialExposed: false,
        },
      };
    },
  } as unknown as CredentialBroker;
}

/** One message as an mbox writes it without Takeout's id in its separator, with one attachment (part 1). */
function plainMboxMessage(index: number, attachment: string): string {
  const one = mail(index);
  return [
    `From ${one.from.replace(/^.*<|>$/g, '')} Mon Mar 04 12:00:00 2024`,
    'X-Gmail-Labels: Inbox,Opened',
    `Delivered-To: ${OWNER_ADDRESS}`,
    `Message-ID: <${one.messageId}>`,
    `From: ${one.from}`,
    `To: ${one.to}`,
    `Subject: ${one.subject}`,
    `Date: ${new Date(one.date).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    one.body,
    '--b',
    'Content-Type: text/plain; name="letter.txt"',
    'Content-Disposition: attachment; filename="letter.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(attachment),
    '--b--',
    '',
  ].join('\n');
}

describe('attachment children, review round 2', () => {
  test('1. an approval revoked during a retry backoff stops the retry before it is sent', async () => {
    const message = liveWithTwo(501);
    const urls: string[] = [];
    let revoked = false;
    const connector = new GoogleGmailSourceConnector({
      account: ACCOUNT,
      apiBaseUrl: 'https://gmail.test/v1',
      credentialBroker: bearerBroker(),
      build: { children: true },
      scope: {},
      fetch: async (url: string | URL | Request) => {
        const at = String(url);
        urls.push(at);
        if (at.includes('/attachments/')) {
          // Rate limited the first time; the bytes would come back on a retry.
          return urls.filter((entry) => entry.includes('/attachments/')).length === 1
            ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
            : new Response(JSON.stringify({ data: b64url(LEASE_TEXT) }), { status: 200 });
        }
        return new Response(JSON.stringify(message), { status: 200 });
      },
      // The approval is revoked while the request waits out its backoff.
      sleep: async () => { revoked = true; },
      beforeEachRequest: () => {
        if (revoked) throw new Error('the mail approval is no longer current');
      },
      maxRetries: 2,
    });
    const read = connector.fetchItemWithin(`${ACCOUNT}:${childOf(message.id, '1')}`, {
      deferredBytes: { locator: `gmail-part1:${message.id}:1` },
      maxBytes: 10_000,
    });
    await expect(read).rejects.toThrow('no longer current');
    expect(urls.filter((entry) => entry.includes('/attachments/'))).toHaveLength(1);
  });

  test('2. a parent moved to Trash after one part was read serves no further part from the cached message', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const message = liveWithTwo(502);
    h.mailbox.messages = [message];
    h.mailbox.attachments['att-a-502'] = b64url(LEASE_TEXT);
    h.mailbox.attachments['att-b-502'] = b64url(OTHER_TEXT);
    const reader = h.liveReader({ scope: {} });
    const first = await reader.fetchItemWithin(`${ACCOUNT}:${childOf(message.id, '1')}`, { deferredBytes: { locator: `gmail-part1:${message.id}:1` }, maxBytes: 10_000 });
    expect(first.content.kind === 'bytes' ? Buffer.from(first.content.bytes).toString() : '').toBe(LEASE_TEXT);

    h.mailbox.messages = [{ ...message, labelIds: ['TRASH'] }];
    h.mailbox.calls.length = 0;
    const second = reader.fetchItemWithin(`${ACCOUNT}:${childOf(message.id, '2')}`, { deferredBytes: { locator: `gmail-part1:${message.id}:2` }, maxBytes: 10_000 });
    await expect(second).rejects.toMatchObject({ errorKind: 'source_permission_denied' });
    expect(h.mailbox.calls).toEqual([`metadata:${message.id}`]);

    // Deleted in Gmail since: not found, and no part asked for.
    h.mailbox.messages = [];
    h.mailbox.calls.length = 0;
    const third = reader.fetchItemWithin(`${ACCOUNT}:${childOf(message.id, '2')}`, { deferredBytes: { locator: `gmail-part1:${message.id}:2` }, maxBytes: 10_000 });
    await expect(third).rejects.toMatchObject({ errorKind: 'source_item_not_found' });
    expect(h.mailbox.calls).toEqual([`metadata:${message.id}`]);
  });

  test('3. an mbox locator re-aimed at another message\'s place is refused, though no Takeout id marks either message', async () => {
    const h = gmailArchiveHarness(cleanups, { build: { children: true } });
    const first = mail(503);
    const second = mail(504);
    // No Takeout id in the separators: each message is matched to its Gmail id by its headers.
    h.match.current = async (headers) => ({ id: headers.messageId === first.messageId ? first.id : second.id });
    const text = `${plainMboxMessage(503, LEASE_TEXT)}${plainMboxMessage(504, OTHER_TEXT)}`;
    const started = await h.approve('mail.mbox', text, { confirmAccount: true });
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    await h.importAll(started.archive_id);
    const firstLocator = h.locatorOf(childOf(first.id, '1'));
    const secondLocator = h.locatorOf(childOf(second.id, '1'));
    if (!firstLocator || !secondLocator) throw new Error(`no locators: ${JSON.stringify(h.rows())}`);
    const read = (locator: string, child: string) => readMboxPart({ state: h.runtime.state, sourceId: 'gmail.email', locator, childProviderItemId: child });

    expect(Buffer.from((await read(firstLocator, childOf(first.id, '1'))).bytes).toString()).toBe(LEASE_TEXT);
    // The first message's locator, aimed at the second message's offset: the bytes there are not the ones recorded.
    const secondOffset = secondLocator.split(':')[3]!;
    const forged = firstLocator.split(':');
    forged[3] = secondOffset;
    await expect(read(forged.join(':'), childOf(first.id, '1'))).rejects.toBeInstanceOf(FileExtractionSourceError);
    // A locator without the recorded digest is refused too.
    const bare = firstLocator.split(':');
    bare.splice(4, 1);
    await expect(read(bare.join(':'), childOf(first.id, '1'))).rejects.toBeInstanceOf(FileExtractionSourceError);
  });

  test('4. a child queued for reading whose parent is deleted is neither read nor landed, before its fetch or after it', async () => {
    for (const when of ['before fetch', 'after fetch'] as const) {
      const h = gmailArchiveHarness(cleanups, { build: { children: true } });
      const message = mail(505 + (when === 'before fetch' ? 0 : 1), { body: 'One file attached.' });
      const takeout = [
        `From ${decimal(message.id)}@xxx Mon Mar 04 12:00:00 +0000 2024`,
        `X-GM-THRID: ${decimal(message.threadId)}`,
        'X-Gmail-Labels: Inbox,Opened',
        `Delivered-To: ${OWNER_ADDRESS}`,
        `Message-ID: <${message.messageId}>`,
        `From: ${message.from}`,
        `Subject: ${message.subject}`,
        `Date: ${new Date(message.date).toUTCString()}`,
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain',
        '',
        message.body,
        '--b',
        'Content-Type: text/plain; name="lease.txt"',
        'Content-Disposition: attachment; filename="lease.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        b64(LEASE_TEXT),
        '--b--',
        '',
      ].join('\n');
      const started = await h.approve('takeout.mbox', takeout);
      if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
      await h.importAll(started.archive_id);
      const parent = { family: 'email' as const, provider: 'gmail', accountScope: ACCOUNT, providerItemId: message.id, localItemId: `${ACCOUNT}:${message.id}` };
      // The parent is deleted in every store that holds it, as an absence reconcile does it.
      const deleteParent = (): void => {
        for (const store of h.set.openStores()) store.tombstoneCopy(parent, { connectorId: 'absence-reconcile' });
      };
      let reads = 0;
      const runtime = createGmailAttachmentExtractionRuntime({
        stores: [h.stores.internal, h.stores.secure],
        set: h.set,
        accountScope: () => ACCOUNT,
        connector: (accountScope) => {
          const reader = gmailAttachmentConnector({ account: accountScope, imports: h.runtime.state, live: () => undefined });
          return {
            ...reader,
            fetchItemWithin: async (id, options) => {
              reads += 1;
              const item = await reader.fetchItemWithin(id, options);
              if (when === 'after fetch') deleteParent();
              return item;
            },
          };
        },
        env: h.env,
        jobsDbPath: join(h.home, 'file-extraction-jobs.sqlite'),
        warn: () => {},
      })!;
      cleanups.push(() => runtime.close());
      let planned = 0;
      for (const lane of gmailAttachmentLanes(ACCOUNT)) planned += (await runtime.runner.plan({ ...lane, limit: 50, policyDecision: 'index_allowed' })).candidates;
      expect(planned).toBe(1);
      if (when === 'before fetch') deleteParent();
      let indexed = 0;
      for (const lane of gmailAttachmentLanes(ACCOUNT)) indexed += (await runtime.runner.run({ ...lane, limit: 10 })).counts.indexed;
      expect(indexed).toBe(0);
      expect(reads).toBe(when === 'before fetch' ? 0 : 1);
      expect(h.textOf(childOf(message.id, '1'))).not.toContain('fixtureleaseword');
    }
  });
});
