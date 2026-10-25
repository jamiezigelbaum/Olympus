/**
 * The AI reviewer (layer 4 of the release-testing design, olympus-ops docs/ops/release-testing-design.md): a model that does not build
 * Olympus looks at the pictures a run took and says what a careful new user would trip over that no rule catches: words they would not
 * understand, two parts of a screen that disagree, a problem with no way to its fix, controls that do not line up, a stray font.
 *
 * It reads a finished run's report folder: every screen as it was before the visual mask (review/), the dashboard screenshots, and
 * each journey's and crawl's pictures with the step that led to them. Every finding names the picture it is about and comes back with
 * the steps that reach it; a finding that points at no picture, or at a kind of problem the checklist does not name, is dropped.
 *
 * It is advisory until it qualifies (reviewer-qualify.ts measures it against planted bugs): its findings are listed in the report and
 * never change the run's verdict. The model and its limits live in config/release-check-reviewer.json.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JourneyTrace } from './journey.ts';
import type { MachineReport } from './report.ts';

// ---------------------------------------------------------------------------
// What the reviewer looks for

/** The checklist: each kind of problem, in the words the model is given. A finding of any other kind is dropped. */
export const REVIEW_KINDS = {
  words: 'Words a new user would not understand: developer terms, error codes, internal names, snake_case, placeholder text such as "undefined" or "NaN"',
  contradiction: 'Two parts of the picture disagree about the same thing (a state, a count, a status), or a number that cannot be right',
  'no-fix': 'A problem is shown with no button or link beside it that fixes it or says exactly what is wrong',
  layout: 'Controls in one row that do not line up, text cut off or overlapping other text, something running off the edge',
  font: 'Text in a typeface that does not match the rest of the page, such as a fixed-width or fallback font',
  contrast: 'Text or a control too faint to read against its background',
  outcome: 'After a step, the page does not show what a person who took that step would expect, or leaves them unsure what happened',
} as const;
export type ReviewKind = keyof typeof REVIEW_KINDS;
const KINDS = Object.keys(REVIEW_KINDS) as ReviewKind[];

/** The product's own words: a new user meets them on purpose, so they are never a "words" finding by themselves. */
export const PRODUCT_WORDS = [
  'Olympus', 'Sources', 'Models', 'Built-in', 'Keys', 'Agents', 'Inbox', 'Ask', 'Build a connector', 'Needs you', 'Private', 'Personal',
  'Secrets', 'zkAPI', 'Venice', 'MCP', 'Readwise', 'Gmail', 'Google Drive', 'Dropbox', 'Files on this computer', 'Archives', 'X bookmarks',
  'Telegram', 'WhatsApp', 'ChatGPT', 'Claude', 'Grok', 'Unlock', 'Lock', 'remote access',
] as const;

export type Confidence = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// What it is shown

export interface ReviewPicture {
  /** Relative to the report folder. */
  path: string;
  /** What the picture shows and how the page got there, in a line. */
  caption: string;
  /** The steps a person takes to see it, in order. */
  steps: string[];
}

/** One request to the model: a screen on its own, or a run of a journey's pictures in order. */
export interface ReviewUnit {
  id: string;
  kind: 'screen' | 'journey';
  title: string;
  pictures: ReviewPicture[];
}

const SCREEN_TITLES: Record<string, string> = {
  dashboard: 'the dashboard', keys: 'the Keys page', agents: 'the Agents page', ask: 'the Ask page and Inbox', connector: 'the Build a connector page',
};

/** One dashboard screen at one size, as a unit: the same words for a run's screens and a qualification's pictures. */
export function screenUnit(screen: string, width: number, theme: string, path: string, id = `screen:${screen}-${width}-${theme}`): ReviewUnit {
  const where = SCREEN_TITLES[screen] ?? screen;
  return {
    id, kind: 'screen', title: `${where[0]!.toUpperCase()}${where.slice(1)}, ${width} px wide, ${theme}`,
    pictures: [{ path, caption: `${where} at ${width} px wide in the ${theme} theme`, steps: [`Open ${where} in a window ${width} px wide, ${theme} theme`] }],
  };
}

/**
 * The units of a finished run. Screens come from review/ (each dashboard page at phone and desktop width, light and dark, as captured
 * before the mask that makes the visual comparison stable; the masked pictures say things like "0 unread" that the page never said),
 * then the dashboard screenshots. Journeys and the crawl give their pictures in order with the step that led to each; a long one is
 * cut into runs of `perUnit` pictures.
 */
export function unitsFromReport(machine: MachineReport, reportDir: string, perUnit = 10): ReviewUnit[] {
  const units: ReviewUnit[] = [];
  const reviewDir = join(reportDir, 'review');
  if (existsSync(reviewDir)) {
    for (const file of readdirSync(reviewDir).filter((name) => name.endsWith('.png')).sort()) {
      const match = /^(.+)-(\d+)-(light|dark)\.png$/.exec(file);
      if (!match) continue;
      const [, screen, width, theme] = match as unknown as [string, string, string, string];
      units.push(screenUnit(screen, Number(width), theme, `review/${file}`));
    }
  }
  for (const shot of machine.screenshots) {
    if (!/\.(png|jpe?g)$/i.test(shot.path)) continue;
    units.push({ id: `shot:${shot.path}`, kind: 'screen', title: shot.label, pictures: [{ path: shot.path, caption: shot.label, steps: [`Open the page shown: ${shot.label}`] }] });
  }
  // The crawl's traces are also listed with the journeys' in a run's report; each is looked at once.
  const traces = new Map<string, JourneyTrace>();
  for (const trace of [...(machine.traces ?? []), ...(machine.explore?.traces ?? []), ...(machine.explore?.pages?.traces ?? [])]) if (!traces.has(trace.id)) traces.set(trace.id, trace);
  for (const trace of traces.values()) {
    const pictures: ReviewPicture[] = [];
    const before: string[] = [];
    for (const step of trace.steps) {
      before.push(`${step.name} (${step.action})`);
      if (!step.screenshot) continue;
      pictures.push({ path: `traces/${step.screenshot}`, caption: `after "${step.name}": ${step.action}. The check expected ${step.expected}; it found ${step.actual}`, steps: [...before] });
    }
    for (let start = 0; start < pictures.length; start += perUnit) {
      const part = pictures.slice(start, start + perUnit);
      const parts = Math.ceil(pictures.length / perUnit);
      units.push({ id: parts > 1 ? `journey:${trace.id}#${start / perUnit + 1}` : `journey:${trace.id}`, kind: 'journey', title: parts > 1 ? `${trace.title} (part ${start / perUnit + 1} of ${parts})` : trace.title, pictures: part });
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Asking

/** The instructions for one unit. Fixed apart from the unit's own captions, so a qualification measures what a run uses. */
export function reviewPrompt(unit: ReviewUnit): string {
  const checklist = KINDS.filter((kind) => unit.kind === 'journey' || kind !== 'outcome').map((kind) => `- ${kind}: ${REVIEW_KINDS[kind]}`).join('\n');
  const pictures = unit.pictures.map((picture, index) => `Picture ${index + 1}: ${picture.caption}`).join('\n');
  return [
    'You check a release of Olympus, an app that lets a person search and ask about their own files and accounts from their AI assistant. These pictures are its dashboard, on a test machine with made-up data, as a new user would see it.',
    unit.kind === 'journey' ? `They are taken in order while a person goes through "${unit.title}".` : `The picture is ${unit.title}.`,
    '',
    pictures,
    '',
    'Report each problem a careful new user would notice, of these kinds only:',
    checklist,
    '',
    'Rules:',
    `- These are the product's own names and are fine by themselves: ${PRODUCT_WORDS.join(', ')}.`,
    '- Report only what you can see in a picture. Do not report taste, a wording you would choose differently, or a feature you think is missing.',
    '- The data is made up: names, counts, dates and which sources are connected are not problems unless two parts of a picture disagree.',
    '- A step the check expected and found is not a problem because of the check; judge the picture.',
    '- Say which picture (its number) and where on it, so a person can find it at once.',
    '- If nothing is wrong, return no findings. An empty list is a good answer.',
    '',
    `Answer with JSON only: {"findings":[{"picture":1,"kind":"${KINDS.join('|')}","what":"one sentence: what is wrong","where":"where on the picture","confidence":"low|medium|high"}]}`,
  ].join('\n');
}

export interface ModelPicture { mime: string; data: Buffer }

/** A model the reviewer can ask: the prompt and the pictures in, its text out. */
export interface ReviewModel {
  readonly name: string;
  ask(prompt: string, pictures: readonly ModelPicture[], timeoutMs: number): Promise<string>;
}

/** Any OpenAI-compatible chat API that takes pictures (xAI, OpenAI, Gemini's compatible endpoint). */
export function chatModel(options: { baseUrl: string; model: string; key: string; fetch?: typeof fetch }): ReviewModel {
  const send = options.fetch ?? fetch;
  return {
    name: options.model,
    async ask(prompt, pictures, timeoutMs) {
      const content = [{ type: 'text', text: prompt }, ...pictures.map((picture) => ({ type: 'image_url', image_url: { url: `data:${picture.mime};base64,${picture.data.toString('base64')}`, detail: 'high' } }))];
      const response = await send(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
        body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`the model answered ${response.status}: ${text.slice(0, 160)}`);
      const message = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
      if (typeof message !== 'string') throw new Error('the model answered with no message');
      return message;
    },
  };
}

// ---------------------------------------------------------------------------
// What comes back

export interface ReviewFinding {
  unit: string;
  unitTitle: string;
  /** The picture it is about, relative to the report folder. */
  picture: string;
  kind: ReviewKind;
  what: string;
  where: string;
  confidence: Confidence;
  /** How a person reaches the picture. */
  steps: string[];
}

export interface ReviewResult {
  model: string;
  /** Advisory until a qualification record says otherwise; an advisory review never changes the run's verdict. */
  status: 'advisory' | 'qualified';
  units: number;
  pictures: number;
  findings: ReviewFinding[];
  /** Units the model did not answer usably (an error, a timeout, an answer that was not the JSON asked for). */
  inconclusive: Array<{ unit: string; reason: string }>;
  /** Findings dropped because they named no picture of the unit or no kind on the checklist, or were below the confidence floor. */
  dropped: number;
  ms: number;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Reads the model's answer: the findings that name a picture of this unit and a kind on the checklist, at or above `floor`. */
export function readFindings(unit: ReviewUnit, answer: string, floor: Confidence): { findings: ReviewFinding[]; dropped: number } {
  const body = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(body) as { findings?: unknown };
  if (!Array.isArray(parsed.findings)) throw new Error('the answer has no findings list');
  const findings: ReviewFinding[] = [];
  let dropped = 0;
  for (const raw of parsed.findings as Array<Record<string, unknown>>) {
    const index = Number(raw?.picture);
    const picture = Number.isInteger(index) && index >= 1 ? unit.pictures[index - 1] : undefined;
    const kind = String(raw?.kind ?? '') as ReviewKind;
    const what = typeof raw?.what === 'string' ? raw.what.trim() : '';
    const confidence = (['low', 'medium', 'high'].includes(String(raw?.confidence)) ? raw.confidence : 'low') as Confidence;
    if (!picture || !KINDS.includes(kind) || (kind === 'outcome' && unit.kind !== 'journey') || what === '' || RANK[confidence] < RANK[floor]) { dropped += 1; continue; }
    findings.push({ unit: unit.id, unitTitle: unit.title, picture: picture.path, kind, what, where: typeof raw.where === 'string' ? raw.where.trim() : '', confidence, steps: picture.steps });
  }
  return { findings, dropped };
}

export interface ReviewOptions {
  /** How many units are asked at once. */
  concurrency: number;
  timeoutMs: number;
  /** Findings below this are dropped. */
  minConfidence: Confidence;
  status: 'advisory' | 'qualified';
  /** Reads a picture by its path relative to the report folder. */
  read(path: string): Buffer;
  now?: () => number;
}

/** Asks the model about every unit, a few at a time. A unit it cannot answer is inconclusive, never a pass. */
export async function review(units: readonly ReviewUnit[], model: ReviewModel, options: ReviewOptions): Promise<ReviewResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const findings: ReviewFinding[][] = units.map(() => []);
  const inconclusive: Array<{ unit: string; reason: string } | undefined> = units.map(() => undefined);
  let dropped = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < units.length; at = next++) {
      const unit = units[at]!;
      try {
        const pictures = unit.pictures.map((picture) => ({ mime: /\.jpe?g$/i.test(picture.path) ? 'image/jpeg' : 'image/png', data: options.read(picture.path) }));
        const read = readFindings(unit, await model.ask(reviewPrompt(unit), pictures, options.timeoutMs), options.minConfidence);
        findings[at] = read.findings;
        dropped += read.dropped;
      } catch (error) {
        inconclusive[at] = { unit: unit.id, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, units.length)) }, worker));
  return {
    model: model.name, status: options.status, units: units.length, pictures: units.reduce((sum, unit) => sum + unit.pictures.length, 0),
    findings: findings.flat(), inconclusive: inconclusive.filter((entry): entry is { unit: string; reason: string } => entry !== undefined), dropped, ms: now() - started,
  };
}

// ---------------------------------------------------------------------------
// Its settings

export interface ReviewerConfig {
  status: 'advisory' | 'qualified';
  baseUrl: string;
  model: string;
  /** The environment variable that holds the API key; the key itself is never in a file. */
  keyEnv: string;
  concurrency: number;
  timeoutMs: number;
  picturesPerUnit: number;
  minConfidence: Confidence;
  /** What a qualification (reviewer-qualify.ts) must show before `status` may say qualified. */
  qualification: QualificationThresholds;
}

export interface QualificationThresholds {
  trials: number;
  /** Of the planted pictures of each kind, the share where the reviewer reports that kind. */
  minRecall: number;
  /** The same over the held-out bugs only. */
  minHeldOutRecall: number;
  /** Of the reports of each kind, the share that are of a bug planted there. */
  minPrecision: number;
  /** The share of looks at a picture with nothing planted that report a problem anyway. */
  maxCleanFalseAlarm: number;
  /** The share of looks the model did not answer usably. */
  maxInconclusive: number;
}

export function loadReviewerConfig(path = join(import.meta.dir, '..', '..', 'config', 'release-check-reviewer.json')): ReviewerConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as ReviewerConfig;
}
