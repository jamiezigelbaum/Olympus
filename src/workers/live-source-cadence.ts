/**
 * How soon a new item in a live source can be found (product rule, 13 Nov 2026):
 * within about 10 minutes on any install. "I just got this email, find it."
 *
 * Every live source whose check for new items is a cheap incremental call
 * (Gmail history, Drive changes, Dropbox list_folder/continue, Readwise
 * updatedAfter) checks this often by default; each source keeps its own
 * override. A quota or rate refusal defers the task with a reason on the
 * source card (`retryAt`), so a slower check is shown, never silent. Sources
 * that hear of changes themselves (local files, Telegram, WhatsApp, archive
 * imports) are woken by the change and keep their interval as a backstop. X
 * bookmarks keep their own paid-API cadence.
 */
export const LIVE_NEW_ITEMS_INTERVAL_MS = 5 * 60_000;
