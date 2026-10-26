// The release check's archive-import leg (scripts/release-check/archive-leg.ts): what it reads off the product, and what it fails on.
//
// Three kinds of test. The words and the parsers are held to what the product writes (its own vocabulary, and its own agent status).
// The evaluators are given a good observation, which passes, and one fault at a time, each of which must fail the check that guards it,
// so a broken install cannot pass and a good one cannot fail on the leg's own say-so. The journeys are run against the product's real
// dashboard panel in a DOM, through the same page-side script the machine's browser runs: every control the leg presses and every
// sentence it waits for is the product's actual markup, and a fault in the page (a row that never settles, a remove that leaves the row)
// fails the journey that guards it. Every name and path here is invented.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  type ComputerArchiveEntry,
  type ComputerArchivesMeta,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { archivesOpenTarget, createArchiveImportAgent } from '../src/workers/archive-import/agent.ts';
import { previewDashboardToolResult } from '../scripts/dashboard-preview.ts';
import { FIXTURE_FOLDER, legFixture, type LegFixture } from '../scripts/release-check/archive-fixtures.ts';
import {
  ARCHIVE_BOUNDS, ARCHIVE_PANEL_PROBE, agentImportJourney, agentViewProblems, changedChecks, datesWord, drainBoundS, drainChecks, expectedGapLines, expectedHeadings, expectedLists, expectedSeeLabel,
  gapSentence, heldOffChecks, heldSentenceOf, importChecks, judgedLineOf, messagesWord, modelChecks, panelArchivesOf, pickerImportJourney, removalLabel, removeChecks,
  removeJourney, rowNamed, rowProblems, searchChecks, startViewOf, statusViewOf, stoppedJourney,
  type AgentArchiveView, type ChangedObservation, type DrainView, type ImportObservation, type ModelObservation, type RemoveObservation, type RowView,
  type SearchView, type StatusView, type StoreView,
} from '../scripts/release-check/archive-leg.ts';
import { egressVerdict } from '../scripts/release-check/inbox.ts';
import { runJourney, type Journey, type JourneyTrace } from '../scripts/release-check/journey.ts';
import { PANEL_IDS, PanelDriver, closeWindows, dashboardAnswer, entryFor, evalIn, live, mountPanel, settle, uploadTools, type Serve } from './helpers/release-check-panel.ts';
import { DASHBOARD_CHATGPT_PAGE_COPY as PANEL } from '../src/workers/dashboard/vocabulary.ts';

const fill = (template: string, values: Record<string, string>): string => Object.entries(values).reduce((out, [key, value]) => out.split(`{${key}}`).join(value), template);

const SEED = 'seed-leg';
const agentFx = legFixture('agent', SEED);
const pickerFx = legFixture('picker', SEED);
const heldFx = legFixture('held', SEED);
const tgFx = legFixture('agent', SEED, 'telegram_json');

// ---------------------------------------------------------------------------
// Words, held to the product's own vocabulary

describe('the words the leg expects', () => {
  test('counts, gap lines and days are the dashboard\'s own sentences', () => {
    expect(messagesWord(1)).toBe(A.nouns.email.one);
    expect(messagesWord(4)).toBe(fill(A.nouns.email.many, { n: '4' }));
    expect(messagesWord(12_345)).toBe(fill(A.nouns.email.many, { n: '12,345' }));
    // What the items are called follows the format's family: chat items are messages too, a note family's are notes.
    expect(messagesWord(5, 'chat')).toBe(fill(A.nouns.chat.many, { n: '5' }));
    expect(messagesWord(1, 'chat')).toBe(A.nouns.chat.one);
    expect(messagesWord(3, 'note')).toBe(fill(A.nouns.note.many, { n: '3' }));
    expect(gapSentence('attachments_not_read', 1)).toBe(A.gaps.attachments_not_read.one);
    expect(gapSentence('spam_or_trash', 30)).toBe(fill(A.gaps.spam_or_trash.many, { n: '30' }));
    expect(gapSentence('a_kind_nobody_wrote_words_for', 2)).toBe(fill(A.gaps.other.many, { n: '2' }));
    expect(datesWord({ earliest: '2024-03-04', latest: '2024-03-09' })).toBe(fill(A.dates, { earliest: '2024-03-04', latest: '2024-03-09' }));
    expect(datesWord({ earliest: '2024-03-04', latest: '2024-03-04' })).toBe('2024-03-04');
    // Mail has nothing under How it was read: Spam and Trash left out is mail Olympus does not have.
    expect(expectedLists(agentFx.expect)).toEqual({ notImported: [A.gaps.attachments_not_read.one, A.gaps.spam_or_trash.one], howRead: [] });
    expect(expectedGapLines(agentFx.expect)).toEqual([A.gaps.attachments_not_read.one, A.gaps.spam_or_trash.one]);
    expect(expectedGapLines(heldFx.expect)).toEqual([]);
    // The button is named by which of the two lists a row has.
    expect(expectedSeeLabel(agentFx.expect)).toBe(A.seeWhy.notImported);
    expect(expectedSeeLabel(heldFx.expect)).toBe(A.seeWhy.notImported);
    expect(expectedHeadings(agentFx.expect)).toEqual([A.lists.notImported]);
    expect(expectedHeadings(heldFx.expect)).toEqual([]);
  });

  test('a Telegram export is held to the dashboard\'s exact words: one file not imported, then one message with nothing in it under how it was read', () => {
    expect(tgFx.expect).toMatchObject({
      label: 'Telegram Desktop export (JSON)', citationLabel: 'Telegram', family: 'chat', messages: 7, earliest: '2024-03-04', latest: '2024-03-09',
    });
    expect(expectedLists(tgFx.expect)).toEqual({
      notImported: ['1 picture, recording or other file the archive refers to was not imported'],
      howRead: ['1 message with nothing to read (no text, picture or file) left out'],
    });
    expect(expectedSeeLabel(tgFx.expect)).toBe(A.seeWhy.both);
    expect(expectedHeadings(tgFx.expect)).toEqual([A.lists.notImported, A.lists.howRead]);
    expect(messagesWord(tgFx.expect.messages, tgFx.expect.family)).toBe('7 messages');
    expect(datesWord(tgFx.expect)).toBe('2024-03-04 to 2024-03-09');
  });

  test('the notes exports are held to the dashboard\'s exact words: notes, not messages; what is not imported, then how it was read', () => {
    const reflectFx = legFixture('agent', SEED, 'reflect-json');
    const roamFx = legFixture('agent', SEED, 'roam-json');
    expect(reflectFx.expect).toMatchObject({ label: 'Reflect notes (JSON)', citationLabel: 'Reflect', family: 'note', messages: 4, earliest: '2024-03-04', latest: '2024-03-09' });
    expect(roamFx.expect).toMatchObject({ label: 'Roam notes (JSON)', citationLabel: 'Roam', family: 'note', messages: 4, earliest: '2024-05-06', latest: '2024-05-12' });
    expect(expectedLists(reflectFx.expect)).toEqual({ notImported: ['1 note could not be read'], howRead: ['1 note with nothing written in it left out'] });
    expect(expectedLists(roamFx.expect)).toEqual({ notImported: ['1 note with a kind of content Olympus cannot read yet'], howRead: ['1 note with nothing written in it left out'] });
    for (const fx of [reflectFx, roamFx]) {
      expect(messagesWord(fx.expect.messages, fx.expect.family)).toBe('4 notes');
      // A row that counts them as messages is not the notes\' row.
      expect(rowProblems(goodRow(fx), fx.expect)).toEqual([]);
      expect(rowProblems(goodRow(fx, { text: goodRow(fx).text.replace('4 notes', '4 messages') }), fx.expect)).toEqual([`the row does not say "4 notes"`]);
    }
  });

  test('a good notes import passes each of its checks: the export\'s own row, the agent\'s view of it, and a search cited by its own name', () => {
    for (const [format, citation] of [['reflect-json', 'Reflect'], ['roam-json', 'Roam']] as const) {
      const fx = legFixture('agent', SEED, format);
      const search: SearchView = { ok: true, isError: false, evidence: [{ source: citation, hasToken: true }] };
      const drain: DrainView = { drained: true, ms: 60_000, boundMs: 900_000, last: { messages: 4, judged: 4, waiting: 0 }, privateModel: 'ready', row: goodRow(fx) };
      const checks = importChecks(goodImport(fx, 'request', { search, drain }), fx, 'macos');
      expect(failing(checks)).toEqual([]);
      expect(Object.keys(statuses(checks))).toEqual(expect.arrayContaining([
        `archive.agent.${format}.requested`, `archive.agent.${format}.imported`, `archive.agent.${format}.dashboard`, `archive.agent.${format}.agent-view`, `archive.agent.${format}.drain`, `archive.agent.${format}.search`,
      ]));
      const asMail: SearchView = { ok: true, isError: false, evidence: [{ source: 'Imported mail', hasToken: true }] };
      expect(failing(importChecks(goodImport(fx, 'request', { search: asMail }), fx, 'macos'))).toEqual([`archive.agent.${format}.search`]);
    }
  });

  test('the judged line and the reason messages wait are read back out of the product\'s own text', () => {
    expect(judgedLineOf(`Mail ${fill(A.judgedLine, { judged: '1,240', held: '10' })} more`)).toEqual({ judged: 1240, held: 10 });
    expect(judgedLineOf(fill(A.judgedLine, { judged: '0', held: '3' }))).toEqual({ judged: 0, held: 3 });
    expect(judgedLineOf('4 messages')).toBeNull();
    expect(heldSentenceOf(`x ${A.heldWhy.off} y`)).toBe('off');
    expect(heldSentenceOf(A.heldWhy.waiting)).toBe('waiting');
    expect(heldSentenceOf(A.heldWhy.ready)).toBe('ready');
    expect(heldSentenceOf('nothing about the model')).toBeNull();
  });

  test('the drain bound is the longer one on the machine with the smaller model, and shorter than the seed bound is not asked of it', () => {
    expect(drainBoundS('linux')).toBeGreaterThan(drainBoundS('macos'));
    expect(drainBoundS('macos')).toBe(ARCHIVE_BOUNDS.drainS.macos);
  });
});

// ---------------------------------------------------------------------------
// The agent's tool answers, in the product's own shape

describe('what the agent\'s tool says', () => {
  const entry = (over: Partial<ComputerArchiveEntry> = {}): ComputerArchiveEntry => ({
    id: '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60', name: agentFx.fileName, format: agentFx.expect.label, family: 'email', where: `~/${FIXTURE_FOLDER}`, status: 'imported',
    items: 4, judged: 3, held: 1, earliest: '2024-03-04', latest: '2024-03-09', startedAt: '2026-10-22T08:00:00.000Z', importedAt: '2026-10-22T09:00:00.000Z',
    gaps: [{ kind: 'attachments_not_read', count: 1 }], skipped: [{ kind: 'spam_or_trash', count: 1 }], ...over,
  });
  const statusOf = (archives: ComputerArchiveEntry[], requests: ComputerArchivesMeta['requests'] = [], privateModel: ComputerArchivesMeta['privateModel'] = 'ready'): unknown =>
    createArchiveImportAgent({ state: {} as never, requests: {} as never, view: () => ({ sourceId: 'archive.imports', archives, requests, privateModel }) }).status();

  test('status: the archive with its counts, days, gaps in the product\'s words, and the private model', () => {
    const view = statusViewOf(statusOf([entry()], [{ id: 'r1', name: 'next.mbox', where: '~', origin: 'agent', status: 'pending' }], 'waiting'), agentFx.token);
    expect(view.ok).toBe(true);
    expect(view.privateModel).toBe('waiting');
    expect(view.requestStates).toEqual(['waiting_for_approval']);
    expect(view.carriesContent).toBe(false);
    const archive = view.archives[0]!;
    expect(archive).toMatchObject({ name: agentFx.fileName, format: 'Mail (mbox)', status: 'imported', messages: 4, judged: 3, waiting: 1, earliest: '2024-03-04', latest: '2024-03-09' });
    // Both are mail Olympus does not have: the agent's list is the dashboard's Not imported, and How it was read is empty.
    expect(archive.notImported).toEqual([A.gaps.attachments_not_read.one, A.gaps.spam_or_trash.one]);
    expect(archive.howRead).toEqual([]);
    expect(agentViewProblems({ ...archive, waiting: 0 }, agentFx.expect)).toEqual([]);
  });

  test('status: a stopped import carries its code; an uncounted archive has no numbers (never zero)', () => {
    const stopped = statusViewOf(statusOf([entry({ status: 'stopped', stop: { code: 'file_changed', file: agentFx.fileName } })]), agentFx.token).archives[0]!;
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopCode).toBe('file_changed');
    const uncounted = statusViewOf(statusOf([entry({ countsUnavailable: true })]), agentFx.token).archives[0]!;
    expect(uncounted.messages).toBeUndefined();
    expect(agentViewProblems(uncounted, agentFx.expect).join(' ')).toContain('no messages');
  });

  test('status: a word of the archive in the answer is reported, and an unreadable answer is not ok', () => {
    expect(statusViewOf({ ok: true, archives: [], note: `holds ${agentFx.token}` }, agentFx.token).carriesContent).toBe(true);
    expect(statusViewOf({ ok: true, archives: [] }, '').carriesContent).toBe(false);
    expect(statusViewOf({ ok: false, code: 'archives_unreadable' }, agentFx.token).ok).toBe(false);
    expect(statusViewOf(undefined, agentFx.token)).toMatchObject({ ok: false, archives: [] });
  });

  test('start: needs_approval with a request id and where to approve, from the product\'s own open target', () => {
    const good = startViewOf({ ok: false, code: 'needs_approval', request_id: 'r1', message: 'Waiting.', open: archivesOpenTarget() }, agentFx.token);
    expect(good).toEqual({ ok: false, code: 'needs_approval', requestId: 'r1', hasOpenTarget: true, carriesContent: false });
    expect(startViewOf({ ok: false, code: 'needs_approval', request_id: 'r1', message: 'x' }, agentFx.token).hasOpenTarget).toBe(false);
    expect(startViewOf({ ok: true, status: 'checking' }, agentFx.token).code).toBe('started');
    expect(startViewOf(undefined, agentFx.token)).toMatchObject({ ok: false, code: '' });
  });

  test('the panel\'s rows and requests are read from whatever a probe returns, and junk reads as nothing', () => {
    expect(panelArchivesOf(undefined)).toEqual({ rows: [], requests: [] });
    expect(panelArchivesOf({ rows: [{ name: 5, gapLines: 'x', whyOpen: 'yes' }], requests: 'no' })).toEqual({
      rows: [{ status: '', name: '', tag: '', facts: '', text: '', gapLines: [], notImported: [], howRead: [], headings: [], whyOpen: null, buttons: [] }], requests: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Evaluators: a good observation passes; each fault fails the check that guards it

const trace = (id: string, ok = true): JourneyTrace => ({ id, title: `journey ${id}`, source: 'test', ok, steps: [], ms: 10 });

function goodRow(fx: LegFixture, over: Partial<RowView> = {}): RowView {
  const lists = expectedLists(fx.expect);
  const lines = expectedGapLines(fx.expect);
  const facts = `${fx.expect.label} · ~/${FIXTURE_FOLDER} · ${datesWord(fx.expect)}`;
  return {
    status: 'imported', name: fx.fileName, tag: A.status.imported, facts,
    text: [fx.fileName, A.status.imported, facts, messagesWord(fx.expect.messages, fx.expect.family), fill(A.judgedLine, { judged: String(fx.expect.messages), held: '0' }), ...lines].join(' '),
    gapLines: lines, notImported: lists.notImported, howRead: lists.howRead, headings: expectedHeadings(fx.expect),
    whyOpen: lines.length > 0 ? true : null, buttons: lines.length > 0 ? [expectedSeeLabel(fx.expect), A.remove] : [A.remove], ...over,
  };
}

function goodStatus(fx: LegFixture, over: Partial<AgentArchiveView> = {}, model = 'ready'): StatusView {
  return {
    ok: true, requestStates: [], privateModel: model, carriesContent: false,
    archives: [{
      id: 'a1', name: fx.fileName, format: fx.expect.label, status: 'imported', messages: fx.expect.messages, judged: fx.expect.messages, waiting: 0,
      earliest: fx.expect.earliest, latest: fx.expect.latest,
      notImported: expectedLists(fx.expect).notImported, howRead: expectedLists(fx.expect).howRead, ...over,
    }],
  };
}

const store = (tier: StoreView['tier'], over: Partial<StoreView> = {}): StoreView => ({ tier, exists: true, live: 0, tokenRows: 0, ...over });
const GOOD_EGRESS = { samples: 40, intervalMs: 150, baseline: 3, fresh: [], pageRequests: 12, pageOutside: [] };

function goodImport(fx: LegFixture, via: 'request' | 'picker', over: Partial<ImportObservation> = {}): ImportObservation {
  return {
    ok: true, role: fx.role, format: fx.format, fileName: fx.fileName, token: fx.token, via, traces: [trace(`archive-${fx.role}-${fx.format}-import`)],
    settled: true, settleMs: 5_000, row: goodRow(fx), status: goodStatus(fx), archiveId: 'a1', stores: [store('private'), store('personal', { live: fx.expect.messages, tokenRows: 3 }), store('public')],
    ...(via === 'request' ? {
      start: { ok: false, code: 'needs_approval', requestId: 'r1', hasOpenTarget: true, carriesContent: false },
      waiting: { ok: true, archives: [], requestStates: ['waiting_for_approval'], carriesContent: false },
    } : {}),
    ...over,
  };
}

const statuses = (checks: ReadonlyArray<{ id: string; status: string }>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
const failing = (checks: ReadonlyArray<{ id: string; status: string }>) => checks.filter((c) => c.status === 'fail').map((c) => c.id);

describe('an archive imported with the private model on', () => {
  test('a good agent-path import passes every check, and says what it saw', () => {
    const search: SearchView = { ok: true, isError: false, evidence: [{ source: agentFx.expect.citationLabel, hasToken: true }] };
    const drain: DrainView = { drained: true, ms: 60_000, boundMs: 900_000, last: { messages: 4, judged: 4, waiting: 0 }, privateModel: 'ready', row: goodRow(agentFx) };
    const checks = importChecks(goodImport(agentFx, 'request', { search, drain }), agentFx, 'macos');
    expect(failing(checks)).toEqual([]);
    expect(Object.keys(statuses(checks))).toEqual(expect.arrayContaining([
      'archive.agent.mbox.requested', 'journey.archive-agent-mbox-import', 'archive.agent.mbox.imported', 'archive.agent.mbox.dashboard',
      'archive.agent.mbox.agent-view', 'archive.agent.mbox.drain', 'archive.agent.mbox.search',
    ]));
  });

  test('a good Telegram import passes: its own row, the agent\'s view of it, and a search cited as "Telegram"', () => {
    const search: SearchView = { ok: true, isError: false, evidence: [{ source: 'Telegram', hasToken: true }] };
    const drain: DrainView = { drained: true, ms: 60_000, boundMs: 900_000, last: { messages: 7, judged: 7, waiting: 0 }, privateModel: 'ready', row: goodRow(tgFx) };
    const checks = importChecks(goodImport(tgFx, 'request', { search, drain }), tgFx, 'macos');
    expect(failing(checks)).toEqual([]);
    expect(Object.keys(statuses(checks))).toEqual(expect.arrayContaining([
      'archive.agent.telegram_json.requested', 'journey.archive-agent-telegram_json-import', 'archive.agent.telegram_json.imported',
      'archive.agent.telegram_json.dashboard', 'archive.agent.telegram_json.agent-view', 'archive.agent.telegram_json.drain', 'archive.agent.telegram_json.search',
    ]));
    // The mail archive's label is not the Telegram archive's: a search that cites its items as mail does not pass.
    const asMail: SearchView = { ok: true, isError: false, evidence: [{ source: 'Imported mail', hasToken: true }] };
    expect(failing(importChecks(goodImport(tgFx, 'request', { search: asMail }), tgFx, 'macos'))).toEqual(['archive.agent.telegram_json.search']);
  });

  test('a Telegram row that is wrong in one thing fails the dashboard check naming it', () => {
    const [mediaLine] = expectedLists(tgFx.expect).notImported;
    const [emptyLine] = expectedLists(tgFx.expect).howRead;
    const good = goodRow(tgFx);
    const cases: Array<[Partial<RowView>, string]> = [
      // A line in the wrong list is as wrong as a missing one: the picture belongs under Not imported.
      [{ notImported: [], howRead: [emptyLine!, mediaLine!], gapLines: [emptyLine!, mediaLine!] }, 'Not imported holds [nothing]'],
      [{ notImported: [mediaLine!, emptyLine!], howRead: [], gapLines: [mediaLine!, emptyLine!] }, 'How it was read holds [nothing]'],
      [{ howRead: [], gapLines: [mediaLine!] }, 'How it was read holds [nothing]'],
      [{ notImported: [], gapLines: [emptyLine!] }, 'Not imported holds [nothing]'],
      [{ notImported: [gapSentence('media_not_imported', 2)], gapLines: [gapSentence('media_not_imported', 2), emptyLine!] }, 'Not imported'],
      // Lines under no heading.
      [{ gapLines: [mediaLine!, emptyLine!, 'A line under no heading'] }, 'neither list'],
      [{ headings: [A.lists.howRead, A.lists.notImported] }, 'headings'],
      [{ buttons: [A.seeWhy.notImported, A.remove] }, 'the button reads'],
      [{ facts: good.facts.replace('Telegram Desktop export (JSON)', 'Mail (mbox)') }, 'format'],
      [{ facts: good.facts.replace('2024-03-04', '2023-12-30') }, 'days'],
      [{ text: good.text.replace(messagesWord(7, 'chat'), messagesWord(6, 'chat')) }, messagesWord(7, 'chat')],
    ];
    for (const [over, mention] of cases) {
      const problems = rowProblems(goodRow(tgFx, over), tgFx.expect);
      expect(problems.join(' | ')).toContain(mention);
      expect(failing(importChecks(goodImport(tgFx, 'request', { row: goodRow(tgFx, over) }), tgFx, 'macos'))).toContain('archive.agent.telegram_json.dashboard');
    }
    expect(rowProblems(good, tgFx.expect)).toEqual([]);
    // The agent's status says the same in the same words: what is not imported, and how it was read.
    expect(agentViewProblems(goodStatus(tgFx).archives[0], tgFx.expect)).toEqual([]);
    expect(agentViewProblems(goodStatus(tgFx, { howRead: [] }).archives[0], tgFx.expect).join(' ')).toContain('how-it-was-read');
    expect(agentViewProblems(goodStatus(tgFx, { notImported: [], howRead: [mediaLine!, emptyLine!] }).archives[0], tgFx.expect).join(' ')).toContain('not-imported');
    expect(agentViewProblems(goodStatus(tgFx, { notImported: [gapSentence('media_not_imported', 1)] }).archives[0], tgFx.expect)).toEqual([]);
  });

  test('a picker import has no request check and is held to the same row', () => {
    const checks = importChecks(goodImport(pickerFx, 'picker'), pickerFx, 'linux');
    expect(failing(checks)).toEqual([]);
    expect(checks.some((c) => c.id.endsWith('.requested'))).toBe(false);
  });

  test('no result from the machine fails one check that says so', () => {
    const checks = importChecks(undefined, agentFx, 'macos');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'archive.agent.mbox.ran', status: 'fail' });
    expect(checks[0]!.detail).toContain('no result');
  });

  test('what the machine\'s agent prints when it fails before it has anything to report (just ok and a detail) fails one check with that detail', () => {
    const bare = { ok: false, detail: 'the dashboard did not open' } as unknown as ImportObservation;
    const checks = importChecks(bare, agentFx, 'macos');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'archive.agent.mbox.ran', status: 'fail', detail: 'the dashboard did not open' });
    const removed = removeChecks({ ok: false, detail: 'no panel' } as unknown as RemoveObservation, [agentFx, pickerFx, heldFx]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ id: 'archive.remove.ran', status: 'fail', detail: 'no panel' });
    const changed = changedChecks({ ok: false, detail: 'no panel' } as unknown as ChangedObservation);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: 'archive.changed.stops', status: 'fail', detail: 'no panel' });
    const held = heldOffChecks({ ok: false, detail: 'no panel' } as unknown as ImportObservation, heldFx);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: 'fail', detail: 'no panel' });
  });

  test('a start that does not ask for approval, or imports before the owner approved, fails the request check', () => {
    const wrongCode = importChecks(goodImport(agentFx, 'request', { start: { ok: true, code: 'started', hasOpenTarget: false, carriesContent: false } }), agentFx, 'macos');
    expect(failing(wrongCode)).toContain('archive.agent.mbox.requested');
    const early = importChecks(goodImport(agentFx, 'request', { waiting: { ok: true, archives: goodStatus(agentFx).archives, requestStates: ['waiting_for_approval'], carriesContent: false } }), agentFx, 'macos');
    expect(failing(early)).toContain('archive.agent.mbox.requested');
    const leaky = importChecks(goodImport(agentFx, 'request', { start: { ok: false, code: 'needs_approval', requestId: 'r1', hasOpenTarget: true, carriesContent: true } }), agentFx, 'macos');
    expect(failing(leaky)).toContain('archive.agent.mbox.requested');
  });

  test('an import that never settles fails the imported check and carries the journey\'s own failure', () => {
    const checks = importChecks(goodImport(agentFx, 'request', { settled: false, row: { ...goodRow(agentFx), status: 'importing', tag: A.status.importing }, traces: [trace('archive-agent-mbox-import', false)] }), agentFx, 'macos');
    expect(failing(checks)).toEqual(expect.arrayContaining(['journey.archive-agent-mbox-import', 'archive.agent.mbox.imported']));
  });

  test('a row that is wrong in one thing fails the dashboard check naming it', () => {
    const cases: Array<[Partial<RowView>, string]> = [
      [{ facts: goodRow(agentFx).facts.replace('Mail (mbox)', 'Something else') }, 'format'],
      [{ facts: goodRow(agentFx).facts.replace('2024-03-09', '2024-03-10') }, 'days'],
      [{ text: goodRow(agentFx).text.replace(messagesWord(4), messagesWord(5)) }, messagesWord(4)],
      [{ notImported: [A.gaps.attachments_not_read.one], gapLines: [A.gaps.attachments_not_read.one] }, A.gaps.spam_or_trash.one],
      [{ gapLines: [...expectedGapLines(agentFx.expect), 'An extra line'] }, 'An extra line'],
      [{ whyOpen: false }, 'not open'],
      [{ tag: A.status.importing, status: 'importing' }, 'reads'],
    ];
    for (const [over, mention] of cases) {
      const problems = rowProblems(goodRow(agentFx, over), agentFx.expect);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join(' | ')).toContain(mention);
      const checks = importChecks(goodImport(agentFx, 'request', { row: goodRow(agentFx, over) }), agentFx, 'macos');
      expect(failing(checks)).toContain('archive.agent.mbox.dashboard');
    }
    expect(rowProblems(goodRow(agentFx), agentFx.expect)).toEqual([]);
    expect(rowProblems(goodRow(heldFx), heldFx.expect)).toEqual([]);
  });

  test('an agent status that disagrees with the dashboard, or repeats message text, fails the agent-view check', () => {
    for (const status of [
      goodStatus(agentFx, { messages: 3 }),
      goodStatus(agentFx, { format: 'Other' }),
      goodStatus(agentFx, { latest: '2024-03-10' }),
      goodStatus(agentFx, { notImported: [] }),
      goodStatus(agentFx, { howRead: ['Something else was left out.'] }),
      { ...goodStatus(agentFx), carriesContent: true },
      { ...goodStatus(agentFx), archives: [] },
    ]) {
      expect(failing(importChecks(goodImport(agentFx, 'request', { status }), agentFx, 'macos'))).toContain('archive.agent.mbox.agent-view');
    }
  });

  test('held messages that never drain, or a row that still shows a reason, fail the drain check with the bound that applied', () => {
    const stuck: DrainView = { drained: false, ms: 900_000, boundMs: 900_000, last: { messages: 4, judged: 1, waiting: 3 } };
    const checks = drainChecks('d', stuck, agentFx, 'macos', 'baseline');
    expect(failing(checks)).toEqual(['d']);
    expect(checks[0]!.detail).toContain('3 of 4');
    expect(checks[0]!.detail).toContain('900 s');
    const rowStillHeld = (text: string): DrainView => ({ drained: true, ms: 1, boundMs: 1, last: {}, row: goodRow(agentFx, { text }) });
    expect(failing(drainChecks('d', rowStillHeld(fill(A.judgedLine, { judged: '3', held: '1' })), agentFx, 'macos', 'baseline'))).toEqual(['d']);
    expect(failing(drainChecks('d', rowStillHeld(`${fill(A.judgedLine, { judged: '4', held: '0' })} ${A.heldWhy.waiting}`), agentFx, 'macos', 'baseline'))).toEqual(['d']);
    expect(failing(drainChecks('d', rowStillHeld('no judged line at all'), agentFx, 'macos', 'baseline'))).toEqual(['d']);
    expect(failing(drainChecks('d', undefined, agentFx, 'macos', 'baseline'))).toEqual(['d']);
  });

  test('a restored drain must see the model as back on', () => {
    const drain: DrainView = { drained: true, ms: 1, boundMs: 1, last: { messages: heldFx.expect.messages, waiting: 0 }, privateModel: 'off', row: goodRow(heldFx) };
    expect(failing(drainChecks('d', drain, heldFx, 'linux', 'restored'))).toEqual(['d']);
    expect(failing(drainChecks('d', { ...drain, privateModel: 'ready' }, heldFx, 'linux', 'restored'))).toEqual([]);
  });

  test('a drain is proven only by a readable row and the agent\'s own counts', () => {
    const drained: DrainView = { drained: true, ms: 1, boundMs: 1, last: { messages: heldFx.expect.messages, waiting: 0 }, privateModel: 'ready', row: goodRow(heldFx) };
    const { row: _row, ...noRow } = drained;
    const unread = drainChecks('d', noRow, heldFx, 'linux', 'restored');
    expect(failing(unread)).toEqual(['d']);
    expect(unread[0]!.detail).toContain('the dashboard row could not be read');
    const fewer = drainChecks('d', { ...drained, last: { messages: heldFx.expect.messages - 1, waiting: 0 } }, heldFx, 'linux', 'restored');
    expect(failing(fewer)).toEqual(['d']);
    expect(fewer[0]!.detail).toContain(`expected 0 of ${heldFx.expect.messages}`);
    expect(failing(drainChecks('d', { ...drained, last: {} }, heldFx, 'linux', 'restored'))).toEqual(['d']);
  });

  test('a search must return the archive\'s word under its citation label', () => {
    const cited: SearchView = { ok: true, isError: false, evidence: [{ source: 'Mail', hasToken: false }, { source: agentFx.expect.citationLabel, hasToken: true }] };
    expect(failing(searchChecks('p', cited, agentFx, 'cited'))).toEqual([]);
    for (const search of [
      undefined,
      { ok: false, isError: true, evidence: [], error: 'boom' },
      { ok: true, isError: false, evidence: [] },
      { ok: true, isError: false, evidence: [{ source: agentFx.expect.citationLabel, hasToken: false }] },
      { ok: true, isError: false, evidence: [{ source: 'Mail', hasToken: true }] },
    ] as Array<SearchView | undefined>) {
      expect(failing(searchChecks('p', search, agentFx, 'cited'))).toEqual(['p.search']);
    }
  });
});

describe('an archive imported with the private model off', () => {
  const held = (over: Partial<ImportObservation> = {}): ImportObservation => goodImport(heldFx, 'request', {
    row: goodRow(heldFx, {
      text: [heldFx.fileName, A.status.imported, messagesWord(3), fill(A.judgedLine, { judged: '0', held: '3' }), A.heldWhy.off].join(' '),
      buttons: [A.remove, A.setUpPrivateModel],
    }),
    status: goodStatus(heldFx, { judged: 0, waiting: 3 }, 'off'),
    stores: [store('private', { live: 3, tokenRows: 6 }), store('personal'), store('public')],
    search: { ok: true, isError: false, evidence: [] },
    egress: GOOD_EGRESS,
    ...over,
  });

  test('a good held import passes: held Private, the way to set it up, nothing lower, nothing found, nothing sent', () => {
    expect(failing(heldOffChecks(held(), heldFx))).toEqual([]);
    expect(Object.keys(statuses(heldOffChecks(held(), heldFx)))).toEqual(expect.arrayContaining([
      'archive.held.mbox.held', 'archive.held.mbox.stores', 'archive.held.mbox.search', 'archive.held.mbox.stays-here',
    ]));
  });

  test('content in the Personal or Public store, or none in the Private one, fails the stores check', () => {
    for (const stores of [
      [store('private', { tokenRows: 6 }), store('personal', { tokenRows: 1 }), store('public')],
      [store('private', { tokenRows: 6 }), store('personal'), store('public', { tokenRows: 2 })],
      [store('private'), store('personal'), store('public')],
      [],
      [store('private', { tokenRows: 6, error: 'database is locked' }), store('personal'), store('public')],
    ]) {
      expect(failing(heldOffChecks(held({ stores }), heldFx))).toEqual(['archive.held.mbox.stores']);
    }
  });

  test('a row that does not say held, or the model not seen as off, fails the held check', () => {
    const text = (extra: string) => [heldFx.fileName, messagesWord(3), extra].join(' ');
    for (const over of [
      { row: goodRow(heldFx, { text: text(`${fill(A.judgedLine, { judged: '0', held: '3' })} ${A.heldWhy.ready}`), buttons: [A.setUpPrivateModel] }) },
      { row: goodRow(heldFx, { text: text(`${fill(A.judgedLine, { judged: '2', held: '1' })} ${A.heldWhy.off}`), buttons: [A.setUpPrivateModel] }) },
      { row: goodRow(heldFx, { text: text(`${fill(A.judgedLine, { judged: '0', held: '3' })} ${A.heldWhy.off}`), buttons: [A.remove] }) },
      { status: goodStatus(heldFx, {}, 'ready') },
    ]) {
      expect(failing(heldOffChecks(held(over), heldFx))).toEqual(['archive.held.mbox.held']);
    }
  });

  test('a search that finds the content while it is held fails; so does a search that was not made', () => {
    expect(failing(heldOffChecks(held({ search: { ok: true, isError: false, evidence: [{ source: heldFx.expect.citationLabel, hasToken: true }] } }), heldFx))).toEqual(['archive.held.mbox.search']);
    const unsearched = held();
    delete unsearched.search;
    expect(failing(heldOffChecks(unsearched, heldFx))).toEqual(['archive.held.mbox.search']);
  });

  test('a new connection, a page request outside the machine, or no watch at all fails the stays-here check', () => {
    for (const egress of [
      { ...GOOD_EGRESS, fresh: ['203.0.113.7:443'] },
      { ...GOOD_EGRESS, pageOutside: ['https://example.invalid/x'] },
      { ...GOOD_EGRESS, samples: 0 },
    ]) {
      expect(failing(heldOffChecks(held({ egress }), heldFx))).toEqual(['archive.held.mbox.stays-here']);
    }
    const unwatched = held();
    delete unwatched.egress;
    expect(failing(heldOffChecks(unwatched, heldFx))).toEqual(['archive.held.mbox.stays-here']);
    // The rule is the inbox leg's own.
    expect(egressVerdict(GOOD_EGRESS).ok).toBe(true);
  });
});

describe('Remove', () => {
  // Two archives of the agent role, of different formats, as the run has them; each is judged on its own format's stores.
  const fixtures = [agentFx, tgFx, pickerFx, heldFx];
  const sameOne = (a: LegFixture, b: LegFixture): boolean => a.role === b.role && a.format === b.format;
  const removal = (fx: LegFixture, over: Partial<RemoveObservation['removals'][number]> = {}): RemoveObservation['removals'][number] => ({
    role: fx.role, format: fx.format, fileName: fx.fileName, archiveId: 'a1', traces: [trace(`archive-${removalLabel(fx)}-remove`)], gone: true, goneMs: 3_000, unlisted: true,
    stores: [store('private'), store('personal'), store('public')],
    others: fixtures.filter((other) => !sameOne(other, fx)).map((other) => ({ role: other.role, format: other.format, fileName: other.fileName, stores: [store('private', { tokenRows: 4 })] })),
    ...over,
  });
  const observation = (over: Partial<RemoveObservation['removals'][number]> = {}, which: LegFixture = agentFx): RemoveObservation =>
    ({ ok: true, removals: fixtures.map((fx) => removal(fx, sameOne(fx, which) ? over : {})) });

  test('a good removal passes for every archive, each under its own format', () => {
    const checks = removeChecks(observation(), fixtures);
    expect(failing(checks)).toEqual([]);
    expect(checks.filter((c) => c.id.endsWith('.removed')).map((c) => c.id)).toEqual([
      'archive.agent.mbox.removed', 'archive.agent.telegram_json.removed', 'archive.picker.mbox.removed', 'archive.held.mbox.removed',
    ]);
    // The two archives of one role do not share a journey, so neither can pass for the other.
    expect(removalLabel(agentFx)).toBe('agent');
    expect(removalLabel(tgFx)).toBe('agent-telegram_json');
    expect(checks.filter((c) => c.id.startsWith('journey.')).map((c) => c.id)).toContain('journey.archive-agent-telegram_json-remove');
    expect(checks.find((c) => c.id === 'archive.agent.telegram_json.removed')!.detail).toContain(agentFx.fileName);
  });

  test('a row still on the page, an archive still listed, live items or content left in a store each fail it', () => {
    for (const fx of [agentFx, tgFx]) {
      for (const over of [
        { gone: false },
        { unlisted: false },
        { stores: [store('private', { live: 2 }), store('personal'), store('public')] },
        { stores: [store('private'), store('personal', { tokenRows: 1 }), store('public')] },
        { stores: [] },
        { stores: [store('private', { error: 'locked' }), store('personal'), store('public')] },
      ]) {
        // Only the archive that was wrong fails, even when another archive of the same role is fine.
        expect(failing(removeChecks(observation(over, fx), fixtures))).toEqual([`archive.${fx.role}.${fx.format}.removed`]);
      }
    }
  });

  test('removing one archive must not take another\'s content, whatever its format', () => {
    for (const taken of [pickerFx, tgFx]) {
      const took = observation({ others: [{ role: taken.role, format: taken.format, fileName: taken.fileName, stores: [store('private')] }] });
      expect(failing(removeChecks(took, fixtures))).toEqual(['archive.agent.mbox.removed']);
    }
    const tgTook = observation({ others: [{ role: agentFx.role, format: agentFx.format, fileName: agentFx.fileName, stores: [store('private')] }] }, tgFx);
    expect(failing(removeChecks(tgTook, fixtures))).toEqual(['archive.agent.telegram_json.removed']);
  });

  test('a failed removal journey fails with it, and an archive nobody tried to remove is named', () => {
    const failedJourney = observation({ traces: [trace('archive-agent-remove', false)], gone: false });
    expect(failing(removeChecks(failedJourney, fixtures))).toEqual(expect.arrayContaining(['journey.archive-agent-remove', 'archive.agent.mbox.removed']));
    const partial: RemoveObservation = { ok: true, removals: [removal(agentFx)] };
    const checks = removeChecks(partial, fixtures);
    expect(failing(checks)).toEqual(['archive.remove.ran']);
    expect(checks.find((c) => c.id === 'archive.remove.ran')!.detail).toContain(pickerFx.fileName);
    // The Telegram archive was not removed, though another archive of its role was: it is named, not covered by the mail one.
    const onlyMail: RemoveObservation = { ok: true, removals: [removal(agentFx), removal(pickerFx), removal(heldFx)] };
    const missingTg = removeChecks(onlyMail, fixtures).find((c) => c.id === 'archive.remove.ran')!;
    expect(missingTg.status).toBe('fail');
    expect(missingTg.detail).toContain(tgFx.fileName);
    expect(missingTg.detail).not.toContain(agentFx.fileName);
    expect(failing(removeChecks(undefined, fixtures))).toEqual(['archive.remove.ran']);
  });
});

describe('a file that changes while it is imported', () => {
  const stoppedRow = (): RowView => ({ status: 'stopped', name: 'rc-bulk-8000.mbox', tag: A.status.stopped, facts: '', text: 'rc-bulk-8000.mbox', gapLines: [], notImported: [], howRead: [], headings: [], whyOpen: null, buttons: [A.remove] });
  const stoppedStatus = (code = 'file_changed'): StatusView => ({
    ok: true, requestStates: [], carriesContent: false,
    archives: [{ id: 'b1', name: 'rc-bulk-8000.mbox', format: 'Mail (mbox)', status: 'stopped', stopCode: code, notImported: [], howRead: [] }],
  });
  const good = (over: Partial<ChangedObservation> = {}): ChangedObservation => ({
    ok: true, fileName: 'rc-bulk-8000.mbox', traces: [trace('archive-bulk-8000-approve'), trace('archive-bulk-stopped')],
    attempts: [{ messages: 8_000, outcome: 'changed', detail: 'a message was added while 1000 messages were read' }],
    row: stoppedRow(), status: stoppedStatus(), removed: { gone: true, unlisted: true, stores: [store('private'), store('personal'), store('public')] }, ...over,
  });

  test('a stop the dashboard and the agent both show, then removed with its rows, passes', () => {
    expect(failing(changedChecks(good()))).toEqual([]);
  });

  test('a larger archive is tried when the first finishes before the file can be changed', () => {
    const second = good({ attempts: [{ messages: 8_000, outcome: 'finished-first', detail: 'finished' }, { messages: 40_000, outcome: 'changed', detail: 'changed' }] });
    expect(failing(changedChecks(second))).toEqual([]);
  });

  test('never catching an import in progress fails, naming each attempt', () => {
    const base = good({ attempts: [{ messages: 8_000, outcome: 'finished-first', detail: 'finished' }, { messages: 40_000, outcome: 'finished-first', detail: 'finished' }] });
    delete base.row;
    delete base.status;
    delete base.removed;
    const none = changedChecks(base);
    expect(failing(none)).toEqual(['archive.changed.stops']);
    expect(none.find((c) => c.id === 'archive.changed.stops')!.detail).toContain('8000 messages finished-first');
    expect(failing(changedChecks(undefined))).toEqual(['archive.changed.stops']);
  });

  test('a row that does not read Stopped, or a stop that is not file_changed, fails', () => {
    expect(failing(changedChecks(good({ row: { ...stoppedRow(), status: 'importing', tag: A.status.importing } })))).toEqual(['archive.changed.stops']);
    expect(failing(changedChecks(good({ status: stoppedStatus('file_missing') })))).toEqual(['archive.changed.stops']);
    expect(failing(changedChecks(good({ traces: [trace('archive-bulk-stopped', false)] })))).toEqual(['journey.archive-bulk-stopped']);
  });

  test('a stopped archive that Remove leaves behind fails the clean-up check', () => {
    expect(failing(changedChecks(good({ removed: { gone: false, unlisted: true, stores: [] } })))).toEqual(['archive.changed.removed']);
    expect(failing(changedChecks(good({ removed: { gone: true, unlisted: true, stores: [store('private', { live: 5 })] } })))).toEqual(['archive.changed.removed']);
  });

  test('a removal check without evidence fails: no store read, or a store that could not be read', () => {
    const unread = changedChecks(good({ removed: { gone: true, unlisted: true, stores: [] } }));
    expect(failing(unread)).toEqual(['archive.changed.removed']);
    expect(unread.find((c) => c.id === 'archive.changed.removed')!.detail).toContain('the stores were not read');
    const broken = changedChecks(good({ removed: { gone: true, unlisted: true, stores: [store('private'), store('personal', { error: 'database is locked' })] } }));
    expect(failing(broken)).toEqual(['archive.changed.removed']);
    expect(broken.find((c) => c.id === 'archive.changed.removed')!.detail).toContain('the personal store could not be read: database is locked');
  });
});

describe('the private model switch', () => {
  const ready = (over: Partial<ModelObservation> = {}): ModelObservation => ({ ok: true, mode: 'off', readyMs: 90_000, privateModel: 'off', ...over });

  test('off must read off on the agent\'s side; on must not', () => {
    expect(failing(modelChecks(ready(), 'off'))).toEqual([]);
    expect(failing(modelChecks(ready({ privateModel: 'ready' }), 'off'))).toEqual(['archive.model-off']);
    expect(failing(modelChecks(ready({ mode: 'on', privateModel: 'ready' }), 'on'))).toEqual([]);
    expect(failing(modelChecks(ready({ mode: 'on', privateModel: 'off' }), 'on'))).toEqual(['archive.model-on']);
  });

  test('an engine that did not come back, or no answer at all, fails with the machine\'s reason', () => {
    const checks = modelChecks({ ok: false, mode: 'off', detail: 'the engine was not ready within 420 s' }, 'off');
    expect(failing(checks)).toEqual(['archive.model-off']);
    expect(checks[0]!.detail).toContain('420 s');
    expect(failing(modelChecks(undefined, 'on'))).toEqual(['archive.model-on']);
  });
});

// ---------------------------------------------------------------------------
// The journeys, run on the product's real panel

/** The row once the panel has drawn it, as a journey waits for it: the panel renders after its first answer, later on a loaded machine. */
async function rowOnPanel(driver: PanelDriver, name: string, waitMs = 5_000): Promise<ReturnType<typeof rowNamed>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = rowNamed(panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE)), name);
    if (row || Date.now() > deadline) return row;
    await settle(20);
  }
}

async function runOn(serve: Serve, journey: Journey): Promise<{ trace: JourneyTrace; driver: PanelDriver }> {
  const driver = new PanelDriver(async () => (await mountPanel(serve)).win);
  await driver.go();
  return { trace: await runJourney(driver, journey, live), driver };
}

afterEach(closeWindows);

describe('the leg\'s journeys on the product\'s real panel', () => {
  const requestFor = (fx: LegFixture, path: string): ComputerArchivesMeta['requests'] => [{ id: 'req-1', name: fx.fileName, where: `~/${FIXTURE_FOLDER}`, path, origin: 'agent', status: 'pending' }];

  test('the agent path: the owner sees the request, presses Import, the row settles, the See button lists what was not imported and how it was read', async () => {
    const path = `/Users/you/${FIXTURE_FOLDER}/${agentFx.fileName}`;
    let archives: ComputerArchiveEntry[] = [];
    let requests = requestFor(agentFx, `~/${FIXTURE_FOLDER}/${agentFx.fileName}`);
    const approvals: unknown[] = [];
    const serve: Serve = {
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer(archives, requests),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => {
        approvals.push(args);
        requests = [];
        archives = [entryFor(agentFx)];
        return { content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: agentFx.fileName } };
      },
    };
    // The page shows the path the agent asked for, as the owner reads it; the journey is given the same text.
    const journey = agentImportJourney(agentFx, `~/${FIXTURE_FOLDER}/${agentFx.fileName}`, { startS: 4, settleS: 4 });
    const { trace, driver } = await runOn(serve, journey);
    expect(trace.steps.map((step) => `${step.ok ? 'ok' : 'FAILED'} ${step.name}`)).toEqual(journey.steps.map((step) => `ok ${step.name}`));
    expect(trace.ok).toBe(true);
    expect(approvals).toEqual([{ request_id: 'req-1' }]);
    // The same page, read the way the machine reads it, is what the evaluators were written for.
    const row = rowNamed(panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE)), agentFx.fileName)!;
    expect(row).toBeDefined();
    expect(rowProblems(row, agentFx.expect)).toEqual([]);
    expect(path).toContain(agentFx.fileName);
  });

  test('the agent path for a Telegram export, with a mail archive already listed: its row has the exact gap lines, and the evaluators accept it as the page shows it', async () => {
    const listed = entryFor(agentFx);
    let archives: ComputerArchiveEntry[] = [listed];
    let requests = requestFor(tgFx, `~/${FIXTURE_FOLDER}/${tgFx.fileName}`);
    const approvals: unknown[] = [];
    const serve: Serve = {
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer(archives, requests),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => {
        approvals.push(args);
        requests = [];
        archives = [listed, entryFor(tgFx)];
        return { content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: tgFx.fileName } };
      },
    };
    const journey = agentImportJourney(tgFx, `~/${FIXTURE_FOLDER}/${tgFx.fileName}`, { startS: 4, settleS: 4 });
    const { trace, driver } = await runOn(serve, journey);
    expect(trace.steps.filter((step) => !step.ok).map((step) => `${step.name}: expected ${step.expected}; got ${step.actual}`).join(' || ')).toBe('');
    expect(trace.ok).toBe(true);
    expect(approvals).toEqual([{ request_id: 'req-1' }]);
    const panel = panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE));
    const row = rowNamed(panel, tgFx.fileName)!;
    expect(row).toBeDefined();
    expect(rowProblems(row, tgFx.expect)).toEqual([]);
    expect(row.notImported).toEqual(['1 picture, recording or other file the archive refers to was not imported']);
    expect(row.howRead).toEqual(['1 message with nothing to read (no text, picture or file) left out']);
    expect(row.headings).toEqual([A.lists.notImported, A.lists.howRead]);
    expect(row.facts).toContain('Telegram Desktop export (JSON)');
    // The mail archive beside it keeps its own row, with its own lines (its See button was not pressed).
    expect(rowNamed(panel, agentFx.fileName)!.gapLines).toEqual(expectedGapLines(agentFx.expect));
  });

  test('the Telegram removal journey presses Remove on its own row and leaves the mail archive listed', async () => {
    const mail = entryFor(agentFx);
    const chat = entryFor(tgFx);
    let archives: ComputerArchiveEntry[] = [mail, chat];
    const removals: unknown[] = [];
    const serve: Serve = {
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer(archives),
      [ARCHIVE_REMOVE_TOOL_NAME]: (args: { archive_id: string }) => {
        removals.push(args);
        archives = archives.filter((entry) => entry.id !== args.archive_id);
        return { content: [{ type: 'text', text: 'Removing.' }], structuredContent: { ok: true } };
      },
    };
    const { trace, driver } = await runOn(serve, removeJourney(removalLabel(tgFx), tgFx.fileName, 4, 4));
    expect(trace.id).toBe('archive-agent-telegram_json-remove');
    expect(trace.ok).toBe(true);
    expect(removals).toEqual([{ archive_id: chat.id }]);
    expect(chat.id).not.toBe(mail.id);
    expect(panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE)).rows.map((row) => row.name)).toEqual([agentFx.fileName]);
  });

  test('the agent path fails when the request is not on the page, and when the row never reaches Imported', async () => {
    const empty = await runOn({ [DASHBOARD_TOOL_NAME]: () => dashboardAnswer([], []) }, agentImportJourney(agentFx, `~/${FIXTURE_FOLDER}/${agentFx.fileName}`, { openS: 1, startS: 1, settleS: 1 }));
    expect(empty.trace.ok).toBe(false);
    expect(empty.trace.steps.find((step) => !step.ok)!.name).toContain('request is waiting');
    const importing = entryFor(agentFx, { status: 'importing', percent: 10 });
    const stuck = await runOn({
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer([importing], requestFor(agentFx, `~/${FIXTURE_FOLDER}/${agentFx.fileName}`)),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: agentFx.fileName } }),
    }, agentImportJourney(agentFx, `~/${FIXTURE_FOLDER}/${agentFx.fileName}`, { openS: 3, startS: 3, settleS: 1 }));
    expect(stuck.trace.ok).toBe(false);
    expect(stuck.trace.steps.find((step) => !step.ok)!.name).toContain('settles');
  });

  test('the drop zone: Import an archive, the file chosen in its file input, and the row settles', async () => {
    let archives: ComputerArchiveEntry[] = [];
    const approvals: Array<{ upload_id?: string }> = [];
    const drop = uploadTools();
    const dir = mkdtempSync(join(tmpdir(), 'rc-drop-'));
    const path = join(dir, pickerFx.fileName);
    writeFileSync(path, 'Takeout');
    const serve: Serve = {
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer(archives),
      ...drop.serve,
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => {
        approvals.push(args);
        archives = [entryFor(pickerFx)];
        return { content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: drop.nameOf(String(args.upload_id)) } };
      },
    };
    const journey = pickerImportJourney(pickerFx, path, { startS: 4, settleS: 4 });
    const { trace, driver } = await runOn(serve, journey).finally(() => rmSync(dir, { recursive: true, force: true }));
    expect(trace.steps.filter((step) => !step.ok).map((step) => `${step.name}: expected ${step.expected}; got ${step.actual}`).join(' || ')).toBe('');
    expect(trace.ok).toBe(true);
    // The file travelled as an upload under its own name, and the approval named that upload: no path of this computer crossed.
    expect([...drop.uploads.values()]).toEqual([[pickerFx.fileName]]);
    expect(approvals).toEqual([{ upload_id: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
    const row = rowNamed(panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE)), pickerFx.fileName)!;
    expect(rowProblems(row, pickerFx.expect, 'picker')).toEqual([]);
  });

  test('the picker journey fails when an archive is already listed (its button has moved into a menu)', async () => {
    const { trace } = await runOn({ [DASHBOARD_TOOL_NAME]: () => dashboardAnswer([entryFor(agentFx)]) }, pickerImportJourney(pickerFx, '/unused', { openS: 1, startS: 1, settleS: 1 }));
    expect(trace.ok).toBe(false);
    expect(trace.steps[0]!.ok).toBe(false);
  });

  test('Remove: it asks first in the archive\'s name, and the row goes once confirmed', async () => {
    let archives = [entryFor(agentFx), entryFor(pickerFx)];
    const removals: unknown[] = [];
    const serve: Serve = {
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer(archives),
      [ARCHIVE_REMOVE_TOOL_NAME]: (args) => {
        removals.push(args);
        archives = archives.filter((entry) => entry.id !== args.archive_id);
        return { content: [{ type: 'text', text: 'Removing.' }], structuredContent: { ok: true } };
      },
    };
    const { trace, driver } = await runOn(serve, removeJourney('agent', agentFx.fileName, 4, 4));
    expect(trace.steps.filter((step) => !step.ok).map((step) => `${step.name}: expected ${step.expected}; got ${step.actual}`).join(' || ')).toBe('');
    expect(removals).toEqual([{ archive_id: PANEL_IDS.agent }]);
    // Only that archive's row went.
    const rows = panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE)).rows.map((row) => row.name);
    expect(rows).toEqual([pickerFx.fileName]);
    expect(PANEL.confirm).toContain('{label}');
  });

  test('Remove fails when the row stays after the owner confirms', async () => {
    const serve: Serve = {
      [DASHBOARD_TOOL_NAME]: () => dashboardAnswer([entryFor(agentFx)]),
      [ARCHIVE_REMOVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Removing.' }], structuredContent: { ok: true } }),
    };
    const { trace } = await runOn(serve, removeJourney('agent', agentFx.fileName, 1, 3));
    expect(trace.ok).toBe(false);
    expect(trace.steps.find((step) => !step.ok)!.name).toContain('the row goes');
  });

  test('the stopped journey: the stopped row, the product\'s sentence naming the file, what to do, the Needs you line, Remove', async () => {
    // The preview's stopped state carries the card the engine builds for a stopped import (its Needs you line), with the changed file named.
    const preview = previewDashboardToolResult('archives-stopped', false) as { _meta: Record<string, any> };
    const listed = preview._meta[COMPUTER_META_KEY].archives.archives[0] as ComputerArchiveEntry;
    const { trace } = await runOn({ [DASHBOARD_TOOL_NAME]: () => preview }, stoppedJourney('bulk', listed.name, 3));
    expect(trace.steps.filter((step) => !step.ok).map((step) => `${step.name}: expected ${step.expected}; got ${step.actual}`).join(' || ')).toBe('');
    expect(trace.ok).toBe(true);
  });

  test('the stopped journey fails on an import that is only importing', async () => {
    const importing = entryFor(agentFx, { status: 'importing', percent: 5 });
    const { trace } = await runOn({ [DASHBOARD_TOOL_NAME]: () => dashboardAnswer([importing]) }, stoppedJourney('bulk', agentFx.fileName, 1));
    expect(trace.ok).toBe(false);
  });

  test('the probe reads a held row as the held evaluators expect it, with the way to set up the private model', async () => {
    const heldEntry = entryFor(heldFx, { judged: 0, held: heldFx.expect.messages });
    const driver = new PanelDriver(async () => (await mountPanel({ [DASHBOARD_TOOL_NAME]: () => dashboardAnswer([heldEntry], [], 'off') })).win);
    await driver.go();
    const row = (await rowOnPanel(driver, heldFx.fileName))!;
    expect(row).toBeDefined();
    expect(judgedLineOf(row.text)).toEqual({ judged: 0, held: heldFx.expect.messages });
    expect(heldSentenceOf(row.text)).toBe('off');
    expect(row.buttons).toContain(A.setUpPrivateModel);
    expect(rowProblems(row, heldFx.expect)).toEqual([]);
    // A row for an archive that is not on the page reads as absent, not as a row of zeros.
    expect(rowNamed(panelArchivesOf(evalIn(driver.win, ARCHIVE_PANEL_PROBE)), 'not-there.mbox')).toBeUndefined();
  });
});
