/**
 * The share of the Gmail day budget imports may spend, and the one gate every
 * request an import makes passes (labels, the mailbox check, the search, the
 * candidates' headers). Live Gmail keeps the rest of the day.
 *
 * - **Allowance.** Half of the day's budget, but never less than what one
 *   message costs at worst (`MESSAGE_COST`), so any budget the import accepts
 *   makes progress: at least one message a day.
 * - **Too small.** A day's budget under twice that cost cannot leave live
 *   Gmail its share while an import still moves: the import waits, and the
 *   receipt says so (`gmail_budget_too_small`), with the setting to raise.
 * - **Whole messages.** A message is begun only when the allowance holds its
 *   worst case, so a message is never left half asked about and asked again.
 * - **No charge for waiting.** A refusal spends nothing: the gate refuses
 *   before any request.
 *
 * The count is the import's own, per UTC day, in this process (the lane's one
 * day counter still bounds every request, imports' and live's alike); a
 * restart begins the import's count again, still under that counter.
 */
import type { GoogleRequestBudgetStatus } from './request-budget.ts';

/** One search, five candidates' headers, and the mailbox check: the most one message asks. */
export const GMAIL_IMPORT_MESSAGE_COST = 7;
/** The share of the day's budget imports may spend. */
export const GMAIL_IMPORT_SHARE = 0.5;

export type GmailImportWait =
  /** The import's share of today's requests is spent: it goes on tomorrow. */
  | 'gmail_import_allowance_spent'
  /** The lane's day budget is spent (live Gmail used it): it goes on tomorrow. */
  | 'gmail_requests_spent'
  /** The day's budget is too small for an import to move while live Gmail keeps its share. */
  | 'gmail_budget_too_small';

export interface GmailImportAllowance {
  /** Whether `requests` more may be asked now; on yes they are counted. */
  take(requests: number): true | GmailImportWait;
  /** What one message's worst case would meet now, without counting anything. */
  check(requests: number): true | GmailImportWait;
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
    if (usage.dailyRequestBudget < GMAIL_IMPORT_MESSAGE_COST * 2) return 'gmail_budget_too_small';
    if (usage.requests + requests > usage.dailyRequestBudget) return 'gmail_requests_spent';
    const allowance = Math.max(GMAIL_IMPORT_MESSAGE_COST, Math.floor(usage.dailyRequestBudget * GMAIL_IMPORT_SHARE));
    return used + requests > allowance ? 'gmail_import_allowance_spent' : true;
  };
  return {
    check,
    take(requests) {
      const verdict = check(requests);
      if (verdict === true) used += requests;
      return verdict;
    },
  };
}
