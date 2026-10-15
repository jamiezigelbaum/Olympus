/**
 * Turns what the release check saw of the Private answers inbox (1.1.0) into checks.
 *
 * The surfaces, in the order an owner meets them:
 *   - An agent asks a Private question that is not answered inline. The tool result carries the product's fixed note ("Your
 *     answer is in Olympus on your computer.") and one `olympus://open/private/<id>` link. Nothing else about the question or
 *     the answer is in it.
 *   - The computer's Inbox gets that question as an entry and the local model answers it. The link's id is the entry's id: the
 *     dashboard route and the Inbox page both resolve it.
 *   - The Ask page takes a question typed by the owner. Pressing "Ask the local model" answers it on the computer, with sources,
 *     and keeps it in the Inbox. Venice and zkAPI, when not set up, show the way to fix that (a link to Models) and nothing in
 *     the row can send. None of it leaves the machine.
 *
 * Everything here is an exact comparison over booleans, counts and fixed product wording; Private text stays in the machine and
 * only whether each expected fact was stated crosses to the report. The dashboard is driven through the owner's own path: the
 * opening link signs the browser in, then the page's Unlock is pressed (the route a bearer holder cannot use).
 */
import { REMOTE_PRIVATE_NOTE } from '../../src/core/remote-result.ts';
import { parseOlympusOpenUrl } from '../../src/core/open-targets.ts';
import { DASHBOARD_PRIVATE_ANSWERS_COPY as COPY } from '../../src/workers/dashboard/vocabulary.ts';
import { describeLeaks, findLeaks, type LeakMarker } from './leak.ts';
import type { CheckResult } from './report.ts';

// ---------------------------------------------------------------------------
// The agent's side: the note and its link

const LINK_IN_TEXT = /olympus:\/\/open\/private\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g;

/** The ids of the well-formed Private-answer links in a text, once each, in order. */
export function privateLinkIdsIn(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(LINK_IN_TEXT)) if (!ids.includes(match[1]!)) ids.push(match[1]!);
  return ids;
}

/** The `private_note` of a tool result (its structured form, its JSON text, or the sentence found in plain text); null when there is none. */
export function privateNoteIn(text: string, structured?: unknown): string | null {
  const fromStructured = (structured as { private_note?: unknown } | null | undefined)?.private_note;
  if (typeof fromStructured === 'string') return fromStructured;
  try {
    const parsed = JSON.parse(text) as { private_note?: unknown } | null;
    if (typeof parsed?.private_note === 'string') return parsed.private_note;
  } catch { /* not JSON: look for the sentence */ }
  const at = text.indexOf(REMOTE_PRIVATE_NOTE);
  if (at < 0) return null;
  return /^[^"\n]*/.exec(text.slice(at))?.[0] ?? null;
}

export interface NoteVerdict {
  /** The note is exactly the fixed sentence and one well-formed Private-answer link. */
  shape: { ok: boolean; detail: string };
  /** The link opens nothing but a locator: it holds no word of the question. */
  opaque: { ok: boolean; detail: string };
  /** The id, when the note has a well-formed link. */
  id?: string;
}

/** Words of five letters or more in a question, lower case: what an id that "carried the question" would contain. */
function wordsOf(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []))];
}

export function judgeNote(note: string | null, asked: string): NoteVerdict {
  if (note === null) return { shape: { ok: false, detail: 'no Private note in the tool result' }, opaque: { ok: false, detail: 'no link to judge' } };
  if (!note.startsWith(REMOTE_PRIVATE_NOTE)) return { shape: { ok: false, detail: 'the note is not the product\'s fixed sentence' }, opaque: { ok: false, detail: 'no link to judge' } };
  const rest = note.slice(REMOTE_PRIVATE_NOTE.length).trim();
  if (rest === '') return { shape: { ok: false, detail: 'the fixed sentence arrived without an Open link' }, opaque: { ok: false, detail: 'no link to judge' } };
  const link = /^\[[^\]\n]{1,60}\]\((olympus:\/\/open\/private\/[A-Za-z0-9_-]{22})\)$/.exec(rest)?.[1];
  if (!link) return { shape: { ok: false, detail: 'after the fixed sentence the note holds more than one Open link of the expected form' }, opaque: { ok: false, detail: 'no link to judge' } };
  const target = parseOlympusOpenUrl(link);
  if (!target || target.kind !== 'private_answers' || target.fallback || !target.answerId) {
    return { shape: { ok: false, detail: 'the product\'s own link reader does not take this as a Private answer link' }, opaque: { ok: false, detail: 'no link to judge' } };
  }
  const id = target.answerId;
  const carried = wordsOf(asked).filter((word) => id.toLowerCase().includes(word));
  return {
    shape: { ok: true, detail: 'the fixed sentence and one Open link the product\'s own reader accepts' },
    opaque: carried.length === 0
      ? { ok: true, detail: `a 22-character locator; none of the question's ${wordsOf(asked).length} longer words is in it` }
      : { ok: false, detail: `the link holds ${carried.length} word(s) of the question` },
    id,
  };
}

/**
 * The checks for one agent's Private note: used for the harness's own scripted agent and for every model agent. The link is judged
 * on its own; whether anything else in the agent's transcript held Private text is the transcript's own leak check.
 */
export function noteChecks(prefix: string, who: string, note: string | null, asked: string, markers: readonly LeakMarker[]): { checks: CheckResult[]; id?: string } {
  const verdict = judgeNote(note, asked);
  const leaks = findLeaks([{ label: 'the Private note', text: note ?? '' }], markers);
  const checks: CheckResult[] = [
    {
      id: `${prefix}.link`,
      title: `${who}: the Private question got the "answer is in Olympus" note with an Open link`,
      status: verdict.shape.ok ? 'pass' : 'fail',
      detail: verdict.shape.detail,
    },
    {
      id: `${prefix}.link-carries-nothing`,
      title: `${who}: the link carries no part of the question or the answer`,
      status: verdict.opaque.ok && leaks.length === 0 ? 'pass' : 'fail',
      detail: leaks.length > 0 ? describeLeaks(leaks).join('; ') : verdict.opaque.detail,
    },
  ];
  return { checks, ...(verdict.id ? { id: verdict.id } : {}) };
}

// ---------------------------------------------------------------------------
// The computer's side: what the in-machine agent saw in the owner's browser

export type DestinationId = 'computer' | 'anonymous' | 'venice';

export interface CardView {
  /** The card's state as the page marks it: ready, not_set_up, not_allowed, busy. */
  state: string;
  status: string;
  reason: string;
  control: { tag: string; text: string; href: string | null; action: string | null; submit: boolean; disabled: boolean } | null;
}

/** One Inbox entry as the dashboard's own route showed it. */
export interface EntryView {
  id: string;
  listed: boolean;
  /** private (the computer's model), venice or anonymous. */
  path: string | null;
  /** The entry names where it came from. */
  fromShown: boolean;
  /** The listed question is the one that was asked; null when no question was given to compare. */
  questionMatches: boolean | null;
  /** The route's read status: answered, answering, queued, ... */
  status: string | null;
  factsStated: boolean[];
  citations: number;
  citesExpected: boolean;
  waitedS: number;
}

/** The Inbox page opened by the link's own address. */
export interface PageView {
  id: string;
  landedOnInbox: boolean;
  rowFound: boolean;
  /** The row showed its answer (the link opens it). */
  opened: boolean;
  factsStated: boolean[];
  citations: number;
  citesExpected: boolean;
}

export interface AskView {
  /** The question was typed into the page's field and "Ask the local model" was pressed. */
  pressed: boolean;
  answered: boolean;
  message: string;
  factsStated: boolean[];
  citations: number;
  citesExpected: boolean;
  ms: number;
  /** The Inbox entry that appeared for it. */
  entry: EntryView | null;
}

export interface FixView {
  /** The row's link was pressed. */
  clicked: boolean;
  /** Where it landed (path, query and fragment only). */
  landedAt: string;
  /** The Models section it names is on screen. */
  anchorShown: boolean;
}

export interface EgressView {
  samples: number;
  intervalMs: number;
  /** Destinations already connected when the watch began. */
  baseline: number;
  /** Destinations the product newly connected to (empty when nothing left). */
  fresh: string[];
  pageRequests: number;
  /** Hosts the page asked for that are not this machine. */
  pageOutside: string[];
}

export interface ShotView { file: string; label: string; width: number; theme: 'light' | 'dark'; bytes: number }

export interface InboxObservation {
  ok: boolean;
  detail?: string;
  ownerPath: {
    /** The status the Inbox route gave a bearer-minted session (403: only an unlocked browser on this computer opens it); null when not tried. */
    bearerStatus: number | null;
    /** After the opening link signed the browser in, the page offered Unlock. */
    unlockOffered: boolean;
    /** Pressing it opened the controls. */
    unlocked: boolean;
  };
  destinations: Partial<Record<DestinationId, CardView>>;
  entries: EntryView[];
  pages: PageView[];
  ask: AskView | null;
  fixes: { venice: FixView | null; anonymous: FixView | null };
  /** The status the route gave an ask of Venice while the page showed it not set up; null when it was not pressed (it was ready, or the press was not tried). */
  refusals: { venice: number | null };
  egress: EgressView;
  shots: ShotView[];
}

export interface InboxContext {
  /** The link id the harness's own scripted agent received. */
  scriptedId?: string | undefined;
  /** Link ids the model agents received. */
  agentLinks: ReadonlyArray<{ agent: string; id: string }>;
}

function check(id: string, title: string, ok: boolean, detail: string, ms?: number): CheckResult {
  return { id, title, status: ok ? 'pass' : 'fail', detail, ...(ms === undefined ? {} : { ms }) };
}

const allTrue = (flags: readonly boolean[]): boolean => flags.length > 0 && flags.every(Boolean);

function factsLine(flags: readonly boolean[]): string {
  return `${flags.filter(Boolean).length} of ${flags.length} Private facts stated`;
}

/** An address of the Models page with the given section, whatever token its query carries. */
function modelsHref(href: string | null, anchor: string): boolean {
  return href !== null && new RegExp(`^/dashboard\\?keys(?:&token=[^#]*)?#${anchor}$`).test(href);
}

function destinationChecks(obs: InboxObservation): CheckResult[] {
  const out: CheckResult[] = [];
  const computer = obs.destinations.computer;
  const askButton = computer?.control;
  const computerOk = computer?.state === 'ready' && askButton?.tag === 'button' && askButton.submit && askButton.action === 'ask' && askButton.text === COPY.askComputer;
  out.push(check(
    'inbox.ask.page',
    'The Ask page offers the local model, Venice and zkAPI, and the local model is ready to be asked',
    computerOk && obs.destinations.venice !== undefined && obs.destinations.anonymous !== undefined,
    computer ? `local model ${computer.state}${askButton ? ` (${askButton.tag}: "${askButton.text}")` : ' (no control)'}; Venice ${obs.destinations.venice?.state ?? 'missing'}; zkAPI ${obs.destinations.anonymous?.state ?? 'missing'}` : 'the local model card was not on the page',
  ));

  const venice = obs.destinations.venice;
  const veniceControl = venice?.control;
  const veniceFix = obs.fixes.venice;
  const veniceOk = venice?.state === 'not_set_up' && veniceControl?.tag === 'a' && !veniceControl.submit && veniceControl.action === null
    && veniceControl.text === COPY.setUpVenice && venice.reason === COPY.veniceNotSetUp && modelsHref(veniceControl.href, 'venice-setup')
    && veniceFix?.clicked === true && veniceFix.anchorShown;
  out.push(check(
    'inbox.venice.route',
    'Venice, not set up, says so and links to the Models section that fixes it; nothing in the row can send',
    veniceOk,
    !venice ? 'the Venice card was not on the page'
      : `state ${venice.state}; control ${veniceControl ? `${veniceControl.tag} "${veniceControl.text}" -> ${veniceControl.href ?? 'no address'}` : 'none'}; reason ${venice.reason === COPY.veniceNotSetUp ? 'is the product\'s wording' : 'differs from the product\'s wording'}; pressing it ${veniceFix?.clicked ? `landed at ${veniceFix.landedAt}${veniceFix.anchorShown ? ' with the section shown' : ' without the section'}` : 'was not done'}`,
  ));

  const zk = obs.destinations.anonymous;
  const zkControl = zk?.control;
  const zkFix = obs.fixes.anonymous;
  const zkOk = zk?.state === 'not_set_up' && zkControl?.tag === 'a' && !zkControl.submit && zkControl.action === null
    && zkControl.text.length > 0 && zk.reason.length > 0 && modelsHref(zkControl.href, 'anonymous')
    && zkFix?.clicked === true && zkFix.anchorShown;
  out.push(check(
    'inbox.zkapi.route',
    'zkAPI, not set up, says so and links to the Models section that fixes it; nothing in the row can send',
    zkOk,
    !zk ? 'the zkAPI card was not on the page'
      : `state ${zk.state}; control ${zkControl ? `${zkControl.tag} "${zkControl.text}" -> ${zkControl.href ?? 'no address'}` : 'none'}; reason ${zk.reason.length > 0 ? 'shown' : 'missing'}; pressing it ${zkFix?.clicked ? `landed at ${zkFix.landedAt}${zkFix.anchorShown ? ' with the section shown' : ' without the section'}` : 'was not done'}`,
  ));

  // The route itself refuses an ask of Venice that is not set up (403) before anything leaves; zkAPI's ask goes through the writer and
  // the gate, which the check never presses: its row, not set up, offers a link and no send control (checked above).
  const noZkSend = zk?.state === 'not_set_up' && zkControl?.submit !== true && zkControl?.action === null;
  out.push(check(
    'inbox.no-send',
    'Pressing Ask on Venice, not set up, is refused before anything is sent; zkAPI\'s row has nothing to press that sends',
    obs.refusals.venice === 403 && noZkSend,
    `Venice's ask route ${obs.refusals.venice === null ? 'was not pressed' : `answered ${obs.refusals.venice}`}; zkAPI's row ${noZkSend ? 'has no send control' : 'has a control that could send, or is not in the not-set-up state'}`,
  ));
  return out;
}

export function evaluateInbox(obs: InboxObservation, ctx: InboxContext): CheckResult[] {
  if (!obs.ok) {
    return [check('inbox.ran', 'The Ask page and the Inbox were driven in the owner\'s browser', false, obs.detail ?? 'the inbox check did not finish')];
  }
  const out: CheckResult[] = [];

  out.push(check(
    'inbox.owner-path',
    'The Inbox opens only in the owner\'s own browser: the opening link signs in, Unlock opens it, and a bearer session is refused',
    obs.ownerPath.bearerStatus === 403 && obs.ownerPath.unlockOffered && obs.ownerPath.unlocked,
    `bearer-minted session ${obs.ownerPath.bearerStatus === null ? 'not tried' : `answered ${obs.ownerPath.bearerStatus}`}; Unlock ${obs.ownerPath.unlockOffered ? 'offered' : 'not offered'} and ${obs.ownerPath.unlocked ? 'opened the controls' : 'did not open the controls'}`,
  ));

  const scripted = ctx.scriptedId ? obs.entries.find((entry) => entry.id === ctx.scriptedId) : undefined;
  if (scripted) {
    out.push(check(
      'inbox.agent.entry',
      'The agent\'s Private question is in the Inbox, under the id its link names',
      scripted.listed && scripted.path === 'private' && scripted.fromShown && scripted.questionMatches !== false,
      scripted.listed ? `listed as a ${scripted.path ?? 'unknown'} entry; says where it came from: ${scripted.fromShown ? 'yes' : 'no'}; the question is the one asked: ${scripted.questionMatches === null ? 'not compared' : scripted.questionMatches ? 'yes' : 'no'}` : 'the id in the link is not in the Inbox',
    ));
    out.push(check(
      'inbox.agent.answered',
      'The local model answered it, stating the Private facts, with sources',
      scripted.status === 'answered' && allTrue(scripted.factsStated) && scripted.citations > 0 && scripted.citesExpected,
      scripted.status === 'answered'
        ? `${factsLine(scripted.factsStated)}; ${scripted.citations} source(s)${scripted.citesExpected ? ', the Private item named' : ', the Private item not named'}; answered after ${scripted.waitedS} s`
        : `status ${scripted.status ?? 'unreadable'} after waiting ${scripted.waitedS} s`,
      scripted.waitedS * 1000,
    ));
    const page = obs.pages.find((p) => p.id === scripted.id);
    out.push(check(
      'inbox.agent.page',
      'The link\'s own address opens the Inbox on that entry, with its answer and sources',
      page !== undefined && page.landedOnInbox && page.rowFound && page.opened && allTrue(page.factsStated) && page.citations > 0 && page.citesExpected,
      page === undefined ? 'the address was not opened'
        : `${page.landedOnInbox ? 'landed on the Inbox' : 'did not land on the Inbox'}; entry ${page.rowFound ? 'found' : 'not found'}${page.rowFound ? ` and ${page.opened ? 'opened' : 'not opened'}` : ''}; ${factsLine(page.factsStated)}; ${page.citations} source(s)`,
    ));
  } else {
    out.push(check('inbox.agent.entry', 'The agent\'s Private question is in the Inbox, under the id its link names', false, ctx.scriptedId ? 'the in-machine check was not given this id' : 'the scripted agent received no link, so there is no entry to find'));
  }

  for (const link of ctx.agentLinks) {
    const entry = obs.entries.find((e) => e.id === link.id);
    out.push(check(
      `inbox.${link.agent}.entry`,
      `${link.agent}: the link its Private question was given resolves to an Inbox entry`,
      entry?.listed === true && entry.path === 'private',
      entry?.listed ? `listed as a ${entry.path ?? 'unknown'} entry (${entry.status ?? 'unreadable'})` : 'the id in the link is not in the Inbox',
    ));
  }

  out.push(...destinationChecks(obs));

  const ask = obs.ask;
  out.push(check(
    'inbox.ask.answer',
    'Ask the local model, typed on the Ask page, is answered on the computer with sources',
    ask !== null && ask.pressed && ask.answered && allTrue(ask.factsStated) && ask.citations > 0 && ask.citesExpected,
    ask === null ? 'the question was not asked'
      : !ask.pressed ? 'the page had no ready Ask button to press'
        : ask.answered ? `${factsLine(ask.factsStated)}; ${ask.citations} source(s)${ask.citesExpected ? ', the Private item named' : ', the Private item not named'}; ${Math.round(ask.ms / 1000)} s`
          : `no answer (${ask.message || 'nothing on the page'}) after ${Math.round(ask.ms / 1000)} s`,
    ask?.ms,
  ));
  const entry = ask?.entry ?? null;
  out.push(check(
    'inbox.ask.in-inbox',
    'The answer lands in the Inbox, with its sources',
    entry !== null && entry.listed && entry.path === 'private' && entry.questionMatches === true && entry.status === 'answered' && allTrue(entry.factsStated) && entry.citations > 0 && entry.citesExpected,
    entry === null ? 'no entry appeared for the question'
      : `${entry.listed ? 'listed' : 'not listed'} as a ${entry.path ?? 'unknown'} entry (${entry.status ?? 'unreadable'}); the question is the one asked: ${entry.questionMatches ? 'yes' : 'no'}; ${factsLine(entry.factsStated)}; ${entry.citations} source(s)`,
  ));

  out.push(check(
    'inbox.stays-here',
    'Nothing left the machine while the Ask page was used (the local answer, and the Venice and zkAPI rows)',
    obs.egress.fresh.length === 0 && obs.egress.pageOutside.length === 0 && obs.egress.samples > 0,
    obs.egress.fresh.length === 0 && obs.egress.pageOutside.length === 0
      ? `${obs.egress.samples} samples of the machine's connections, one every ${obs.egress.intervalMs} ms: none new beyond the ${obs.egress.baseline} already open; the page asked for ${obs.egress.pageRequests} address(es), all on this machine`
      : `new connections: ${obs.egress.fresh.join(', ') || 'none'}; the page also asked for: ${obs.egress.pageOutside.join(', ') || 'nothing outside'}`,
  ));
  return out;
}
