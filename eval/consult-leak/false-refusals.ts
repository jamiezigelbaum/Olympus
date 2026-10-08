// False-refusal measurement for the consult outbound gate: how often does the
// gate refuse an ordinary, legitimate general-knowledge question? Reported, not
// gated. Run: bun eval/consult-leak/false-refusals.ts [--json]
// Snapshot is a small synthetic pack of ordinary text that does not contain the
// questions' words, so every refusal is vocabulary or shape driven, never copying.

import {
  CONSULT_LANGUAGE_PACKS,
  CONSULT_VOCABULARY_PACKS,
  consultVocabularySelection,
  consultWriterContextFromPack,
  evaluateConsultRequest,
  loadConsultVocabulary,
  normalizeForComparison,
  type ConsultGateOptions,
  type ConsultLanguage,
} from '../../src/core/consult-gate.ts';
import type { EvidencePack } from '../../src/core/contracts.ts';
import { ENGLISH_CATEGORIES, FALSE_REFUSAL_QUESTIONS, LANGUAGE_CATEGORIES, type FalseRefusalCategory } from './false-refusals-questions.ts';

const provenance = {
  sourceItem: { family: 'file' as const, provider: 'synthetic', accountScope: 'acct-synthetic-one', providerItemId: 'item-one', localItemId: 'local-item-one' },
  citation: { title: 'Quarterly notes' },
};

const NEUTRAL_PACK: EvidencePack = {
  question: 'what is in the folder about the report',
  candidates: [{
    provenance,
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: [
      'The committee met on a quiet afternoon and agreed to revisit the plan after the holidays.',
      'Several members suggested a simpler schedule, and the chair promised to circulate a revised outline.',
    ],
  }],
  coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
  builtAt: '2026-10-05T09:00:00.000Z',
};

const SHIPPED_LANGUAGES: readonly ConsultLanguage[] = ['en', 'nl', 'fr', 'es', 'pt-PT', 'pt-BR'];

export const CONFIGURATIONS: Readonly<Record<string, ConsultGateOptions>> = {
  'a defaults (en + units + medicines)': {},
  'b defaults + countries': { domains: { countries: true } },
  'c all shipped languages': { languages: SHIPPED_LANGUAGES },
  'd all shipped languages + countries': { languages: SHIPPED_LANGUAGES, domains: { countries: true } },
  'e all shipped + de requested (pack not installed)': { languages: [...SHIPPED_LANGUAGES, 'de'], domains: { countries: true } },
};

/** Words of a question the configured vocabulary does not hold (mirrors the gate's letter-run test). */
const vocabularyCache = new Map<string, ReturnType<typeof loadConsultVocabulary>['vocabulary']>();
function unknownWords(question: string, options: ConsultGateOptions): string[] {
  const { shipped } = consultVocabularySelection(options);
  const key = shipped.join(',');
  if (!vocabularyCache.has(key)) {
    vocabularyCache.set(key, loadConsultVocabulary(Object.fromEntries(shipped.map((id) => [id, CONSULT_VOCABULARY_PACKS[id]!])), null).vocabulary);
  }
  const vocabulary = vocabularyCache.get(key);
  const out: string[] = [];
  for (const run of normalizeForComparison(question).split(/[^a-z0-9]+/u)) {
    for (const word of run.split(/[0-9]+/u)) if (word.length > 1 && !vocabulary?.has(word)) out.push(word);
  }
  return out;
}

export interface FalseRefusalRow {
  readonly category: FalseRefusalCategory;
  readonly question: string;
  readonly config: string;
  readonly decision: 'pass' | 'refuse';
  readonly reasons: readonly string[];
  readonly unknown: readonly string[];
  readonly ms: number;
}

export function runFalseRefusals(): FalseRefusalRow[] {
  const context = consultWriterContextFromPack(NEUTRAL_PACK);
  const rows: FalseRefusalRow[] = [];
  for (const [config, options] of Object.entries(CONFIGURATIONS)) {
    for (const category of [...ENGLISH_CATEGORIES, ...LANGUAGE_CATEGORIES]) {
      // Language sets run with their own language enabled (c-e) or as-is (a-b).
      for (const question of FALSE_REFUSAL_QUESTIONS[category]) {
        const t0 = performance.now();
        const verdict = evaluateConsultRequest([question], context, {}, {}, { ...options, ownerQuestionTexts: [NEUTRAL_PACK.question] });
        const ms = performance.now() - t0;
        const unknown = verdict.reasons.includes('unknown_word') ? unknownWords(question, options) : [];
        rows.push({ category, question, config, decision: verdict.decision, reasons: verdict.reasons, unknown, ms });
      }
    }
  }
  return rows;
}

function pct(n: number, d: number): string { return d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`; }
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function report(rows: readonly FalseRefusalRow[]): string {
  const lines: string[] = [];
  const configs = Object.keys(CONFIGURATIONS);
  const en = new Set<string>(ENGLISH_CATEGORIES);
  lines.push('## Refusal rate per category (refused / total)');
  lines.push(['category', ...configs.map((c) => c.slice(0, 1))].join(' | '));
  for (const category of [...ENGLISH_CATEGORIES, ...LANGUAGE_CATEGORIES]) {
    lines.push([category, ...configs.map((config) => {
      const set = rows.filter((r) => r.category === category && r.config === config);
      const refused = set.filter((r) => r.decision === 'refuse').length;
      return `${refused}/${set.length} (${pct(refused, set.length)})`;
    })].join(' | '));
  }
  const enRows = (config: string): FalseRefusalRow[] => rows.filter((r) => r.config === config && en.has(r.category));
  lines.push(['ALL ENGLISH', ...configs.map((config) => {
    const set = enRows(config);
    const refused = set.filter((r) => r.decision === 'refuse').length;
    return `${refused}/${set.length} (${pct(refused, set.length)})`;
  })].join(' | '));
  lines.push('', 'Configurations: ' + configs.join(' ; '));
  for (const config of configs) {
    const set = enRows(config);
    const counts = new Map<string, number>();
    for (const r of set) for (const reason of r.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    lines.push('', `## Reason codes, English, config ${config} (questions carrying the reason)`);
    lines.push([...counts].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'none');
  }
  for (const config of [configs[0]!, configs[1]!]) {
    const words = new Map<string, number>();
    for (const r of enRows(config)) for (const w of new Set(r.unknown)) words.set(w, (words.get(w) ?? 0) + 1);
    lines.push('', `## Unknown words, English, config ${config} (word=questions)`);
    lines.push([...words].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([w, n]) => `${w}=${n}`).join(', ') || 'none');
  }
  lines.push('', '## Non-English refusals by reason (configs a, c, e)');
  for (const config of [configs[0]!, configs[2]!, configs[4]!]) {
    for (const category of LANGUAGE_CATEGORIES) {
      const set = rows.filter((r) => r.category === category && r.config === config);
      const counts = new Map<string, number>();
      for (const r of set) for (const reason of r.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      lines.push(`${config.slice(0, 1)} ${category}: ` + ([...counts].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'));
    }
  }
  const ms = rows.map((r) => r.ms);
  lines.push('', `## Latency per call (ms, ${ms.length} calls, includes first-call vocabulary load): median=${quantile(ms, 0.5).toFixed(2)} p95=${quantile(ms, 0.95).toFixed(2)} max=${Math.max(...ms).toFixed(1)}`);
  void CONSULT_LANGUAGE_PACKS;
  return lines.join('\n');
}

if (import.meta.main) {
  const rows = runFalseRefusals();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else if (process.argv.includes('--refused')) {
    for (const r of rows.filter((x) => x.decision === 'refuse' && x.config.startsWith(process.argv[process.argv.indexOf('--refused') + 1] ?? 'a'))) console.log(`[${r.category}] ${r.question} => ${r.reasons.join(',')} ${r.unknown.join('|')}`);
  } else console.log(report(rows));
}
