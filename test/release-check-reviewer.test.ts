// The AI reviewer: what it is shown from a finished run, what it keeps of a model's answer, that a unit it cannot answer is
// inconclusive and never a pass, and that its findings are listed in the report without changing the verdict.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { StepTrace } from '../scripts/release-check/journey.ts';
import { buildReport, renderHtml, type MachineReport } from '../scripts/release-check/report.ts';
import { isLayoutRule } from '../scripts/release-check/layout-rules.ts';
import { PLANTS, PLANT_SCREENS, type PlantedPicture } from '../scripts/release-check/reviewer-plants.ts';
import { qualificationUnits, scoreQualification, summarise } from '../scripts/release-check/reviewer-qualify.ts';
import { parseCli } from '../scripts/release-check/run.ts';
import { chatModel, loadReviewerConfig, readFindings, review, reviewPrompt, unitsFromReport, PRODUCT_WORDS, REVIEW_KINDS, type ReviewFinding, type ReviewModel, type ReviewUnit } from '../scripts/release-check/reviewer.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function reportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rc-review-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'review'));
  for (const name of ['dashboard-390-light.png', 'keys-1280-dark.png', 'notes.txt']) writeFileSync(join(dir, 'review', name), 'x');
  return dir;
}

const step = (n: number, screenshot?: string): StepTrace => ({ n, name: `Step ${n}`, action: `press ${n}`, expected: `outcome ${n}`, actual: `found ${n}`, ok: true, ms: 1, at: '/dashboard', ...(screenshot ? { screenshot } : {}), consoleErrors: [], failedRequests: [], findings: [] });

function machine(extra: Partial<MachineReport> = {}): MachineReport {
  return {
    id: 'm1', label: 'Linux VM', os: 'linux', driver: 'test', timings: {}, checks: [{ id: 'c1', title: 'Install', status: 'pass' }],
    agents: [{ id: 'a1', label: 'Agent', kind: 'model', ran: true, checks: [{ id: 'q1', title: 'Answer', status: 'pass' }] }],
    screenshots: [{ label: '1280 px wide, dark', path: 'screenshots/dashboard-1280-dark.png' }, { label: 'a log', path: 'logs/run.log' }],
    logs: [],
    traces: [{ id: 'privacy', title: 'Privacy settings', source: 'test', ok: true, ms: 1, steps: [step(1, 'privacy/01.jpg'), step(2), step(3, 'privacy/03.jpg')] }],
    ...extra,
  };
}

describe('what the reviewer is shown', () => {
  test('the unmasked screens, the dashboard screenshots and each journey\'s pictures, each with the steps that reach it', () => {
    const units = unitsFromReport(machine(), reportDir());
    expect(units.map((unit) => unit.id)).toEqual(['screen:dashboard-390-light', 'screen:keys-1280-dark', 'shot:screenshots/dashboard-1280-dark.png', 'journey:privacy']);
    expect(units[1]!.pictures[0]).toEqual({ path: 'review/keys-1280-dark.png', caption: 'the Keys page at 1280 px wide in the dark theme', steps: ['Open the Keys page in a window 1280 px wide, dark theme'] });
    const journey = units[3]!;
    expect(journey.pictures.map((picture) => picture.path)).toEqual(['traces/privacy/01.jpg', 'traces/privacy/03.jpg']);
    // A picture's steps include the steps before it that took no picture.
    expect(journey.pictures[1]!.steps).toEqual(['Step 1 (press 1)', 'Step 2 (press 2)', 'Step 3 (press 3)']);
    expect(journey.pictures[1]!.caption).toContain('The check expected outcome 3');
  });

  test('a trace listed both with the journeys and with the crawl is looked at once', () => {
    const report = machine();
    const units = unitsFromReport({ ...report, explore: { traces: [report.traces![0]!], pages: { traces: [report.traces![0]!] } } as unknown as NonNullable<MachineReport['explore']> }, reportDir());
    expect(units.filter((unit) => unit.id === 'journey:privacy')).toHaveLength(1);
  });

  test('a long journey is cut into parts, in order, so no request carries too many pictures', () => {
    const long = machine({ screenshots: [], traces: [{ id: 'long', title: 'Long', source: 'test', ok: true, ms: 1, steps: Array.from({ length: 5 }, (_, i) => step(i + 1, `long/${i + 1}.jpg`)) }] });
    const units = unitsFromReport(long, mkdtempSync(join(tmpdir(), 'rc-review-')), 2);
    expect(units.map((unit) => [unit.id, unit.pictures.length])).toEqual([['journey:long#1', 2], ['journey:long#2', 2], ['journey:long#3', 1]]);
    expect(units[2]!.title).toBe('Long (part 3 of 3)');
    expect(units[2]!.pictures[0]!.steps).toHaveLength(5);
  });

  test('the prompt carries the checklist, the product\'s own words and the pictures\' captions; a screen is not asked about outcomes', () => {
    const [screen, , , journey] = unitsFromReport(machine(), reportDir());
    const forScreen = reviewPrompt(screen!);
    for (const word of PRODUCT_WORDS) expect(forScreen).toContain(word);
    expect(forScreen).toContain(REVIEW_KINDS.contradiction);
    expect(forScreen).not.toContain(REVIEW_KINDS.outcome);
    const forJourney = reviewPrompt(journey!);
    expect(forJourney).toContain(REVIEW_KINDS.outcome);
    expect(forJourney).toContain('Picture 2: after "Step 3"');
  });
});

describe('what it keeps of an answer', () => {
  const unit: ReviewUnit = { id: 'screen:x', kind: 'screen', title: 'X', pictures: [{ path: 'review/x.png', caption: 'x', steps: ['Open x'] }] };

  test('a finding must name one of the unit\'s pictures and a kind on the checklist, at or above the confidence floor', () => {
    const answer = JSON.stringify({ findings: [
      { picture: 1, kind: 'words', what: 'The status says ERR_SCOPE_ROOT_MISSING', where: 'Gmail row', confidence: 'high' },
      { picture: 2, kind: 'words', what: 'no such picture', confidence: 'high' },
      { picture: 1, kind: 'taste', what: 'not a kind on the list', confidence: 'high' },
      { picture: 1, kind: 'layout', what: 'the look is the layout rules\' since 2026-10-25', confidence: 'high' },
      { picture: 1, kind: 'outcome', what: 'outcome is for journeys only', confidence: 'high' },
      { picture: 1, kind: 'words', what: '', confidence: 'high' },
      { picture: 1, kind: 'words', what: 'unsure', confidence: 'low' },
    ] });
    const read = readFindings(unit, `\`\`\`json\n${answer}\n\`\`\``, 'medium');
    expect(read.findings).toEqual([{ unit: 'screen:x', unitTitle: 'X', picture: 'review/x.png', kind: 'words', what: 'The status says ERR_SCOPE_ROOT_MISSING', where: 'Gmail row', confidence: 'high', steps: ['Open x'] }]);
    expect(read.dropped).toBe(6);
  });

  test('an answer that is not the JSON asked for is an error, not an empty review', () => {
    expect(() => readFindings(unit, 'Looks fine to me!', 'medium')).toThrow();
    expect(() => readFindings(unit, '{"verdict":"ok"}', 'medium')).toThrow('no findings list');
  });
});

describe('asking the model', () => {
  test('every unit is asked, a few at a time; a unit that errs or answers badly is inconclusive, never a pass', async () => {
    const units = unitsFromReport(machine(), reportDir());
    let running = 0;
    let most = 0;
    const model: ReviewModel = {
      name: 'fake',
      async ask(prompt, pictures) {
        running += 1; most = Math.max(most, running);
        await new Promise((done) => setTimeout(done, 5));
        running -= 1;
        expect(pictures[0]!.mime).toBe(prompt.includes('Privacy settings') ? 'image/jpeg' : 'image/png');
        if (prompt.includes('Keys page')) throw new Error('the model answered 503: busy');
        if (prompt.includes('1280 px wide, dark')) return 'no JSON here';
        return JSON.stringify({ findings: prompt.includes('Privacy settings') ? [{ picture: 2, kind: 'outcome', what: 'Nothing says the sender was refused', where: 'under the field', confidence: 'medium' }] : [] });
      },
    };
    const result = await review(units, model, { concurrency: 2, timeoutMs: 1_000, minConfidence: 'medium', status: 'advisory', read: () => Buffer.from('x') });
    expect(most).toBe(2);
    expect(result.units).toBe(4);
    expect(result.pictures).toBe(5);
    expect(result.findings.map((finding) => [finding.unit, finding.picture])).toEqual([['journey:privacy', 'traces/privacy/03.jpg']]);
    expect(result.inconclusive.map((entry) => entry.unit).sort()).toEqual(['screen:keys-1280-dark', 'shot:screenshots/dashboard-1280-dark.png']);
    expect(result.inconclusive.find((entry) => entry.unit === 'screen:keys-1280-dark')!.reason).toContain('503');
  });

  test('the chat client sends the prompt and the pictures, asks for JSON, and reports a refusal with its status', async () => {
    const sent: Array<{ url: string; body: any; auth: string | null }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
      return sent.length === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] })) : new Response('quota', { status: 429 });
    }) as unknown as typeof fetch;
    const model = chatModel({ baseUrl: 'https://api.example.test/v1/', model: 'some-model', key: 'k', fetch: fake });
    expect(await model.ask('look', [{ mime: 'image/png', data: Buffer.from('png') }], 1_000)).toBe('{"findings":[]}');
    expect(sent[0]!.url).toBe('https://api.example.test/v1/chat/completions');
    expect(sent[0]!.auth).toBe('Bearer k');
    expect(sent[0]!.body.model).toBe('some-model');
    expect(sent[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(sent[0]!.body.messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`);
    await expect(model.ask('look', [], 1_000)).rejects.toThrow('429');
  });

  test('the shipped settings are advisory, name the key by its variable, and drop unsure findings', () => {
    const config = loadReviewerConfig();
    expect(config.status).toBe('advisory');
    expect(config.keyEnv).toMatch(/^[A-Z_]+$/);
    expect(config.minConfidence).not.toBe('low');
  });
});

describe('in the report', () => {
  test('findings are listed with their picture and steps, and never change the verdict', () => {
    const base = { runId: 'r', candidate: { label: 'main' }, startedAt: 'a', finishedAt: 'b', errors: [] };
    const before = buildReport({ ...base, machines: [machine()] });
    const reviewed = machine({ review: {
      model: 'fake', status: 'advisory', units: 4, pictures: 5, dropped: 1, ms: 10,
      findings: [{ unit: 'journey:privacy', unitTitle: 'Privacy settings', picture: 'traces/privacy/03.jpg', kind: 'outcome', what: 'Nothing says the sender was refused', where: 'under the field', confidence: 'medium', steps: ['Step 1 (press 1)', 'Step 3 (press 3)'] }],
      inconclusive: [{ unit: 'screen:keys-1280-dark', reason: 'the model answered 503' }],
    } });
    const after = buildReport({ ...base, machines: [reviewed] });
    expect(after.verdict).toBe(before.verdict);
    expect(after.counts).toEqual(before.counts);
    const html = renderHtml(after);
    expect(html).toContain('AI reviewer');
    expect(html).toContain('ADVISORY');
    expect(html).toContain('Nothing says the sender was refused');
    expect(html).toContain('src="traces/privacy/03.jpg"');
    expect(html).toContain('<li>Step 3 (press 3)</li>');
    expect(html).toContain('screen:keys-1280-dark: the model answered 503');
    expect(html).toContain('1 more named no picture');
  });
});

/** A dashboard-like page in a DOM, with boxes, the way the planted bugs meet the panel. */
function dashboardPage(): Window {
  const window = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  (window.Element.prototype as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = () => ({ left: 10, top: 10, width: 200, height: 24, right: 210, bottom: 34 });
  window.document.body.innerHTML = `<main class="page"><h1>Olympus</h1><h2>Sources</h2>
    <div class="row"><strong>Readwise</strong><p class="muted">Checking Readwise…</p><button>Sync now</button></div>
    <div class="row"><strong>Gmail</strong><p class="muted">Not connected</p><button>Connect</button></div>
    <div class="row"><strong>Dropbox</strong><p class="muted">Not connected</p><button>Connect</button></div>
    <details><summary>Models — Built-in · Ready</summary><ul><li>Search: Built-in</li></ul></details></main>`;
  return window;
}
const runIn = (window: Window, script: string): unknown => new Function('window', 'document', 'getComputedStyle', `return ${script};`)(window, window.document, window.getComputedStyle.bind(window));

describe('qualifying the reviewer', () => {
  test('each planted bug plants itself on a dashboard page and marks what it changed; nothing is planted on an empty page', () => {
    expect(new Set(PLANTS.map((plant) => plant.id)).size).toBe(PLANTS.length);
    // The reviewer's held-out bugs are of its own kinds; the look bugs are the layout rules', written after the plants.
    expect(PLANTS.filter((plant) => plant.heldOut).map((plant) => plant.id)).toEqual(['state-contradiction']);
    for (const plant of PLANTS) {
      const page = dashboardPage();
      expect(runIn(page, plant.script), plant.id).toBe(true);
      expect(page.document.querySelectorAll('[data-rc-plant]').length, plant.id).toBeGreaterThan(0);
      const empty = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
      empty.document.body.innerHTML = '<iframe></iframe>';
      expect(runIn(empty, plant.script), `${plant.id} on an empty page`).toBe(false);
    }
    const misaligned = dashboardPage();
    runIn(misaligned, PLANTS.find((plant) => plant.id === 'button-misaligned')!.script);
    // The second of the two Connect buttons is the one moved.
    expect(misaligned.document.querySelectorAll('button')[2]!.getAttribute('data-rc-plant')).toBe('');
    const words = dashboardPage();
    runIn(words, PLANTS.find((plant) => plant.id === 'developer-words')!.script);
    expect(words.document.body.textContent).toContain('ERR_SCOPE_ROOT_MISSING');
    expect(PLANT_SCREENS.length).toBeGreaterThanOrEqual(4);
  });

  const pictures: PlantedPicture[] = [
    { screen: 'dashboard', width: 1280, theme: 'light', picture: 'dashboard-1280-light/clean.png', plant: null, kind: null, heldOut: false },
    { screen: 'dashboard', width: 1280, theme: 'light', picture: 'dashboard-1280-light/state-contradiction.png', plant: 'state-contradiction', kind: 'contradiction', heldOut: true },
    { screen: 'dashboard', width: 1280, theme: 'light', picture: 'dashboard-1280-light/developer-words.png', plant: 'developer-words', kind: 'words', heldOut: false },
    { screen: 'keys', width: 390, theme: 'dark', picture: 'keys-390-dark/developer-words.png', plant: 'developer-words', kind: 'words', heldOut: false },
    // A look bug is the layout rules': never put to the reviewer, never in its score.
    { screen: 'keys', width: 390, theme: 'dark', picture: 'keys-390-dark/font-monospace.png', plant: 'font-monospace', kind: 'monospace-text', heldOut: false },
  ];
  const finding = (unit: string, kind: ReviewFinding['kind']): ReviewFinding => ({ unit, unitTitle: 'x', picture: 'p', kind, what: `a ${kind} problem`, where: 'top', confidence: 'high', steps: [] });
  const trial = (findings: ReviewFinding[], inconclusive: string[] = []) => ({ model: 'fake', status: 'advisory' as const, units: 4, pictures: 4, dropped: 0, ms: 1, findings, inconclusive: inconclusive.map((unit) => ({ unit, reason: 'busy' })) });
  const thresholds = { trials: 2, minRecall: 0.8, minHeldOutRecall: 0.8, minPrecision: 0.7, maxCleanFalseAlarm: 0.2, maxInconclusive: 0.05 };

  test('the pictures are asked as a run\'s screens, under ids that say nothing of what was planted', () => {
    const units = qualificationUnits(pictures);
    expect(units.map((unit) => unit.id)).toEqual(['picture:1', 'picture:2', 'picture:3', 'picture:4']);
    expect(PLANTS.every((plant) => plant.kind in REVIEW_KINDS || isLayoutRule(plant.kind))).toBe(true);
    expect(units[3]!.title).toBe('The Keys page, 390 px wide, dark');
    // The model is sent the prompt and the picture; the prompt for a planted picture is word for word the clean one's.
    expect(reviewPrompt(units[1]!)).toBe(reviewPrompt(units[0]!));
    expect(reviewPrompt(units[2]!)).not.toMatch(/monospace|planted|developer-words|clean/);
  });

  test('a reviewer that finds every planted bug and reports nothing on the clean picture qualifies', () => {
    const perfect = trial([finding('picture:2', 'contradiction'), finding('picture:3', 'words'), finding('picture:4', 'words'), finding('picture:4', 'no-fix')]);
    const score = scoreQualification(pictures, [perfect, perfect], thresholds);
    expect(score.qualified).toBe(true);
    expect(score.pictures).toBe(4);
    expect(score.perKind.words).toEqual({ planted: 4, found: 4, recall: 1, reported: 4, correct: 4, precision: 1 });
    // The planted error code is plainly also a problem with no fix, so that report is right too.
    expect(score.perKind['no-fix']).toEqual({ planted: 0, found: 0, recall: null, reported: 2, correct: 2, precision: 1 });
    expect(score.heldOut).toEqual({ looked: 2, found: 2, recall: 1 });
    expect(score.clean.falseAlarmRate).toBe(0);
    expect(summarise(score)).toContain('QUALIFIED');
  });

  test('missed bugs, false alarms, wrong kinds and unanswered looks each keep it from qualifying, and say so', () => {
    const first = trial([finding('picture:1', 'no-fix'), finding('picture:3', 'words'), finding('picture:4', 'contradiction')]);
    const second = trial([finding('picture:3', 'words'), finding('picture:4', 'words')], ['picture:2']);
    const score = scoreQualification(pictures, [first, second], thresholds);
    expect(score.qualified).toBe(false);
    expect(score.perKind.contradiction).toEqual({ planted: 1, found: 0, recall: 0, reported: 1, correct: 0, precision: 0 });
    expect(score.perKind.words!.recall).toBe(0.75);
    expect(score.perKind['no-fix']).toEqual({ planted: 0, found: 0, recall: null, reported: 1, correct: 0, precision: 0 });
    expect(score.clean).toMatchObject({ looked: 2, withFindings: 1, falseAlarmRate: 0.5 });
    expect(score.clean.findings).toEqual([{ picture: 'dashboard-1280-light/clean.png', kind: 'no-fix', what: 'a no-fix problem', where: 'top' }]);
    expect(score.inconclusive).toEqual({ asked: 8, unanswered: 1, rate: 0.125 });
    const said = score.shortfalls.join('\n');
    for (const part of ['contradiction: found 0 of 1', 'words: found 3 of 4', 'no-fix: 0 of 1 reports', 'held-out bugs: found 0 of 1', 'nothing planted: a problem was reported in 1 of 2', 'no usable answer for 1 of 8']) expect(said).toContain(part);
  });

  test('a report of a known issue counts neither way, and an answer of a kind off the checklist is dropped', () => {
    const known = [{ phrase: 'Worker token', kinds: ['words' as const], note: 'handed off' }];
    const real = { ...finding('picture:1', 'words'), what: 'The banner says "until the worker token is rotated"' };
    const old = { ...finding('picture:3', 'words'), kind: 'layout' as unknown as ReviewFinding['kind'] };
    const answers = trial([real, old, finding('picture:2', 'contradiction'), finding('picture:3', 'words'), finding('picture:4', 'words')]);
    const score = scoreQualification(pictures, [answers, answers], thresholds, known);
    expect(score.clean.withFindings).toBe(0);
    expect(score.known).toEqual([real, real].map((entry) => ({ picture: 'dashboard-1280-light/clean.png', kind: 'words', what: entry.what, phrase: 'Worker token' })));
    expect(score.qualified).toBe(true);
    expect(summarise(score)).toContain('known issues, not counted: 2 report(s) of 1 issue(s)');
    // Without the list the same report is a false alarm.
    expect(scoreQualification(pictures, [answers, answers], thresholds).clean.withFindings).toBe(2);
  });

  test('a qualification run is asked for with --reviewer-plants, needs the screens, and never writes baselines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-review-cli-'));
    dirs.push(dir);
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ driver: ['/bin/true'] }));
    const base = ['--config', config, '--candidate', dir, '--out', join(dir, 'out')];
    expect(parseCli([...base, '--reviewer-plants']).reviewerPlants).toBe(true);
    expect(parseCli(base).reviewerPlants).toBe(false);
    expect(() => parseCli([...base, '--reviewer-plants', '--skip-journeys'])).toThrow('--skip-journeys');
    expect(() => parseCli([...base, '--reviewer-plants', '--baselines', dir, '--update-baselines'])).toThrow('never writes baselines');
  });
});
