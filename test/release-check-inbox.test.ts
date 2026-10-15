// The release check's 1.1.0 Inbox leg: the Private note and its Open link, the checks over what the owner's browser showed, the
// connection sampler's parsers, and the page scripts, run against the product's own rendered page so a markup change the check no
// longer understands fails here first.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { REMOTE_PRIVATE_NOTE, withRemotePrivateNote } from '../src/core/remote-result.ts';
import { DASHBOARD_PRIVATE_ANSWERS_COPY as COPY } from '../src/workers/dashboard/vocabulary.ts';
import { DASHBOARD_PRIVATE_ANSWERS_PATH } from '../src/workers/http.ts';
import { renderDashboardPrivateAnswersPage } from '../src/workers/dashboard/pages/private-answers.ts';
import { INBOX_ASK, PRIVATE_FACTS, PRIVATE_MARKER, SUITE_QUESTIONS, forbiddenMarkers } from '../scripts/release-check/fixture.ts';
import {
  evaluateInbox, judgeNote, noteChecks, privateLinkIdsIn, privateNoteIn, type CardView, type EntryView, type InboxObservation,
} from '../scripts/release-check/inbox.ts';
import {
  anchorPresent, ASK_VIEW, centerOf, factsIn, FOCUS_QUESTION, PAGE_STATE, PAGE_UNLOCK_OFFERED, PAGE_UNLOCKED, pageApi, PRIVATE_ANSWERS_POST_PATH, rowView, sourceNames,
} from '../scripts/release-check/inbox-page.ts';
import {
  freshEgress, isBrowserProcess, normalizeIp, outboundFromLsof, outboundFromProcNet, procAddress, requestsOutsideMachine,
} from '../scripts/release-check/egress.ts';
import { evaluateObservation, type QuestionObservation } from '../scripts/release-check/suite.ts';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const OTHER = 'ZyXwVuTsRqPoNmLkJiHgFe';
const NEW = 'NnNnNnNnNnNnNnNnNnNnNn';
const privateQuestion = SUITE_QUESTIONS.find((question) => question.kind === 'private')!;
const markers = forbiddenMarkers();

/** The note exactly as the product writes it for an Inbox entry. */
const productNote = (id: string): string => withRemotePrivateNote({ kind: 'source_answer', status: 'answered', answer: 'x', citations: [] }, id).private_note as string;

describe('the Private note and its link', () => {
  test('what the product writes is what the check accepts: the fixed sentence and one Open link', () => {
    const note = productNote(ID);
    expect(note).toBe(`${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${ID})`);
    const verdict = judgeNote(note, privateQuestion.text);
    expect(verdict.shape.ok).toBe(true);
    expect(verdict.opaque.ok).toBe(true);
    expect(verdict.id).toBe(ID);
  });

  test('a note without a link, a different sentence, a longer id, a second link, or text after the link is refused', () => {
    expect(judgeNote(REMOTE_PRIVATE_NOTE, 'q').shape.ok).toBe(false);
    expect(judgeNote(null, 'q').shape.ok).toBe(false);
    expect(judgeNote(`Look in Olympus. [Open answer](olympus://open/private/${ID})`, 'q').shape.ok).toBe(false);
    expect(judgeNote(`${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${ID}X)`, 'q').shape.ok).toBe(false);
    expect(judgeNote(`${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${ID}) [again](olympus://open/private/${OTHER})`, 'q').shape.ok).toBe(false);
    expect(judgeNote(`${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${ID}) Your resting heart rate was 52 bpm.`, 'q').shape.ok).toBe(false);
    expect(judgeNote(`${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/dashboard)`, 'q').shape.ok).toBe(false);
  });

  test('an id that holds a word of the question is not an opaque locator', () => {
    const word = 'cardiology'.padEnd(22, 'X');
    const verdict = judgeNote(`${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${word})`, privateQuestion.text);
    expect(verdict.shape.ok).toBe(true);
    expect(verdict.opaque.ok).toBe(false);
  });

  test('links and notes are found in a tool result however it is carried', () => {
    const output = { kind: 'source_answer', status: 'answered', answer: 'a', citations: [], private_note: productNote(ID) };
    const text = JSON.stringify(output, null, 2);
    expect(privateNoteIn(text)).toBe(productNote(ID));
    expect(privateNoteIn('not json', output)).toBe(productNote(ID));
    expect(privateNoteIn(`prefix ${productNote(ID)} suffix`.replace(' suffix', '"'))).toBe(productNote(ID));
    expect(privateNoteIn('{"answer":"nothing"}')).toBeNull();
    expect(privateLinkIdsIn(`${text} ${text}`)).toEqual([ID]);
    expect(privateLinkIdsIn(`olympus://open/private/${ID}extra`)).toEqual([]);
    expect(privateLinkIdsIn(`a olympus://open/private/${ID} b olympus://open/private/${OTHER}`)).toEqual([ID, OTHER]);
  });

  test('a Private fact or marker planted in the note fails "carries nothing"', () => {
    const planted = `${productNote(ID)} ${PRIVATE_FACTS[0]}`;
    const clean = noteChecks('p', 'agent', productNote(ID), privateQuestion.text, markers);
    expect(clean.checks.map((c) => c.status)).toEqual(['pass', 'pass']);
    expect(clean.id).toBe(ID);
    const dirty = noteChecks('p', 'agent', planted, privateQuestion.text, markers);
    expect(dirty.checks.find((c) => c.id === 'p.link')?.status).toBe('fail');
    expect(dirty.checks.find((c) => c.id === 'p.link-carries-nothing')?.status).toBe('fail');
    expect(JSON.stringify(dirty.checks)).not.toContain(PRIVATE_FACTS[0]);
    expect(JSON.stringify(noteChecks('p', 'agent', `${productNote(ID)} ${PRIVATE_MARKER}`, 'q', markers).checks)).not.toContain(PRIVATE_MARKER);
  });
});

describe('an agent\'s Private question in the suite', () => {
  const observation = (over: Partial<QuestionObservation> = {}): QuestionObservation => ({
    question: privateQuestion,
    visible: [{ label: 'reply', text: productNote(ID) }, { label: 'tool output', text: JSON.stringify({ private_note: productNote(ID) }) }],
    answerText: productNote(ID),
    evidenceTitles: [],
    privateNote: true,
    privateNoteText: productNote(ID),
    ms: 1,
    ...over,
  });
  const status = (checks: ReturnType<typeof evaluateObservation>, id: string): string | undefined => checks.find((c) => c.id === id)?.status;

  test('the link checks join the note check, and an agent that passes the note on passes them', () => {
    const checks = evaluateObservation(observation(), markers);
    expect(checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(['private-medical.private-note', 'private-medical.link', 'private-medical.link-carries-nothing', 'private-medical.link-relayed']));
  });

  test('an agent that drops the link is a warning, not a failure; a planted Private string in its reply is a failure', () => {
    const dropped = evaluateObservation(observation({ answerText: 'The answer is in Olympus.' }), markers);
    expect(status(dropped, 'private-medical.link-relayed')).toBe('warn');
    expect(dropped.some((c) => c.status === 'fail')).toBe(false);
    const planted = evaluateObservation(observation({ visible: [{ label: 'reply', text: `${productNote(ID)} ${PRIVATE_FACTS[1]}` }] }), markers);
    expect(status(planted, 'private-medical.no-leak')).toBe('fail');
  });

  test('a surface whose note has no link to judge (the ChatGPT panel) is not asked for one', () => {
    const { privateNoteText: _omit, ...panel } = observation();
    const checks = evaluateObservation(panel, markers);
    expect(checks.some((c) => c.id.includes('link'))).toBe(false);
  });

  test('no note at all fails the note and the link', () => {
    const checks = evaluateObservation(observation({ privateNote: false, privateNoteText: null }), markers);
    expect(status(checks, 'private-medical.private-note')).toBe('fail');
    expect(status(checks, 'private-medical.link')).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// The checks over what the owner's browser showed

const FACTS = [true, true];
const entry = (id: string, over: Partial<EntryView> = {}): EntryView => ({ id, listed: true, path: 'private', fromShown: true, questionMatches: true, status: 'answered', factsStated: FACTS, citations: 1, citesExpected: true, waitedS: 30, ...over });
const link = (href: string, text: string, over: Partial<NonNullable<CardView['control']>> = {}): CardView['control'] => ({ tag: 'a', text, href, action: null, submit: false, disabled: false, ...over });

function good(): InboxObservation {
  return {
    ok: true,
    ownerPath: { bearerStatus: 403, unlockOffered: true, unlocked: true },
    destinations: {
      computer: { state: 'ready', status: 'Ready', reason: '', control: { tag: 'button', text: COPY.askComputer, href: null, action: 'ask', submit: true, disabled: false } },
      venice: { state: 'not_set_up', status: 'Not connected', reason: COPY.veniceNotSetUp, control: link('/dashboard?keys#venice-setup', COPY.setUpVenice) },
      anonymous: { state: 'not_set_up', status: 'Not connected', reason: COPY.zkapiNotSetUp, control: link('/dashboard?keys#anonymous', COPY.setUpZkapi) },
    },
    entries: [entry(ID), entry(OTHER, { status: 'answering', factsStated: [], citations: 0, citesExpected: false })],
    pages: [{ id: ID, landedOnInbox: true, rowFound: true, opened: true, factsStated: FACTS, citations: 1, citesExpected: true }],
    ask: { pressed: true, answered: true, message: '', factsStated: FACTS, citations: 1, citesExpected: true, ms: 31_000, entry: entry(NEW) },
    fixes: { venice: { clicked: true, landedAt: '/dashboard?keys#venice-setup', anchorShown: true }, anonymous: { clicked: true, landedAt: '/dashboard?keys#anonymous', anchorShown: true } },
    refusals: { venice: 403 },
    egress: { samples: 900, intervalMs: 150, baseline: 3, fresh: [], pageRequests: 40, pageOutside: [] },
    shots: [],
  };
}
const ctx = { scriptedId: ID, agentLinks: [{ agent: 'xai', id: OTHER }] };
const failing = (obs: InboxObservation, c = ctx): string[] => evaluateInbox(obs, c).filter((check) => check.status === 'fail').map((check) => check.id);

describe('the Inbox checks', () => {
  test('a clean visit passes every check, and each check is named for what it proves', () => {
    const checks = evaluateInbox(good(), ctx);
    expect(checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      'inbox.owner-path', 'inbox.agent.entry', 'inbox.agent.answered', 'inbox.agent.page', 'inbox.xai.entry', 'inbox.ask.page', 'inbox.venice.route',
      'inbox.zkapi.route', 'inbox.no-send', 'inbox.ask.answer', 'inbox.ask.in-inbox', 'inbox.stays-here',
    ]);
  });

  const faults: Array<[string, (obs: InboxObservation) => void, string]> = [
    ['a bearer session that the Inbox did not refuse', (o) => { o.ownerPath.bearerStatus = 200; }, 'inbox.owner-path'],
    ['an Unlock that was not offered', (o) => { o.ownerPath.unlockOffered = false; }, 'inbox.owner-path'],
    ['controls that did not open after Unlock', (o) => { o.ownerPath.unlocked = false; }, 'inbox.owner-path'],
    ['a link id that is not in the Inbox', (o) => { o.entries[0] = entry(ID, { listed: false, path: null, fromShown: false, questionMatches: null, status: null, factsStated: [], citations: 0, citesExpected: false }); }, 'inbox.agent.entry'],
    ['an entry that is another path (Venice)', (o) => { o.entries[0] = entry(ID, { path: 'venice' }); }, 'inbox.agent.entry'],
    ['an entry that says nothing about where it came from', (o) => { o.entries[0] = entry(ID, { fromShown: false }); }, 'inbox.agent.entry'],
    ['an entry for a different question', (o) => { o.entries[0] = entry(ID, { questionMatches: false }); }, 'inbox.agent.entry'],
    ['an answer the local model never gave', (o) => { o.entries[0] = entry(ID, { status: 'answering', factsStated: [], citations: 0, citesExpected: false }); }, 'inbox.agent.answered'],
    ['an answer that leaves out a Private fact', (o) => { o.entries[0] = entry(ID, { factsStated: [true, false] }); }, 'inbox.agent.answered'],
    ['an answer with no sources', (o) => { o.entries[0] = entry(ID, { citations: 0 }); }, 'inbox.agent.answered'],
    ['an answer that does not name the Private item', (o) => { o.entries[0] = entry(ID, { citesExpected: false }); }, 'inbox.agent.answered'],
    ['an address that did not land on the Inbox', (o) => { o.pages[0]!.landedOnInbox = false; }, 'inbox.agent.page'],
    ['an address that did not open the entry', (o) => { o.pages[0]!.opened = false; }, 'inbox.agent.page'],
    ['an address whose row was not on the page', (o) => { o.pages[0]!.rowFound = false; o.pages[0]!.opened = false; }, 'inbox.agent.page'],
    ['no page opened for the link', (o) => { o.pages.length = 0; }, 'inbox.agent.page'],
    ['a model agent\'s link that is not in the Inbox', (o) => { o.entries[1] = entry(OTHER, { listed: false }); }, 'inbox.xai.entry'],
    ['a local model that is not ready on the Ask page', (o) => { o.destinations.computer!.state = 'not_set_up'; }, 'inbox.ask.page'],
    ['an Ask button with other words', (o) => { o.destinations.computer!.control!.text = 'Ask'; }, 'inbox.ask.page'],
    ['a Venice row with a button that submits', (o) => { o.destinations.venice!.control = { tag: 'button', text: COPY.askVenice, href: null, action: 'ask_venice', submit: true, disabled: false }; }, 'inbox.venice.route'],
    ['a Venice link to the wrong section', (o) => { o.destinations.venice!.control = link('/dashboard?keys#anonymous', COPY.setUpVenice); }, 'inbox.venice.route'],
    ['a Venice row that says nothing about why', (o) => { o.destinations.venice!.reason = ''; }, 'inbox.venice.route'],
    ['a Venice link that landed nowhere', (o) => { o.fixes.venice = { clicked: true, landedAt: '/dashboard', anchorShown: false }; }, 'inbox.venice.route'],
    ['a Venice link that was never pressed', (o) => { o.fixes.venice = null; }, 'inbox.venice.route'],
    ['a zkAPI row that is ready to send while not set up', (o) => { o.destinations.anonymous!.control = { tag: 'button', text: COPY.askZkapi, href: null, action: 'ask_anonymous', submit: true, disabled: false }; }, 'inbox.zkapi.route'],
    ['a zkAPI link to the wrong section', (o) => { o.destinations.anonymous!.control = link('/dashboard?keys#venice-setup', COPY.setUpZkapi); }, 'inbox.zkapi.route'],
    ['a Venice ask that the route took', (o) => { o.refusals.venice = 200; }, 'inbox.no-send'],
    ['a Venice ask that was never tried', (o) => { o.refusals.venice = null; }, 'inbox.no-send'],
    ['a zkAPI row that offers a send', (o) => { o.destinations.anonymous!.control = { tag: 'button', text: COPY.askZkapi, href: null, action: 'ask_anonymous', submit: true, disabled: false }; }, 'inbox.no-send'],
    ['an Ask that was never pressed', (o) => { o.ask = { pressed: false, answered: false, message: '', factsStated: [], citations: 0, citesExpected: false, ms: 0, entry: null }; }, 'inbox.ask.answer'],
    ['an Ask that got no answer', (o) => { o.ask!.answered = false; o.ask!.message = 'Nothing on this computer answers this.'; }, 'inbox.ask.answer'],
    ['an Ask answer without sources', (o) => { o.ask!.citations = 0; }, 'inbox.ask.answer'],
    ['an Ask answer that misses a Private fact', (o) => { o.ask!.factsStated = [true, false]; }, 'inbox.ask.answer'],
    ['an Ask that left no Inbox entry', (o) => { o.ask!.entry = null; }, 'inbox.ask.in-inbox'],
    ['an Ask entry not yet answered', (o) => { o.ask!.entry = entry(NEW, { status: 'answering', factsStated: [], citations: 0, citesExpected: false }); }, 'inbox.ask.in-inbox'],
    ['a connection the product opened to another machine', (o) => { o.egress.fresh = ['203.0.113.7:443 (bun)']; }, 'inbox.stays-here'],
    ['a page request to another machine', (o) => { o.egress.pageOutside = ['api.venice.ai']; }, 'inbox.stays-here'],
    ['a watch that never sampled', (o) => { o.egress.samples = 0; }, 'inbox.stays-here'],
  ];
  for (const [name, mutate, id] of faults) {
    test(`${name} fails ${id}`, () => {
      const obs = good();
      mutate(obs);
      expect(failing(obs)).toContain(id);
    });
  }

  test('a fault fails its own check and not the unrelated ones', () => {
    const obs = good();
    obs.egress.fresh = ['203.0.113.7:443 (bun)'];
    expect(failing(obs)).toEqual(['inbox.stays-here']);
    const venice = good();
    venice.fixes.venice = null;
    expect(failing(venice)).toEqual(['inbox.venice.route']);
  });

  test('a visit that did not finish is one failure that says why; no scripted agent link means no entry to find', () => {
    const failed = evaluateInbox({ ...good(), ok: false, detail: 'the page did not open' }, ctx);
    expect(failed.map((c) => [c.id, c.status])).toEqual([['inbox.ran', 'fail']]);
    expect(failed[0]!.detail).toContain('the page did not open');
    const noLink = evaluateInbox(good(), { agentLinks: [] });
    expect(noLink.find((c) => c.id === 'inbox.agent.entry')?.status).toBe('fail');
  });

  describe('an install that offers agents no answer tool (a standard install: olympus_search, no source_answer)', () => {
    const standard = { agentLinks: [], agentLink: 'not_offered' as const, agentTools: ['olympus_search', 'source_answer_result', 'source_index_status'] };
    // No link came from an agent: the Ask page's own entry is opened by its address instead.
    const standardGood = (): InboxObservation => {
      const obs = good();
      obs.entries = [];
      obs.pages = [{ id: NEW, landedOnInbox: true, rowFound: true, opened: true, factsStated: FACTS, citations: 1, citesExpected: true }];
      return obs;
    };

    test('the link path is a visible skip that names why and what it needs, and nothing fails', () => {
      const checks = evaluateInbox(standardGood(), standard);
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
      const skipped = checks.find((c) => c.id === 'inbox.agent.link-path')!;
      expect(skipped.status).toBe('skip');
      expect(skipped.detail).toContain('olympus_search, source_answer_result, source_index_status');
      expect(skipped.detail).toContain('answer model');
      expect(checks.some((c) => c.id === 'inbox.agent.entry')).toBe(false);
      expect(checks.find((c) => c.id === 'inbox.link.opens-entry')?.status).toBe('pass');
    });

    test('an entry whose own address did not open it fails inbox.link.opens-entry, whether the page was not opened, the row was missing, or the answer was empty', () => {
      const none = standardGood();
      none.pages = [];
      expect(failing(none, standard as never)).toEqual(['inbox.link.opens-entry']);
      const missing = standardGood();
      missing.pages[0]!.rowFound = false;
      missing.pages[0]!.opened = false;
      expect(failing(missing, standard as never)).toEqual(['inbox.link.opens-entry']);
      const empty = standardGood();
      empty.pages[0]!.factsStated = [false, false];
      expect(failing(empty, standard as never)).toEqual(['inbox.link.opens-entry']);
      const noEntry = standardGood();
      noEntry.ask!.entry = null;
      expect(failing(noEntry, standard as never)).toContain('inbox.link.opens-entry');
    });

    test('the same observation with a link expected is judged as before: the missing link is a failure, not a skip', () => {
      const checks = evaluateInbox(standardGood(), { agentLinks: [] });
      expect(checks.find((c) => c.id === 'inbox.agent.entry')?.status).toBe('fail');
      expect(checks.some((c) => c.id === 'inbox.agent.link-path')).toBe(false);
    });
  });

  test('no check detail holds a Private fact, whatever the observation', () => {
    const obs = good();
    obs.ask!.message = '';
    const text = JSON.stringify(evaluateInbox(obs, ctx));
    for (const marker of markers) expect(text).not.toContain(marker.text);
  });
});

describe('comparing in place', () => {
  test('facts are matched ignoring case and spacing, and sources by the Private item\'s name', () => {
    expect(factsIn('Your resting heart rate was 52  BPM and Lisinopril 5 mg', [...PRIVATE_FACTS])).toEqual([true, true]);
    expect(factsIn('Nothing', [...PRIVATE_FACTS])).toEqual([false, false]);
    expect(factsIn('52 bpm only', [...PRIVATE_FACTS])).toEqual([true, false]);
    expect(sourceNames(['Cardiology follow-up notes · Readwise · 2 Oct'], INBOX_ASK.citedTitle)).toBe(true);
    expect(sourceNames(['Other note'], INBOX_ASK.citedTitle)).toBe(false);
  });

  test('the Ask page question is worded differently from the suite\'s, so the two Inbox entries can be told apart', () => {
    expect(INBOX_ASK.text).not.toBe(privateQuestion.text);
    expect(INBOX_ASK.facts).toEqual([...PRIVATE_FACTS]);
  });
});

// ---------------------------------------------------------------------------
// The connection sampler

/** The hex of an address as /proc/net/tcp prints it: each four bytes in the machine's own byte order. */
function procHex(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) out += bytes.slice(i, i + 4).reverse().map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return out;
}
const ROW = (local: string, remote: string, state: string, inode: string): string => `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

describe('the connection sampler\'s parsers', () => {
  test('addresses are read in the byte order /proc prints them, IPv4, IPv6 and IPv4-mapped', () => {
    expect(procAddress(procHex([93, 179, 193, 213]))).toBe('93.179.193.213');
    expect(procAddress(procHex([127, 0, 0, 1]))).toBe('127.0.0.1');
    expect(procAddress(procHex([0x26, 0x06, 0x47, 0x00, 0x30, 0x30, 0, 0, 0, 0, 0, 0, 0xac, 0x43, 0x9a, 0x5b]))).toBe('2606:4700:3030:0:0:0:ac43:9a5b');
    expect(procAddress(procHex([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4]))).toBe('1.2.3.4');
    expect(procAddress(procHex([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBe('::1');
    expect(procAddress('xyz')).toBeUndefined();
  });

  test('only live, non-loopback connections count: listeners, loopback and closed ones do not', () => {
    const table = [
      HEADER,
      ROW(`${procHex([127, 0, 0, 1])}:1F4A`, '00000000:0000', '0A', '1'),
      ROW(`${procHex([10, 0, 0, 5])}:C3A2`, `${procHex([93, 179, 193, 213])}:01BB`, '01', '22222'),
      ROW(`${procHex([127, 0, 0, 1])}:D2A0`, `${procHex([127, 0, 0, 1])}:1F4A`, '01', '3'),
      ROW(`${procHex([10, 0, 0, 5])}:C3A4`, `${procHex([8, 8, 8, 8])}:01BB`, '06', '0'),
      ROW(`${procHex([10, 0, 0, 5])}:C3A6`, `${procHex([1, 1, 1, 1])}:0050`, '02', '44444'),
    ].join('\n');
    expect(outboundFromProcNet(table)).toEqual([
      { remote: '93.179.193.213:443', inode: '22222' },
      { remote: '1.1.1.1:80', inode: '44444' },
    ]);
    expect(outboundFromProcNet('')).toEqual([]);
  });

  test('lsof output gives the remote end and its owner', () => {
    const out = [
      'p1234', 'cbun', 'n127.0.0.1:8010->127.0.0.1:50000', 'n10.0.0.5:51000->93.184.216.34:443',
      'p999', 'cGoogle Chrome H', 'n10.0.0.5:51001->142.250.1.1:443', 'n[fe80::1]:5353->[2606:4700::1]:443 (ESTABLISHED)', 'n*:8010',
    ].join('\n');
    expect(outboundFromLsof(out)).toEqual([
      { remote: '93.184.216.34:443', pid: 1234, comm: 'bun' },
      { remote: '142.250.1.1:443', pid: 999, comm: 'Google Chrome H' },
      { remote: '2606:4700:0:0:0:0:0:1:443', pid: 999, comm: 'Google Chrome H' },
    ]);
  });

  test('fresh egress is a destination that is new, not the check\'s own browser, and not an address of the relay', () => {
    const fresh = freshEgress({
      baseline: new Set(['93.184.216.34:443']),
      allowedIps: new Set(['104.18.1.1', normalizeIp('2606:4700::1')]),
      seen: [
        { remote: '93.184.216.34:443', comm: 'bun' },
        { remote: '142.250.1.1:443', comm: 'chrome' },
        { remote: '104.18.1.1:443', comm: 'bun' },
        { remote: '2606:4700:0:0:0:0:0:1:443', comm: 'bun' },
        { remote: '8.8.8.8:443', comm: 'bun' },
        { remote: '9.9.9.9:443' },
        { remote: '8.8.8.8:443', comm: 'bun' },
      ],
    });
    expect(fresh).toEqual(['8.8.8.8:443 (bun)', '9.9.9.9:443 (owner unknown)']);
    expect(isBrowserProcess('Google Chrome Helper')).toBe(true);
    expect(isBrowserProcess('bun')).toBe(false);
    expect(normalizeIp('2606:4700::1')).toBe('2606:4700:0:0:0:0:0:1');
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
  });

  test('page requests that are not this machine are named by host', () => {
    expect(requestsOutsideMachine([
      'http://127.0.0.1:8010/dashboard?private-answers', 'http://localhost:8010/x', 'http://[::1]:8010/y', 'data:text/css,a{}', 'about:blank', 'blob:http://127.0.0.1/z',
      'https://api.venice.ai/v1/chat', 'https://api.venice.ai/v1/other', 'not a url',
    ])).toEqual(['(unparseable address)', 'api.venice.ai']);
  });
});

// ---------------------------------------------------------------------------
// The page scripts, against the product's own page

type Page = ReturnType<typeof mountPage>;

function mountPage(options: Parameters<typeof renderDashboardPrivateAnswersPage>[0], answer: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } })) {
  const html = renderDashboardPrivateAnswersPage(options);
  const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?private-answers', settings: { disableJavaScriptEvaluation: true } });
  const document = window.document as unknown as Document;
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/^<body[^>]*>/, '');
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/g, '');
  // happy-dom keeps no layout; the real browser has both of these.
  const proto = (window as unknown as { Element: { prototype: Record<string, unknown> } }).Element.prototype;
  proto.scrollIntoView ??= () => undefined;
  const posts: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchStub = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const parsed = JSON.parse(init.body) as Record<string, unknown>;
    posts.push({ url, body: parsed, headers: init.headers });
    const reply = answer(parsed);
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  const script = scripts.find((code) => code.includes('[data-private-answers]'));
  // The page's own script, run the way a browser would (its timers collected, not run).
  const pageWindow = { location: window.location, confirm: () => true, addEventListener: () => undefined, setTimeout: () => undefined } as Record<string, unknown>;
  if (script) new Function('window', 'document', 'fetch', script)(pageWindow, document, fetchStub);
  const mounted = {
    html, document, window, posts,
    /** Runs one of the check's page scripts the way the browser's console does. */
    run: async (source: string): Promise<unknown> => await new Function('document', 'location', 'fetch', `return ${source};`)(document, window.location, fetchStub),
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
  return mounted;
}

const SOON = new Date('2026-10-14T12:00:00Z');
const waiting = (questions: Array<Record<string, unknown>>) => ({ questions: questions as never, olderRemoved: false });
const entryRow = { id: ID, question: privateQuestion.text, from: 'An agent', askedAt: new Date(SOON.getTime() - 3_600_000).toISOString(), unchecked: false, state: 'answered', unread: true, path: 'private' };
const localOptions = (extra: Record<string, unknown> = {}) => ({
  now: SOON, controlSessionCsrfToken: 'csrf-token', outsideHelpLocalSession: true,
  privateAnswers: { available: true, destinations: { computer: 'ready', venice: 'not_set_up' }, waiting: waiting([entryRow]) },
  ...extra,
}) as Parameters<typeof renderDashboardPrivateAnswersPage>[0];

describe('the page scripts read the product\'s own page', () => {
  test('the route the scripts call is the route the product serves', () => {
    expect(PRIVATE_ANSWERS_POST_PATH).toBe(DASHBOARD_PRIVATE_ANSWERS_PATH);
  });

  test('the three destinations, their states and the control each offers are read as the product renders them', async () => {
    const page = mountPage(localOptions());
    const state = await page.run(PAGE_STATE).then((json) => JSON.parse(String(json))) as { cards: Record<string, CardView>; unlock: boolean; ask: boolean; page: boolean; rows: Array<{ id: string; question: string; from: string; unread: boolean }> };
    expect(Object.keys(state.cards).sort()).toEqual(['anonymous', 'computer', 'venice']);
    expect(state.cards.computer).toMatchObject({ state: 'ready', control: { tag: 'button', text: COPY.askComputer, action: 'ask', submit: true } });
    expect(state.cards.venice).toMatchObject({ state: 'not_set_up', reason: COPY.veniceNotSetUp, control: { tag: 'a', text: COPY.setUpVenice, href: '/dashboard?keys#venice-setup', submit: false, action: null } });
    expect(state.cards.anonymous).toMatchObject({ state: 'not_set_up', control: { tag: 'a', text: COPY.setUpZkapi, href: '/dashboard?keys#anonymous', submit: false } });
    expect(state.cards.venice!.status).toBe(COPY.notConnectedStatus);
    expect(state.page && state.ask && !state.unlock).toBe(true);
    expect(state.rows).toEqual([{ id: ID, question: privateQuestion.text, from: expect.stringContaining('An agent'), unread: true }]);
    expect(await page.run(PAGE_UNLOCKED)).toBe(true);
    expect(await page.run(PAGE_UNLOCK_OFFERED)).toBe(false);
  });

  test('a launch session sees Unlock and no controls; a page with no session is locked', async () => {
    const launch = mountPage(localOptions({ outsideHelpLocalSession: false }));
    expect(await launch.run(PAGE_UNLOCK_OFFERED)).toBe(true);
    expect(await launch.run(PAGE_UNLOCKED)).toBe(false);
    const locked = mountPage({ now: SOON } as never);
    expect(await locked.run(PAGE_UNLOCK_OFFERED)).toBe(false);
    expect(await locked.run(PAGE_UNLOCKED)).toBe(false);
    const state = JSON.parse(String(await locked.run(PAGE_STATE))) as { locked: boolean };
    expect(state.locked).toBe(true);
  });

  test('a destination that is ready shows no link; a model that is still downloading shows the way to the Models page', async () => {
    const downloading = mountPage(localOptions({ privateAnswers: { available: true, destinations: { computer: 'not_set_up', venice: 'not_set_up' }, waiting: waiting([]) } }));
    const state = JSON.parse(String(await downloading.run(PAGE_STATE))) as { cards: Record<string, CardView> };
    expect(state.cards.computer).toMatchObject({ state: 'not_set_up', control: { tag: 'a', submit: false } });
  });

  test('the route is called as the page calls it: its own CSRF token, no bearer', async () => {
    const page = mountPage(localOptions(), (body) => (body.action === 'list' ? { status: 200, body: { ok: true, questions: [{ id: ID }] } } : { status: 403, body: { ok: false } }));
    // The page's script (kept out of the DOM above) holds the token the call reads.
    const script = document_scripts(page.html);
    page.document.body.appendChild(Object.assign(page.document.createElement('script'), { textContent: script }));
    const listed = JSON.parse(String(await page.run(pageApi({ action: 'list' })))) as { status: number; body: { questions: Array<{ id: string }> } };
    expect(listed.status).toBe(200);
    expect(listed.body.questions[0]!.id).toBe(ID);
    expect(page.posts.at(-1)).toMatchObject({ url: DASHBOARD_PRIVATE_ANSWERS_PATH, body: { action: 'list' }, headers: { 'X-Olympus-CSRF': 'csrf-token' } });
    expect(Object.keys(page.posts.at(-1)!.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
    const refused = JSON.parse(String(await page.run(pageApi({ action: 'ask_venice', question: 'q' })))) as { status: number };
    expect(refused.status).toBe(403);
  });

  test('an opened Inbox row, and an answer on the Ask form, are read as the page renders them', async () => {
    const answered = { ok: true, status: 'answered', generation: 1, answer: 'Resting **52 bpm**, lisinopril 5 mg.', citations: [{ title: 'Cardiology follow-up notes', source: 'Readwise', date: '2 Oct' }], unanswered: [], left_out: [] };
    const page = mountPage(localOptions(), (body) => (body.action === 'read' || body.action === 'ask' ? { status: 200, body: answered } : { status: 200, body: { ok: true, status: 'read' } }));

    // Before it is opened the row is there with no answer.
    const closed = JSON.parse(String(await page.run(rowView(ID)))) as { found: boolean; opened: boolean };
    expect(closed).toMatchObject({ found: true, opened: false });
    expect(JSON.parse(String(await page.run(rowView('NotThere'.padEnd(22, 'x')))))).toEqual({ found: false });

    // The owner presses the row; the page reads it and shows the answer with its sources.
    (page.document.querySelector(`[data-pa-question="${ID}"] [data-pa-read]`) as unknown as { click(): void }).click();
    await page.settle();
    const opened = JSON.parse(String(await page.run(rowView(ID)))) as { found: boolean; opened: boolean; answer: string; sources: string[] };
    expect(opened.opened).toBe(true);
    expect(factsIn(opened.answer, [...PRIVATE_FACTS])).toEqual([true, true]);
    expect(sourceNames(opened.sources, INBOX_ASK.citedTitle)).toBe(true);
    expect(opened.sources).toHaveLength(1);

    // Typing into the Ask form and pressing the local model's button.
    expect(await page.run(FOCUS_QUESTION)).toBe(true);
    const field = page.document.querySelector('textarea[name="question"]') as unknown as { value: string };
    field.value = INBOX_ASK.text;
    page.document.querySelector('form[data-pa-ask]')!.dispatchEvent(new (page.window as unknown as { Event: typeof Event }).Event('submit', { bubbles: true, cancelable: true }));
    await page.settle();
    const view = JSON.parse(String(await page.run(ASK_VIEW))) as { found: boolean; answer: string; sources: string[]; busy: boolean; error: boolean };
    expect(view).toMatchObject({ found: true, busy: false, error: false });
    expect(factsIn(view.answer, [...PRIVATE_FACTS])).toEqual([true, true]);
    expect(sourceNames(view.sources, INBOX_ASK.citedTitle)).toBe(true);
    expect(page.posts.some((post) => post.body.action === 'ask' && post.body.question === INBOX_ASK.text)).toBe(true);
  });

  test('a click target is found by selector, and a missing one is null; a section is shown only when present', async () => {
    const page = mountPage(localOptions());
    const box = JSON.parse(String(await page.run(centerOf('form[data-pa-ask] button[data-pa-destination="computer"]')))) as { x: number; y: number };
    expect(typeof box.x).toBe('number');
    expect(await page.run(centerOf('#nope'))).toBeNull();
    expect(await page.run(anchorPresent('nope'))).toBe(false);
  });
});

/** The page's own script text, which holds the CSRF token the check reads. */
function document_scripts(html: string): string {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).filter((code) => code.includes('csrfToken')).join('\n');
}
