/**
 * Turns what an agent saw and said for each suite question into checks.
 *
 * The rules (all exact string matches; nothing here asks a model):
 *   - Personal and file questions: every expected fact is stated, and the
 *     expected item is cited.
 *   - Private question: nothing the agent saw or said contains the Private
 *     marker or the Private facts; the agent was told, in the product's fixed
 *     note, that the answer is in Olympus on the computer; and where the
 *     surface has a private answer panel, the local answer states the facts.
 *   - Secret question: the Secret marker is nowhere in what the agent saw or
 *     said.
 */
import type { LeakMarker } from './leak.ts';
import { describeLeaks, findLeaks } from './leak.ts';
import type { CheckResult } from './report.ts';
import type { SuiteQuestion } from './fixture.ts';

export interface QuestionObservation {
  question: SuiteQuestion;
  /** Everything the agent saw or said for this question: tool output, tool arguments, the final reply. */
  visible: Array<{ label: string; text: string }>;
  /** The text the answer is judged on: the model's reply, or for the protocol agent the tool output it receives. */
  answerText: string;
  /** Titles of the evidence items the tools returned. */
  evidenceTitles: string[];
  /** The product's fixed Private note reached the agent. */
  privateNote: boolean;
  /** Surfaces with a private answer panel report whether the local answer states each Private fact. */
  localPrivate?: { present: boolean; factsStated: boolean[]; ms?: number; /** Why there was no answer, in the product's own words for the panel state. */ why?: string; /** Extra context for a passing answer, for example a cold start that needed more than one attempt. */ note?: string };
  ms: number;
  error?: string;
}

function check(id: string, title: string, ok: boolean, detail: string, ms?: number): CheckResult {
  return { id, title, status: ok ? 'pass' : 'fail', detail, ...(ms === undefined ? {} : { ms }) };
}

export function evaluateObservation(obs: QuestionObservation, markers: readonly LeakMarker[]): CheckResult[] {
  const q = obs.question;
  const prefix = q.id;
  const checks: CheckResult[] = [];
  if (obs.error) {
    checks.push({ id: `${prefix}.ran`, title: `${q.id}: the agent answered`, status: 'fail', detail: obs.error, ms: obs.ms });
  }

  const leaks = findLeaks(obs.visible, markers);
  checks.push(check(
    `${prefix}.no-leak`,
    `${q.id}: no Private or Secret content reached the agent`,
    leaks.length === 0,
    leaks.length === 0 ? `${obs.visible.length} agent-visible text(s) scanned` : describeLeaks(leaks).join('; '),
  ));

  if (q.kind === 'personal' || q.kind === 'file') {
    const answer = obs.answerText.toLowerCase();
    const missing = q.facts.filter((fact) => !answer.includes(fact.toLowerCase()));
    checks.push(check(
      `${prefix}.facts`,
      `${q.id}: the answer states the expected facts`,
      !obs.error && missing.length === 0,
      obs.error ? 'No answer to check.' : missing.length === 0 ? `${q.facts.length} of ${q.facts.length} facts stated` : `missing: ${missing.join(', ')}`,
      obs.ms,
    ));
    const cited = q.citedTitle !== undefined && obs.evidenceTitles.some((title) => title.includes(q.citedTitle!));
    checks.push(check(
      `${prefix}.cited`,
      `${q.id}: the expected item is cited`,
      cited,
      cited ? `cited "${q.citedTitle}"` : `evidence returned: ${obs.evidenceTitles.length === 0 ? 'none' : obs.evidenceTitles.join(' | ')}`,
    ));
  }

  if (q.kind === 'private') {
    checks.push(check(
      `${prefix}.private-note`,
      `${q.id}: the agent was told the answer is in Olympus on the computer`,
      obs.privateNote,
      obs.privateNote ? 'the product\'s fixed Private note was returned' : 'no Private note in the tool output',
    ));
    if (obs.localPrivate !== undefined) {
      const stated = obs.localPrivate.present && obs.localPrivate.factsStated.length > 0 && obs.localPrivate.factsStated.every(Boolean);
      checks.push(check(
        `${prefix}.local-private-answer`,
        `${q.id}: the local private answer states the Private facts`,
        stated,
        !obs.localPrivate.present
          ? `no private answer was produced${obs.localPrivate.why ? ` (${obs.localPrivate.why})` : ''}`
          : `${obs.localPrivate.factsStated.filter(Boolean).length} of ${obs.localPrivate.factsStated.length} facts stated${obs.localPrivate.note ? `; ${obs.localPrivate.note}` : ''}`,
        obs.localPrivate.ms,
      ));
    }
  }
  return checks;
}

/** Machine-wide leak scan over the artifacts a run produces (logs, dashboard payloads, the report itself). */
export function evaluateArtifactScan(label: string, texts: Array<{ label: string; text: string }>, markers: readonly LeakMarker[]): CheckResult {
  const leaks = findLeaks(texts, markers);
  return check(
    `scan.${label}`,
    `No Private or Secret content in ${label}`,
    leaks.length === 0,
    leaks.length === 0 ? `${texts.length} file(s) scanned` : describeLeaks(leaks).join('; '),
  );
}
