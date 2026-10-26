/**
 * The one budget model for the Gmail requests imports make
 * (docs/design/archive-live-one-dataset.md, "Built, step 6").
 *
 * - **Charged at the transport.** Imports read Gmail through a client whose
 *   day counter is `gmailImportBudget`: every HTTP attempt, a retry included,
 *   passes the imports' allowance before the lane's own day counter, so no
 *   request goes around it.
 * - **Allowance.** Half of the day's budget: live Gmail keeps the rest.
 * - **Worst cases, retries included.** An import's client retries a failed
 *   request once (`GMAIL_IMPORT_ATTEMPTS`). One message asks at most the
 *   mailbox check, one search and five candidates' headers
 *   (`GMAIL_IMPORT_MESSAGE_COST` attempts); the label list, asked once a day
 *   when an owner rule names a label, at most `GMAIL_IMPORT_LABELS_COST`.
 * - **Any accepted budget moves.** The smallest accepted day budget
 *   (`GMAIL_IMPORT_MIN_DAILY_BUDGET`) gives an allowance that holds the label
 *   list and one message at their worst, so an import goes on by at least one
 *   message a day. A smaller budget is refused with `gmail_budget_too_small`,
 *   which the import's row and Needs you say in plain words, with the setting
 *   to raise.
 * - **Whole steps, nothing charged while waiting.** A message (or the label
 *   list) is begun only when the allowance holds its worst case; a refusal
 *   comes before any request.
 *
 * The count is the imports' own, per UTC day, in this process; a restart
 * begins it again, still under the lane's durable day counter.
 */
import type { SourceInvocationProvenance } from '../../core/invocation-provenance.ts';
import type { GoogleRequestBudgetStatus } from './request-budget.ts';

/** Retries an import's client makes after a failed attempt. */
export const GMAIL_IMPORT_MAX_RETRIES = 1;
export const GMAIL_IMPORT_ATTEMPTS = 1 + GMAIL_IMPORT_MAX_RETRIES;
/** The mailbox check, one search and five candidates' headers, each at its worst. */
export const GMAIL_IMPORT_MESSAGE_COST = 7 * GMAIL_IMPORT_ATTEMPTS;
/** The account's label list, at its worst. */
export const GMAIL_IMPORT_LABELS_COST = 1 * GMAIL_IMPORT_ATTEMPTS;
/** The share of the day's budget imports may spend. */
export const GMAIL_IMPORT_SHARE = 0.5;
/** The smallest day budget whose share holds the label list and one message at their worst. */
export const GMAIL_IMPORT_MIN_DAILY_BUDGET = Math.ceil((GMAIL_IMPORT_LABELS_COST + GMAIL_IMPORT_MESSAGE_COST) / GMAIL_IMPORT_SHARE);
/** The setting that raises the day budget, named where the budget is too small. */
export const GMAIL_DAILY_BUDGET_SETTING = 'OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET';

export type GmailImportWait =
  /** The imports' share of today's requests is spent: they go on tomorrow. */
  | 'gmail_import_allowance_spent'
  /** The lane's day budget is spent (live Gmail used it): imports go on tomorrow. */
  | 'gmail_requests_spent'
  /** The day's budget is under `GMAIL_IMPORT_MIN_DAILY_BUDGET`: imports wait until it is raised. */
  | 'gmail_budget_too_small';

/** How an import says it waits: the reason, and for a budget too small, the least it must be. */
export function gmailImportWait(reason: GmailImportWait): { later: GmailImportWait; minimum?: number } {
  return reason === 'gmail_budget_too_small' ? { later: reason, minimum: GMAIL_IMPORT_MIN_DAILY_BUDGET } : { later: reason };
}

/** Thrown by the imports' day counter instead of making a request. */
export class GmailImportWaitError extends Error {
  constructor(readonly reason: GmailImportWait) {
    super(`Gmail import waits: ${reason}`);
    this.name = 'GmailImportWaitError';
  }
}

export interface GmailImportAllowance {
  /** Whether `requests` attempts may begin now, without counting them. */
  check(requests: number): true | GmailImportWait;
  /** Counts one attempt, or refuses it. */
  take(): true | GmailImportWait;
}

export function gmailImportAllowance(options: {
  usage: () => GoogleRequestBudgetStatus | undefined;
  now?: () => Date;
}): GmailImportAllowance {
  const now = options.now ?? (() => new Date());
  let day = '';
  let used = 0;
  const check = (requests: number): true | GmailImportWait => {
    const today = now().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
    const usage = options.usage();
    if (!usage) return true;
    if (usage.dailyRequestBudget < GMAIL_IMPORT_MIN_DAILY_BUDGET) return 'gmail_budget_too_small';
    if (usage.requests + requests > usage.dailyRequestBudget) return 'gmail_requests_spent';
    return used + requests > Math.floor(usage.dailyRequestBudget * GMAIL_IMPORT_SHARE) ? 'gmail_import_allowance_spent' : true;
  };
  return {
    check,
    take() {
      const verdict = check(1);
      if (verdict === true) used += 1;
      return verdict;
    },
  };
}

/** The lane's day counter, as an import client uses it: the shape `GoogleDailyRequestBudget` has. */
export interface GmailRequestCounter {
  reserve(provenance?: SourceInvocationProvenance): void;
  status(): GoogleRequestBudgetStatus;
}

/**
 * The day counter an import's Gmail client is given: every attempt passes the
 * imports' allowance, then the lane's own counter.
 */
export function gmailImportBudget(lane: GmailRequestCounter, allowance: GmailImportAllowance): GmailRequestCounter {
  return {
    reserve(provenance) {
      const verdict = allowance.take();
      if (verdict !== true) throw new GmailImportWaitError(verdict);
      lane.reserve(provenance);
    },
    status: () => lane.status(),
  };
}
