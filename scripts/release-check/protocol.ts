import { SUITE_QUESTIONS } from './fixture.ts';
import type { LeakMarker } from './leak.ts';
import type { ExecResult } from './machine.ts';
import type { CheckResult } from './report.ts';
import { evaluateObservation, evaluateSmokeVerdict, type QuestionObservation } from './suite.ts';

/** A short, plaintext-free reason for a missing private answer: the panel state and, if a job ran, its status. */
function panelWhy(row: Record<string, any>): string {
  const state = row.panelState ?? 'no panel';
  const panel = row.panel as { ok?: boolean; status?: string; detail?: string; polls?: number } | null;
  const tries = (row.attempts as Array<{ panelState: string | null; noteKind: string | null; atS: number }> | undefined) ?? [];
  const history = tries.length > 0 ? `; ${tries.length} attempt(s): ${tries.map((a) => `${a.panelState ?? 'no panel'}/${a.noteKind ?? 'no note'}@${a.atS}s`).join(', ')}` : '';
  return (panel && panel.ok === false ? `panel ${state}, job ${panel.status ?? 'unknown'}: ${panel.detail ?? ''}`.trim() : `panel state ${state}`) + history;
}

/** Judge the same smoke receipt on the VM and the dedicated canary machines. */
export function protocolChecks(out: Pick<ExecResult, 'code' | 'stderr'>, result: Record<string, any> | undefined, markers: readonly LeakMarker[]): CheckResult[] {
  const results = (result?.results ?? []) as Array<Record<string, any>>;
  if (result?.ok !== true || results.length === 0) {
    return [{ id: 'protocol.ran', title: 'The ChatGPT-protocol pass ran', status: 'fail', detail: `no results (exit ${out.code}; smoke exit ${result?.exit ?? 'n/a'}): ${(result?.detail ?? (((result?.smokeChecks ?? []) as string[]).join('; ') || out.stderr.slice(-200)))}` }];
  }
  const checks: CheckResult[] = [];
  // The smoke's own verdict stands: its private-content and panel checks are stronger than anything re-derived here.
  checks.push(evaluateSmokeVerdict(result.exit, (result.smokeChecks ?? []) as string[], markers));
  for (const question of SUITE_QUESTIONS) {
    const row = results.find((r) => r.id === question.id);
    if (!row) {
      checks.push({ id: `${question.id}.ran`, title: `${question.id}: the agent answered`, status: 'fail', detail: 'no result for this question' });
      continue;
    }
    const observation: QuestionObservation = {
      question,
      visible: [{ label: `chatgpt-protocol tool result (${question.id})`, text: String(row.text ?? '') }],
      answerText: String(row.text ?? ''),
      evidenceTitles: (row.evidence as Array<{ title: string }>).map((e) => e.title),
      privateNote: row.noteKind !== null && row.noteKind !== undefined,
      ms: Number(row.searchMs ?? 0),
      ...(row.isError ? { error: 'the tool returned an error' } : {}),
      ...(question.kind === 'private'
        ? { localPrivate: { present: row.privateAnswer !== null, factsStated: (row.privateAnswer?.factsStated ?? []) as boolean[], ms: row.panel?.totalMs, why: panelWhy(row), note: Array.isArray(row.attempts) && row.attempts.length > 1 ? `answer model started on attempt ${row.attempts.length} (${row.attempts[row.attempts.length - 1].atS} s after the first)` : '' } }
        : {}),
    };
    checks.push(...evaluateObservation(observation, markers));
  }
  return checks;
}
