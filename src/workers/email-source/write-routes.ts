// Every route the worker serves to a writing method (anything but GET, HEAD
// and OPTIONS), as an exhaustive registry (#1224). The dashboard's routes are
// V0_4_PUBLIC_DASHBOARD_ROUTES; the worker's own, beneath its basePath, are
// WORKER_WRITE_PATHS, one entry for each action of a prefix route and each
// alias. index.ts asks workerRouteAllowed before any handler, so a writer
// that is not registered answers 404 rather than run. The engine split's
// route guard (test/engine-split-route-guard.test.ts) then makes every entry
// say where it runs in the split, and holds this list to the handlers.

import { WORKER_CLI_OPERATIONS, WORKER_CLI_ROUTE_PREFIX } from '../../core/cli-via-worker.ts';
import { isV04PublicDashboardRoute } from '../../core/public-surface.ts';

export const WORKER_WRITE_PATHS: readonly string[] = [
  '/consult/ask',
  '/archive-import/start',
  '/archive-import/status',
  '/archive-import/remove',
  '/privacy-item/find',
  '/privacy-item/raise',
  '/source/answer',
  '/source/answer/received',
  '/source/answer/release',
  '/source/export',
  '/source/index/status',
  '/source/credentials/recheck',
  '/source/scheduler/status',
  '/source/watch/create',
  '/source/watches',
  '/source/watch/cancel',
  '/source/index/x-bookmarks/content/recover',
  '/source/index/sync',
  '/source/index/files/extract',
  '/source/index/files/plan',
  '/source/index/files/transcribe',
  '/source/index/files/recycle-leases',
  '/source/index/files/janitor-requeue',
  '/source/index/files/extract-pdfs',
  '/source/index/files/status',
  '/source/index/dropbox/content/export-eval-shard',
  '/source/index/search',
  '/source/index/embed',
  // Family-scoped aliases of the extraction routes (index.ts rewrites them).
  '/source/index/dropbox/content/extract',
  '/source/index/dropbox/content/plan',
  '/source/index/dropbox/content/recycle-leases',
  '/source/index/dropbox/content/janitor-requeue',
  '/source/index/dropbox/transcribe',
  ...WORKER_CLI_OPERATIONS.map((operation) => `${WORKER_CLI_ROUTE_PREFIX}${operation}`),
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_PATHS = new Set(WORKER_WRITE_PATHS);

/** Whether the worker may serve this method on this path at all. */
export function workerRouteAllowed(method: string, pathname: string, basePath: string): boolean {
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/oauth/callback/')) {
    return isV04PublicDashboardRoute(method, pathname);
  }
  if (READ_METHODS.has(method)) return true;
  return pathname.startsWith(`${basePath}/`) && WRITE_PATHS.has(pathname.slice(basePath.length));
}
