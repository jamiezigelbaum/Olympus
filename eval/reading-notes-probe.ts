// Probe for answers that leave out a value the evidence holds (#1590), on
// made-up documents only, so its prompts and answers can be read by anyone.
//
// Each question asks for several values that sit in the middle or at the end
// of one long item among five; another item of the same kind holds different
// values for a different subject. The local Analyst answers the same pack
// with each reading-notes arm, and an answer is complete when it states
// every asked-for value exactly as the item gives it. This is a wording
// check for the arms, not the bar: the bar is the held-out eval and the
// passage eval's --answer-arms on a real archive.
//
//   bun eval/reading-notes-probe.ts [--arms off,first,pass] [--repeats 3] [--show] [--out file.json]
//     [--only k3-seat5,k2-seat3] [--raw calls.jsonl]
//
// --raw writes every model call of each incomplete answer (rules' first line,
// the prompt's size, the whole reply) as one JSON line: made-up text only.
//
// It answers through the same local lane as eval:passages --answer
// (OLYMPUS_SOURCE_INDEX_ANALYST_LANE / _PROFILE). --show prints each
// incomplete answer and the values it left out.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createAnalyst, withPromptBudget, type AnalystModel, type AnalystReadingNotes } from '../src/core/analyst.ts';
import { createDelphiAnalystModel } from '../src/core/analyst-delphi.ts';
import { loadConfig, parseLane, parseModelProfile } from '../src/core/config.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import { signTestP } from './run-passages.ts';

export interface ProbeQuestion { id: string; pack: EvidencePack; values: string[] }

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

const TOPICS = ['maintenance', 'access', 'insurance', 'notices', 'repairs', 'utilities', 'subletting', 'inspection', 'keys', 'parking', 'storage', 'signage', 'waste', 'heating', 'alterations', 'pets'];
const PLACES = ['Rua das Flores 12', 'Avenida Norte 4', 'Largo do Carmo 7', 'Travessa da Fonte 31', 'Praça Nova 9', 'Rua do Sol 58'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** One long item: numbered filler sections with `facts` set at the given section positions. */
function longItem(rand: () => number, facts: ReadonlyArray<{ at: number; text: string }>, sections = 22): string {
  const out: string[] = [];
  for (let n = 1; n <= sections; n++) {
    const topic = TOPICS[Math.floor(rand() * TOPICS.length)]!;
    out.push(`Section ${n}. On ${topic}: each party keeps a written record, answers a written request within ${3 + Math.floor(rand() * 25)} days and bears its own costs up to ${100 + Math.floor(rand() * 80) * 10} EUR per event, unless section ${1 + Math.floor(rand() * sections)} says otherwise.`);
    for (const fact of facts) if (fact.at === n) out.push(fact.text);
  }
  return out.join(' ');
}

const amount = (rand: () => number, low: number, high: number) => `${(low + Math.floor(rand() * ((high - low) / 50)) * 50).toLocaleString('en-US')} EUR`;
const date = (rand: () => number, year: number) => `${1 + Math.floor(rand() * 28)} ${MONTHS[Math.floor(rand() * 12)]} ${year}`;

type Kind = (rand: () => number, subject: string) => { title: string; question: string; facts: string[]; values: string[] };
const KINDS: Kind[] = [
  (rand, place) => {
    const [deposit, rent, notice] = [amount(rand, 1500, 6000), amount(rand, 600, 2400), `${30 + Math.floor(rand() * 5) * 15} days`];
    return { title: `Lease - ${place}`, question: `What are the deposit, the monthly rent and the notice period in the lease for ${place}?`,
      facts: [`The tenant pays a deposit of ${deposit} on signing.`, `The monthly rent is ${rent}, due on the first working day.`, `Either party may end this lease with ${notice} of written notice.`], values: [deposit, rent, notice] };
  },
  (rand, place) => {
    const [premium, excess, limit, renewal] = [amount(rand, 200, 1200), amount(rand, 100, 900), amount(rand, 50000, 400000), date(rand, 2027)];
    return { title: `Home insurance policy - ${place}`, question: `Summarise the terms of the home insurance policy for ${place}.`,
      facts: [`The yearly premium is ${premium}.`, `Each claim carries an excess of ${excess}.`, `Cover is limited to ${limit} per year.`, `The policy renews on ${renewal}.`], values: [premium, excess, limit, renewal] };
  },
  (rand, place) => {
    const dates = [2027, 2027, 2028, 2028, 2029].map(year => date(rand, year));
    return { title: `Works payment schedule - ${place}`, question: `List every payment date in the works payment schedule for ${place}.`,
      facts: dates.map((day, index) => `Instalment ${index + 1} falls due on ${day}.`), values: dates };
  },
  (rand, place) => {
    const [fee, due, account] = [amount(rand, 300, 3000), date(rand, 2027), `PT50 ${1000 + Math.floor(rand() * 9000)} ${1000 + Math.floor(rand() * 9000)}`];
    return { title: `Survey invoice - ${place}`, question: `What does the survey invoice for ${place} charge, when is it due and to which account is it paid?`,
      facts: [`The survey fee is ${fee} including tax.`, `Payment is due by ${due}.`, `Pay by transfer to account ${account}.`], values: [fee, due, account] };
  },
];

/** The probe's questions: every kind, at three seats, values from a fixed seed. */
export function probeQuestions(): ProbeQuestion[] {
  const questions: ProbeQuestion[] = [];
  KINDS.forEach((kind, kindIndex) => [0, 2, 4].forEach((seat, round) => {
    const rand = random(1590 + kindIndex * 31 + round * 7);
    const places = [...PLACES].sort(() => rand() - 0.5);
    const target = kind(rand, places[0]!);
    // A second item of the same kind about another place, and three of other kinds.
    const others = [kind(rand, places[1]!), ...[1, 2, 3].map(step => KINDS[(kindIndex + step) % KINDS.length]!(rand, places[1 + step]!))];
    const spread = (facts: readonly string[]) => facts.map((text, index) => ({ at: 6 + Math.floor((index * 15) / Math.max(1, facts.length - 1)), text }));
    const items = others.map(other => ({ title: other.title, text: longItem(rand, spread(other.facts)) }));
    items.splice(seat, 0, { title: target.title, text: longItem(rand, spread(target.facts)) });
    questions.push({ id: `k${kindIndex + 1}-seat${seat + 1}`, values: target.values, pack: {
      question: target.question, builtAt: '2026-11-16T00:00:00Z',
      coverage: { searchedCorpora: ['probe'], skippedCorpora: [], extractionGaps: [] },
      candidates: items.map((item, index) => ({
        provenance: { sourceItem: { family: 'file', provider: 'probe', accountScope: 'probe', providerItemId: `p${index + 1}`, localItemId: `p${index + 1}` }, citation: { title: item.title } },
        trustTier: 'S2', trustDomain: 'internal', chunks: [item.text],
      })),
    } });
  }));
  return questions;
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');
export const missingValues = (answer: string, values: readonly string[]): string[] => values.filter(value => !squash(answer).includes(squash(value)));

async function main(argv: readonly string[]): Promise<void> {
  const option = (name: string) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const arms = (option('--arms') ?? 'off,first,pass').split(',') as AnalystReadingNotes[];
  if (arms.some(arm => !['off', 'first', 'pass'].includes(arm))) throw new Error('Arms are off, first and pass.');
  const repeats = Number(option('--repeats') ?? 3);
  const show = argv.includes('--show');
  const lane = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE?.trim() ? parseLane(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE) : undefined;
  const profile = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE?.trim() ? parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE) : 'source_answer';
  const delphi = createDelphiAnalystModel(new DelphiClient(loadConfig()), lane ? { lane } : { profile });
  const raw = option('--raw');
  let calls: Array<{ system: string; promptChars: number; maxOutputChars?: number; reply: string }> = [];
  const model: AnalystModel = { complete: async (request) => {
    const completion = await delphi.complete(request);
    calls.push({ system: request.system.split('\n')[0]!, promptChars: request.prompt.length, ...(request.maxOutputChars !== undefined ? { maxOutputChars: request.maxOutputChars } : {}), reply: completion.text });
    return completion;
  } };
  const analysts = new Map(arms.map(arm => [arm, createAnalyst(model, { auditSuspiciousDrafts: true, evidenceFormat: 'compact', readingNotes: arm })]));
  const only = option('--only')?.split(',');
  const questions = probeQuestions().filter(question => !only || only.includes(question.id));
  const runs = new Map(arms.map(arm => [arm, questions.map(() => [] as Array<{ missing: number; ms: number }>)]));
  for (const [index, question] of questions.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let turn = 0; turn < arms.length; turn++) {
        const arm = arms[(turn + index + repeat) % arms.length]!;
        const started = performance.now(); calls = [];
        const result = await analysts.get(arm)!.analyze(withPromptBudget(question.pack, 27_000), { localOnly: true });
        const missing = missingValues(result.answer, question.values);
        runs.get(arm)![index]!.push({ missing: missing.length, ms: performance.now() - started });
        if (raw && missing.length) appendFileSync(raw, `${JSON.stringify({ id: question.id, arm, repeat: repeat + 1, answer: result.answer, unanswered: result.unanswered, calls })}\n`);
        if (show && missing.length) console.error(`${question.id} ${arm} run ${repeat + 1} left out ${JSON.stringify(missing)}: ${result.answer}`);
      }
    }
    console.error(`probe ${index + 1}/${questions.length}`);
  }
  const complete = (arm: AnalystReadingNotes) => runs.get(arm)!.map(row => row.filter(run => run.missing === 0).length * 2 > row.length);
  const summary = Object.fromEntries(arms.map((arm, armIndex) => {
    const rows = runs.get(arm)!; const all = rows.flat(); const times = all.map(run => run.ms).sort((a, b) => a - b);
    const asked = questions.reduce((sum, question) => sum + question.values.length, 0) * repeats;
    const now = complete(arm); const before = complete(arms[0]!);
    const wins = now.filter((value, index) => value && !before[index]).length; const losses = now.filter((value, index) => !value && before[index]).length;
    return [arm, { questions: questions.length, complete: now.filter(Boolean).length, completeRuns: all.filter(run => run.missing === 0).length, runs: all.length,
      valuesGiven: asked - all.reduce((sum, run) => sum + run.missing, 0), valuesAsked: asked, medianMs: Math.round(times[Math.floor(times.length / 2)] ?? 0),
      ...(armIndex > 0 ? { paired: { wins, losses, p: signTestP(wins, losses) } } : {}) }];
  }));
  console.log(JSON.stringify(summary, null, 2));
  const out = option('--out');
  if (out) writeFileSync(out, `${JSON.stringify({ summary, rows: Object.fromEntries(arms.map(arm => [arm, runs.get(arm)])) }, null, 2)}\n`);
}
if (import.meta.main) await main(process.argv.slice(2));
