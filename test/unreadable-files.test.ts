/**
 * Which files can't be read (owner rulings, 2026-10-10): See why names them,
 * and on the computer each one opens.
 *
 * - Secrets never show as unreadable on any host: a Secrets item extraction
 *   gave up on (by its tier ledger row, or by the secret-locations index) is
 *   neither counted nor listed, on the scoped and the corpus readiness path;
 *   it counts with the policy exit instead.
 * - The count and the list are one decision: the ledger's list is the items
 *   its count is the length of, newest failure first.
 * - Opening a file takes a one-time token, never a path: minted only for an
 *   unlocked session (or the bearer) and bound to it, spent before the open
 *   starts, good for 30 minutes from issue however often the list is read;
 *   rate limited, re-checked at open time, and the tool is the computer's alone.
 * - The count and the names are checked again at publish time: a file that
 *   became Secrets (a ledger row, the secret index, or a persisted
 *   `olympus tier set … secrets` override) is never named or counted.
 * - Every file is reachable: past the first page, the computer pages the rest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, withWorkerBearerAuth } from '../src/workers/http.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OLYMPUS_TAB_TOOL_NAMES } from '../src/core/control-ui-gateway.ts';
import { V0_4_PUBLIC_MCP_TOOLS, V0_4_PUBLIC_NATIVE_TOOLS } from '../src/core/public-surface.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import {
  COMPUTER_HOST_TOOL_NAMES,
  COMPUTER_UNREADABLE_FILES_LIMIT,
  OPEN_UNREADABLE_FILE_TOOL_NAME,
  PANEL_TOOL_NAMES,
  UNREADABLE_FILES_PAGE_TOOL_NAME,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { CHATGPT_TOOLS } from '../src/workers/chatgpt/mcp-surface.ts';
import { computerUnreadableEntries, createDashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
import { LocalFileExtractionJobStore, type ExtractionUnreadableItem } from '../src/workers/file-extraction/job-store.ts';
import { createExtractionReadinessLedger } from '../src/workers/file-extraction/readiness-ledger.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';
import {
  isUnreadableOpenToken,
  isUnreadablePageCursor,
  createUnreadableFiles,
  createUnreadableVerdict,
  type UnreadableFiles,
} from '../src/workers/file-extraction/unreadable-files.ts';

const LANE = {
  corpusId: 'secure_local.dropbox.files',
  provider: 'dropbox',
  accountScope: 'owner@example.com',
  approvedScopeKey: 'dropbox.personal:/Work',
};

/** The unlocked session (or bearer) a list was read for. */
const OPENER = 'session:owner';
const AS_OPENER = { opener: OPENER };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      // Cleanup must not mask a test's own failure.
    }
  }
});

function ref(providerItemId: string, overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: LANE.corpusId,
    provider: LANE.provider,
    accountScope: LANE.accountScope,
    approvedScopeKey: LANE.approvedScopeKey,
    providerItemId,
    localItemId: `${LANE.accountScope}:${providerItemId}`,
    sourceVersion: `${providerItemId}-v1`,
    contentHash: `hash-${providerItemId}`,
    name: `${providerItemId}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1_024,
    ...overrides,
  };
}

function identity(providerItemId: string) {
  return { provider: LANE.provider, accountScope: LANE.accountScope, providerItemId };
}

/** A job store whose items failed for good, each at its own time. */
function failedStore(failures: Array<[providerItemId: string, failedAt: string]>) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-unreadable-'));
  const dbPath = join(root, 'jobs.sqlite');
  const store = new LocalFileExtractionJobStore(dbPath);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close());
  for (const [id, failedAt] of failures) {
    const jobId = store.enqueue({ refs: [ref(id)], extractorKind: 'local_text', extractorVersion: 'v1', policyDecision: 'index_allowed' }).jobRefs[0]!.jobId;
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'extractor_crashed' });
    const db = new Database(dbPath);
    db.exec('PRAGMA busy_timeout = 10000;');
    db.query('UPDATE extraction_jobs SET updated_at = ? WHERE job_id = ?').run(failedAt, jobId);
    db.close();
  }
  return store;
}

/** A tier lane with one item judged Secrets by its ledger row and one by the secret index. */
function secretsLane() {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const secrets = new SecretLocationsIndex({ dbPath: ':memory:' });
  cleanups.push(() => ledger.close(), () => secrets.close());
  const key = ['AKIA', 'ZYXWVUTSRQPONMLK'].join('');
  ledger.recordDecision(identity('secret-by-tier'), classifyItemTiers({ signals: { title: 'env.txt' }, text: `deploy key ${key}` }));
  ledger.recordDecision(identity('ordinary-old'), classifyItemTiers({ signals: { title: 'notes' }, text: 'weekly notes' }));
  secrets.record({ identity: identity('secret-by-index'), locator: '/Work/creds.txt', findingKinds: ['aws_access_key_id'] });
  return { corpusIds: new Set([LANE.corpusId]), ledger, secrets };
}

const FAILURES: Array<[string, string]> = [
  ['ordinary-old', '2026-10-01T00:00:00.000Z'],
  ['secret-by-tier', '2026-10-02T00:00:00.000Z'],
  ['ordinary-new', '2026-10-05T00:00:00.000Z'],
  ['secret-by-index', '2026-10-06T00:00:00.000Z'],
  ['removed', '2026-10-07T00:00:00.000Z'],
  ['ordinary-mid', '2026-10-03T00:00:00.000Z'],
];

function verdictFor(lane: ReturnType<typeof secretsLane>) {
  return createUnreadableVerdict({
    // Every item but 'removed' is still served by a store.
    locate: (item) => (item.providerItemId === 'removed' ? undefined : { locatorUri: `dropbox://id:${item.providerItemId}` }),
    lanes: () => [lane],
  });
}

describe('Secrets never count as unreadable', () => {
  test('the ledger row says Secrets (and the ordinary row does not)', () => {
    const lane = secretsLane();
    expect(lane.ledger.getCurrent(identity('secret-by-tier'))?.contentTier).toBe('secrets');
    expect(lane.ledger.getCurrent(identity('ordinary-old'))?.contentTier).not.toBe('secrets');
  });

  test('on both readiness paths: neither counted nor listed, and counted as policy-blocked', () => {
    const store = failedStore(FAILURES);
    const classifyUnreadable = verdictFor(secretsLane());
    const expected = { unreadableItems: 3, blockedByPolicyItems: 2, failedActionableJobs: 0 };
    const listed: Record<string, string[]> = {};
    const onUnreadable = (path: string) => (items: readonly ExtractionUnreadableItem[]) => {
      listed[path] = items.map((item) => item.ref.providerItemId);
    };
    expect(store.corpusReadiness(LANE.corpusId, new Date(), { classifyUnreadable, onUnreadable: onUnreadable('corpus') })).toMatchObject(expected);
    expect(store.scopedReadiness([LANE], { classifyUnreadable, onUnreadable: onUnreadable('scoped') })).toMatchObject(expected);
    // Newest failure first; the removed item is in neither the count nor the list.
    expect(listed.corpus).toEqual(['ordinary-new', 'ordinary-mid', 'ordinary-old']);
    expect(listed.scoped).toEqual(listed.corpus!);
  });

  test('a verdict that throws fails closed: policy-blocked, never listed', () => {
    const store = failedStore([['x', '2026-10-01T00:00:00.000Z']]);
    const readiness = store.corpusReadiness(LANE.corpusId, new Date(), { classifyUnreadable: () => { throw new Error('ledger closed'); } });
    expect(readiness).toMatchObject({ unreadableItems: 0, blockedByPolicyItems: 1 });
  });

  test('the readiness ledger\'s count and its list are one decision, on the corpus and the scoped path', () => {
    const store = failedStore(FAILURES);
    const classifyUnreadable = verdictFor(secretsLane());
    for (const scoped of [false, true]) {
      const ledger = createExtractionReadinessLedger(store, {
        classifyUnreadable,
        ...(scoped ? { lanesForCorpus: () => [LANE], currentItem: () => true } : {}),
      });
      const counts = ledger.snapshotForCorpus(LANE.corpusId)?.counts;
      const list = ledger.unreadableItems(LANE.corpusId).map((item) => item.ref.providerItemId);
      expect(counts).toMatchObject({ extraction_items_unreadable: 3, qa_blocked_policy: 2 });
      expect(list).toEqual(['ordinary-new', 'ordinary-mid', 'ordinary-old']);
      expect(list).toHaveLength(counts!.extraction_items_unreadable!);
    }
  });

  test('a Secrets item is never opened from an older list either', async () => {
    const lane = secretsLane();
    const items: ExtractionUnreadableItem[] = [{ ref: ref('ordinary-new'), failedAt: '2026-10-05T00:00:00.000Z' }];
    const files = createUnreadableFiles({
      items: () => items,
      verdict: verdictFor(lane),
      locate: () => ({ locatorUri: 'dropbox://id:ordinary-new' }),
      openTarget: () => ({ url: 'https://www.dropbox.com/preview/Work/ordinary-new.pdf' }),
    });
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    // Judged Secrets after the list was read.
    lane.secrets.record({ identity: identity('ordinary-new'), findingKinds: ['aws_access_key_id'] });
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
  });
});

// ---- the list and opening ---------------------------------------------------

function itemsOf(count: number): ExtractionUnreadableItem[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: ref(`file-${String(index).padStart(3, '0')}`),
    failedAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
  }));
}

function filesOver(items: ExtractionUnreadableItem[], overrides: Partial<Parameters<typeof createUnreadableFiles>[0]> = {}) {
  const opened: string[] = [];
  const files = createUnreadableFiles({
    items: () => items,
    verdict: () => 'unreadable',
    locate: (item) => ({ locatorUri: `/Work/${item.name}` }),
    openTarget: (_provider, locator) => (locator.includes('local') ? { localPath: `/Users/owner/Dropbox${locator}` } : { url: `https://www.dropbox.com/preview${locator}` }),
    openFile: async (path) => { opened.push(path); },
    ...overrides,
  });
  return { files, opened };
}

describe('the list', () => {
  test('names are newest failure first, and "more" is the rest', () => {
    const { files } = filesOver(itemsOf(7));
    expect(files.names([LANE.corpusId], 5)).toEqual(['file-006.pdf', 'file-005.pdf', 'file-004.pdf', 'file-003.pdf', 'file-002.pdf']);
    const listed = files.computerList([LANE.corpusId], 5, AS_OPENER);
    expect(listed.files.map((file) => file.name)).toEqual(files.names([LANE.corpusId], 5));
    expect(listed.more).toBe(2);
    expect(files.computerList([LANE.corpusId], COMPUTER_UNREADABLE_FILES_LIMIT).more).toBe(0);
  });

  test('a file with no place to open is plain text: no token', () => {
    const { files } = filesOver(itemsOf(2), { openTarget: (_p, locator) => (locator.endsWith('file-000.pdf') ? undefined : { url: 'http://insecure.example/x' }) });
    expect(files.computerList([LANE.corpusId], 10, AS_OPENER).files.every((file) => file.token === undefined)).toBe(true);
  });

  test('tokens are random, per file, and read again keep the same token', () => {
    const { files } = filesOver(itemsOf(3));
    const first = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    for (const file of first) expect(isUnreadableOpenToken(file.token)).toBe(true);
    expect(new Set(first.map((file) => file.token)).size).toBe(3);
    expect(files.computerList([LANE.corpusId], 10, AS_OPENER).files.map((file) => file.token)).toEqual(first.map((file) => file.token));
    // No path or locator rides in the list.
    expect(JSON.stringify(first)).not.toContain('/Work/');
  });
});

describe('opening a file', () => {
  test('a synced copy opens on this computer; anything else answers its web page', async () => {
    const items = [
      { ref: ref('local-copy'), failedAt: '2026-10-02T00:00:00.000Z' },
      { ref: ref('web-only'), failedAt: '2026-10-01T00:00:00.000Z' },
    ];
    const { files, opened } = filesOver(items);
    const [local, web] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    expect(await files.open(local!.token, OPENER)).toEqual({ status: 'opened' });
    expect(opened).toEqual(['/Users/owner/Dropbox/Work/local-copy.pdf']);
    expect(await files.open(web!.token, OPENER)).toEqual({ status: 'open_link', url: 'https://www.dropbox.com/preview/Work/web-only.pdf' });
  });

  test('refuses anything but a token it handed out: malformed, a path, unknown, or expired', async () => {
    let clock = Date.UTC(2026, 9, 10);
    const { files, opened } = filesOver(itemsOf(1), { now: () => clock, tokenTtlMs: 60_000 });
    for (const bad of [undefined, 42, '', '/etc/passwd', '../../x', 'A'.repeat(42), { token: 'x' }]) {
      expect(await files.open(bad, OPENER)).toEqual({ status: 'invalid' });
    }
    expect(await files.open('A'.repeat(43), OPENER)).toEqual({ status: 'gone' });
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    clock += 61_000;
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
    expect(opened).toEqual([]);
  });

  test('a file no longer unreadable (read since, or removed) is gone at open time', async () => {
    let verdict: 'unreadable' | 'hidden' = 'unreadable';
    const { files } = filesOver(itemsOf(1), { verdict: () => verdict });
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    verdict = 'hidden';
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
    verdict = 'unreadable';
    // The refused token is dropped, not kept for later.
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
  });

  test('a burst of opens is rate limited, then one a second; a refused open keeps its token', async () => {
    let clock = Date.UTC(2026, 9, 10);
    const { files } = filesOver(itemsOf(11), { now: () => clock });
    const listed = files.computerList([LANE.corpusId], 20, AS_OPENER).files;
    const results = [];
    for (const file of listed) results.push((await files.open(file.token, OPENER)).status);
    expect(results.slice(0, 10).every((status) => status === 'open_link')).toBe(true);
    expect(results[10]).toBe('rate_limited');
    clock += 1_000;
    expect((await files.open(listed[10]!.token, OPENER)).status).toBe('open_link');
  });

  test('a token opens once: spent before the open starts, so a racing second call finds nothing', async () => {
    let release: () => void = () => {};
    const opening: string[] = [];
    const items = [{ ref: ref('local-copy'), failedAt: '2026-10-02T00:00:00.000Z' }];
    const { files } = filesOver(items, {
      openFile: (path) => {
        opening.push(path);
        return new Promise<void>((resolve) => { release = resolve; });
      },
    });
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    const first = files.open(file!.token, OPENER);
    const second = await files.open(file!.token, OPENER);
    expect(second).toEqual({ status: 'gone' });
    release();
    expect(await first).toEqual({ status: 'opened' });
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
    expect(opening).toHaveLength(1);
    // Read again, the list hands out a new token for the next open.
    const [again] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    expect(again!.token).not.toBe(file!.token);
  });

  test('30 minutes from issue, however often the list is read', async () => {
    let clock = Date.UTC(2026, 9, 10);
    const { files } = filesOver(itemsOf(1), { now: () => clock });
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    for (let minute = 0; minute < 29; minute += 1) {
      clock += 60_000;
      expect(files.computerList([LANE.corpusId], 10, AS_OPENER).files[0]!.token).toBe(file!.token);
    }
    clock += 61_000;
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
    // The next read issues a fresh one, good for its own 30 minutes.
    const [fresh] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    expect(fresh!.token).not.toBe(file!.token);
    expect((await files.open(fresh!.token, OPENER)).status).toBe('open_link');
  });

  test('tokens only for an opener, and only that opener redeems them', async () => {
    const { files, opened } = filesOver(itemsOf(1));
    // A locked reader: names, no tokens.
    expect(files.computerList([LANE.corpusId], 10).files).toEqual([{ name: 'file-000.pdf' }]);
    const [mine] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    const [theirs] = files.computerList([LANE.corpusId], 10, { opener: 'session:other' }).files;
    expect(theirs!.token).not.toBe(mine!.token);
    expect(await files.open(mine!.token, 'session:other')).toEqual({ status: 'gone' });
    expect(await files.open(mine!.token)).toEqual({ status: 'gone' });
    // Refused for the wrong opener, it is still the right one's.
    expect((await files.open(mine!.token, OPENER)).status).toBe('open_link');
    expect(opened).toEqual([]);
  });
});

// ---- the computer-only tool ---------------------------------------------------

function panelTools(files: UnreadableFiles | undefined) {
  return createDashboardPanelTools({
    surface: () => { throw new Error('opening a file never reaches the ChatGPT surface'); },
    setup: {} as never,
    workerFetch: async () => { throw new Error('opening a file calls no worker route'); },
    makeContext: () => { throw new Error('not used'); },
    indexFasterState: async () => undefined,
    unreadableFiles: () => files,
  });
}

describe('the open tool', () => {
  test('is the computer\'s alone: never on ChatGPT, MCP, the native plugin or the OpenClaw tab', () => {
    expect(COMPUTER_HOST_TOOL_NAMES).toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
    expect(PANEL_TOOL_NAMES as readonly string[]).not.toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
    expect(OLYMPUS_TAB_TOOL_NAMES as readonly string[]).not.toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
    expect(CHATGPT_TOOLS.map((tool) => tool.name)).not.toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
    expect(V0_4_PUBLIC_MCP_TOOLS as readonly string[]).not.toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
    expect(V0_4_PUBLIC_NATIVE_TOOLS as readonly string[]).not.toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
  });

  test('takes a token and nothing else; never a path', async () => {
    const { files, opened } = filesOver(itemsOf(1));
    const tools = panelTools(files);
    expect(tools.allows(OPEN_UNREADABLE_FILE_TOOL_NAME)).toBe(true);
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    for (const args of [{}, { path: '/Users/owner/Dropbox/Work/file-000.pdf' }, { token: file!.token, path: '/etc/passwd' }, { token: 7 }, { token: '/etc/passwd' }]) {
      const result = await tools.call(OPEN_UNREADABLE_FILE_TOOL_NAME, args as Record<string, unknown>, { origin: 'http://127.0.0.1:8787', opener: OPENER });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: 'invalid_params' });
    }
    expect(opened).toEqual([]);
    // No opener (a locked reader's call): refused before the token is looked at.
    expect((await tools.call(OPEN_UNREADABLE_FILE_TOOL_NAME, { token: file!.token }, { origin: 'http://127.0.0.1:8787' })).structuredContent).toEqual({ error: 'unavailable' });
    const ok = await tools.call(OPEN_UNREADABLE_FILE_TOOL_NAME, { token: file!.token }, { origin: 'http://127.0.0.1:8787', opener: OPENER });
    expect(ok.structuredContent).toEqual({ status: 'open_link', url: 'https://www.dropbox.com/preview/Work/file-000.pdf' });
  });

  test('an unknown or expired token is gone, with a way forward', async () => {
    const tools = panelTools(filesOver(itemsOf(1)).files);
    const result = await tools.call(OPEN_UNREADABLE_FILE_TOOL_NAME, { token: 'B'.repeat(43) }, { origin: 'http://127.0.0.1:8787', opener: OPENER });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: 'gone' } });
    expect(result.content[0]).toEqual({ type: 'text', text: 'This file is no longer in the list. Refresh the dashboard.' });
    expect((await panelTools(undefined).call(OPEN_UNREADABLE_FILE_TOOL_NAME, { token: 'B'.repeat(43) }, { origin: 'http://127.0.0.1:8787' })).isError).toBe(true);
  });
});

describe('the computer\'s list per source', () => {
  function view(count: number, corpusIds = [LANE.corpusId]) {
    return { sources: [{ source_id: 'dropbox.files', coverage: { unreadable_items: count }, unreadable_files: { names: [], corpus_ids: corpusIds } }] } as never;
  }

  test('up to 200 files with their tokens, and "more" for the rest', () => {
    const { files } = filesOver(itemsOf(230));
    const [entry] = computerUnreadableEntries(view(230), files, OPENER);
    expect(entry!.sourceId).toBe('dropbox.files');
    expect(entry!.files).toHaveLength(COMPUTER_UNREADABLE_FILES_LIMIT);
    expect(entry!.files[0]!.name).toBe('file-229.pdf');
    expect(entry!.files.every((file) => typeof file.token === 'string')).toBe(true);
    expect(entry!.more).toBe(30);
    // A locked reader (no opener) gets the same names and no tokens.
    const [locked] = computerUnreadableEntries(view(230), files);
    expect(locked!.files.map((file) => file.name)).toEqual(entry!.files.map((file) => file.name));
    expect(locked!.files.every((file) => file.token === undefined)).toBe(true);
  });

  test('the row\'s count wins when the list is shorter, so "more" never hides a file', () => {
    const { files } = filesOver(itemsOf(3));
    expect(computerUnreadableEntries(view(5), files)[0]!.more).toBe(2);
    expect(computerUnreadableEntries(view(3), files)[0]!.more).toBe(0);
    expect(computerUnreadableEntries(view(0), files)).toEqual([]);
    expect(computerUnreadableEntries(view(3, []), files)).toEqual([]);
  });

  test('names are capped like the result\'s', () => {
    const long = [{ ref: ref('x', { name: `${'a'.repeat(300)}.pdf` }), failedAt: '2026-10-01T00:00:00.000Z' }];
    const [entry] = computerUnreadableEntries(view(1), filesOver(long).files);
    expect(Array.from(entry!.files[0]!.name)).toHaveLength(120);
    expect(entry!.files[0]!.name.endsWith('…')).toBe(true);
  });
});

// ---- Codex review of #231 ---------------------------------------------------

describe('checked again at publish time (P1a)', () => {
  test('a file judged Secrets after the snapshot is neither named nor counted, and moves to the policy exit', () => {
    const lane = secretsLane();
    let clock = Date.UTC(2026, 9, 10);
    // The ledger's last snapshot: three ordinary files.
    const snapshot: ExtractionUnreadableItem[] = [
      { ref: ref('ordinary-new'), failedAt: '2026-10-05T00:00:00.000Z' },
      { ref: ref('ordinary-mid'), failedAt: '2026-10-03T00:00:00.000Z' },
      { ref: ref('ordinary-old'), failedAt: '2026-10-01T00:00:00.000Z' },
    ];
    const files = createUnreadableFiles({
      items: () => snapshot,
      verdict: verdictFor(lane),
      locate: (item) => ({ locatorUri: `dropbox://id:${item.providerItemId}` }),
      openTarget: () => ({ url: 'https://www.dropbox.com/preview/Work/x.pdf' }),
      now: () => clock,
    });
    expect(files.recheck(LANE.corpusId)).toEqual({ unreadable: 3, blocked: 0 });
    lane.secrets.record({ identity: identity('ordinary-mid'), findingKinds: ['aws_access_key_id'] });
    clock += 1_001;
    expect(files.recheck(LANE.corpusId)).toEqual({ unreadable: 2, blocked: 1 });
    expect(files.names([LANE.corpusId], 5)).toEqual(['ordinary-new.pdf', 'ordinary-old.pdf']);
    expect(files.computerList([LANE.corpusId], 10, AS_OPENER).files.map((file) => file.name)).toEqual(['ordinary-new.pdf', 'ordinary-old.pdf']);
  });
});

describe('a persisted Secrets override counts at once (P1b)', () => {
  test('`olympus tier set <file> secrets` on a routed item: blocked before the next sync, in the list and at open time', async () => {
    const lane = secretsLane();
    let clock = Date.UTC(2026, 9, 10);
    const verdict = verdictFor(lane);
    const item = { ref: ref('ordinary-old'), failedAt: '2026-10-01T00:00:00.000Z' };
    const files = createUnreadableFiles({
      items: () => [item],
      verdict,
      locate: () => ({ locatorUri: 'dropbox://id:ordinary-old' }),
      openTarget: () => ({ url: 'https://www.dropbox.com/preview/Work/ordinary-old.pdf' }),
      now: () => clock,
    });
    const [file] = files.computerList([LANE.corpusId], 10, AS_OPENER).files;
    expect(verdict(item)).toBe('unreadable');
    // What tier-cli.ts does for a routed item: the override only, the record unchanged.
    lane.ledger.setOverride(identity('ordinary-old'), { kind: 'tier', tier: 'secrets' });
    expect(lane.ledger.getCurrent(identity('ordinary-old'))?.contentTier).not.toBe('secrets');
    expect(verdict(item)).toBe('blocked_policy');
    // An already issued token no longer opens it.
    expect(await files.open(file!.token, OPENER)).toEqual({ status: 'gone' });
    clock += 1_001;
    expect(files.names([LANE.corpusId], 5)).toEqual([]);
    expect(files.recheck(LANE.corpusId)).toEqual({ unreadable: 0, blocked: 1 });
    // Any other override leaves it unreadable.
    lane.ledger.setOverride(identity('ordinary-old'), { kind: 'not_secret' });
    expect(verdict(item)).toBe('unreadable');
  });
});

describe('every file is reachable (P2c)', () => {
  function pagingTools(files: UnreadableFiles, count: number) {
    const view = { sources: [{ source_id: 'dropbox.files', coverage: { unreadable_items: count }, unreadable_files: { names: [], corpus_ids: [LANE.corpusId] } }] };
    return createDashboardPanelTools({
      surface: () => ({ dashboardView: async () => view }) as never,
      setup: {} as never,
      workerFetch: async () => { throw new Error('paging calls no worker route'); },
      makeContext: () => ({}) as never,
      indexFasterState: async () => undefined,
      unreadableFiles: () => files,
    });
  }
  const firstPage = (files: UnreadableFiles, count: number) => computerUnreadableEntries(
    { sources: [{ source_id: 'dropbox.files', coverage: { unreadable_items: count }, unreadable_files: { names: [], corpus_ids: [LANE.corpusId] } }] } as never,
    files,
    OPENER,
  )[0]!;
  type Page = { status: string; files: Array<{ name: string; token?: string }>; more: number; after?: string };
  const CONTEXT = { origin: 'http://127.0.0.1:8787', opener: OPENER };

  test('past the first 200, the computer pages the rest: 450 files, each named once, each with a token', async () => {
    const { files } = filesOver(itemsOf(450));
    expect(COMPUTER_HOST_TOOL_NAMES).toContain(UNREADABLE_FILES_PAGE_TOOL_NAME);
    expect(PANEL_TOOL_NAMES as readonly string[]).not.toContain(UNREADABLE_FILES_PAGE_TOOL_NAME);
    expect(CHATGPT_TOOLS.map((tool) => tool.name)).not.toContain(UNREADABLE_FILES_PAGE_TOOL_NAME);
    expect(OLYMPUS_TAB_TOOL_NAMES as readonly string[]).not.toContain(UNREADABLE_FILES_PAGE_TOOL_NAME);
    const first = firstPage(files, 450);
    expect(first.files).toHaveLength(200);
    expect(first.more).toBe(250);
    expect(isUnreadablePageCursor(first.after)).toBe(true);
    // The cursor names no file: a time and an opaque digest.
    expect(first.after).not.toContain('file-');
    const tools = pagingTools(files, 450);
    // A source the dashboard does not list now has nothing to page.
    expect((await tools.call(UNREADABLE_FILES_PAGE_TOOL_NAME, { source_id: 'gmail.email', after: first.after }, CONTEXT)).structuredContent).toEqual({ error: 'gone' });
    const names = first.files.map((file) => file.name);
    let after = first.after;
    let more = first.more;
    let lastToken = '';
    while (more > 0) {
      const listed = (await tools.call(UNREADABLE_FILES_PAGE_TOOL_NAME, { source_id: 'dropbox.files', after }, CONTEXT)).structuredContent as Page;
      expect(listed.status).toBe('listed');
      expect(listed.files.length).toBeLessThanOrEqual(COMPUTER_UNREADABLE_FILES_LIMIT);
      expect(listed.files.every((file) => isUnreadableOpenToken(file.token))).toBe(true);
      names.push(...listed.files.map((file) => file.name));
      lastToken = listed.files.at(-1)!.token!;
      after = listed.after;
      more = listed.more;
    }
    expect(after).toBeUndefined();
    expect(names).toHaveLength(450);
    expect(new Set(names).size).toBe(450);
    expect(names.at(-1)).toBe('file-000.pdf');
    // The last file opens like the first.
    expect((await tools.call(OPEN_UNREADABLE_FILE_TOOL_NAME, { token: lastToken }, CONTEXT)).structuredContent).toEqual({ status: 'open_link', url: 'https://www.dropbox.com/preview/Work/file-000.pdf' });
  });

  // Second-round review: with an offset, a file judged Secrets on page one
  // shifted file 201 to offset 199, and offset 200 came back empty.
  test('201 files; a page-one file judged Secrets before page two: the 201st is still listed, the Secrets one never', async () => {
    const items = itemsOf(201);
    const secret = new Set<string>();
    const { files } = filesOver(items, { verdict: (item) => (secret.has(item.ref.providerItemId) ? 'blocked_policy' : 'unreadable') });
    const first = firstPage(files, 201);
    expect(first.files).toHaveLength(200);
    expect(first.more).toBe(1);
    secret.add('file-199');
    const second = (await pagingTools(files, 201).call(UNREADABLE_FILES_PAGE_TOOL_NAME, { source_id: 'dropbox.files', after: first.after }, CONTEXT)).structuredContent as Page;
    expect(second.files.map((file) => file.name)).toEqual(['file-000.pdf']);
    expect(second.more).toBe(0);
    // And the same change on the page still to come leaves the rest in place.
    secret.clear();
    secret.add('file-000');
    const empty = (await pagingTools(files, 201).call(UNREADABLE_FILES_PAGE_TOOL_NAME, { source_id: 'dropbox.files', after: first.after }, CONTEXT)).structuredContent as Page;
    expect(empty.files).toEqual([]);
    expect(empty.more).toBe(0);
  });

  test('takes a source and a cursor only, and never for a locked reader', async () => {
    const { files } = filesOver(itemsOf(3));
    const tools = pagingTools(files, 3);
    const after = files.computerList([LANE.corpusId], 1, AS_OPENER).after;
    for (const args of [{}, { source_id: 'dropbox.files' }, { source_id: 'dropbox.files', after: 5 }, { source_id: 'dropbox.files', after: 'file-000.pdf' }, { source_id: 'dropbox.files', after, offset: 0 }]) {
      expect((await tools.call(UNREADABLE_FILES_PAGE_TOOL_NAME, args as Record<string, unknown>, CONTEXT)).structuredContent).toEqual({ error: 'invalid_params' });
    }
    expect((await tools.call(UNREADABLE_FILES_PAGE_TOOL_NAME, { source_id: 'dropbox.files', after }, { origin: 'http://127.0.0.1:8787' })).structuredContent).toEqual({ error: 'unavailable' });
  });
});

describe('no verdict is reused (second-round review)', () => {
  test('a listed file marked Secrets, by the secret index or by an override, is gone on the very next read', async () => {
    const lane = secretsLane();
    const items: ExtractionUnreadableItem[] = [
      { ref: ref('ordinary-new'), failedAt: '2026-10-05T00:00:00.000Z' },
      { ref: ref('ordinary-old'), failedAt: '2026-10-01T00:00:00.000Z' },
    ];
    // A clock that never moves: nothing may be reused within any window.
    const files = createUnreadableFiles({
      items: () => items,
      verdict: verdictFor(lane),
      locate: (item) => ({ locatorUri: `dropbox://id:${item.providerItemId}` }),
      openTarget: () => ({ url: 'https://www.dropbox.com/preview/Work/x.pdf' }),
      now: () => Date.UTC(2026, 9, 10),
    });
    expect(files.names([LANE.corpusId], 5)).toEqual(['ordinary-new.pdf', 'ordinary-old.pdf']);
    lane.secrets.record({ identity: identity('ordinary-new'), findingKinds: ['aws_access_key_id'] });
    expect(files.names([LANE.corpusId], 5)).toEqual(['ordinary-old.pdf']);
    expect(files.recheck(LANE.corpusId)).toEqual({ unreadable: 1, blocked: 1 });
    lane.ledger.setOverride(identity('ordinary-old'), { kind: 'tier', tier: 'secrets' });
    expect(files.names([LANE.corpusId], 5)).toEqual([]);
    expect(files.computerList([LANE.corpusId], 10, AS_OPENER).files).toEqual([]);
    expect(files.recheck(LANE.corpusId)).toEqual({ unreadable: 0, blocked: 2 });
  });
});

describe('tokens bind to the control session (P2b)', () => {
  test('a panel tool call under the control session carries that session to the worker; a forged one is stripped', async () => {
    const seen: Request[] = [];
    const origin = 'http://127.0.0.1:17777';
    const fetch = withWorkerBearerAuth(async (request) => {
      seen.push(request);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }, { authToken: 'worker-secret' });
    const mint = await fetch(new Request(`${origin}/dashboard/control/session`, { method: 'POST', headers: { Authorization: 'Bearer worker-secret', Origin: origin } }));
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const { csrf_token: csrf } = await mint.json() as { csrf_token: string };
    const call = (headers: Record<string, string>) => fetch(new Request(`${origin}/dashboard/tools/call`, { method: 'POST', headers: { Origin: origin, ...headers }, body: '{}' }));
    expect((await call({ Cookie: cookie, 'X-Olympus-CSRF': csrf })).status).toBe(200);
    expect(seen.at(-1)!.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)).toBe(csrf);
    // The bearer (the OpenClaw gateway) carries no session; a forged one never arrives.
    expect((await call({ Authorization: 'Bearer worker-secret', [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: 'forged' })).status).toBe(200);
    expect(seen.at(-1)!.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)).toBeNull();
  });
});
