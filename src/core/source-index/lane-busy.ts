/**
 * The `code` of an error a corpus adapter throws when its store could not
 * answer in time because it is busy (the read pool's queue was full, or the
 * lane's deadline passed while its query waited or ran there). The router
 * reports that lane as a timeout, the same as one that missed its own timer
 * (#1079). Its own module, so the read pool can name it without loading the
 * router.
 */
export const SOURCE_INDEX_LANE_BUSY_CODE = 'source_index_lane_busy';

export function isSourceIndexLaneBusyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === SOURCE_INDEX_LANE_BUSY_CODE;
}
