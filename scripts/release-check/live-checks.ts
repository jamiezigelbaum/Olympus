import { appendFileSync } from 'node:fs';
import type { CheckResult } from './report.ts';

/** Observe checks at insertion, including agent checks produced before the agent finishes. */
export function liveChecks(report: (check: CheckResult) => void): CheckResult[] {
  const checks: CheckResult[] = [];
  Object.defineProperty(checks, 'push', { value: (...added: CheckResult[]) => {
    for (const check of added) report(check);
    return Array.prototype.push.apply(checks, added);
  } });
  return checks;
}

/** The caller redacts item markers before anything reaches this live surface. */
export function publishFailedCheck(check: CheckResult, summaryPath = process.env.GITHUB_STEP_SUMMARY): void {
  if (check.status !== 'fail') return;
  console.error(`CHECK FAIL ${check.id}: ${check.detail ?? check.title}`);
  if (summaryPath) {
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    try { appendFileSync(summaryPath, `<p><strong>FAIL ${escape(check.id)}</strong>: ${escape(check.detail ?? check.title)}</p>\n`); } catch {
      console.error(`CHECK SUMMARY unavailable; failure remains in live log: ${check.id}`);
    }
  }
}
