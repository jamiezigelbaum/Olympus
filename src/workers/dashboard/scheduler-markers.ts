/**
 * The scheduler degradation markers that mean Olympus paused itself.
 *
 * None of them asks the reader for anything: the daily budgets park a lane
 * until the UTC rollover, and a provider rate limit clears on the provider's
 * own reset clock. Reconnecting a credential changes none of it.
 *
 * `api_request_guard` is deliberately absent — that one IS the provider
 * refusing, and reconnecting the credential is the way out.
 *
 * Shared by the view model, which must not arm a connect control on a lane in
 * this set, and the detail page, which translates the same marker into the
 * sentence above the checks. They read one list because a lane the card treats
 * as refusing and the page describes as paused is exactly the 2026-08-19
 * dashboard-honesty defect.
 */
export const OPERATOR_PAUSED_SCHEDULER_MARKERS: ReadonlySet<string> = new Set([
  'daily_api_request_guard',
  'daily_resource_read_guard',
  'daily_cost_guard',
  'readwise_daily_api_request_guard',
  'gmail_daily_api_request_guard',
  'google_drive_daily_api_request_guard',
  'head_api_request_reserve_guard',
  'head_resource_read_reserve_guard',
  'head_cost_reserve_guard',
  'provider_rate_limit',
]);
