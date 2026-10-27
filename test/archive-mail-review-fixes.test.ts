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
import { gmailHeaderMatch } from '../src/workers/google-connectors/gmail-header-match.ts';
import {
  GMAIL_DAILY_BUDGET_SETTING,
  GMAIL_IMPORT_LABELS_COST,
  GMAIL_IMPORT_MAX_RETRIES,
  GMAIL_IMPORT_MIN_DAILY_BUDGET,
  gmailImportAllowance,
  gmailImportBudget,
  gmailImportWait,
} from '../src/workers/google-connectors/gmail-import-allowance.ts';
import { GoogleDailyRequestBudget } from '../src/workers/google-connectors/request-budget.ts';
import { dashboardImportAttentionSentence } from '../src/workers/dashboard/vocabulary.ts';
import { gapSentence } from '../scripts/release-check/archive-leg.ts';
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
    h.labels.current = async () => ({ unavailable: 'gmail_labels_unavailable' });
    expect(await gmailLabelLookup({ set: h.set, labelIds: h.labels.current })).toEqual({ kind: 'unavailable', reason: 'gmail_labels_unavailable' });
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
    let asked = 0;
    expect(await gmailLabelLookup({ set: h.set, labelIds: async () => { asked += 1; return new Map(); } })).toEqual({ kind: 'none' });
    // Nothing is asked of Gmail when no rule names a label.
    expect(asked).toBe(0);
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

  const live = mail(7);
  const headers = { messageId: live.messageId!, date: new Date(live.date).toUTCString(), from: live.from, subject: live.subject };
  const TOKEN_BROKER = { async issueSession() { return { kind: 'bearer_token' as const, token: 'fixture-token' }; } } as unknown as CredentialBroker;

  /**
   * The imports' real Gmail client (the REST transport, its retries, the lane's day counter) over a fake Gmail
   * that fails the first attempt of every request when `flaky` (each request then costs its worst case).
   */
  async function importClient(daily: number, options: { flaky?: boolean; candidates?: number } = {}) {
    const lane = new GoogleDailyRequestBudget({ provider: 'Gmail', dailyRequestBudget: daily, now: () => new Date('2026-10-26T12:00:00Z') });
    const allowance = gmailImportAllowance({ usage: () => lane.status(), now: () => new Date('2026-10-26T12:00:00Z') });
    const twins = Array.from({ length: options.candidates ?? 1 }, (_, at) => apiMessage(mail(200 + at, {
      messageId: live.messageId!, date: live.date, from: live.from, subject: live.subject,
    })));
    const seen = new Map<string, number>();
    const http = { attempts: 0 };
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      http.attempts += 1;
      const tries = (seen.get(url) ?? 0) + 1;
      seen.set(url, tries);
      if (options.flaky && tries === 1) return new Response('busy', { status: 503 });
      if (url.includes('/profile')) return Response.json({ emailAddress: OWNER_ADDRESS });
      if (url.includes('/labels')) return Response.json({ labels: [{ id: 'Label_7', name: 'Payroll' }] });
      if (url.includes('messages?')) return Response.json({ messages: twins.map((entry) => ({ id: entry.id })) });
      const id = /messages\/([^?]+)/.exec(url)?.[1];
      const found = twins.find((entry) => entry.id === id)!;
      return Response.json({ ...found, payload: { headers: found.payload?.headers ?? [] } });
    };
    const connector = new GoogleGmailSourceConnector({
      account: 'personal',
      credentialBroker: TOKEN_BROKER,
      fetch: fetchImpl as never,
      requestBudget: gmailImportBudget(lane, allowance),
      maxRetries: GMAIL_IMPORT_MAX_RETRIES,
      sleep: async () => {},
    });
    return { client: await connector.apiClientForTooling(), allowance, lane, http };
  }

  test('every HTTP attempt is charged, retries included: an import never goes past its share', async () => {
    const { client, allowance, lane, http } = await importClient(40, { flaky: true });
    const match = gmailHeaderMatch(async () => client, { allowance, sameAccount: () => true });
    const answers: unknown[] = [];
    for (let at = 0; at < 10; at += 1) answers.push(await match(headers));
    // The share of a day of 40 is 20 attempts, and each attempt, the failed ones too, is the lane's as well.
    expect(http.attempts).toBeLessThanOrEqual(20);
    expect(lane.status().requests).toBe(http.attempts);
    expect(answers[0]).toEqual({ id: mail(200).id });
    expect(answers.at(-1)).toEqual({ later: 'gmail_import_allowance_spent' });
    // A waiting retry spends nothing.
    const before = http.attempts;
    expect(await match(headers)).toEqual({ later: 'gmail_import_allowance_spent' });
    expect(http.attempts).toBe(before);
  });

  test('any accepted budget makes progress within a day, at its worst: the label list and one message, every request retried', async () => {
    for (const daily of [GMAIL_IMPORT_MIN_DAILY_BUDGET, GMAIL_IMPORT_MIN_DAILY_BUDGET + 1, GMAIL_IMPORT_MIN_DAILY_BUDGET + 7, 100, 5_000]) {
      const { client, allowance } = await importClient(daily, { flaky: true, candidates: 5 });
      expect(allowance.check(GMAIL_IMPORT_LABELS_COST)).toBe(true);
      expect((await client.listLabels!()).map((label) => label.id)).toEqual(['Label_7']);
      // Five candidates agree on all four headers: no single message is it, and the message is done with.
      const answer = await gmailHeaderMatch(async () => client, { allowance, sameAccount: () => true })(headers);
      expect(answer, String(daily)).toBe('none');
    }
    const { allowance } = await importClient(GMAIL_IMPORT_MIN_DAILY_BUDGET - 1);
    expect(allowance.check(1)).toBe('gmail_budget_too_small');
    expect(gmailImportWait('gmail_budget_too_small')).toEqual({ later: 'gmail_budget_too_small', minimum: GMAIL_IMPORT_MIN_DAILY_BUDGET });
  });

  test('a budget too small is said on the import\'s row and under Needs you, with the least it must be and the setting', async () => {
    const h = gmailArchiveHarness(cleanups);
    h.match.current = async () => gmailImportWait('gmail_budget_too_small');
    const text = takeoutMbox([mail(19)], { separator: () => 'From someone@example.test Mon Jan  1 00:00:00 2024' });
    const id = await started(await h.approve('export.mbox', text));
    const outcome = await h.importAll(id);
    expect(outcome.record?.waiting).toMatchObject({ reason: 'gmail_budget_too_small', minimum: GMAIL_IMPORT_MIN_DAILY_BUDGET });
    const row = h.dashboard.sourceImports()[0]!.imports[0]!;
    expect(row.gaps).toContainEqual({ kind: 'gmail_budget_too_small', count: GMAIL_IMPORT_MIN_DAILY_BUDGET });
    expect(gapSentence('gmail_budget_too_small', GMAIL_IMPORT_MIN_DAILY_BUDGET)).toContain(`${GMAIL_DAILY_BUDGET_SETTING} to ${GMAIL_IMPORT_MIN_DAILY_BUDGET} or more`);
    const attention = h.dashboard.present().attention ?? [];
    const item = attention.find((entry) => entry.kind === 'waiting');
    expect(item).toMatchObject({ id, reason: 'gmail_budget_too_small', minimum: GMAIL_IMPORT_MIN_DAILY_BUDGET });
    expect(dashboardImportAttentionSentence(item!)).toContain(`${GMAIL_DAILY_BUDGET_SETTING} to ${GMAIL_IMPORT_MIN_DAILY_BUDGET} or more`);
    // Once a pass does not wait, the note goes.
    h.match.current = async () => 'none';
    const after = await h.importAll(id);
    expect(after.record?.waiting).toBeUndefined();
    expect((h.dashboard.present().attention ?? []).some((entry) => entry.kind === 'waiting')).toBe(false);
  });

  test('end to end: messages matched before the budget ran out are stored, the rest wait for the next pass', async () => {
    const h = gmailArchiveHarness(cleanups);
    const loose = [mail(8), mail(9), mail(10)];
    let allowed = 2;
    h.match.current = async () => (allowed-- > 0 ? 'none' : { later: 'gmail_import_allowance_spent' });
    const text = takeoutMbox(loose, { separator: () => 'From someone@example.test Mon Jan  1 00:00:00 2024' });
    const id = await started(await h.approve('export.mbox', text));
    const first = await h.importAll(id);
    expect(first.continueSoon).toBe(false);
    expect(first.receipt.warnings).toContain('archive_import_waiting_for_provider: gmail_import_allowance_spent');
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

describe('a cut-short Gmail page resumes by message, never by position', () => {
  test('a message removed before the resume does not make the next one skipped', async () => {
    const first = apiMessage(mail(16));
    const base = apiMessage(mail(17));
    const second: GmailMessage = {
      ...base,
      payload: {
        partId: '', mimeType: 'multipart/mixed', headers: base.payload!.headers!,
        parts: [
          { partId: '0', mimeType: 'text/plain', filename: '', body: { data: Buffer.from('body').toString('base64url') } },
          ...[1, 2].map((at) => ({ partId: String(at), mimeType: 'application/pdf', filename: `g${at}.pdf`, body: { attachmentId: `b${at}`, size: 3 } })),
        ],
      },
    };
    const third = apiMessage(mail(18));
    let mailbox = [first, second, third];
    const client: GmailApiClient = {
      async listMessages(request) {
        const offset = request.pageToken ? Number(request.pageToken) : 0;
        const slice = mailbox.slice(offset, offset + request.maxResults);
        return { messages: slice.map((entry) => ({ id: entry.id })), ...(offset + slice.length < mailbox.length ? { nextPageToken: String(offset + slice.length) } : {}) };
      },
      async getMessage(id) { return [first, second, third].find((entry) => entry.id === id)!; },
    };
    const connector = new GoogleGmailSourceConnector({ account: 'personal', credentialBroker: OFFLINE_BROKER, apiClient: client, build: { children: true } });
    const ids: string[] = [];
    let cursor: string | undefined;
    // First pass: the first message fits; the second (three items) does not beside it.
    for await (const page of connector.listItems({ limit: 3 })) {
      ids.push(...page.items.map((item) => item.identity.providerItemId));
      cursor = page.nextCursor;
    }
    expect(ids).toEqual([first.id]);
    // The first message is deleted in Gmail before the next pass.
    mailbox = [second, third];
    let done = false;
    for (let pass = 0; pass < 10 && !done; pass += 1) {
      for await (const page of connector.listItems({ limit: 3, ...(cursor ? { cursor } : {}) })) {
        ids.push(...page.items.map((item) => item.identity.providerItemId));
        cursor = page.nextCursor;
        done = page.done;
      }
    }
    expect(ids).toContain(second.id);
    expect(ids).toContain(third.id);
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
