import { RELAY_SURFACES_PATH } from '../core/remote-access.ts';
import { isLoopbackAddress, requestPeerAddress, requestFromOwnerSocket } from '../core/request-peer.ts';
import { readBoundedRequestText } from './remote-request-body.ts';

const MESSAGE = 'Choose how Olympus may answer with Private items before source data can leave this computer. Open Olympus on the computer or use olympus_privacy_get.';
const refusal = () => ({ content: [{ type: 'text', text: MESSAGE }], structuredContent: { error: 'privacy_choice_required' }, isError: true });

/**
 * One source-neutral gate around every external worker surface (MCP, OpenAPI,
 * bearer routes and dashboard). In-process calls stay inside this boundary.
 * Only the computer's browser may browse before consent; URL/Host alone is
 * never evidence of locality. Authentication and CSRF still run downstream.
 */
export function withFirstRunPrivacyGate(
  handler: (request: Request) => Response | Promise<Response>,
  options: { pending: () => boolean; isRelayed?: (request: Request) => boolean },
): (request: Request) => Promise<Response> {
  return async request => {
    let pending = true;
    try { pending = options.pending(); } catch { /* Unreadable choice fails closed. */ }
    if (!pending) return handler(request);
    const url = new URL(request.url);
    const path = url.pathname;
    const localDashboard = path.startsWith('/dashboard')
      && url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isLoopbackAddress(url.hostname))
      && (requestFromOwnerSocket(request) || isLoopbackAddress(requestPeerAddress(request)))
      && !request.headers.has('authorization')
      && !request.headers.has('x-olympus-gateway-public-origin')
      && !options.isRelayed?.(request);
    if (localDashboard) return handler(request);
    // Olympus connection authorization and constant liveness responses contain
    // no source data. Source OAuth/pickers are deliberately outside this list.
    if (request.method === 'GET' && ['/v1/health', '/health'].includes(path)) {
      return Response.json({ reachable: true, status: 'ok', privacy_choice_pending: true, dependency_check: 'not_run' });
    }
    if (path.startsWith('/.well-known/') || path.startsWith('/connect/')
      || path === RELAY_SURFACES_PATH || path === '/openapi.json'
      || ['/dashboard/launch', '/dashboard/control/launch', '/dashboard/control/launch/redeem', '/dashboard/control/session', '/dashboard/control/session/local'].includes(path)
      || (request.method === 'GET' && path === '/v1/service/readiness')) {
      return handler(request);
    }
    if ((path === '/mcp' || path === '/openai/mcp') && request.method === 'POST') {
      const body = await readBoundedRequestText(request, undefined, { deadlineMs: 5_000 });
      if (!body.ok) return Response.json({ error: { code: 'privacy_choice_required', message: MESSAGE } }, { status: 403 });
      // Read once with a cap; teeing an unread body can hang cancellation.
      const forward = () => handler(new Request(request.url, { method: request.method,
        headers: request.headers, body: body.text, signal: request.signal }));
      let rpc: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } };
      try { rpc = JSON.parse(body.text); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
      if (rpc && !Array.isArray(rpc)) {
        // Static protocol/resources and the privacy chooser remain usable.
        if (['initialize', 'notifications/initialized', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read'].includes(String(rpc.method))) return forward();
        if (rpc.method === 'tools/call') {
          if (rpc.params?.name === 'olympus_privacy_get' || rpc.params?.name === 'olympus_privacy_set') return forward();
          return Response.json({ jsonrpc: '2.0', id: rpc.id ?? null, result: refusal() });
        }
      }
    }
    return Response.json({ error: { code: 'privacy_choice_required', message: MESSAGE } }, { status: 403 });
  };
}
