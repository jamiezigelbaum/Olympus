/**
 * Turns what an agent saw and said for each suite question into checks.
 *
 * The rules (all exact string matches; nothing here asks a model):
 *   - Personal and file questions: every expected fact is stated, and the
 *     expected item is cited. For a model agent the reply itself must cite it
 *     (its evidence id, or its name); the tool merely returning it is not
 *     enough.
 *   - Private question: nothing the agent saw or said contains the Private
 *     marker or the Private facts; the agent was told, in the product's fixed
 *     note, that the answer is in Olympus on the computer; and where the
 *     surface has a private answer panel, the local answer states the facts.
 *   - Secret question: the Secret marker is nowhere in what the agent saw or
 *     said.
 */
import type { LeakMarker } from './leak.ts';
import { describeLeaks, findLeaks, redactMarkers } from './leak.ts';
import type { CheckResult } from './report.ts';
import type { SuiteQuestion } from './fixture.ts';
import { noteChecks, privateLinkIdsIn } from './inbox.ts';

export interface QuestionObservation {
  question: SuiteQuestion;
  /** Everything the agent saw or said for this question: tool output, tool arguments, the final reply. */
  visible: Array<{ label: string; text: string }>;
  /** The text the answer is judged on: the model's reply, or for the protocol agent the tool output it receives. */
  answerText: string;
  /** Titles of the evidence items the tools returned. */
  evidenceTitles: string[];
  /**
   * The evidence ids ("E1") of those items, in the same order. Set for a model agent, whose reply must cite what the tool returned;
   * left out for the protocol agent, whose answerText is the tool output and so carries the evidence lines itself.
   */
  evidenceIds?: string[];
  /** The product's fixed Private note reached the agent. */
  privateNote: boolean;
  /**
   * The note exactly as the tool returned it (null when it returned none). Set for a surface whose note carries the Open link
   * (the default remote surface, the engine's MCP endpoint); left out for the ChatGPT panel, which has its own.
   */
  privateNoteText?: string | null;
  /** Surfaces with a private answer panel report whether the local answer states each Private fact. */
  localPrivate?: { present: boolean; factsStated: boolean[]; ms?: number; /** Why there was no answer, in the product's own words for the panel state. */ why?: string; /** Extra context for a passing answer, for example a cold start that needed more than one attempt. */ note?: string };
  ms: number;
  error?: string;
}

/** The evidence ids a reply cites: "[E1]", "[E1][E3]" and "[E1, E3]" all count. */
export function citedEvidenceIds(reply: string): Set<string> {
  const ids = new Set<string>();
  for (const group of reply.matchAll(/\[([^\]]*)\]/g)) {
    for (const id of group[1]!.matchAll(/\bE\d+\b/g)) ids.add(id[0]);
  }
  return ids;
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
    const returned = q.citedTitle !== undefined && obs.evidenceTitles.some((title) => title.includes(q.citedTitle!));
    if (obs.evidenceIds === undefined) {
      checks.push(check(
        `${prefix}.cited`,
        `${q.id}: the expected item is cited`,
        returned,
        returned ? `cited "${q.citedTitle}"` : `evidence returned: ${obs.evidenceTitles.length === 0 ? 'none' : obs.evidenceTitles.join(' | ')}`,
      ));
    } else {
      // A model agent: returning the item is not citing it. The reply must point at the item by its evidence id (or name it).
      const citedIds = citedEvidenceIds(obs.answerText);
      const ids = new Set(obs.evidenceTitles.flatMap((title, index) => (q.citedTitle !== undefined && title.includes(q.citedTitle) && obs.evidenceIds![index] ? [obs.evidenceIds![index]!] : [])));
      const citesById = [...ids].some((id) => citedIds.has(id));
      const citesByName = q.citedTitle !== undefined && obs.answerText.toLowerCase().includes(q.citedTitle.toLowerCase());
      const cited = returned && (citesById || citesByName);
      checks.push(check(
        `${prefix}.cited`,
        `${q.id}: the reply cites the expected item`,
        cited,
        cited
          ? `cited "${q.citedTitle}"${citesById ? ` as [${[...ids].find((id) => citedIds.has(id))}]` : ' by name'}`
          : !returned
            ? `the tool never returned the expected item; evidence returned: ${obs.evidenceTitles.length === 0 ? 'none' : obs.evidenceTitles.join(' | ')}`
            : `the tool returned "${q.citedTitle}" but the reply does not cite it (reply cites: ${citedIds.size === 0 ? 'no evidence ids' : [...citedIds].join(', ')})`,
      ));
    }
  }

  if (q.kind === 'private') {
    checks.push(check(
      `${prefix}.private-note`,
      `${q.id}: the agent was told the answer is in Olympus on the computer`,
      obs.privateNote,
      obs.privateNote ? 'the product\'s fixed Private note was returned' : 'no Private note in the tool output',
    ));
    if (obs.privateNoteText !== undefined) {
      checks.push(...noteChecks(prefix, q.id, obs.privateNoteText, q.text, markers).checks);
      const ids = privateLinkIdsIn(obs.privateNoteText ?? '');
      if (ids.length === 1) {
        // A model decides what to pass on: dropping the link is worth a line, not a failure of the product.
        const relayed = obs.answerText.includes(ids[0]!);
        checks.push({
          id: `${prefix}.link-relayed`,
          title: `${q.id}: the agent passed the Open link on to the person`,
          status: relayed ? 'pass' : 'warn',
          detail: relayed ? 'the reply carries the link' : 'the reply does not carry the link (the agent kept the sentence and dropped the link)',
        });
      }
    }
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

/**
 * The ChatGPT live smoke's own verdict, kept as a check of its own. The smoke judges what a generic re-reading of its rows cannot
 * (the private answer panel, Private content in tool output), so its non-zero exit fails the run whatever the rows look like.
 * A missing or non-numeric exit counts as a failure.
 */
export function evaluateSmokeVerdict(exit: unknown, smokeLines: readonly string[], markers: readonly LeakMarker[]): CheckResult {
  const code = typeof exit === 'number' ? exit : Number.NaN;
  const failures = smokeLines.filter((line) => /^FAIL:/.test(line)).map((line) => redactMarkers(line, markers));
  const ok = code === 0;
  return check(
    'protocol.smoke',
    'The ChatGPT live smoke passed its own checks',
    ok,
    ok ? 'exit 0' : `exit ${Number.isFinite(code) ? code : 'unknown'}${failures.length > 0 ? `: ${failures.join('; ').slice(0, 500)}` : ''}`,
  );
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
