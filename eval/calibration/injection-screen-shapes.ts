// Run the sniffer's injection screen over a labeled calibration sample and
// describe every hit by its shape only (#881). The item text never leaves this
// process: a row carries the item id, the owner's label, the rule that fired
// and shape facts (which part of the material, how long the smallest firing
// span is, where it sits, which of the screen's own fixed keywords it holds).
// No word of the item is printed beyond those fixed keywords.
//
//   bun eval/calibration/injection-screen-shapes.ts --dir DIR [--baseline PATH/TO/sniffer.ts] [--json]
//
// The material is the judge's input as judge-run.ts builds it (production's
// `judgeInput`, then the parent-context and own-material split). --baseline
// loads another checkout's sniffer.ts (for example a `main` checkout) and
// reports that screen's hits too, each marked with whether today's screen
// still fires on it.

import { join, resolve } from 'node:path';
import {
  snifferInjectionRule,
  snifferMaterialForModel,
  snifferOwnMaterial,
} from '../../src/workers/classification/sniffer.ts';
import { CALIBRATION_DIR_DEFAULT, readLabels, readSample, type CalibrationSampleItem } from './files.ts';
import { judgeInput } from './judge-input.ts';

export type InjectionScreen = (material: string) => string | undefined;
export interface ScreenModule {
  snifferInjectionRule: InjectionScreen;
  snifferMaterialForModel: (material: string) => string;
  snifferOwnMaterial: (material: string) => string;
}

export interface InjectionShape {
  id: string;
  /** The owner's label, or `unlabelled`. */
  label: string;
  source: string;
  rule: string;
  /** Where the smallest firing span sits: the item's names, its excerpt, or unframed material. */
  part: 'names' | 'excerpt' | 'material';
  /** Characters in the smallest span that still fires the same rule. */
  spanLength: number;
  /** Characters in the item's own material. */
  materialLength: number;
  /** Span start, as a fifth of its part: `0-20%` ... `80-100%`. */
  position: string;
  /** Lines the span covers. */
  lines: number;
  /** The screen's own fixed keywords found in the span, by class. */
  keywords: Record<string, string[]>;
  /** Shape markers, each a yes/no about the span. */
  markers: string[];
}

/** The screen's fixed vocabulary, by class. Only these words are ever printed. */
export const SCREEN_KEYWORDS: Record<string, readonly string[]> = {
  override_verb: ['ignore', 'disregard', 'forget', 'override', 'bypass', 'skip'],
  override_object: ['instruction', 'instructions', 'rules', 'prompt', 'previous', 'prior', 'above', 'earlier', 'policy', 'settings'],
  instruction_verb: ['reply', 'answer', 'respond', 'output', 'return', 'mark', 'set', 'label', 'classify', 'treat', 'tag', 'rate', 'assign', 'choose', 'use', 'emit', 'produce', 'make'],
  schema_word: ['ownrecord', 'privatekind', 'confidence', 'tier', 'category', 'verdict', 'verdicts', 'classification', 'classifier', 'classified', 'sniffer'],
  tier_word: ['personal', 'public', 'private'],
  role_word: ['system', 'assistant', 'developer', 'user', 'inst', 'sys'],
  set_word: ['every', 'all', 'each', 'other', 'items', 'item', 'files', 'file', 'documents', 'document', 'entries', 'messages', 'message'],
};

const EXCERPT_MARK = '\nExcerpt: ';

function wordStarts(text: string): number[] {
  const starts = [0];
  for (let i = 1; i < text.length; i++) if (!/[\p{L}\p{N}_]/u.test(text[i - 1]!) && /[\p{L}\p{N}_<\[{"'|]/u.test(text[i]!)) starts.push(i);
  return starts;
}

function wordEnds(text: string): number[] {
  const ends: number[] = [];
  for (let i = 1; i < text.length; i++) if (/[\p{L}\p{N}_>\]}"'|]/u.test(text[i - 1]!) && !/[\p{L}\p{N}_]/u.test(text[i]!)) ends.push(i);
  ends.push(text.length);
  return ends;
}

/** Largest index in `cuts` for which `ok` holds, assuming it holds at cuts[0]. */
function lastHolding(cuts: number[], ok: (cut: number) => boolean): number {
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(cuts[mid]!)) lo = mid; else hi = mid - 1;
  }
  return cuts[lo]!;
}

/** The smallest span, cut at word edges, on which the screen still fires the same rule. */
export function firingSpan(text: string, rule: string, screen: InjectionScreen): { start: number; end: number } {
  const start = lastHolding(wordStarts(text), (cut) => screen(text.slice(cut)) === rule);
  const ends = wordEnds(text).filter((cut) => cut > start).reverse();
  // Ends in descending order: find the smallest end that still fires.
  let lo = 0;
  let hi = ends.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (screen(text.slice(start, ends[mid]!)) === rule) lo = mid; else hi = mid - 1;
  }
  const end = ends[lo] ?? text.length;
  return screen(text.slice(start, end)) === rule ? { start, end } : { start: 0, end: text.length };
}

function keywordsIn(span: string): Record<string, string[]> {
  const words = new Set(span.normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? []);
  const found: Record<string, string[]> = {};
  for (const [kind, list] of Object.entries(SCREEN_KEYWORDS)) {
    const hits = list.filter((word) => words.has(word));
    if (hits.length) found[kind] = hits;
  }
  return found;
}

function markersOf(span: string, material: string): string[] {
  const lines = span.split('\n');
  const markers: string[] = [];
  if (lines.some((line) => /^\s*>/.test(line))) markers.push('quoted_reply_line');
  if (lines.some((line) => /^\s*[\p{L}][\p{L}\s-]{0,24}:\s/u.test(line))) markers.push('header_like_line');
  if (/[{}\[\]=;`]/.test(span)) markers.push('code_or_json_punctuation');
  if (/<[^<>]{0,60}>/.test(span)) markers.push('angle_bracket_tag');
  if (/\b(?:https?:\/\/|www\.)/i.test(span)) markers.push('url');
  if (/@[\w-]+\.[\w.-]+/.test(span)) markers.push('email_address');
  if (/\b(?:i|my|we|our|me|us)\b/i.test(span)) markers.push('first_person');
  if (/\b(?:you|your)\b/i.test(span)) markers.push('second_person');
  if (/^(?:fwd?|fw):|forwarded message|begin forwarded/im.test(material)) markers.push('item_is_forwarded');
  if (/[^\x00-\x7f]/.test(span)) markers.push('non_ascii');
  return markers;
}

function bucket(offset: number, length: number): string {
  const fifth = Math.min(4, Math.floor((offset / Math.max(1, length)) * 5));
  return `${fifth * 20}-${fifth * 20 + 20}%`;
}

/** The item's own material as judge-run.ts would screen it, or undefined when no screen reads it. */
export function screenedMaterial(item: CalibrationSampleItem, screen: ScreenModule): string | undefined {
  let material = item.judgeSees;
  if (material === undefined) {
    const input = judgeInput(item.signals ?? { title: item.name, path: `/${item.rel}` }, item.text, item.source ?? 'dropbox');
    if (input.secret || input.material === undefined) return undefined;
    material = input.material;
  }
  return screen.snifferOwnMaterial(screen.snifferMaterialForModel(material));
}

export function injectionShape(item: { id: string; source?: string }, label: string, own: string, rule: string, screen: InjectionScreen): InjectionShape {
  const { start, end } = firingSpan(own, rule, screen);
  const at = own.indexOf(EXCERPT_MARK);
  const framed = own.startsWith('Names:') && at >= 0;
  const part = !framed ? 'material' : start >= at ? 'excerpt' : 'names';
  const partStart = !framed ? 0 : part === 'excerpt' ? at + EXCERPT_MARK.length : 'Names: '.length;
  const partLength = !framed ? own.length : part === 'excerpt' ? own.length - partStart : at - partStart;
  const span = own.slice(start, end);
  return {
    id: item.id,
    label,
    source: item.source ?? 'dropbox',
    rule,
    part,
    spanLength: span.length,
    materialLength: own.length,
    position: bucket(Math.max(0, start - partStart), partLength),
    lines: span.split('\n').length,
    keywords: keywordsIn(span),
    markers: markersOf(span, own),
  };
}

export function injectionShapes(dir: string, screen: ScreenModule): { items: number; screened: number; hits: InjectionShape[] } {
  const sample = readSample(dir);
  const labels = readLabels(dir).labels;
  const hits: InjectionShape[] = [];
  let screened = 0;
  for (const item of sample.items) {
    const own = screenedMaterial(item, screen);
    if (own === undefined) continue;
    screened += 1;
    const rule = screen.snifferInjectionRule(own);
    if (rule) hits.push(injectionShape(item, labels[item.id]?.label ?? 'unlabelled', own, rule, screen.snifferInjectionRule));
  }
  return { items: sample.items.length, screened, hits };
}

export function formatShape(row: InjectionShape): string {
  const keywords = Object.entries(row.keywords).map(([kind, words]) => `${kind}=${words.join('+')}`).join(' ') || '-';
  return [row.id, row.label, row.source, row.rule, row.part, `span=${row.spanLength}/${row.materialLength}`,
    `at=${row.position}`, `lines=${row.lines}`, keywords, row.markers.join(',') || '-'].join('\t');
}

function tally(hits: InjectionShape[]): string {
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(`${hit.label} ${hit.rule}`, (counts.get(`${hit.label} ${hit.rule}`) ?? 0) + 1);
  return [...counts].sort().map(([key, count]) => `  ${key}: ${count}`).join('\n') || '  none';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dir = flag('--dir') ?? CALIBRATION_DIR_DEFAULT;
  const current: ScreenModule = { snifferInjectionRule, snifferMaterialForModel, snifferOwnMaterial };
  const report: Record<string, unknown> = { dir: join(dir), current: injectionShapes(dir, current) };
  const baselinePath = flag('--baseline');
  if (baselinePath) {
    const baseline = await import(resolve(baselinePath)) as ScreenModule;
    const result = injectionShapes(dir, baseline);
    const sample = new Map(readSample(dir).items.map((item) => [item.id, item]));
    const stillFires = (id: string) => {
      const own = screenedMaterial(sample.get(id)!, current);
      return own === undefined ? null : current.snifferInjectionRule(own) ?? null;
    };
    report.baseline = { ...result, hits: result.hits.map((hit) => ({ ...hit, nowFires: stillFires(hit.id) })) };
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 1));
    return;
  }
  const print = (title: string, result: { items: number; screened: number; hits: Array<InjectionShape & { nowFires?: string | null }> }) => {
    console.log(`${title}: ${result.hits.length} hits of ${result.screened} screened items (${result.items} in the sample)`);
    console.log(tally(result.hits));
    console.log('id\tlabel\tsource\trule\tpart\tspan\tposition\tlines\tkeywords\tmarkers' + (result.hits.some((hit) => 'nowFires' in hit) ? '\tnow' : ''));
    for (const hit of result.hits) console.log(formatShape(hit) + ('nowFires' in hit ? `\t${hit.nowFires ?? 'clear'}` : ''));
  };
  if (report.baseline) print('Baseline screen', report.baseline as Parameters<typeof print>[1]);
  print('Current screen', report.current as Parameters<typeof print>[1]);
}

if (import.meta.main) await main();
