/**
 * Runs the AI reviewer (reviewer.ts) over a finished release-check report and adds its findings to the report:
 *
 *   RELEASE_CHECK_REVIEWER_KEY=... bun scripts/release-check/review.ts --report <report folder> [--only <unit id prefix>,...]
 *
 * The model and its limits come from config/release-check-reviewer.json; the key comes from the environment variable it names. The
 * report's verdict is left as it was: the review is advisory until it qualifies. Prints one JSON line with what it did.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderHtml, type ReleaseReport } from './report.ts';
import { chatModel, loadReviewerConfig, review, unitsFromReport } from './reviewer.ts';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const dir = option('--report');
if (!dir) {
  console.error('usage: bun scripts/release-check/review.ts --report <report folder> [--only <unit id prefix>,...]');
  process.exit(2);
}
const config = loadReviewerConfig();
const key = process.env[config.keyEnv];
if (!key) {
  console.error(`set ${config.keyEnv} to the reviewer's API key (${config.baseUrl})`);
  process.exit(2);
}
const root = resolve(dir);
const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as ReleaseReport;
const machine = report.machines[0];
if (!machine) {
  console.error('the report has no machine');
  process.exit(1);
}
const only = option('--only')?.split(',').filter(Boolean);
const units = unitsFromReport(machine, root, config.picturesPerUnit).filter((unit) => !only || only.some((prefix) => unit.id.startsWith(prefix)));
const result = await review(units, chatModel({ baseUrl: config.baseUrl, model: config.model, key }), {
  concurrency: config.concurrency, timeoutMs: config.timeoutMs, minConfidence: config.minConfidence, status: config.status,
  read: (path) => readFileSync(join(root, path)),
});
machine.review = result;
writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(root, 'report.html'), renderHtml(report));
console.log(JSON.stringify({ model: result.model, status: result.status, units: result.units, pictures: result.pictures, findings: result.findings.length, inconclusive: result.inconclusive.length, dropped: result.dropped, ms: result.ms }));
