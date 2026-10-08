// PII detector bake-off, step 3: score each candidate's spans
// (eval/consult-pii/out/pred-<candidate>.jsonl) against the exported truth and
// gate verdicts (export.ts). Prints markdown tables and writes
// eval/consult-pii/out/results.json. Evaluation only.
//
// Metrics (docs/design/consult-pii-bakeoff.md, "Method"):
//   recall      share of questions carrying a hard identifier where the model
//               finds at least one hard-identifier span;
//   false flags share of legitimate questions (no hard identifier) where it
//               finds one;
//   policy c    the gate as shipped, plus: a question the unnamed level refused
//               ONLY for unknown_word / snapshot_name passes when no
//               hard-identifier span overlaps its unknown or capitalised tokens;
//   policy c+   policy c, and a passed question is refused when the model finds
//               a hard-identifier span anywhere in it (the model as a second
//               blocker; reported for comparison, not proposed).
// A place span that is a whole country name (English or the question's
// language) is not a hard identifier (the level allows a jurisdiction).
//
// Run: bun eval/consult-pii/score.ts [--json]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportCase, ExportItem } from './export.ts';

const OUT_DIR = join(import.meta.dir, 'out');

export const HARD_CATEGORIES: ReadonlySet<string> = new Set(['person', 'org', 'location', 'address', 'date', 'amount', 'id', 'email', 'phone', 'url', 'handle', 'secret']);

interface Span { readonly start: number; readonly end: number; readonly label: string; readonly cat: string; readonly text: string }
interface Perf { readonly candidate: string; readonly p50_ms: number; readonly p95_ms: number; readonly load_s: number; readonly rss_mb_loaded: number; readonly rss_mb_before_load: number; readonly download_mb: number | null }

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

// Country names (whole names, CLDR via Intl) in English and the question's language.
const COUNTRY_LOCALES: Readonly<Record<string, readonly string[]>> = { en: ['en'], pt: ['en', 'pt'], es: ['en', 'es'], fr: ['en', 'fr'], de: ['en', 'de'] };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const countryNames = new Map<string, Set<string>>();
function countriesFor(lang: string): Set<string> {
  let names = countryNames.get(lang);
  if (names) return names;
  names = new Set(['us', 'usa', 'uk', 'eu', 'europe', 'european union', 'schengen area', 'england', 'scotland', 'wales', 'northern ireland']);
  for (const locale of COUNTRY_LOCALES[lang] ?? ['en']) {
    const display = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    for (const a of LETTERS) for (const b of LETTERS) {
      const name = display.of(a + b);
      if (name) names.add(fold(name));
    }
  }
  countryNames.set(lang, names);
  return names;
}
function countryOnly(text: string, lang: string): boolean {
  const folded = fold(text).replace(/^(the|a|o|os|el|la|le|les|die|der|das) /u, '');
  return countriesFor(lang).has(folded);
}

function hardSpans(spans: readonly Span[], lang: string): Span[] {
  return spans.filter((span) => HARD_CATEGORIES.has(span.cat) && !((span.cat === 'location' || span.cat === 'address') && countryOnly(span.text, lang)));
}

const items = new Map(readJsonl<ExportItem>(join(OUT_DIR, 'items.jsonl')).map((entry) => [entry.id, entry]));
const langOf = (id: string): string => items.get(id)?.lang ?? 'en';
const cases = readJsonl<ExportCase>(join(OUT_DIR, 'cases.jsonl'));

/** Policy groups reported in the main table. */
const GROUPS: ReadonlyArray<{ id: string; label: string; match: (entry: ExportCase) => boolean }> = [
  { id: 'unnamed', label: 'Unnamed situation set', match: (entry) => entry.set === 'unnamed' },
  { id: 'recorded', label: 'Recorded writer outputs', match: (entry) => entry.set === 'recorded-unnamed' || entry.set === 'recorded-reid' },
  { id: 'corpus', label: 'Leak corpus (at unnamed)', match: (entry) => entry.set === 'corpus' },
  { id: 'held-out-en', label: 'Held-out EN', match: (entry) => entry.set === 'held-out-en' },
  { id: 'held-out-pt', label: 'Held-out PT', match: (entry) => entry.set === 'held-out-pt' },
  { id: 'held-out-es-fr', label: 'Held-out ES+FR', match: (entry) => entry.set === 'held-out-es' || entry.set === 'held-out-fr' },
  { id: 'false-refusals', label: 'False-refusal set', match: (entry) => entry.set === 'false-refusals' && entry.lang !== 'de' },
  { id: 'name-probe', label: 'Name probes (in snapshot)', match: (entry) => entry.set === 'name-probe' },
  { id: 'probes', label: 'Identifier probes EN/PT/ES/FR', match: (entry) => entry.set.startsWith('probe-') && entry.lang !== 'de' },
];

/** canaryPasses: passed leak cases the independent canary oracle confirms. */
interface PolicyTally { legit: number; legitRefused: number; leaks: number; leaksPassed: number; canaryPasses: number }

function tally(selected: readonly ExportCase[], decide: (entry: ExportCase) => 'pass' | 'refuse'): PolicyTally {
  const out: PolicyTally = { legit: 0, legitRefused: 0, leaks: 0, leaksPassed: 0, canaryPasses: 0 };
  for (const entry of selected) {
    const decision = decide(entry);
    if (entry.role === 'legitimate') {
      out.legit += 1;
      if (decision === 'refuse') out.legitRefused += 1;
    } else {
      out.leaks += 1;
      if (decision === 'pass') out.leaksPassed += 1;
    }
    if (decision === 'pass' && entry.canary && entry.role === 'leak') out.canaryPasses += 1;
  }
  return out;
}

function overlaps(span: { start: number; end: number }, tokens: ReadonlyArray<readonly [number, number]>): boolean {
  return tokens.some(([start, end]) => span.start < end && start < span.end);
}

export function scoreCandidate(name: string | null) {
  const preds = new Map<string, Span[]>();
  if (name) for (const row of readJsonl<{ id: string; spans: Span[] }>(join(OUT_DIR, `pred-${name}.jsonl`))) preds.set(row.id, hardSpans(row.spans, langOf(row.id)));
  const hardIn = (id: string): Span[] => preds.get(id) ?? [];
  const policyC = (entry: ExportCase): 'pass' | 'refuse' => {
    if (entry.decision === 'pass') return 'pass';
    if (!name || !entry.rescuable) return 'refuse';
    // Guard: a rescue token holding a digit (a plate, a reference) is never rescued; models miss these.
    if (entry.items.some((id, index) => (entry.rescueTokens[index] ?? []).some(([start, end]) => /\d/u.test(items.get(id)!.text.slice(start, end))))) return 'refuse';
    return entry.items.every((id, index) => !hardIn(id).some((span) => overlaps(span, entry.rescueTokens[index] ?? []))) ? 'pass' : 'refuse';
  };
  const policyCPlus = (entry: ExportCase): 'pass' | 'refuse' => {
    const decision = policyC(entry);
    if (decision === 'pass' && name && entry.items.some((id) => hardIn(id).length > 0)) return 'refuse';
    return decision;
  };
  const policy: Record<string, { c: PolicyTally; cPlus: PolicyTally }> = {};
  for (const group of GROUPS) {
    const selected = cases.filter(group.match);
    policy[group.id] = { c: tally(selected, policyC), cPlus: tally(selected, policyCPlus) };
  }
  // Detection (model alone), per item.
  const detection: Record<string, { hard: number; found: number; none: number; flagged: number }> = {};
  const bump = (key: string, entry: ExportItem, flagged: boolean) => {
    const bucket = detection[key] ?? { hard: 0, found: 0, none: 0, flagged: 0 };
    if (entry.truth === 'hard') { bucket.hard += 1; if (flagged) bucket.found += 1; }
    if (entry.truth === 'none') { bucket.none += 1; if (flagged) bucket.flagged += 1; }
    detection[key] = bucket;
  };
  const misses: string[] = [];
  const falseFlags: string[] = [];
  for (const entry of items.values()) {
    if (entry.truth === 'unlabelled') continue;
    const flagged = hardIn(entry.id).length > 0;
    bump('all', entry, flagged);
    bump(`lang:${entry.lang}`, entry, flagged);
    if (entry.truth === 'hard') bump(`kind:${entry.kind}`, entry, flagged);
    if (entry.truth === 'hard' && !flagged && misses.length < 400) misses.push(`${entry.id} [${entry.kind}] ${entry.text}`);
    if (entry.truth === 'none' && flagged && falseFlags.length < 400) falseFlags.push(`${entry.id}: ${hardIn(entry.id).map((span) => `${span.cat}:"${span.text}"`).join(', ')} | ${entry.text}`);
  }
  return { policy, detection, misses, falseFlags };
}

const pct = (part: number, whole: number): string => (whole === 0 ? '-' : `${Math.round((100 * part) / whole)}%`);

if (import.meta.main) {
  const candidates = readdirSync(OUT_DIR).filter((file) => /^pred-.+\.jsonl$/.test(file)).map((file) => file.slice(5, -6)).sort();
  const results: Record<string, ReturnType<typeof scoreCandidate> & { perf?: Perf }> = { main: scoreCandidate(null) };
  for (const candidate of candidates) {
    const perfPath = join(OUT_DIR, `perf-${candidate}.json`);
    results[candidate] = { ...scoreCandidate(candidate), ...(existsSync(perfPath) ? { perf: JSON.parse(readFileSync(perfPath, 'utf8')) as Perf } : {}) };
  }
  writeFileSync(join(OUT_DIR, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const lines: string[] = [];
    lines.push('### Policy c (unnamed level): legitimate refused / leaks passed');
    lines.push(`| Candidate | ${GROUPS.map((group) => group.label).join(' | ')} |`);
    lines.push(`|---|${GROUPS.map(() => '---').join('|')}|`);
    for (const [candidate, result] of Object.entries(results)) {
      lines.push(`| ${candidate} | ${GROUPS.map((group) => {
        const t = result.policy[group.id]!.c;
        return `${t.legitRefused}/${t.legit} · ${t.leaksPassed}/${t.leaks}${t.canaryPasses ? ` (canary ${t.canaryPasses})` : ''}`;
      }).join(' | ')} |`);
    }
    lines.push('', '### Policy c+ (rescue and block): legitimate refused / leaks passed');
    lines.push(`| Candidate | ${GROUPS.map((group) => group.label).join(' | ')} |`);
    lines.push(`|---|${GROUPS.map(() => '---').join('|')}|`);
    for (const [candidate, result] of Object.entries(results)) {
      if (candidate === 'main') continue;
      lines.push(`| ${candidate} | ${GROUPS.map((group) => {
        const t = result.policy[group.id]!.cPlus;
        return `${t.legitRefused}/${t.legit} · ${t.leaksPassed}/${t.leaks}`;
      }).join(' | ')} |`);
    }
    const kinds = ['name', 'place', 'date', 'amount', 'identifier', 'email', 'phone', 'address', 'title', 'exact_figure', 'exact_date', 'multilingual', 'writer-leak'];
    lines.push('', '### Detection: recall on hard identifiers, false flags on legitimate questions');
    lines.push(`| Candidate | Recall (all) | False flags (all) | ${kinds.map((kind) => `R ${kind}`).join(' | ')} |`);
    lines.push(`|---|---|---|${kinds.map(() => '---').join('|')}|`);
    for (const [candidate, result] of Object.entries(results)) {
      if (candidate === 'main') continue;
      const all = result.detection.all!;
      lines.push(`| ${candidate} | ${pct(all.found, all.hard)} (${all.found}/${all.hard}) | ${pct(all.flagged, all.none)} (${all.flagged}/${all.none}) | ${kinds.map((kind) => {
        const bucket = result.detection[`kind:${kind}`];
        return bucket ? pct(bucket.found, bucket.hard) : '-';
      }).join(' | ')} |`);
    }
    const langs = ['en', 'pt', 'es', 'fr', 'de'];
    lines.push('', '### Languages: recall / false flags');
    lines.push(`| Candidate | ${langs.join(' | ')} |`);
    lines.push(`|---|${langs.map(() => '---').join('|')}|`);
    for (const [candidate, result] of Object.entries(results)) {
      if (candidate === 'main') continue;
      lines.push(`| ${candidate} | ${langs.map((lang) => {
        const bucket = result.detection[`lang:${lang}`];
        return bucket ? `${pct(bucket.found, bucket.hard)} / ${pct(bucket.flagged, bucket.none)}` : '-';
      }).join(' | ')} |`);
    }
    lines.push('', '### Performance (CPU, 4 threads, Apple M3)');
    lines.push('| Candidate | p50 ms | p95 ms | Load s | RSS added MB | Download MB |');
    lines.push('|---|---|---|---|---|---|');
    for (const [candidate, result] of Object.entries(results)) {
      const perf = result.perf;
      if (!perf) continue;
      lines.push(`| ${candidate} | ${perf.p50_ms} | ${perf.p95_ms} | ${perf.load_s} | ${Math.round(perf.rss_mb_loaded - perf.rss_mb_before_load)} | ${perf.download_mb ?? '-'} |`);
    }
    console.log(lines.join('\n'));
  }
}
