/**
 * Records what the relay itself answers along the ChatGPT directory reviewer's
 * path, before any engine is involved:
 *
 * - the directory endpoint (`/openai/mcp`) with no token: initialize, the tool
 *   and resource lists, every UI resource, the dashboard and a linking call;
 * - the OAuth documents, ChatGPT's client registration, the connect page with
 *   its demo button, and the demo sign-in while the demo install is offline.
 *
 * `golden.json` beside this file is this recording made from the relay of the
 * commit submitted for review (see connect-relay/server/directory/approved.ts);
 * test/reviewer-path.test.ts records the current relay and requires the same
 * answers. The recorder only uses relay APIs that commit already had, so it
 * runs unchanged in a checkout of it:
 *
 *   bun connect-relay/test/fixtures/reviewer-path/record.ts > golden.json
 */
import { join } from 'node:path';

export const RECORD_HOST = 'mcp.olympus.test';
/** A fixed clock, so the dashboard's dates and the registration's issue time repeat. */
export const RECORD_NOW = Date.UTC(2026, 9, 11, 17, 0, 0);
/** Any well-formed install id; the demo install never connects while recording. */
export const RECORD_DEMO_INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';

const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const AUTHORIZE_QUERY = new URLSearchParams({
  response_type: 'code',
  client_id: CHATGPT_CLIENT_ID,
  redirect_uri: CHATGPT_REDIRECT,
  state: 'reviewer-state',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  resource: `https://${RECORD_HOST}/openai/mcp`,
}).toString();

interface Step {
  readonly name: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

/** The submitted resource URIs (content versions included) a reviewer's ChatGPT reads. */
const SUBMITTED_RESOURCE_URIS = [
  'ui://olympus/dashboard?v=1c887768189e',
  'ui://olympus/private-answer?v=625370ec27fe',
  'ui://olympus/private-question?v=6a9d8c18b516',
];

export const STEPS: readonly Step[] = [
  { name: 'initialize', method: 'POST', path: '/openai/mcp', body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } }) },
  { name: 'tools/list', method: 'POST', path: '/openai/mcp', body: rpc(2, 'tools/list') },
  { name: 'resources/list', method: 'POST', path: '/openai/mcp', body: rpc(3, 'resources/list') },
  ...SUBMITTED_RESOURCE_URIS.map((uri, index): Step => ({ name: `resources/read ${uri}`, method: 'POST', path: '/openai/mcp', body: rpc(10 + index, 'resources/read', { uri }) })),
  { name: 'tools/call olympus_dashboard', method: 'POST', path: '/openai/mcp', body: rpc(20, 'tools/call', { name: 'olympus_dashboard', arguments: {} }) },
  { name: 'tools/call olympus_search', method: 'POST', path: '/openai/mcp', body: rpc(21, 'tools/call', { name: 'olympus_search', arguments: { query: 'What did Sam say about renewing my lease?' } }) },
  { name: 'tools/call off the directory list', method: 'POST', path: '/openai/mcp', body: rpc(22, 'tools/call', { name: 'not_a_directory_tool', arguments: {} }) },
  { name: 'protected resource metadata', method: 'GET', path: '/.well-known/oauth-protected-resource/openai/mcp' },
  { name: 'authorization server metadata', method: 'GET', path: '/.well-known/oauth-authorization-server' },
  {
    name: 'ChatGPT client registration',
    method: 'POST',
    path: '/connect/register',
    body: { client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
  },
  { name: 'connect page', method: 'GET', path: `/connect/authorize?${AUTHORIZE_QUERY}` },
  { name: 'demo sign-in, demo offline', method: 'GET', path: `/connect/demo/authorize?${AUTHORIZE_QUERY}` },
];

export interface RecordedAnswer {
  readonly name: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Headers that differ per response without saying anything about the answer. */
const VOLATILE_HEADERS = new Set(['date', 'content-length', 'keep-alive', 'connection']);

/** The per-response CSP nonce is random; everything else must repeat exactly. */
function normalize(text: string): string {
  return text.replace(/nonce-[A-Za-z0-9+/=]{16,}/g, 'nonce-<nonce>').replace(/nonce="[A-Za-z0-9+/=]{16,}"/g, 'nonce="<nonce>"');
}

/** Starts the relay found under `root` (a checkout), walks the reviewer's path and stops it. */
export async function recordReviewerPath(root: string): Promise<RecordedAnswer[]> {
  const { startRelay } = await import(join(root, 'connect-relay/server/relay.ts'));
  const { MemoryInstallRegistry } = await import(join(root, 'connect-relay/server/registry.ts'));
  const relay = await startRelay({
    publicHost: RECORD_HOST,
    registry: new MemoryInstallRegistry(),
    listen: { host: '127.0.0.1', port: 0 },
    demoInstallId: RECORD_DEMO_INSTALL_ID,
    now: () => RECORD_NOW,
  });
  try {
    const answers: RecordedAnswer[] = [];
    for (const step of STEPS) {
      const response = await fetch(`http://127.0.0.1:${relay.port}${step.path}`, {
        method: step.method,
        headers: {
          Host: RECORD_HOST,
          Accept: 'application/json, text/event-stream',
          ...(step.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
        redirect: 'manual',
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of [...response.headers].sort(([a], [b]) => a.localeCompare(b))) {
        if (!VOLATILE_HEADERS.has(name)) headers[name] = normalize(value);
      }
      const text = normalize(await response.text());
      let body: unknown = text;
      if ((response.headers.get('content-type') ?? '').includes('json') && text.length > 0) body = JSON.parse(text);
      answers.push({ name: step.name, status: response.status, headers, body });
    }
    return answers;
  } finally {
    await relay.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  process.stdout.write(`${JSON.stringify(await recordReviewerPath(root), null, 2)}\n`);
}
