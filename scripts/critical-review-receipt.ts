import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CriticalReviewPolicy {
  schemaVersion: 1;
  statusContext: string;
  receiptMarker: string;
  reviewerLogins: string[];
}

export interface CriticalReviewComment {
  body?: string | null;
  html_url?: string;
  user?: { login?: string | null } | null;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export function validateCriticalReviewPolicy(policy: CriticalReviewPolicy): void {
  if (policy.schemaVersion !== 1) throw new Error('Unsupported critical-review policy schema.');
  if (policy.statusContext !== 'critical-review') throw new Error('The required status context must remain critical-review.');
  if (!/^[a-z0-9:-]+$/.test(policy.receiptMarker)) throw new Error('Invalid critical-review receipt marker.');
  if (policy.reviewerLogins.length === 0 || policy.reviewerLogins.some((login) => !/^[A-Za-z0-9-]+$/.test(login))) {
    throw new Error('Critical-review reviewer logins must be a non-empty explicit allowlist.');
  }
}

export function formatCriticalReviewReceipt(sha: string, policy: CriticalReviewPolicy): string {
  validateCriticalReviewPolicy(policy);
  const normalized = sha.toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new Error('Critical-review receipt requires a full 40-character commit SHA.');
  return `<!-- ${policy.receiptMarker} -->\ncritical-review-sha: ${normalized}`;
}

export function parseCriticalReviewReceipt(body: string | null | undefined, policy: CriticalReviewPolicy): string | undefined {
  validateCriticalReviewPolicy(policy);
  const lines = String(body ?? '').replaceAll('\r\n', '\n').trim().split('\n');
  if (lines.length !== 2 || lines[0] !== `<!-- ${policy.receiptMarker} -->`) return undefined;
  const match = /^critical-review-sha: ([0-9a-f]{40})$/.exec(lines[1]!);
  return match?.[1];
}

export function findCriticalReviewReceipt(
  comments: readonly CriticalReviewComment[],
  headSha: string,
  policy: CriticalReviewPolicy,
): CriticalReviewComment | undefined {
  validateCriticalReviewPolicy(policy);
  const allowed = new Set(policy.reviewerLogins.map((login) => login.toLowerCase()));
  const normalizedHead = headSha.toLowerCase();
  if (!FULL_SHA.test(normalizedHead)) throw new Error('Critical-review lookup requires a full head SHA.');
  return comments.find((comment) => {
    const login = comment.user?.login?.toLowerCase();
    return login !== undefined
      && allowed.has(login)
      && parseCriticalReviewReceipt(comment.body, policy) === normalizedHead;
  });
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const policy = JSON.parse(
    readFileSync(join(root, 'config', 'critical-review.json'), 'utf8'),
  ) as CriticalReviewPolicy;
  const sha = process.argv[2];
  if (!sha) throw new Error('usage: bun scripts/critical-review-receipt.ts <40-character-sha>');
  console.log(formatCriticalReviewReceipt(sha, policy));
}
