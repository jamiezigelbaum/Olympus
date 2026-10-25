// An mbox of a Gmail account is an input of the Gmail connector
// (docs/design/archive-live-one-dataset.md, step 6): one dataset with the live
// mail, matched by Gmail's own id, held until judged, under the account the
// export proves (and the owner confirms). Expected values come from the
// fixtures' own messages, never from the code under test.

import { afterEach, describe, expect, test } from 'bun:test';
import { googleAccountIdFromAddress, googleSubjectLabel, composeProviderAccountId } from '../src/core/provider-account-identity.ts';
import { readSourceRegistry } from '../src/core/source-registry.ts';
import { ACCOUNT, gmailArchiveHarness } from './support/gmail-archive-harness.ts';
import { OWNER_ADDRESS, apiMessage, mail, takeoutMbox } from './support/archive-fixtures-gmail.ts';
import type { GmailApiClient, GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import { gmailHeaderMatch } from '../src/workers/google-connectors/gmail-header-match.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const OWNER_LABEL = googleAccountIdFromAddress(OWNER_ADDRESS);

async function started(result: Awaited<ReturnType<ReturnType<typeof gmailArchiveHarness>['approve']>>): Promise<string> {
  if (!result.ok || result.status !== 'started') throw new Error(`expected a start, got ${JSON.stringify(result)}`);
  return result.archive_id;
}

describe('an export of a Gmail account joins the Gmail source', () => {
  test('with no account yet, the import makes it, names its address label, and stores mail under Gmail\'s own ids, held until judged', async () => {
    const h = gmailArchiveHarness(cleanups);
    const mails = [mail(1), mail(2), mail(3)];
    const id = await started(await h.approve('takeout.mbox', takeoutMbox(mails)));
    const record = h.runtime.state.get(id)!;
    expect(record.target?.source_id).toBe('gmail.email');
    const outcome = await h.importAll(id);
    expect(outcome.record?.status).toBe('imported');
    expect([...new Set(h.rows().map((row) => row.id))].sort()).toEqual(mails.map((entry) => entry.id).sort());
    // The registry's entry names the account by the opaque label, never the address.
    const entry = readSourceRegistry(h.env).accounts.find((account) => account.source_id === 'gmail.email');
    expect(entry?.provider_account_hash).toBe(OWNER_LABEL);
    expect(JSON.stringify(readSourceRegistry(h.env))).not.toContain(OWNER_ADDRESS);
    // Held until the private model judges it: its text is in the Private store only.
    for (const entry of mails) {
      const rows = h.rows().filter((row) => row.id === entry.id && row.chunks > 0);
      expect(rows.map((row) => row.domain)).toEqual(['secure_local']);
    }
    expect(h.textOf(mails[0]!.id)).toContain('fixturebody1');
  });

  test('beside live mail: a message live holds is kept, one live holds by name only gains its text, a new one is added; nothing twice', async () => {
    const h = gmailArchiveHarness(cleanups);
    const held = mail(1);
    const namesOnly = mail(2, { date: '2015-03-01T12:00:00.000Z' });
    const fresh = mail(3);
    h.connectLive(OWNER_LABEL);
    h.window.contentAfterMs = Date.parse('2020-01-01T00:00:00.000Z');
    h.mailbox.messages = [apiMessage(held), apiMessage(namesOnly)];
    await h.pullLive();
    expect(h.textOf(namesOnly.id)).toBe('');
    const liveText = h.textOf(held.id);
    expect(liveText).toContain('fixturebody1');

    // An address proves no account by itself: the owner confirms.
    const asked = await h.approve('takeout.mbox', takeoutMbox([held, namesOnly, fresh]));
    expect(asked.ok && asked.status).toBe('confirm_account');
    const id = await started(await h.approve('takeout.mbox', takeoutMbox([held, namesOnly, fresh]), { confirmAccount: true }));
    await h.importAll(id);

    const active = h.rows().filter((row) => row.tombstoned === 0);
    const ids = active.map((row) => `${row.domain}:${row.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...new Set(active.map((row) => row.id))].sort()).toEqual([held.id, namesOnly.id, fresh.id].sort());
    // Live's copy stays as live stored it; the names-only one now holds the export's text.
    expect(h.textOf(held.id)).toBe(liveText);
    expect(h.textOf(namesOnly.id)).toContain('fixturebody2');
    expect(h.textOf(fresh.id)).toContain('fixturebody3');
    // The import counts its own run: three read, two of them already there (one by name only).
    const imports = h.dashboard.sourceImports().flatMap((card) => card.imports);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ read: 3, alreadyThere: 2 });
  });

  test('a later live pull of mail the export brought stores nothing again', async () => {
    const h = gmailArchiveHarness(cleanups);
    const first = mail(4);
    const id = await started(await h.approve('takeout.mbox', takeoutMbox([first])));
    await h.importAll(id);
    const before = h.rows();
    h.mailbox.messages = [apiMessage(first)];
    await h.pullLive();
    expect(h.rows()).toEqual(before);
  });

  test('an account that carries another address keeps the export under Archives', async () => {
    const h = gmailArchiveHarness(cleanups);
    h.connectLive(composeProviderAccountId([googleSubjectLabel('someone'), googleAccountIdFromAddress('other@example.test')])!);
    const result = await h.approve('takeout.mbox', takeoutMbox([mail(5)]));
    const id = await started(result);
    expect(h.runtime.state.get(id)!.target).toBeUndefined();
  });

  test('an account known by its subject alone asks the owner, and a yes joins it without writing the address', async () => {
    const h = gmailArchiveHarness(cleanups);
    const subjectOnly = composeProviderAccountId([googleSubjectLabel('owner-subject')])!;
    h.connectLive(subjectOnly);
    const asked = await h.approve('takeout.mbox', takeoutMbox([mail(6)]));
    expect(asked.ok && asked.status).toBe('confirm_account');
    const id = await started(await h.approve('takeout.mbox', takeoutMbox([mail(6)]), { confirmAccount: true }));
    expect(h.runtime.state.get(id)!.target?.source_id).toBe('gmail.email');
    await h.importAll(id);
    expect(h.rows().some((row) => row.id === mail(6).id)).toBe(true);
    expect(readSourceRegistry(h.env).accounts.find((account) => account.source_id === 'gmail.email')?.provider_account_hash).toBe(subjectOnly);
  });

  test('an mbox without Gmail\'s markers, or with two delivered-to addresses, stays under Archives', async () => {
    const h = gmailArchiveHarness(cleanups);
    const plain = await started(await h.approve('plain.mbox', takeoutMbox([mail(7)], { markers: false })));
    expect(h.runtime.state.get(plain)!.target).toBeUndefined();
    const mixed = await started(await h.approve('mixed.mbox', takeoutMbox([mail(8), mail(9, { deliveredTo: 'second@example.test' })])));
    expect(h.runtime.state.get(mixed)!.target).toBeUndefined();
    expect(h.rows()).toEqual([]);
  });

  test('Spam and Trash are skipped; labels are Gmail\'s ids; a message without Takeout\'s id keeps an id of its own', async () => {
    const h = gmailArchiveHarness(cleanups);
    const spam = mail(10, { labels: ['Spam'] });
    const loose = mail(11);
    const text = takeoutMbox([mail(12), spam]) + takeoutMbox([loose], { separator: () => 'From someone@example.test Mon Jan  1 00:00:00 2024' });
    const id = await started(await h.approve('takeout.mbox', text));
    const outcome = await h.importAll(id);
    expect(outcome.record?.findings.skipped).toMatchObject({ spam_or_trash: 1 });
    const ids = [...new Set(h.rows().map((row) => row.id))];
    expect(ids).toContain(mail(12).id);
    expect(ids).not.toContain(spam.id);
    expect(ids.filter((value) => value.startsWith('mbox-'))).toHaveLength(1);
    expect(ACCOUNT).toBe('personal');
  });
});

describe('a message without Takeout\'s id is matched by asking Gmail', () => {
  const live = mail(20);
  const api = (messages: GmailMessage[], requests: string[] = []): GmailApiClient => ({
    async listMessages(request) {
      requests.push(`list:${request.query}`);
      const wanted = /^rfc822msgid:(.+)$/.exec(request.query ?? '')?.[1];
      return { messages: messages.filter((entry) => entry.payload?.headers?.some((header) => header.name === 'Message-ID' && header.value === `<${wanted}>`)).map((entry) => ({ id: entry.id })) };
    },
    async getMessage(id) {
      requests.push(`get:${id}`);
      const found = messages.find((entry) => entry.id === id)!;
      return { ...found, payload: { headers: found.payload?.headers ?? [] } };
    },
  });
  const headersOf = (entry: typeof live) => ({
    messageId: entry.messageId!, date: new Date(entry.date).toUTCString(), from: entry.from, subject: entry.subject,
  });

  test('exactly one message that agrees on Message-ID, Date, From and Subject is the message', async () => {
    const requests: string[] = [];
    const match = gmailHeaderMatch(async () => api([apiMessage(live)], requests));
    expect(await match(headersOf(live))).toEqual({ id: live.id });
    expect(requests).toEqual([`list:rfc822msgid:${live.messageId}`, `get:${live.id}`]);
  });

  test('a subject that differs, two that agree, no Message-ID, or no Gmail: none', async () => {
    const twin = mail(21, { messageId: live.messageId!, date: live.date, from: live.from, subject: live.subject });
    expect(await gmailHeaderMatch(async () => api([apiMessage(live)]))({ ...headersOf(live), subject: 'Another subject' })).toBe('none');
    expect(await gmailHeaderMatch(async () => api([apiMessage(live), apiMessage(twin)]))(headersOf(live))).toBe('none');
    expect(await gmailHeaderMatch(async () => api([apiMessage(live)]))({ from: live.from })).toBe('none');
    expect(await gmailHeaderMatch(async () => undefined)(headersOf(live))).toBe('none');
  });

  test('end to end: the export\'s copy joins the live message instead of standing beside it', async () => {
    const h = gmailArchiveHarness(cleanups);
    h.connectLive(OWNER_LABEL);
    h.mailbox.messages = [apiMessage(live)];
    await h.pullLive();
    h.match.current = gmailHeaderMatch(async () => api(h.mailbox.messages));
    const loose = takeoutMbox([live, mail(22)], { separator: () => 'From someone@example.test Mon Jan  1 00:00:00 2024' });
    const id = await started(await h.approve('export.mbox', loose, { confirmAccount: true }));
    await h.importAll(id);
    const ids = [...new Set(h.rows().filter((row) => row.tombstoned === 0).map((row) => row.id))];
    expect(ids).toContain(live.id);
    expect(ids.filter((value) => value.startsWith('mbox-'))).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });
});
