/**
 * `GET /v1/engine/brief`: the dashboard's progress and "needs you" sentences,
 * stripped to words and numbers, for `olympus engine status --brief`
 * (core/engine-brief.ts).
 *
 * Mount this INSIDE `withWorkerBearerAuth`: the route does no authentication
 * of its own and is not on the unauthenticated allowlist, so a request
 * without the worker bearer never reaches it.
 */
import { ENGINE_BRIEF_PATH, engineBriefFromViewModel, type EngineBriefViewModel } from '../core/engine-brief.ts';

export interface EngineBriefRouteOptions {
  /** The V1 dashboard view model, built with the same inputs the MCP dashboard tool uses. */
  view: (signal?: AbortSignal) => Promise<EngineBriefViewModel>;
  /** The API base the worker serves under (default /v1). */
  basePath?: string;
}

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export function withEngineBriefRoute(
  rest: (request: Request) => Promise<Response>,
  options: EngineBriefRouteOptions,
): (request: Request) => Promise<Response> {
  const path = `${options.basePath ?? '/v1'}${ENGINE_BRIEF_PATH}`;
  return async (request) => {
    if (new URL(request.url).pathname !== path) return rest(request);
    if (request.method !== 'GET') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
    }
    try {
      return Response.json(engineBriefFromViewModel(await options.view(request.signal)), { headers: HEADERS });
    } catch {
      return Response.json({ error: 'unavailable' }, { status: 503, headers: HEADERS });
    }
  };
}
