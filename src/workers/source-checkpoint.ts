/**
 * One bounded persistence contract for every source scheduler checkpoint.
 *
 * Provider cursors are opaque and some providers legitimately return values
 * larger than the scheduler's historical 4 KiB allowance. Keeping the bound
 * here prevents a connector from accepting a resumable cursor that the shared
 * scheduler cannot persist after the task has already committed useful work.
 */
export const SOURCE_CHECKPOINT_MAX_LENGTH = 32_768;

export function isBoundedSourceCheckpoint(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SOURCE_CHECKPOINT_MAX_LENGTH;
}
