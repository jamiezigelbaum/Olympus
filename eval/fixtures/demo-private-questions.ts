// The demo Private question set (fictional Robin Vale data in
// chatgpt-plugin/demo-data): the private model bench and the answer
// meaning-judge check read it. Everything here is made up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateEvidencePack, type PrivateEvidenceItem } from '../../src/core/analyst-built-in.ts';
import type { EvidencePack } from '../../src/core/contracts.ts';
import type { EvalQuestion } from '../types.ts';

const DEMO = join(import.meta.dir, '..', '..', 'chatgpt-plugin', 'demo-data');
export const DEMO_PRIVATE_CORPUS = 'secure_local.demo';

export const DEMO_PRIVATE_ITEMS: Array<{ id: string; file: string; title: string; source: string }> = [
  { id: 'lab-results', file: 'mail/008-lab-results.eml', title: 'Your test results are ready', source: 'Mail' },
  { id: 'bank-notice', file: 'mail/009-bank-notice.eml', title: 'Your September statement and overdraft notice', source: 'Mail' },
  { id: 'clinic-visit', file: 'notes/2026-09-20-clinic-visit.md', title: 'Clinic visit - 20 Sept 2026', source: 'Notes' },
  { id: 'insurance-claim', file: 'docs/insurance-claim.md', title: 'Insurance claim notes', source: 'Files' },
  { id: 'tax-notes', file: 'docs/tax-notes-2025.md', title: 'Tax notes, 2025 tax year', source: 'Files' },
  // Personal-tier neighbours, so the model has to pick the right evidence.
  { id: 'dentist', file: 'mail/003-dentist-appointment.eml', title: 'Appointment confirmed', source: 'Mail' },
  { id: 'budget-decision', file: 'notes/2026-09-02-budget-decision.md', title: 'Budget decision - 2 Sept 2026', source: 'Notes' },
  { id: 'lease-summary', file: 'docs/lease-summary.md', title: 'Lease summary: 14 Larch Court', source: 'Files' },
];

function ev(id: string) {
  return { corpusId: DEMO_PRIVATE_CORPUS, providerItemId: id, hint: id };
}

export const DEMO_PRIVATE_QUESTIONS: EvalQuestion[] = [
  { id: 'p01', shape: 'value_lookup', question: 'How much was the overdraft fee on my bank account in September?', expectedAnswerContains: ['25'], expectedEvidence: [ev('bank-notice')] },
  { id: 'p02', shape: 'value_lookup', question: 'What is my current loan balance?', expectedAnswerContains: ['8,940'], expectedEvidence: [ev('bank-notice')] },
  { id: 'p03', shape: 'value_lookup', question: 'By how much was my account overdrawn, and on what date?', expectedAnswerContains: ['212.40', '19 September'], expectedEvidence: [ev('bank-notice')] },
  { id: 'p04', shape: 'value_lookup', question: 'How much did I claim from the insurer, and by when do I have to send the referral letter?', expectedAnswerContains: ['340', '10 October'], expectedEvidence: [ev('insurance-claim')] },
  { id: 'p05', shape: 'value_lookup', question: 'How much tax do I expect to owe for 2025?', expectedAnswerContains: ['1,240'], expectedEvidence: [ev('tax-notes')] },
  { id: 'p06', shape: 'count_or_aggregate', question: 'What were my total income and my freelance income in 2025?', expectedAnswerContains: ['71,300', '9,800'], expectedEvidence: [ev('tax-notes')] },
  { id: 'p07', shape: 'locator', question: 'Which clinic sent my blood test results, and which doctor reviewed them?', expectedAnswerContains: ['Riverside', 'Hale'], expectedEvidence: [ev('lab-results')] },
  { id: 'p08', shape: 'cross_source_synthesis', question: 'Why did I see Dr. Hale in September, and what did the blood tests she ordered show?', expectedAnswerContains: ['headache', 'iron'], expectedEvidence: [ev('clinic-visit'), ev('lab-results')] },
  { id: 'p09', shape: 'cross_source_synthesis', question: 'What follow-ups do I have after the blood tests: what did the clinic recommend and what does the insurer still need?', expectedAnswerContains: ['three months', 'referral'], expectedEvidence: [ev('lab-results'), ev('insurance-claim')] },
  { id: 'p10', shape: 'summary_or_sentiment', question: 'Summarize my money situation from the bank notice.', expectedAnswerContains: ['212.40', '8,940'], expectedEvidence: [ev('bank-notice')] },
  { id: 'n01', shape: 'coverage_negative', question: 'What was my blood pressure reading at the clinic?', mustReportGap: true },
  { id: 'n02', shape: 'coverage_negative', question: 'What interest rate does my loan charge?', mustReportGap: true },
];

export function loadDemoPrivateEvidence(): PrivateEvidenceItem[] {
  return DEMO_PRIVATE_ITEMS.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    locator: item.file,
    text: readFileSync(join(DEMO, item.file), 'utf8'),
  }));
}

export function demoPrivatePack(question: string, evidence: PrivateEvidenceItem[]): EvidencePack {
  const pack = privateEvidencePack(question, evidence);
  return {
    ...pack,
    candidates: pack.candidates.map((candidate) => ({
      ...candidate,
      provenance: { ...candidate.provenance, localIds: { corpus_id: DEMO_PRIVATE_CORPUS } },
    })),
    coverage: { ...pack.coverage, searchedCorpora: [DEMO_PRIVATE_CORPUS] },
  };
}
