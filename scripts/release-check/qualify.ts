import { SUITE_QUESTIONS } from './fixture.ts';
import { factsIn, sourceNames } from './inbox-page.ts';
import type { CheckResult } from './report.ts';

export const QUALIFY_QUESTION = SUITE_QUESTIONS.find(question => question.id === 'personal-fact')!;

export interface KnownCanaryAsk {
  text: string;
  facts: readonly string[];
  citedTitle?: string;
  source?: string;
}

export function expectedAskCitations(evidence: unknown, question: KnownCanaryAsk): { title?: string; source?: string }[] {
  if (!Array.isArray(evidence)) return [];
  const expected = question.citedTitle || question.source;
  return evidence.filter(item => item && expected
    && sourceNames([question.citedTitle ? item.title ?? '' : item.source ?? ''], expected));
}

export function citedFixture(evidence: unknown): boolean {
  return Array.isArray(evidence) && sourceNames(evidence.map(item =>
    [item?.title, item?.source].filter(Boolean).join(' · ')), QUALIFY_QUESTION.citedTitle!);
}

export interface AskObservation {
  status: number;
  answered: boolean;
  factsStated: boolean;
  cited: boolean;
  ms: number;
  firstEvidenceMs?: number;
}

/** The local Ask logs its first evidence pack when retrieval finishes. Only use an unambiguous receipt. */
export function firstEvidenceMs(log: string): number | undefined {
  const receipts = [...log.matchAll(/\[local-answer\] retrieval latency_ms=(\d+) candidates=(\d+) searched=/g)];
  const receipt = receipts.length === 1 ? receipts[0] : undefined;
  return receipt && Number(receipt[2]) > 0 ? Number(receipt[1]) : undefined;
}

export function observeAsk(status: number, body: any, ms: number, evidenceMs?: number, question?: KnownCanaryAsk): AskObservation {
  return {
    status, ms,
    ...(evidenceMs !== undefined ? { firstEvidenceMs: evidenceMs } : {}),
    answered: status === 200 && body?.ok === true && body.status === 'answered',
    factsStated: factsIn(String(body?.answer ?? ''), question?.facts ?? QUALIFY_QUESTION.facts).every(Boolean),
    cited: question ? expectedAskCitations(body?.citations, question).length > 0 : citedFixture(body?.citations),
  };
}

export function qualifyAskCheck(obs?: AskObservation): CheckResult {
  const passed = obs?.answered && obs.factsStated && obs.cited;
  // On a ready engine: evidence within 10 s, the whole answer reported against about 20 s; 1.5 does not stream (owner-run-24h.md).
  const lateEvidence = obs?.firstEvidenceMs !== undefined && obs.firstEvidenceMs > 10_000;
  const evidence = obs?.firstEvidenceMs === undefined ? 'unobserved' : `${obs.firstEvidenceMs} ms${lateEvidence ? ' (over 10 s)' : ''}`;
  return {
    id: 'qualify.ask', title: 'Ask cites the expected fixture while the engine is indexing an archive',
    status: passed ? (lateEvidence ? 'warn' : 'pass') : 'fail',
    detail: obs ? `Archive importing at dispatch · HTTP ${obs.status} · answer ${obs.answered ? 'received' : 'missing'} · expected facts ${obs.factsStated ? 'present' : 'missing'} · expected citation ${obs.cited ? 'present' : 'missing'} · first evidence (engine retrieval) ${evidence} · whole answer ${obs.ms} ms (target about 20 s${obs.ms > 20_000 ? ', over' : ''}) · no streaming in 1.5`
      : 'No Ask result from an observed active import',
    ...(obs ? { ms: obs.ms } : {}),
  };
}

export interface PrivacyObservation {
  ackMs?: number;
  finishMs?: number;
  withheldAfterAck?: boolean;
  withheldAfterRestart?: boolean;
  ownerChoiceAfterRestart?: boolean;
  detail?: string;
}

export function qualifyPrivacyCheck(obs?: PrivacyObservation): CheckResult {
  const ms = (value: number | undefined) => value === undefined ? 'unobserved' : `${value} ms`;
  return {
    id: 'qualify.private', title: 'Make it Private acknowledges within 1 s and stays withheld across restart',
    status: obs?.ackMs !== undefined && obs.ackMs <= 1_000 && obs.finishMs !== undefined
      && obs.withheldAfterAck && obs.withheldAfterRestart && obs.ownerChoiceAfterRestart ? 'pass' : 'fail',
    detail: `Acknowledged ${ms(obs?.ackMs)} · finished ${ms(obs?.finishMs)} · withheld after acknowledgement ${obs?.withheldAfterAck ? 'yes' : 'unconfirmed'} · withheld after restart ${obs?.withheldAfterRestart ? 'yes' : 'unconfirmed'} · owner choice retained ${obs?.ownerChoiceAfterRestart ? 'yes' : 'unconfirmed'}${obs?.detail ? ` · ${obs.detail}` : ''}`,
  };
}
