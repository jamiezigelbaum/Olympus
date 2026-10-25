// The Gmail connector's one record and builder, from both inputs: the same
// message read live and read from a Takeout export names the same item and
// the same children; MIME part paths follow Gmail's numbering; live listing
// keeps a message and its attachments together within the item budget.

import { describe, expect, test } from 'bun:test';
import type { RawItem } from '../src/core/contracts.ts';
import { mimeAttachments } from '../src/workers/archive-import/mbox/mime-parts.ts';
import { gmailIdFromDecimal, gmailLabelIds, takeoutMessageId } from '../src/workers/archive-import/mbox/gmail-input.ts';
import { bareAddress } from '../src/workers/archive-import/mbox/gmail-account.ts';
import { parseMboxMessage } from '../src/workers/archive-import/mbox/parse.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  GoogleGmailSourceConnector,
  gmailMailRecordFromMessage,
  type GmailApiClient,
  type GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import { gmailMailEntries, gmailMailItems } from '../src/workers/google-connectors/gmail-mail-record.ts';
import { apiMessage, mail, takeoutMessage } from './support/archive-fixtures-gmail.ts';

const OFFLINE_BROKER = { async issueSession() { throw new Error('no credentials'); } } as unknown as CredentialBroker;

describe('Takeout ids and labels', () => {
  test('the decimal id in the From line is the API\'s hex id', () => {
    // 0x18a0000000000001 = 1774418253183975425
    expect(takeoutMessageId('From 1774418253183975425@xxx Mon Jan 01 12:00:00 +0000 2024')).toBe('18a0000000000001');
    expect(gmailIdFromDecimal('18446744073709551615')).toBe('ffffffffffffffff');
    expect(gmailIdFromDecimal('18446744073709551616')).toBeUndefined();
    expect(takeoutMessageId('From someone@example.test Mon Jan  1 00:00:00 2024')).toBeUndefined();
    expect(takeoutMessageId('From 12@example.test Mon Jan  1 00:00:00 2024')).toBeUndefined();
  });

  test('Gmail\'s own labels by their ids, user labels by name, Opened and Archived dropped', () => {
    expect(gmailLabelIds(['Inbox', 'Opened', 'Category Social', 'Important', 'Archived', 'Receipts', 'Unread']))
      .toEqual(['INBOX', 'CATEGORY_SOCIAL', 'IMPORTANT', 'Receipts', 'UNREAD']);
  });

  test('one delivered-to address, read from a header', () => {
    expect(bareAddress('Owner <Owner@Example.test>')).toBe('owner@example.test');
    expect(bareAddress('a@example.test, b@example.test')).toBeUndefined();
  });
});

describe('MIME part paths', () => {
  const raw = (text: string): Uint8Array => new TextEncoder().encode(text);

  test('a multipart message numbers its parts 0, 1, … and nested ones 1.0, 1.1', () => {
    const message = [
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain',
      '',
      'hello',
      '--inner',
      'Content-Type: text/html',
      '',
      '<p>hello</p>',
      '--inner--',
      '--outer',
      'Content-Type: application/pdf; name="lease.pdf"',
      'Content-Disposition: attachment; filename="lease.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('twelve bytes').toString('base64'),
      '--outer',
      'Content-Type: multipart/mixed; boundary="deep"',
      '',
      '--deep',
      'Content-Type: image/png',
      'Content-Disposition: inline; filename*=utf-8\'\'na%C3%AFve.png',
      '',
      'png',
      '--deep--',
      '--outer--',
      '',
    ].join('\r\n');
    expect(mimeAttachments(raw(message))).toEqual([
      { partId: '1', filename: 'lease.pdf', mimeType: 'application/pdf', size: 12 },
      { partId: '2.0', filename: 'naïve.png', mimeType: 'image/png', size: 3 },
    ]);
  });

  test('a single-part message whose body is a file is part ""; continuations and encoded words are decoded', () => {
    const single = [
      'Content-Type: text/csv',
      'Content-Disposition: attachment; filename*0="quarter"; filename*1="ly.csv"',
      '',
      'a,b',
      '',
    ].join('\n');
    expect(mimeAttachments(raw(single))).toEqual([{ partId: '', filename: 'quarterly.csv', mimeType: 'text/csv', size: 4 }]);
    const encoded = ['Content-Type: application/pdf; name="=?UTF-8?B?w6l0w6kucGRm?="', '', 'x', ''].join('\n');
    expect(mimeAttachments(raw(encoded))[0]?.filename).toBe('été.pdf');
  });
});

describe('one record, two inputs', () => {
  test('a message read live and read from Takeout names the same item and the same child', async () => {
    const message = mail(1, { attachment: { name: 'lease.pdf', mime: 'application/pdf', text: 'the lease text' } });
    const live = gmailMailRecordFromMessage(apiMessage(message));
    const exported = takeoutMessage(message);
    const separator = exported.slice(0, exported.indexOf('\n'));
    const rawText = exported.slice(exported.indexOf('\n') + 1);
    const parsed = (await parseMboxMessage(new TextEncoder().encode(rawText)))!;
    const fromExport = mimeAttachments(new TextEncoder().encode(rawText));
    expect(takeoutMessageId(separator)).toBe(message.id);
    expect(fromExport.map((part) => part.partId)).toEqual(live.attachments.map((part) => part.partId));
    expect(fromExport.map((part) => part.filename)).toEqual(live.attachments.map((part) => part.filename));
    expect(parsed.messageId).toBe(live.headers.messageId!);
    const liveEntries = gmailMailEntries(live, 'personal', { children: true }).map((entry) => entry.identity.localItemId);
    expect(liveEntries).toEqual([`personal:${message.id}`, `personal:${message.id}#child:1`]);
  });

  test('a child is listed by name with the means to read it, and none without the lane\'s choice', () => {
    const message = mail(2, { attachment: { name: 'scan.pdf', mime: 'application/pdf', text: 'scan' } });
    const record = gmailMailRecordFromMessage(apiMessage(message));
    expect(gmailMailItems(record, 'personal')).toHaveLength(1);
    const [parent, child] = gmailMailItems(record, 'personal', { children: true }) as [RawItem, RawItem];
    expect(parent.metadata.messageId).toBe(message.messageId);
    expect(child.identity.parent).toEqual({ providerItemId: message.id, localItemId: `personal:${message.id}` });
    expect(child.content).toEqual({ kind: 'metadata_only' });
    expect(child.deferredBytes).toEqual({ locator: `gmail-part1:${message.id}:1`, available: true, sizeBytes: 4 });
    expect(child.metadata.title).toBe('scan.pdf');
  });

  test('mail kept by name only lists no children', () => {
    const message = mail(3, { attachment: { name: 'old.pdf', mime: 'application/pdf', text: 'old' } });
    const record = gmailMailRecordFromMessage(apiMessage(message), { metadataOnly: true });
    expect(gmailMailItems(record, 'personal', { children: true })).toHaveLength(1);
  });
});

function client(messages: GmailMessage[], requests: string[] = []): GmailApiClient {
  return {
    async listMessages(request) {
      requests.push(`list:${request.pageToken ?? ''}`);
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = messages.slice(offset, offset + request.maxResults);
      return {
        messages: slice.map((entry) => ({ id: entry.id })),
        ...(offset + slice.length < messages.length ? { nextPageToken: String(offset + slice.length) } : {}),
      };
    },
    async getMessage(id) {
      requests.push(`get:${id}`);
      const found = messages.find((entry) => entry.id === id);
      if (!found) throw new Error('Gmail API request failed (404)');
      return found;
    },
    async getAttachment(messageId, attachmentId) {
      requests.push(`attachment:${messageId}:${attachmentId}`);
      return { data: Buffer.from(`bytes of ${attachmentId}`).toString('base64url') };
    },
  };
}

function withAttachments(index: number, count: number): GmailMessage {
  const base = apiMessage(mail(index));
  return {
    ...base,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: base.payload!.headers!,
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: Buffer.from('body').toString('base64url') } },
        ...Array.from({ length: count }, (_, at) => ({
          partId: String(at + 1),
          mimeType: 'application/pdf',
          filename: `file-${at + 1}.pdf`,
          body: { attachmentId: `att-${index}-${at + 1}`, size: 10 },
        })),
      ],
    },
  };
}

/** Every pass until done; what a pass yielded counts as stored before the next (`stored`). */
async function listAll(connector: GoogleGmailSourceConnector, limit: number, stored = new Set<string>()): Promise<{ ids: string[]; cursors: Array<string | undefined> }> {
  const ids: string[] = [];
  const cursors: Array<string | undefined> = [];
  let cursor: string | undefined;
  for (let pass = 0; pass < 20; pass += 1) {
    let done = false;
    let yielded = 0;
    for await (const page of connector.listItems({ limit, ...(cursor ? { cursor } : {}) })) {
      for (const item of page.items) {
        ids.push(item.identity.providerItemId);
        if (!item.identity.parent) stored.add(item.identity.providerItemId);
      }
      yielded += page.items.length;
      expect(yielded).toBeLessThanOrEqual(limit);
      cursor = page.nextCursor;
      cursors.push(cursor);
      done = page.done;
    }
    if (done) break;
  }
  return { ids, cursors };
}

describe('live listing with attachments as children', () => {
  test('never yields more items than its limit, and every message and attachment is listed once', async () => {
    const messages = [withAttachments(1, 1), withAttachments(2, 2), withAttachments(3, 0)];
    const stored = new Set<string>();
    const connector = new GoogleGmailSourceConnector({
      account: 'personal',
      credentialBroker: OFFLINE_BROKER,
      apiClient: client(messages),
      build: { children: true },
      // Stored mail is never listed again: what a pass yielded is stored before the next.
      scope: { storedItem: (id) => (stored.has(id) ? { hasContent: true } : undefined) },
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pass = 0; pass < 20; pass += 1) {
      let done = false;
      let yielded = 0;
      for await (const page of connector.listItems({ limit: 3, ...(cursor ? { cursor } : {}) })) {
        for (const item of page.items) {
          ids.push(item.identity.providerItemId);
          if (!item.identity.parent) stored.add(item.identity.providerItemId);
        }
        yielded += page.items.length;
        cursor = page.nextCursor;
        done = page.done;
      }
      expect(yielded).toBeLessThanOrEqual(3);
      if (done) break;
    }
    const expected = messages.flatMap((message) => [
      message.id,
      ...(message.payload!.parts ?? []).filter((part) => part.filename).map((part) => `${message.id}#child:${part.partId}`),
    ]);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a message with more attachments than one pass holds resumes inside it', async () => {
    const messages = [withAttachments(4, 5)];
    const stored = new Set<string>();
    const connector = new GoogleGmailSourceConnector({
      account: 'personal',
      credentialBroker: OFFLINE_BROKER,
      apiClient: client(messages),
      build: { children: true },
      scope: { storedItem: (id) => (stored.has(id) ? { hasContent: true } : undefined) },
    });
    const { ids } = await listAll(connector, 2, stored);
    expect(ids).toEqual([messages[0]!.id, ...[1, 2, 3, 4, 5].map((at) => `${messages[0]!.id}#child:${at}`)]);
  });

  test('an attachment\'s bytes are read by its locator, inline or by attachment id', async () => {
    const message = withAttachments(5, 1);
    const requests: string[] = [];
    const connector = new GoogleGmailSourceConnector({ account: 'personal', credentialBroker: OFFLINE_BROKER, apiClient: client([message], requests) });
    const item = await connector.fetchItem(`personal:${message.id}#child:1`, { deferredBytes: { locator: `gmail-part1:${message.id}:1` } });
    expect(item.content.kind).toBe('bytes');
    expect(Buffer.from((item.content as { bytes: Uint8Array }).bytes).toString()).toBe(`bytes of att-5-1`);
    expect(requests).toEqual([`get:${message.id}`, `attachment:${message.id}:att-5-1`]);
    await expect(connector.fetchItem('personal:x#child:1', { deferredBytes: { locator: 'elsewhere:1' } })).rejects.toThrow();
  });

  test('without the lane\'s choice, live listing is unchanged: one item per message', async () => {
    const messages = [withAttachments(6, 2)];
    const connector = new GoogleGmailSourceConnector({ account: 'personal', credentialBroker: OFFLINE_BROKER, apiClient: client(messages) });
    const { ids } = await listAll(connector, 10);
    expect(ids).toEqual([messages[0]!.id]);
  });
});
