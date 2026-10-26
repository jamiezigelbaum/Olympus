// Regressions for the review of PR #546 (Astra and the review bot): every
// message is the proved account's, Takeout's label names reach owner rules on
// label ids, a spent request budget keeps what was read and waits, account
// detection stops at its byte bound, a cut-short Gmail page resumes after
// what it handled, Gmail's item scope stays stable across a later connect,
// and imported Private mail counts in the Private store's approved scope.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { googleAccountIdFromAddress } from '../src/core/provider-account-identity.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveFileEntries, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import { identifyGmailExport } from '../src/workers/archive-import/mbox/gmail-account.ts';
import { gmailLabelIds } from '../src/workers/archive-import/mbox/gmail-input.ts';
import { MboxReadBoundError, MboxSplitter } from '../src/workers/archive-import/mbox/split.ts';
import type { OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import { GoogleGmailSourceConnector, type GmailApiClient, type GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import { gmailItemAccountScope, gmailLabelLookup } from '../src/workers/google-connectors/gmail-archive-target.ts';
import { gmailHeaderMatch, IMPORT_SHARE } from '../src/workers/google-connectors/gmail-header-match.ts';
import { gmailPrivateStoreStatusScope } from '../src/workers/email-source/gmail-status-scope.ts';
import { GoogleRequestBudgetError } from '../src/workers/google-connectors/request-budget.ts';
import { ACCOUNT, gmailArchiveHarness } from './support/gmail-archive-harness.ts';
import { OWNER_ADDRESS, apiMessage, mail, takeoutMbox } from './support/archive-fixtures-gmail.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const OFFLINE_BROKER = { async issueSession() { throw new Error('no credentials'); } } as unknown as CredentialBroker;

async function started(result: { ok: boolean; status?: string; archive_id?: string }): Promise<string> {
  if (!result.ok || result.status !== 'started' || !result.archive_id) throw new Error(`expected a start, got ${JSON.stringify(result)}`);
  return result.archive_id;
}

describe('every message is the proved account\'s', () => {
  test('a message delivered to another address after the first ones is counted and never written into the account', async () => {
    const h = gmailArchiveHarness(cleanups);
    // The account check reads the first 500 messages; the one for another address comes after them.
    const mine = Array.from({ length: 500 }, (_, at) => mail(1000 + at));
    const theirs = mail(4, { deliveredTo: 'someone-else@example.test' });
    const text = takeoutMbox([...mine, theirs]);
    const id = await started(await h.approve('takeout.mbox', text));
    const outcome = await h.importAll(id);
    expect(outcome.record?.status).toBe('imported');
    const ids = new Set(h.rows().map((row) => row.id));
    for (const entry of mine) expect(ids.has(entry.id)).toBe(true);
    expect(ids.has(theirs.id)).toBe(false);
    expect(outcome.record?.findings.gaps).toMatchObject({ mail_for_another_account: 1 });
  }, 60_000);
});

describe('Takeout label names reach owner rules on label ids', () => {
  const rule: OwnerTierRule = { id: 'payroll-private', match: { kind: 'label', value: 'Label_7' }, tier: 'secure', strength: 'force' };

  test('a user label is given by its id and its name; Gmail\'s own labels by their ids', () => {
    expect(gmailLabelIds(['Inbox', 'Payroll', 'Unknown'], new Map([['payroll', 'Label_7']]))).toEqual(['INBOX', 'Label_7', 'Payroll', 'Unknown']);
  });

  test('with a label rule and no way to read the account\'s labels, the import waits and stores nothing', async () => {
    const h = gmailArchiveHarness(cleanups, { rules: [rule] });
    h.labels.current = async () => undefined;
    expect(await gmailLabelLookup({ set: h.set, labelIds: h.labels.current })).toEqual({ kind: 'unavailable' });
    const id = await started(await h.approve('takeout.mbox', takeoutMbox([mail(5, { labels: ['Inbox', 'Payroll'] })])));
    const outcome = await h.importAll(id);
    expect(outcome.continueSoon).toBe(false);
    expect(outcome.receipt.warnings?.some((warning) => warning.startsWith('archive_import_waiting_for_provider'))).toBe(true);
    expect(outcome.record?.status).toBe('importing');
    expect(h.rows()).toEqual([]);
  });

  test('with the account\'s labels, the rule on the label id applies to the imported copy', async () => {
    const h = gmailArchiveHarness(cleanups, { rules: [rule] });
    h.labels.current = async () => new Map([['payroll', 'Label_7']]);
    const message = mail(6, { labels: ['Inbox', 'Payroll'] });
    const id = await started(await h.approve('takeout.mbox', takeoutMbox([message])));
    await h.importAll(id);
    const record = h.set.ledger.getCurrent({ provider: 'gmail', accountScope: ACCOUNT, providerItemId: message.id });
    expect(JSON.stringify(record?.reasons ?? [])).toContain('payroll-private');
  });

  test('without a label rule, names alone are enough and nothing waits', async () => {
    const h = gmailArchiveHarness(cleanups);
    expect(await gmailLabelLookup({ set: h.set })).toEqual({ kind: 'none' });
  });
});

describe('a spent request budget keeps what was read and waits', () => {
  const api = (messages: GmailMessage[]): GmailApiClient => ({
    async listMessages(request) {
      const wanted = /^rfc822msgid:(.+)$/.exec(request.query ?? '')?.[1];
      return { messages: messages.filter((entry) => entry.payload?.headers?.some((header) => header.value === `<${wanted}>`)).map((entry) => ({ id: entry.id })) };
    },
    async getMessage(id) {
      const found = messages.find((entry) => entry.id === id)!;
      return { ...found, payload: { headers: found.payload?.headers ?? [] } };
    },
  });

  test('the import\'s share is capped, and a spent budget is "later", never an error', async () => {
    const live = mail(7);
    const headers = { messageId: live.messageId!, date: new Date(live.date).toUTCString(), from: live.from, subject: live.subject };
    const share = Math.floor(100 * IMPORT_SHARE);
    expect(await gmailHeaderMatch(async () => api([apiMessage(live)]), { usage: () => ({ requests: share - 1, dailyRequestBudget: 100 }) })(headers)).toBe('later');
    expect(await gmailHeaderMatch(async () => api([apiMessage(live)]), { usage: () => ({ requests: 0, dailyRequestBudget: 100 }) })(headers)).toEqual({ id: live.id });
    const spent: GmailApiClient = { ...api([]), async listMessages() { throw new GoogleRequestBudgetError('Gmail', '2026-10-27T00:00:00.000Z'); } };
    expect(await gmailHeaderMatch(async () => spent)(headers)).toBe('later');
  });

  test('end to end: messages matched before the budget ran out are stored, the rest wait for the next pass', async () => {
    const h = gmailArchiveHarness(cleanups);
    const loose = [mail(8), mail(9), mail(10)];
    let allowed = 2;
    h.match.current = async () => (allowed-- > 0 ? 'none' : 'later');
    const text = takeoutMbox(loose, { separator: () => 'From someone@example.test Mon Jan  1 00:00:00 2024' });
    const id = await started(await h.approve('export.mbox', text));
    const first = await h.importAll(id);
    expect(first.continueSoon).toBe(false);
    expect(first.record?.status).toBe('importing');
    expect(new Set(h.rows().map((row) => row.id)).size).toBe(2);
    allowed = 10;
    const second = await h.importAll(id);
    expect(second.record?.status).toBe('imported');
    expect(new Set(h.rows().map((row) => row.id)).size).toBe(3);
  });
});

describe('account detection stops at its byte bound', () => {
  test('the splitter reads no more than it may, a message over the size bound included', () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 'a');
    const file = Buffer.concat([Buffer.from('From x@xxx Mon Jan  1 00:00:00 2024\nSubject: big\n\n'), big, Buffer.from('\nFrom y@xxx Mon Jan  1 00:00:00 2024\nSubject: next\n\nbody\n')]);
    let read = 0;
    const source = { size: file.length, readAt: (offset: number, length: number) => { read += length; return file.subarray(offset, offset + length); } };
    const splitter = new MboxSplitter(source, { maxMessageBytes: 1024, maxReadBytes: 1024 * 1024 });
    expect(() => splitter.next()).toThrow(MboxReadBoundError);
    expect(read).toBeLessThanOrEqual(1024 * 1024);
  });

  test('a look that runs out of bytes decides on what it read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-detect-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const filler = 'x'.repeat(4096);
    writeFileSync(join(dir, 'export.mbox'), takeoutMbox([mail(11), mail(12, { body: filler }), mail(13, { deliveredTo: 'other@example.test', body: filler })]));
    const root = ScopeRoot.open(dir);
    try {
      const files = archiveFileEntries(buildArchiveManifest(root, ['export.mbox']));
      expect(identifyGmailExport(root, files, { maxBytes: 2_000 })).toEqual({ kind: 'gmail', address: OWNER_ADDRESS });
      expect(identifyGmailExport(root, files)).toEqual({ kind: 'not_gmail', reason: 'several_addresses' });
    } finally {
      root.close();
    }
  });
});

describe('a cut-short Gmail page resumes after what it handled', () => {
  test('one message with three attachments under a limit of two finishes without a stored-item lookup', async () => {
    const base = apiMessage(mail(14));
    const message: GmailMessage = {
      ...base,
      payload: {
        partId: '', mimeType: 'multipart/mixed', headers: base.payload!.headers!,
        parts: [
          { partId: '0', mimeType: 'text/plain', filename: '', body: { data: Buffer.from('body').toString('base64url') } },
          ...[1, 2, 3].map((at) => ({ partId: String(at), mimeType: 'application/pdf', filename: `f${at}.pdf`, body: { attachmentId: `a${at}`, size: 3 } })),
        ],
      },
    };
    const other = apiMessage(mail(15));
    const client: GmailApiClient = {
      async listMessages(request) {
        const all = [message, other];
        const offset = request.pageToken ? Number(request.pageToken) : 0;
        const slice = all.slice(offset, offset + request.maxResults);
        return { messages: slice.map((entry) => ({ id: entry.id })), ...(offset + slice.length < all.length ? { nextPageToken: String(offset + slice.length) } : {}) };
      },
      async getMessage(id) { return [message, other].find((entry) => entry.id === id)!; },
    };
    const connector = new GoogleGmailSourceConnector({ account: 'personal', credentialBroker: OFFLINE_BROKER, apiClient: client, build: { children: true } });
    const ids: string[] = [];
    let cursor: string | undefined;
    let done = false;
    for (let pass = 0; pass < 10 && !done; pass += 1) {
      for await (const page of connector.listItems({ limit: 2, ...(cursor ? { cursor } : {}) })) {
        ids.push(...page.items.map((item) => item.identity.providerItemId));
        cursor = page.nextCursor;
        done = page.done;
      }
    }
    expect(done).toBe(true);
    expect(ids).toEqual([message.id, `${message.id}#child:1`, `${message.id}#child:2`, `${message.id}#child:3`, other.id]);
  });
});

describe('Gmail\'s item scope and approved scope', () => {
  test('a later connect under another role keeps the scope the account\'s items are under', () => {
    const stores = (scopes: string[]) => [{ itemAccountScopes: () => scopes }];
    expect(gmailItemAccountScope(stores(['personal']), 'business_ocu')).toBe('personal');
    expect(gmailItemAccountScope(stores([]), 'business_ocu')).toBe('business_ocu');
    expect(gmailItemAccountScope(stores(['business_ocu']), 'business_ocu')).toBe('business_ocu');
    expect(gmailItemAccountScope(stores(['personal', 'other']), 'business_ocu')).toBe('business_ocu');
  });

  test('the Private store\'s approved scope counts mail an import brought in, beside the live lane\'s own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-observed-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new LocalConnectorStore({ dbPath: join(dir, 's.sqlite'), corpusId: 'secure_local.email.private', family: 'email', trustDomain: 'secure_local' });
    cleanups.push(() => store.close());
    const scope = gmailPrivateStoreStatusScope({
      authority: {
        mailPolicyRef: () => ({ kind: 'mail', accountGeneration: 'g1', revision: 'r1' }) as never,
        assertCurrentMail: () => ({ mailScope: {} }) as never,
      },
      handle: { accountRole: 'personal' },
    });
    if (!('itemFilters' in scope) || !scope.itemFilters) throw new Error('expected filters');
    expect(scope.itemFilters).toMatchObject({ observedConnectorIdPrefix: 'archive.' });
    const imported = { family: 'email' as const, provider: 'gmail', accountScope: 'personal', providerItemId: 'm1', localItemId: 'personal:m1' };
    await store.syncFromConnector({
      id: 'archive.abc', family: 'email', authenticate: async () => {}, fetchItem: async () => { throw new Error('no'); }, classificationSignals: () => ({}),
      async *listItems() { yield { items: [{ identity: imported, mimeType: 'text/plain', content: { kind: 'text', text: 'hello' }, metadata: { title: 't' }, fetchedAt: new Date().toISOString() }], done: true }; },
    }, { fetchContent: true });
    expect(store.itemMatchesSearchFilters('personal:m1', 'personal', scope.itemFilters!)).toBe(true);
    expect(store.itemMatchesSearchFilters('personal:m1', 'personal', { provider: 'gmail', observedConnectorId: 'gmail.scope.x' })).toBe(false);
    expect(googleAccountIdFromAddress(OWNER_ADDRESS)).toMatch(/^google:/);
  });
});
