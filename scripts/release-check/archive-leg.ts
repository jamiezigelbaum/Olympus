/**
 * The release check's archive-import leg: what the in-machine agent sees of an imported archive, and the checks made of it.
 *
 * The leg walks the whole life of an archive on a fresh install, the way its owner meets it:
 *   - An agent asks to import a file (`olympus archive start --path`, the CLI form of the `archive_import` tool that agents reach over
 *     stdio MCP: the engine's remote endpoint does not offer it). The answer is `needs_approval` and a request; nothing is read yet.
 *     The owner approves in the dashboard on the computer, with a real press of the request's Import (the route a bearer holder
 *     cannot use: archive approval is for an unlocked browser on the computer only).
 *   - The owner can also choose the file herself: Import an archive opens the picker over the computer's files, the folder is opened,
 *     Import is pressed on the file.
 *   - The import settles. The dashboard's row must say what the fixture holds (archive-fixtures.ts): the format, the messages, the
 *     days, what could not be read and what was left out, behind a real press of See what was not read. The agent's own status says
 *     the same and carries no message text. A search for the archive's word is cited as the format's own label ("Imported mail" for
 *     mbox, "Telegram" for a Telegram Desktop export). Every format in ARCHIVE_FORMATS but the stress one goes through this path.
 *   - Remove deletes everything made from it, and only that archive's: counts reach zero, the row is gone, the stores hold none of the
 *     archive's content, and another archive is untouched.
 *   - With the private model off, imported messages stay Private and say so; none of their content reaches the Personal or Public
 *     stores or a search; nothing leaves the machine. With it back on, what was held drains to zero and the content becomes
 *     searchable.
 *   - A file that changes while it is being imported stops the import, and the dashboard says so, in the product's words.
 *
 * Only the parsing, the journeys (data, for the journey runner) and the checks live here, so they are tested without a machine:
 * machine-agent.ts does the pressing, the waiting, the store reading and the egress watch, and hands back the observations below.
 * Nothing here holds message text: a row is the dashboard's own sentences, counts and names, which are the fixture's.
 */
import { DASHBOARD_ARCHIVE_COPY as A, DASHBOARD_CHATGPT_PAGE_COPY as PANEL, dashboardArchiveNouns } from '../../src/workers/dashboard/vocabulary.ts';
import { FIXTURE_FOLDER, STRESS_FORMAT, type ArchiveExpectation, type LegFixture } from './archive-fixtures.ts';
import { egressVerdict, type EgressView } from './inbox.ts';
import { journeyChecks, type Journey, type JourneyTrace } from './journey.ts';
import type { CheckResult } from './report.ts';

// ---------------------------------------------------------------------------
// Bounds

/** How long each wait may take on a machine. The Linux machine's private model is the smaller one, so its drain is the longer. */
export const ARCHIVE_BOUNDS = {
  /** A small archive reaches Imported after it is approved. */
  settleS: 900,
  /** A removal finishes. */
  removeS: 900,
  /** What was held for the private model has been judged, once the model is back. */
  drainS: { macos: 900, linux: 1_500 },
  /** The engine is ready (models included) after a restart. */
  engineS: 420,
  /** The large archive, after approval, is seen importing. */
  startS: 180,
  /** A stopped import shows its state. */
  stopS: 240,
} as const;

export const drainBoundS = (os: string): number => (os === 'macos' ? ARCHIVE_BOUNDS.drainS.macos : ARCHIVE_BOUNDS.drainS.linux);

/** The sizes (messages) of the large archive tried, in order, until one is still importing when the file is changed. */
export const BULK_SIZES: readonly number[] = [8_000, 40_000, 160_000];

// ---------------------------------------------------------------------------
// Words

const fill = (template: string, values: Record<string, string>): string => {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value);
  return out;
};
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const grouped = (n: number): string => n.toLocaleString('en-US');

/** "4 messages" / "1 message", as the dashboard writes a count: what an archive's items are called depends on its format's family (mail and chat are messages). */
export const messagesWord = (n: number, family = 'email'): string => {
  const nouns = dashboardArchiveNouns(family);
  return n === 1 ? nouns.one : fill(nouns.many, { n: grouped(n) });
};

/** One line of "what was not read" or "what was left out" for a kind, as the dashboard writes it. */
export function gapSentence(kind: string, count: number): string {
  const words = ((A.gaps as unknown as Record<string, { one: string; many: string }>)[kind]) ?? A.gaps.other;
  return count === 1 ? words.one : fill(words.many, { n: grouped(count) });
}

/** The lines See what was not read must hold for a fixture: what was not read first, then what was left out. */
export function expectedGapLines(expect: ArchiveExpectation): string[] {
  return [...expect.gaps, ...expect.leftOut].map((entry) => gapSentence(entry.kind, entry.count));
}

/** A path as the dashboard shows it to the person approving: the home folder written as ~ (the same rule as archive-import/dashboard.ts). */
export function shownPath(home: string, path: string): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The date range as the row writes it. */
export function datesWord(expect: Pick<ArchiveExpectation, 'earliest' | 'latest'>): string {
  return expect.earliest === expect.latest ? expect.earliest : fill(A.dates, { earliest: expect.earliest, latest: expect.latest });
}

function templateRegex(template: string, keys: readonly string[]): RegExp {
  let source = escapeRe(template);
  for (const key of keys) source = source.replace(escapeRe(`{${key}}`), '([\\d,]+)');
  return new RegExp(source);
}

const JUDGED_LINE = templateRegex(A.judgedLine, ['judged', 'held']);
const whole = (digits: string | undefined): number => Number((digits ?? '').replace(/,/g, ''));

/** "N judged · M waiting for the private model" out of a row's text; null when the row has no such line. */
export function judgedLineOf(text: string): { judged: number; held: number } | null {
  const match = JUDGED_LINE.exec(text);
  return match ? { judged: whole(match[1]), held: whole(match[2]) } : null;
}

/** Which of the dashboard's three sentences about messages waiting for the private model a row shows. */
export function heldSentenceOf(text: string): 'ready' | 'waiting' | 'off' | null {
  for (const level of ['off', 'waiting', 'ready'] as const) if (text.includes(A.heldWhy[level])) return level;
  return null;
}

// ---------------------------------------------------------------------------
// What the machine reads off the dashboard and the agent's tool

/** One imported archive's row under the Archives line, read from the framed panel. */
export interface RowView {
  /** The row's state: importing, imported, stopped or removing. */
  status: string;
  name: string;
  /** The tag beside the name (Imported, Stopped, ...). */
  tag: string;
  /** The facts line: format, folder and days. */
  facts: string;
  text: string;
  /** The lines under See what was not read (present in the page whether or not it is open). */
  gapLines: string[];
  /** Whether See what was not read is open; null when the row has none. */
  whyOpen: boolean | null;
  buttons: string[];
}

export interface PanelArchives {
  rows: RowView[];
  /** An agent's or the owner's request waiting on the page. */
  requests: Array<{ kind: string; text: string; buttons: string[] }>;
}

/**
 * Page-side source (plain text, run in the framed panel by Runtime.evaluate and in a DOM in the tests): the Archives line's rows and
 * requests. Rows are `li.archive`; a request is `li.archive.request`.
 */
export const ARCHIVE_PANEL_PROBE = String.raw`(() => {
  const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const buttonsOf = (li) => Array.from(li.querySelectorAll('button, summary')).map((b) => clean(b.getAttribute('aria-label') || b.textContent));
  const rows = Array.from(document.querySelectorAll('li.archive:not(.request)')).map((li) => {
    const why = li.querySelector('details.why');
    return {
      status: li.getAttribute('data-archive') || '',
      name: clean((li.querySelector('.archive-name') || {}).textContent),
      tag: clean((li.querySelector('.ftag') || {}).textContent),
      facts: clean((li.querySelector('p.archive-facts') || {}).textContent),
      text: clean(li.textContent),
      gapLines: Array.from(li.querySelectorAll('details.why ul.plain li')).map((n) => clean(n.textContent)),
      whyOpen: why ? why.open === true : null,
      buttons: buttonsOf(li),
    };
  });
  const requests = Array.from(document.querySelectorAll('li.archive.request')).map((li) => ({ kind: li.getAttribute('data-request') || '', text: clean(li.textContent), buttons: buttonsOf(li) }));
  return { rows, requests };
})()`;

export function panelArchivesOf(raw: unknown): PanelArchives {
  const record = (raw && typeof raw === 'object' ? raw : {}) as { rows?: unknown; requests?: unknown };
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  const rows = (Array.isArray(record.rows) ? record.rows : []).map((entry: any): RowView => ({
    status: text(entry?.status), name: text(entry?.name), tag: text(entry?.tag), facts: text(entry?.facts), text: text(entry?.text),
    gapLines: list(entry?.gapLines), whyOpen: typeof entry?.whyOpen === 'boolean' ? entry.whyOpen : null, buttons: list(entry?.buttons),
  }));
  const requests = (Array.isArray(record.requests) ? record.requests : []).map((entry: any) => ({ kind: text(entry?.kind), text: text(entry?.text), buttons: list(entry?.buttons) }));
  return { rows, requests };
}

export const rowNamed = (panel: PanelArchives | undefined, fileName: string): RowView | undefined => panel?.rows.find((row) => row.name === fileName);

/** `archive_import start`, as the CLI prints it. The answer's own words are not kept: only whether it has the parts an agent needs. */
export interface StartView {
  ok: boolean;
  /** The answer's code (`needs_approval`). */
  code: string;
  requestId?: string;
  /** The answer names where the person approves (the Archives page). */
  hasOpenTarget: boolean;
  /** The answer repeats a word of the archive's contents. */
  carriesContent: boolean;
}

/** One archive in the agent's `status`. */
export interface AgentArchiveView {
  id: string;
  name: string;
  format: string;
  status: string;
  messages?: number;
  judged?: number;
  waiting?: number;
  earliest?: string;
  latest?: string;
  notRead: string[];
  leftOut: string[];
  stopCode?: string;
}

export interface StatusView {
  ok: boolean;
  archives: AgentArchiveView[];
  /** The state of each request waiting or finished (`waiting_for_approval`, `checking`, ...). */
  requestStates: string[];
  /** `ready`, `waiting` or `off`: the dashboard's word for the private model. */
  privateModel?: string;
  /** The answer repeats a word of the archive's contents (it must carry no message text). */
  carriesContent: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const optText = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const optNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function startViewOf(json: unknown, token: string): StartView {
  const record = asRecord(json);
  const open = asRecord(record.open);
  return {
    ok: record.ok === true,
    code: optText(record.code) ?? (record.ok === true ? 'started' : ''),
    ...(optText(record.request_id) ? { requestId: optText(record.request_id)! } : {}),
    hasOpenTarget: typeof open.url === 'string' && open.url.length > 0 && typeof open.page === 'string' && open.page.length > 0,
    carriesContent: token.length > 0 && JSON.stringify(json ?? null).includes(token),
  };
}

export function statusViewOf(json: unknown, token: string): StatusView {
  const record = asRecord(json);
  const archives = asList(record.archives).map((entry): AgentArchiveView => {
    const archive = asRecord(entry);
    const lines = (value: unknown): string[] => asList(value).map((line) => optText(asRecord(line).line) ?? '').filter(Boolean);
    return {
      id: optText(archive.archive_id) ?? '',
      name: optText(archive.name) ?? '',
      format: optText(archive.format) ?? '',
      status: optText(archive.status) ?? '',
      // `messages` is the count for mail and chat; any family also gives `items`, the same number.
      ...((optNumber(archive.messages) ?? optNumber(archive.items)) !== undefined ? { messages: (optNumber(archive.messages) ?? optNumber(archive.items))! } : {}),
      ...(optNumber(archive.judged) !== undefined ? { judged: optNumber(archive.judged)! } : {}),
      ...(optNumber(archive.waiting_for_private_model) !== undefined ? { waiting: optNumber(archive.waiting_for_private_model)! } : {}),
      ...(optText(archive.earliest) ? { earliest: optText(archive.earliest)! } : {}),
      ...(optText(archive.latest) ? { latest: optText(archive.latest)! } : {}),
      notRead: lines(archive.not_read),
      leftOut: lines(archive.left_out),
      ...(optText(asRecord(archive.stopped).code) ? { stopCode: optText(asRecord(archive.stopped).code)! } : {}),
    };
  });
  return {
    ok: record.ok === true,
    archives,
    requestStates: asList(record.requests).map((request) => optText(asRecord(request).state) ?? '').filter(Boolean),
    ...(optText(record.private_model) ? { privateModel: optText(record.private_model)! } : {}),
    carriesContent: token.length > 0 && JSON.stringify(json ?? null).includes(token),
  };
}

/** One archive store (a tier) read from the machine's data folder. */
export interface StoreView {
  /** Private holds contents until judged; Personal and Public hold what the private model cleared. */
  tier: 'private' | 'personal' | 'public';
  exists: boolean;
  /** Items of this archive that are not tombstoned. */
  live: number;
  /** Items and chunks whose text holds the archive's word. */
  tokenRows: number;
  error?: string;
}

export interface SearchView {
  ok: boolean;
  isError: boolean;
  evidence: Array<{ source: string; hasToken: boolean }>;
  error?: string;
}

export interface DrainView {
  drained: boolean;
  ms: number;
  boundMs: number;
  last: { messages?: number; judged?: number; waiting?: number };
  privateModel?: string;
  row?: RowView;
}

// ---------------------------------------------------------------------------
// Observations, one per in-machine verb

export interface ImportObservation {
  /** The verb ran to its end (a failed step in a journey is in `traces`, not here). */
  ok: boolean;
  detail?: string;
  role: string;
  format: string;
  fileName: string;
  token: string;
  via: 'request' | 'picker';
  /** The agent's start and the status that listed its request (the agent path only). */
  start?: StartView;
  waiting?: StatusView;
  traces: JourneyTrace[];
  settled: boolean;
  settleMs: number;
  row?: RowView | undefined;
  status?: StatusView;
  archiveId?: string | undefined;
  stores: StoreView[];
  search?: SearchView;
  drain?: DrainView;
  egress?: EgressView;
}

export interface RemoveObservation {
  ok: boolean;
  detail?: string;
  removals: Array<{
    role: string;
    /** The format of the archive removed: two archives of one role may be of different formats. */
    format: string;
    fileName: string;
    archiveId?: string;
    traces: JourneyTrace[];
    /** The row is off the page. */
    gone: boolean;
    goneMs: number;
    /** The agent's status no longer lists the archive. */
    unlisted: boolean;
    stores: StoreView[];
    /** The archives that were not removed, with what their stores still hold. */
    others: Array<{ role: string; format: string; fileName: string; stores: StoreView[] }>;
  }>;
}

export interface ChangedObservation {
  ok: boolean;
  detail?: string;
  attempts: Array<{ messages: number; outcome: 'changed' | 'finished-first' | 'never-started' | 'refused'; detail: string }>;
  fileName?: string;
  traces: JourneyTrace[];
  row?: RowView | undefined;
  status?: StatusView;
  removed?: { gone: boolean; unlisted: boolean; stores: StoreView[] };
}

export interface ModelObservation {
  ok: boolean;
  detail?: string;
  mode: 'off' | 'on';
  readyMs?: number;
  privateModel?: string;
  /** `on` only: there was no earlier setting to put back, and the model was already on. */
  unchanged?: boolean;
}

// ---------------------------------------------------------------------------
// Journeys (data for the journey runner)

/** The dashboard opens on what the step needs (the page loaded, the panel read). */
const OPEN_S = 60;
const BEFORE_NAME = (template: string): string => template.split('{name}')[0] ?? '';
const rowTarget = (fileName: string) => ({ css: 'li.archive:not(.request)', text: fileName, contains: true });

/** The request an agent left waiting, then the owner's press of its Import, until the archive's row is on the page. */
export function approveRequestSteps(fx: LegFixture, fullPath: string, startS = 180, openS = OPEN_S): Journey['steps'] {
  return [
    {
      name: 'Open the dashboard: the agent\'s request is waiting for the owner',
      do: { go: '/dashboard' },
      expect: [
        { present: { css: 'li.archive.request[data-request="pending"]' }, frame: 'panel' },
        { text: new RegExp(`${escapeRe(BEFORE_NAME(A.requestLine))}${escapeRe(fx.fileName)}`), frame: 'panel' },
        { text: fill(A.fullPath, { path: fullPath }), frame: 'panel' },
      ],
      timeoutMs: openS * 1_000,
    },
    {
      name: 'Press Import on the agent\'s request',
      do: { click: { role: 'button', name: A.approve, within: { css: 'li.archive.request[data-request="pending"]' } }, frame: 'panel' },
      expect: [{ present: rowTarget(fx.fileName), frame: 'panel' }],
      timeoutMs: startS * 1_000,
    },
  ];
}

const settleStep = (fx: LegFixture, settleS: number): Journey['steps'][number] => ({
  name: 'The import settles: the row says Imported',
  do: { observe: true },
  expect: [{ present: { css: 'li.archive[data-archive="imported"]', text: fx.fileName, contains: true }, frame: 'panel' }],
  timeoutMs: settleS * 1_000,
});

/** See what was not read, opened with a real press, and every line the fixture must leave there. */
const gapsStep = (fx: LegFixture): Journey['steps'][number] => ({
  name: 'Open See what was not read',
  do: { click: { role: 'button', name: A.seeWhy, within: rowTarget(fx.fileName) }, frame: 'panel' },
  expect: [
    { present: { css: 'li.archive:not(.request) details.why[open]' }, frame: 'panel' },
    ...expectedGapLines(fx.expect).map((line) => ({ text: line, frame: 'panel' as const })),
  ],
});

export function agentImportJourney(fx: LegFixture, fullPath: string, bounds: { startS?: number; settleS?: number; openS?: number } = {}): Journey {
  const hasGaps = expectedGapLines(fx.expect).length > 0;
  return {
    id: `archive-${fx.role}-${fx.format}-import`,
    title: `An agent's request to import an archive is approved in the dashboard, and the import settles (${fx.format}, ${fx.role})`,
    source: 'archive import: the agent path (archive_import start, needs approval, the owner presses Import)',
    mutates: true,
    steps: [
      ...approveRequestSteps(fx, fullPath, bounds.startS ?? ARCHIVE_BOUNDS.startS, bounds.openS ?? OPEN_S),
      settleStep(fx, bounds.settleS ?? ARCHIVE_BOUNDS.settleS),
      ...(hasGaps ? [gapsStep(fx)] : []),
    ],
  };
}

export function pickerImportJourney(fx: LegFixture, bounds: { startS?: number; settleS?: number; openS?: number } = {}): Journey {
  const hasGaps = expectedGapLines(fx.expect).length > 0;
  const importFile = fill(A.pick.makePrivateFor, { name: fx.fileName });
  return {
    id: `archive-${fx.role}-${fx.format}-import`,
    title: `The owner chooses an archive in the picker and imports it, and the import settles (${fx.format}, ${fx.role})`,
    source: 'archive import: the owner\'s picker (Import an archive, the folder, Import on the file)',
    mutates: true,
    steps: [
      {
        name: 'Open the dashboard: no archive is imported yet, and Import an archive is offered',
        do: { go: '/dashboard' },
        expect: [{ present: { role: 'button', name: A.importAction }, frame: 'panel' }, { absent: { css: 'li.archive' }, frame: 'panel' }],
        timeoutMs: (bounds.openS ?? OPEN_S) * 1_000,
      },
      {
        name: 'Press Import an archive: the picker lists the computer\'s folders',
        do: { click: { role: 'button', name: A.importAction }, frame: 'panel' },
        // The listing arrives after the picker opens; the next press waits for it.
        expect: [{ text: A.pick.intro, frame: 'panel' }, { present: { css: 'button[data-key^="picker:open:"]', text: FIXTURE_FOLDER, contains: true }, frame: 'panel' }],
      },
      {
        name: `Open the folder ${FIXTURE_FOLDER}`,
        do: { click: { css: 'button[data-key^="picker:open:"]', text: FIXTURE_FOLDER, contains: true }, frame: 'panel' },
        expect: [{ present: { role: 'button', name: importFile }, frame: 'panel' }],
      },
      {
        name: 'Press Import on the file',
        do: { click: { role: 'button', name: importFile }, frame: 'panel' },
        expect: [{ text: fill(A.started, { name: fx.fileName }), frame: 'panel' }, { present: rowTarget(fx.fileName), frame: 'panel' }],
        timeoutMs: (bounds.startS ?? ARCHIVE_BOUNDS.startS) * 1_000,
      },
      settleStep(fx, bounds.settleS ?? ARCHIVE_BOUNDS.settleS),
      ...(hasGaps ? [gapsStep(fx)] : []),
    ],
  };
}

/**
 * What names an archive's removal in the report: the role alone for the stress format (the ids of the first format's journeys do not
 * change), and the role with the format for every other, so two archives of one role never share a journey id or a check.
 */
export const removalLabel = (fx: { role: string; format: string }): string => (fx.format === STRESS_FORMAT ? fx.role : `${fx.role}-${fx.format}`);

/** Remove, pressed on the archive's row and confirmed, until the row is gone. */
export function removeJourney(role: string, fileName: string, removeS: number = ARCHIVE_BOUNDS.removeS, openS: number = OPEN_S): Journey {
  const confirm = fill(PANEL.confirm, { label: A.remove.toLowerCase() });
  return {
    id: `archive-${role}-remove`,
    title: `The owner removes an imported archive from its row (${role})`,
    source: 'archive import: Remove asks first, then deletes what Olympus made and leaves the file',
    mutates: true,
    steps: [
      { name: 'Open the dashboard: the archive is listed', do: { go: '/dashboard' }, expect: [{ present: rowTarget(fileName), frame: 'panel' }], timeoutMs: openS * 1_000 },
      {
        name: 'Press Remove: the row asks first, and says the file itself stays',
        do: { click: { role: 'button', name: A.remove, within: rowTarget(fileName) }, frame: 'panel' },
        expect: [{ text: fill(A.removeConfirm, { name: fileName }), frame: 'panel' }, { present: { role: 'button', name: confirm }, frame: 'panel' }],
      },
      {
        name: 'Confirm: the row goes',
        do: { click: { role: 'button', name: confirm }, frame: 'panel' },
        expect: [{ absent: rowTarget(fileName), frame: 'panel' }],
        timeoutMs: removeS * 1_000,
      },
    ],
  };
}

/** A line the stop must say: the product's sentence with the file's name (or its "a file of this archive" when it names none). */
export function stoppedSentence(code: 'file_changed', fileName: string): RegExp {
  const words = A.stopped[code];
  const [before = '', after = ''] = words.why.split('{file}');
  return new RegExp(`${escapeRe(before)}(?:${escapeRe(fileName)}|${escapeRe(A.thisFile)})${escapeRe(after)}`);
}

export function stoppedJourney(role: string, fileName: string, stopS: number = ARCHIVE_BOUNDS.stopS): Journey {
  return {
    id: `archive-${role}-stopped`,
    title: `An archive whose file changed during the import stops, and the dashboard says so (${role})`,
    source: 'archive import: a file that changes after the import started stops the import',
    mutates: true,
    steps: [
      {
        name: 'Open the dashboard: the import is stopped, with why and what to do',
        do: { go: '/dashboard' },
        expect: [
          { present: { css: 'li.archive.stopped[data-archive="stopped"]', text: fileName, contains: true }, frame: 'panel' },
          { text: stoppedSentence('file_changed', fileName), frame: 'panel' },
          { text: A.stopped.file_changed.fix, frame: 'panel' },
          { text: fill(A.needsYou.stopped, { name: fileName }), frame: 'panel' },
          { present: { role: 'button', name: A.remove, within: rowTarget(fileName) }, frame: 'panel' },
        ],
        timeoutMs: stopS * 1_000,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Checks

const check = (id: string, title: string, ok: boolean, detail: string, ms?: number): CheckResult => ({ id, title, status: ok ? 'pass' : 'fail', detail, ...(ms !== undefined ? { ms } : {}) });
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((line, index) => line === [...b].sort()[index]);
const prefixOf = (fx: { role: string; format: string }): string => `archive.${fx.role}.${fx.format}`;

/** Everything about a settled row that differs from what the fixture holds; empty when it is as expected. */
export function rowProblems(row: RowView, expect: ArchiveExpectation): string[] {
  const problems: string[] = [];
  if (row.status !== 'imported' || row.tag !== A.status.imported) problems.push(`the row reads "${row.tag || row.status}", not ${A.status.imported}`);
  if (!row.facts.includes(expect.label)) problems.push(`the format is not "${expect.label}" (facts line: "${row.facts.slice(0, 80)}")`);
  if (!row.facts.includes(FIXTURE_FOLDER)) problems.push(`the folder ${FIXTURE_FOLDER} is not on the facts line ("${row.facts.slice(0, 80)}")`);
  if (!row.facts.includes(datesWord(expect))) problems.push(`the days are not "${datesWord(expect)}" (facts line: "${row.facts.slice(0, 80)}")`);
  if (!row.text.includes(messagesWord(expect.messages, expect.family))) problems.push(`the row does not say "${messagesWord(expect.messages, expect.family)}"`);
  const expected = expectedGapLines(expect);
  if (expected.length > 0 && row.whyOpen !== true) problems.push(`See what was not read was not open (${row.whyOpen === null ? 'the row has none' : 'closed'})`);
  if (!sameSet(row.gapLines, expected)) problems.push(`what was not read or left out is [${row.gapLines.join('; ') || 'nothing'}], expected [${expected.join('; ') || 'nothing'}]`);
  return problems;
}

/** What the agent's status says of a settled archive, set against the fixture; empty when it agrees. */
export function agentViewProblems(view: AgentArchiveView | undefined, expect: ArchiveExpectation): string[] {
  if (!view) return ['the agent\'s status does not list the archive'];
  const problems: string[] = [];
  if (view.status !== 'imported') problems.push(`the agent sees it as ${view.status}`);
  if (view.format !== expect.label) problems.push(`the agent sees the format "${view.format}"`);
  if (view.messages !== expect.messages) problems.push(`the agent sees ${view.messages ?? 'no'} messages, expected ${expect.messages}`);
  if (view.earliest?.slice(0, 10) !== expect.earliest || view.latest?.slice(0, 10) !== expect.latest) problems.push(`the agent sees ${view.earliest ?? '?'} to ${view.latest ?? '?'}`);
  const notRead = expect.gaps.map((entry) => gapSentence(entry.kind, entry.count));
  const leftOut = expect.leftOut.map((entry) => gapSentence(entry.kind, entry.count));
  if (!sameSet(view.notRead, notRead)) problems.push(`the agent's not-read lines are [${view.notRead.join('; ') || 'none'}]`);
  if (!sameSet(view.leftOut, leftOut)) problems.push(`the agent's left-out lines are [${view.leftOut.join('; ') || 'none'}]`);
  return problems;
}

export function searchChecks(prefix: string, search: SearchView | undefined, fx: LegFixture, mode: 'cited' | 'withheld'): CheckResult[] {
  const title = mode === 'cited'
    ? `A search for the archive's word returns it, cited as "${fx.expect.citationLabel}"`
    : 'A search for the archive\'s word does not return its contents while the private model is off';
  if (!search) return [check(`${prefix}.search`, title, false, 'the search was not made')];
  if (!search.ok) return [check(`${prefix}.search`, title, false, `the search failed${search.error ? `: ${search.error}` : ''}`)];
  const hits = search.evidence.filter((item) => item.source === fx.expect.citationLabel);
  const withToken = hits.filter((item) => item.hasToken);
  if (mode === 'cited') {
    return [check(`${prefix}.search`, title, withToken.length > 0,
      withToken.length > 0
        ? `${withToken.length} cited item(s) carry the word, labelled "${fx.expect.citationLabel}" (${search.evidence.length} item(s) in all)`
        : `${search.evidence.length} item(s) came back, ${hits.length} labelled "${fx.expect.citationLabel}", none carrying the word: ${search.evidence.map((item) => item.source).join(', ') || 'no evidence'}`)];
  }
  const leaked = search.evidence.filter((item) => item.hasToken);
  return [check(`${prefix}.search`, title, leaked.length === 0,
    leaked.length === 0 ? `${search.evidence.length} item(s) came back, none carrying the archive's word` : `${leaked.length} item(s) carried the archive's word while its messages were held Private`)];
}

/** What every import is held to, however it was started and whatever the private model is doing: the request (agent path), the journeys, the settled row, and the agent's own status. */
function importCoreChecks(obs: ImportObservation, fx: LegFixture): CheckResult[] {
  const prefix = prefixOf(fx);
  const out: CheckResult[] = [];
  if (obs.via === 'request') {
    const start = obs.start;
    const problems: string[] = [];
    if (!start) problems.push('the agent\'s start was not made');
    else {
      if (start.code !== 'needs_approval') problems.push(`start answered "${start.code || 'nothing'}", not needs_approval`);
      if (!start.requestId) problems.push('start gave no request id');
      if (!start.hasOpenTarget) problems.push('start did not say where the owner approves');
      if (start.carriesContent) problems.push('start repeated a word of the archive\'s contents');
    }
    if (!obs.waiting) problems.push('the agent\'s status was not read while the request waited');
    else {
      if (!obs.waiting.requestStates.includes('waiting_for_approval')) problems.push(`status listed the request as [${obs.waiting.requestStates.join(', ') || 'not at all'}], not waiting for approval`);
      if (obs.waiting.carriesContent) problems.push('status repeated a word of the archive\'s contents');
      if (obs.waiting.archives.some((archive) => archive.name === fx.fileName)) problems.push('the archive was listed as imported before the owner approved');
    }
    out.push(check(`${prefix}.requested`, 'The agent\'s start leaves a request for the owner and imports nothing until it is approved', problems.length === 0,
      problems.length === 0 ? 'needs_approval with a request id and where to approve; status lists the request as waiting; neither carries archive text' : problems.join('; ')));
  }
  out.push(...journeyChecks(obs.traces));
  out.push(check(`${prefix}.imported`, `The import settles: the row reads ${A.status.imported}`, obs.settled && obs.row?.status === 'imported',
    obs.settled && obs.row ? `${obs.row.name} reads ${obs.row.tag} after ${secs(obs.settleMs)}` : `the row did not read ${A.status.imported}${obs.row ? ` (it reads "${obs.row.tag || obs.row.status}")` : ''}`, obs.settleMs));
  if (obs.row) {
    const problems = rowProblems(obs.row, fx.expect);
    out.push(check(`${prefix}.dashboard`, 'The dashboard row shows the format, the messages, the days, what was not read and what was left out', problems.length === 0,
      problems.length === 0 ? `${messagesWord(fx.expect.messages, fx.expect.family)}, ${datesWord(fx.expect)}, ${fx.expect.label}${expectedGapLines(fx.expect).length > 0 ? `, ${expectedGapLines(fx.expect).join('; ')}` : ', nothing unread'}` : problems.join('; ')));
    const view = obs.status?.archives.find((archive) => archive.name === fx.fileName);
    const stat = agentViewProblems(view, fx.expect);
    if (obs.status?.carriesContent) stat.push('the agent\'s status repeated a word of the archive\'s contents');
    out.push(check(`${prefix}.agent-view`, 'The agent\'s own status agrees with the dashboard and carries no message text', stat.length === 0,
      stat.length === 0 ? `${view!.messages} messages, ${view!.earliest?.slice(0, 10)} to ${view!.latest?.slice(0, 10)}, the same gaps in the same words` : stat.join('; ')));
  }
  return out;
}

/**
 * The machine's agent prints just `{ ok: false, detail }` when it fails before it has anything to report, so a list the types say is
 * there may not be: a missing list reads as an empty one, and the run fails on the detail.
 */
const notRun = (prefix: string, title: string, obs: { ok: boolean; detail?: string; traces: readonly unknown[] } | undefined): CheckResult | undefined =>
  !obs || (!obs.ok && (obs.traces ?? []).length === 0) ? check(`${prefix}.ran`, title, false, obs?.detail ?? 'no result from the machine') : undefined;

/** Checks for one archive imported on the agent path or the picker, with the private model on. */
export function importChecks(obs: ImportObservation | undefined, fx: LegFixture, os: string): CheckResult[] {
  const prefix = prefixOf(fx);
  const title = `The ${fx.format} archive was imported (${fx.role})`;
  const missing = notRun(prefix, title, obs);
  if (missing) return [missing];
  const seen = obs!;
  const out: CheckResult[] = [];
  if (!seen.ok) out.push(check(`${prefix}.ran`, title, false, seen.detail ?? 'the machine reported a problem'));
  out.push(...importCoreChecks(seen, fx));
  if (seen.drain) out.push(...drainChecks(`${prefix}.drain`, seen.drain, fx, os, 'baseline'));
  if (seen.search) out.push(...searchChecks(prefix, seen.search, fx, 'cited'));
  return out;
}

/** Held messages drained to zero within the leg's own bound. `baseline` is the first time (the model was on all along); `restored` follows the model being switched back on. */
export function drainChecks(id: string, drain: DrainView | undefined, fx: LegFixture, os: string, when: 'baseline' | 'restored'): CheckResult[] {
  const title = when === 'restored'
    ? 'With the private model back on, the messages that were held are judged: held reaches zero'
    : 'With the private model on, the imported messages are judged: held reaches zero';
  if (!drain) return [check(id, title, false, 'the wait was not made')];
  const problems: string[] = [];
  if (!drain.drained) problems.push(`${drain.last.waiting ?? '?'} of ${drain.last.messages ?? '?'} messages were still waiting for the private model after ${secs(drain.ms)} (the bound for this machine is ${secs(drain.boundMs)})`);
  const judged = drain.row ? judgedLineOf(drain.row.text) : null;
  if (drain.drained && (drain.last.waiting !== 0 || drain.last.messages !== fx.expect.messages)) {
    problems.push(`the agent reports ${drain.last.waiting ?? '?'} of ${drain.last.messages ?? '?'} messages waiting, expected 0 of ${fx.expect.messages}`);
  }
  if (drain.drained && !drain.row) problems.push('the dashboard row could not be read, so the judged count is unproven');
  if (drain.drained && drain.row) {
    if (!judged) problems.push('the dashboard row has no judged line');
    else if (judged.held !== 0 || judged.judged !== fx.expect.messages) problems.push(`the dashboard row reads ${judged.judged} judged · ${judged.held} waiting, expected ${fx.expect.messages} judged · 0 waiting`);
    if (heldSentenceOf(drain.row.text) !== null) problems.push('the row still gives a reason for messages waiting');
  }
  if (when === 'restored' && drain.privateModel === 'off') problems.push('the agent still sees the private model as off');
  return [check(id, title, problems.length === 0,
    problems.length === 0 ? `${fx.expect.messages} messages judged, none waiting, after ${secs(drain.ms)} (bound ${secs(drain.boundMs)}; ${os})` : problems.join('; '), drain.ms)];
}

/** The private model is off: the messages are held, say so, and none of their content is anywhere a search or a lower tier could reach. */
export function heldOffChecks(obs: ImportObservation | undefined, fx: LegFixture): CheckResult[] {
  const prefix = prefixOf(fx);
  const title = 'The archive was imported with the private model off';
  const missing = notRun(prefix, title, obs);
  if (missing) return [missing];
  const seen = obs!;
  const out: CheckResult[] = [];
  if (!seen.ok) out.push(check(`${prefix}.ran`, title, false, seen.detail ?? 'the machine reported a problem'));
  out.push(...importCoreChecks(seen, fx));
  return [...out, ...heldOffOnly(seen, fx)];
}

function heldOffOnly(obs: ImportObservation, fx: LegFixture): CheckResult[] {
  const prefix = prefixOf(fx);
  const out: CheckResult[] = [];
  const row = obs.row;
  const held = row ? judgedLineOf(row.text) : null;
  const problems: string[] = [];
  if (!row) problems.push('there is no row');
  else {
    if (heldSentenceOf(row.text) !== 'off') problems.push(`the row does not say "${A.heldWhy.off}" (it gives ${heldSentenceOf(row.text) ?? 'no reason'})`);
    if (!held) problems.push('the row has no judged line');
    else if (held.judged !== 0 || held.held !== fx.expect.messages) problems.push(`the row reads ${held.judged} judged · ${held.held} waiting, expected 0 judged · ${fx.expect.messages} waiting`);
    if (!row.buttons.includes(A.setUpPrivateModel)) problems.push(`the row does not offer "${A.setUpPrivateModel}"`);
  }
  const model = obs.status?.privateModel;
  if (model !== 'off') problems.push(`the agent sees the private model as "${model ?? 'unknown'}", not off`);
  out.push(check(`${prefix}.held`, 'With the private model off the messages stay Private: the row says no private model is set up and none are judged', problems.length === 0,
    problems.length === 0 ? `0 judged · ${fx.expect.messages} waiting, "${A.heldWhy.off}", with the way to set it up; the agent sees the model as off` : problems.join('; ')));
  const priv = obs.stores.find((store) => store.tier === 'private');
  const lower = obs.stores.filter((store) => store.tier !== 'private');
  const storeProblems: string[] = [];
  if (obs.stores.length === 0) storeProblems.push('the stores were not read');
  for (const store of obs.stores) if (store.error) storeProblems.push(`the ${store.tier} store could not be read: ${store.error}`);
  if (!priv || priv.tokenRows === 0) storeProblems.push('the Private store does not hold the archive\'s content');
  for (const store of lower) if (store.tokenRows > 0) storeProblems.push(`the ${store.tier} store holds ${store.tokenRows} row(s) with the archive's content`);
  out.push(check(`${prefix}.stores`, 'None of the archive\'s content is in the Personal or Public stores; it is all in the Private one', storeProblems.length === 0,
    storeProblems.length === 0 ? `Private holds it (${priv!.tokenRows} rows with the word); Personal and Public hold none` : storeProblems.join('; ')));
  out.push(...searchChecks(prefix, obs.search, fx, 'withheld'));
  if (obs.egress) {
    const stays = egressVerdict(obs.egress);
    out.push(check(`${prefix}.stays-here`, 'Nothing left the machine while the archive was imported with the private model off', stays.ok, stays.detail));
  } else {
    out.push(check(`${prefix}.stays-here`, 'Nothing left the machine while the archive was imported with the private model off', false, 'the machine\'s connections were not watched'));
  }
  return out;
}

export function removeChecks(obs: RemoveObservation | undefined, fixtures: ReadonlyArray<Pick<LegFixture, 'role' | 'format' | 'fileName' | 'token'>>): CheckResult[] {
  const out: CheckResult[] = [];
  if (!obs || (!obs.ok && (obs.removals ?? []).length === 0)) {
    return [check('archive.remove.ran', 'Archives were removed from their rows', false, obs?.detail ?? 'no result from the machine')];
  }
  if (!obs.ok) out.push(check('archive.remove.ran', 'Archives were removed from their rows', false, obs.detail ?? 'the machine reported a problem'));
  for (const removal of obs.removals) {
    const fx = fixtures.find((candidate) => candidate.role === removal.role && candidate.format === removal.format);
    const prefix = fx ? prefixOf(fx) : `archive.${removal.role}.${removal.format}`;
    out.push(...journeyChecks(removal.traces));
    const problems: string[] = [];
    if (!removal.gone) problems.push('the row is still on the page');
    if (!removal.unlisted) problems.push('the agent\'s status still lists the archive');
    if (removal.stores.length === 0) problems.push('the stores were not read');
    for (const store of removal.stores) {
      if (store.error) problems.push(`the ${store.tier} store could not be read: ${store.error}`);
      if (store.live > 0) problems.push(`the ${store.tier} store still holds ${store.live} live item(s) of the archive`);
      if (store.tokenRows > 0) problems.push(`the ${store.tier} store still holds ${store.tokenRows} row(s) with the archive's content`);
    }
    for (const other of removal.others) {
      const kept = other.stores.reduce((sum, store) => sum + store.tokenRows, 0);
      if (kept === 0) problems.push(`removing it also took the content of ${other.fileName}`);
    }
    out.push(check(`${prefix}.removed`, 'Remove deletes everything made from the archive and nothing of another archive: the counts reach zero and the row is gone', problems.length === 0,
      problems.length === 0
        ? `row gone after ${secs(removal.goneMs)}, the agent no longer lists it, no live item or content of it in any store${removal.others.length > 0 ? `; ${removal.others.map((other) => other.fileName).join(', ')} untouched` : ''}`
        : problems.join('; '), removal.goneMs));
  }
  const missing = fixtures.filter((fx) => !obs.removals.some((removal) => removal.role === fx.role && removal.format === fx.format));
  if (missing.length > 0) out.push(check('archive.remove.ran', 'Archives were removed from their rows', false, `no removal was made for: ${missing.map((fx) => fx.fileName).join(', ')}`));
  return out;
}

export function changedChecks(obs: ChangedObservation | undefined): CheckResult[] {
  const title = 'A file changed while it was being imported stops the import, and the dashboard says so';
  if (!obs || (!obs.ok && (obs.attempts ?? []).length === 0)) return [check('archive.changed.stops', title, false, obs?.detail ?? 'no result from the machine')];
  const out: CheckResult[] = [];
  if (!obs.ok) out.push(check('archive.changed.ran', 'The changed-file stage ran to its end', false, obs.detail ?? 'the machine reported a problem'));
  out.push(...journeyChecks(obs.traces));
  const last = obs.attempts[obs.attempts.length - 1];
  const stopped = last?.outcome === 'changed';
  const problems: string[] = [];
  if (!stopped) problems.push(`no attempt caught the import still running: ${obs.attempts.map((attempt) => `${attempt.messages} messages ${attempt.outcome} (${attempt.detail})`).join('; ') || 'none was made'}`);
  else {
    if (obs.row?.status !== 'stopped') problems.push(`the row reads "${obs.row?.tag || obs.row?.status || 'nothing'}", not ${A.status.stopped}`);
    const view = obs.status?.archives.find((archive) => archive.name === obs.fileName);
    if (view?.stopCode !== 'file_changed') problems.push(`the agent sees the stop as "${view?.stopCode ?? 'not stopped'}", not file_changed`);
  }
  out.push(check('archive.changed.stops', title, problems.length === 0,
    problems.length === 0 ? `after ${last!.messages} messages' worth of file: ${last!.detail}; the row reads ${A.status.stopped} with "${A.stopped.file_changed.fix}"; the agent sees file_changed` : problems.join('; ')));
  if (obs.removed) {
    const cleanup: string[] = [];
    if (!obs.removed.gone) cleanup.push('the stopped archive\'s row is still on the page after Remove');
    if (!obs.removed.unlisted) cleanup.push('the agent still lists it');
    if (obs.removed.stores.length === 0) cleanup.push('the stores were not read');
    for (const store of obs.removed.stores) {
      if (store.error) cleanup.push(`the ${store.tier} store could not be read: ${store.error}`);
      else if (store.live > 0 || store.tokenRows > 0) cleanup.push(`the ${store.tier} store still holds ${store.live} item(s) / ${store.tokenRows} row(s) of it`);
    }
    out.push(check('archive.changed.removed', 'The stopped archive is removed from its row, with its rows', cleanup.length === 0, cleanup.length === 0 ? 'row gone, unlisted, no rows left in any store' : cleanup.join('; ')));
  }
  return out;
}

export function modelChecks(obs: ModelObservation | undefined, mode: 'off' | 'on'): CheckResult[] {
  const id = `archive.model-${mode}`;
  const title = mode === 'off'
    ? 'The private model was turned off the way the engine\'s settings turn it off, and the engine came back ready'
    : 'The private model was turned back on, and the engine came back ready';
  if (!obs) return [check(id, title, false, 'no result from the machine')];
  const problems: string[] = [];
  if (!obs.ok) problems.push(obs.detail ?? 'the machine reported a problem');
  if (mode === 'off' && obs.ok && obs.privateModel !== 'off') problems.push(`the agent sees the private model as "${obs.privateModel ?? 'unknown'}", not off`);
  if (mode === 'on' && obs.ok && obs.privateModel === 'off') problems.push('the agent still sees the private model as off');
  return [check(id, title, problems.length === 0,
    problems.length === 0 ? `ready after ${secs(obs.readyMs ?? 0)}${obs.privateModel ? `; the private model reads ${obs.privateModel}` : ''}${obs.unchanged ? ' (it had not been turned off)' : ''}` : problems.join('; '), obs.readyMs)];
}
