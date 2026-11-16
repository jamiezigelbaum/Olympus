// The background's workload tests: sync, embed, judge and settle, visibility,
// the status recount. The loop and pool plan guards both run these.
export const BACKGROUND_WORKLOAD_TESTS = [
  'test/background-loop-named-calls.test.ts',
  'test/status-snapshot-never-waits.test.ts',
  'test/source-index-status-readiness-cache.test.ts',
  'test/store-totals-drift.test.ts',
  'test/embedding-hidden-set-in-turns.test.ts',
  'test/hidden-child-incremental.test.ts',
  'test/tier-visibility-incremental.test.ts',
  'test/tier-ledger-cleared-override-paging.test.ts',
  'test/tier-sniffer-recovery.test.ts',
  'test/tier-sniffer-unread-not-missing.test.ts',
  'test/sniffer-new-arrivals.test.ts',
  'test/unreadable-files.test.ts',
] as const;
