import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findCriticalReviewReceipt,
  formatCriticalReviewReceipt,
  parseCriticalReviewReceipt,
  type CriticalReviewPolicy,
  validateCriticalReviewPolicy,
} from '../scripts/critical-review-receipt.ts';

const ROOT = join(import.meta.dir, '..');
const policy = JSON.parse(
  readFileSync(join(ROOT, 'config', 'critical-review.json'), 'utf8'),
) as CriticalReviewPolicy;
const SHA = 'a'.repeat(40);

describe('critical-review receipt', () => {
  test('is exact-SHA, exact-format, and explicit-reviewer bound', () => {
    validateCriticalReviewPolicy(policy);
    const body = formatCriticalReviewReceipt(SHA, policy);
    expect(body).toBe(`<!-- olympus-critical-review:v1 -->\ncritical-review-sha: ${SHA}`);
    expect(parseCriticalReviewReceipt(body, policy)).toBe(SHA);
    expect(findCriticalReviewReceipt([
      { body, user: { login: 'jamiezigelbaum' }, html_url: 'https://example.test/receipt' },
    ], SHA, policy)?.html_url).toBe('https://example.test/receipt');
  });

  test('rejects stale, quoted, embellished, malformed, and unauthorized receipts', () => {
    const body = formatCriticalReviewReceipt(SHA, policy);
    expect(parseCriticalReviewReceipt(`> ${body.replaceAll('\n', '\n> ')}`, policy)).toBeUndefined();
    expect(parseCriticalReviewReceipt(`${body}\nreviewed`, policy)).toBeUndefined();
    expect(parseCriticalReviewReceipt('critical-review-sha: short', policy)).toBeUndefined();
    expect(findCriticalReviewReceipt([
      { body, user: { login: 'someone-else' } },
      { body: formatCriticalReviewReceipt('b'.repeat(40), policy), user: { login: 'jamiezigelbaum' } },
    ], SHA, policy)).toBeUndefined();
  });
});

describe('critical-review publisher workflow', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'critical-review.yml'), 'utf8');
  const concurrency = workflow.slice(workflow.indexOf('concurrency:'), workflow.indexOf('\njobs:'));

  test('uses trusted live API state without checking out or executing PR code', () => {
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('issue_comment:');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('statuses: write');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('setup-bun');
    expect(workflow).not.toMatch(/\bbun\b/);
    expect(workflow).not.toContain('workflow_run:');
    expect(workflow).not.toContain('verify');
  });

  test('classifies renames, rejects stale event heads, and converges from live state', () => {
    expect(workflow).toContain('row.filename');
    expect(workflow).toContain('row.previous_filename');
    expect(workflow).toContain('first.head.sha !== expectedEventSha');
    expect(workflow).toContain("github.rest.repos.getBranch({ owner, repo, branch: defaultBranch })");
    expect(workflow).toContain("jsonAt('config/change-risk.json', policySha)");
    expect(workflow).toContain('confirmPolicySha !== policySha');
    expect(workflow).not.toContain("jsonAt('config/change-risk.json', first.base.sha)");
    expect(workflow).toContain("github.rest.pulls.get({ owner, repo, pull_number: number })");
    expect(workflow).toContain('const after = await liveDecision(number, expectedEventSha)');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain("state: critical && !receipt ? 'pending' : 'success'");
  });

  test('the publisher classifies exchange changes from the protected policy', () => {
    const start = workflow.indexOf('function isCriticalPath(');
    const end = workflow.indexOf('function receiptSha(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const classify = new Function(`${workflow.slice(start, end)}; return isCriticalPath;`)();
    const riskConfig = JSON.parse(readFileSync(join(ROOT, 'config/change-risk.json'), 'utf8'));
    for (const path of ['exchange/src/google.ts', 'exchange/src/redirect-allowlist.ts', 'exchange/wrangler.toml']) {
      expect(classify(path, riskConfig)).toBe(true);
    }
    expect(classify('README.md', riskConfig)).toBe(false);
  });

  test('keeps actions immutable and provides an idempotent all-open-PR backfill', () => {
    expect(workflow).toMatch(/actions\/github-script@[0-9a-f]{40}/);
    expect(workflow).not.toMatch(/uses: [^\n]+@(v|main\b)/);
    expect(workflow).toContain("state: 'open', base: defaultBranch");
    expect(workflow).toContain('createCommitStatus');
    expect(workflow).toContain("context: errorContext");
    expect(workflow).toContain("riskConfig.schemaVersion !== 2");
    expect(workflow).toContain('live.head.sha === errorSha');
    expect(workflow).toContain('errorSha === expectedEventSha');
  });

  test('does not buy a runner for unrelated comments or non-base PR edits', () => {
    expect(workflow).toContain("contains(github.event.comment.body, '<!-- olympus-critical-review:v1 -->')");
    expect(workflow).toContain("contains(github.event.changes.body.from, '<!-- olympus-critical-review:v1 -->')");
    expect(workflow).toContain("github.event.action != 'edited'");
    expect(workflow).toContain('github.event.changes.base != null');
    expect(concurrency).toContain("github.event_name == 'issue_comment' && (contains(github.event.comment.body");
    expect(concurrency).toContain("github.event_name == 'pull_request_target' && (github.event.action != 'edited'");
    expect(concurrency).toContain('github.event.changes.base != null');
    expect(concurrency).toContain("|| github.run_id }}");
  });
});
