/**
 * Walks the ChatGPT directory reviewer's path against a live relay and fails
 * when any step differs from what was submitted (server/directory/approved.ts):
 *
 *   1. `/openai/mcp` without a token lists exactly the submitted tools and
 *      resources, and serves the submitted UI bundles;
 *   2. its protected-resource and authorization-server documents;
 *   3. ChatGPT's client registration returns ChatGPT's pinned client;
 *   4. the connect page names ChatGPT and offers the demo sign-in;
 *   5. the demo sign-in page comes from the demo engine (so it is online
 *      behind this relay) and asks for a password;
 *   6. the domain verification token is served.
 *
 * deploy.sh runs it before a deploy (a broken path is fixed first, never
 * deployed over) and after (a failure rolls the relay back). Read-only: the
 * registration is stateless on the relay, and nothing signs in.
 *
 *   bun connect-relay/deploy/reviewer-check.ts [--host mcp.olympusplugin.ai] [--wait <seconds>] [--no-demo]
 *
 * --wait retries the whole walk until it passes or the time runs out (the
 * demo engine reconnects a few seconds after a relay restart). --no-demo
 * skips step 5, for when no demo engine is meant to be running.
 */
import { toolsForSurface } from '../shared/directory-tools.ts';
import {
  APPROVED,
  APPROVED_DASHBOARD_CONTENTS,
  APPROVED_PRIVATE_ANSWER_CONTENTS,
  APPROVED_PRIVATE_QUESTION_CONTENTS,
  APPROVED_RESOURCES,
  APPROVED_TOOLS,
} from '../server/directory/approved.ts';

const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

export interface CheckResult {
  readonly step: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One step's limit, so a relay or demo engine that stops answering fails the walk instead of holding it. */
const STEP_TIMEOUT_MS = 10_000;

/** One JSON-RPC answer from a POST, plain JSON or a single Server-Sent Event. */
async function rpcAnswer(response: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const event = /^data: (.*)$/m.exec(text);
  return JSON.parse(event ? event[1]! : text);
}

/**
 * `baseUrl` sends the requests somewhere else with `host` as their Host
 * header (a test's loopback relay); the answers must still name `https://<host>`.
 */
export async function checkReviewerPath(host: string, options: { demo: boolean; baseUrl?: string; deadline?: number }): Promise<CheckResult[]> {
  const origin = `https://${host}`;
  const base = options.baseUrl ?? origin;
  // Each step gets STEP_TIMEOUT_MS, less once the caller's deadline is near
  // (at least a second), and the abort covers reading the body too.
  let signal: AbortSignal = AbortSignal.timeout(STEP_TIMEOUT_MS);
  const fetch = (path: string, init: RequestInit = {}) => globalThis.fetch(`${base}${path}`, {
    ...init,
    signal,
    headers: { ...(init.headers as Record<string, string> | undefined), ...(options.baseUrl ? { Host: host } : {}) },
  });
  const results: CheckResult[] = [];
  const check = async (step: string, run: () => Promise<string | undefined>) => {
    const limit = options.deadline === undefined
      ? STEP_TIMEOUT_MS
      : Math.max(1_000, Math.min(STEP_TIMEOUT_MS, options.deadline - Date.now()));
    signal = AbortSignal.timeout(limit);
    try {
      const problem = await Promise.race([
        run(),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error(`no answer within ${limit} ms`)), { once: true })),
      ]);
      results.push(problem === undefined ? { step, ok: true } : { step, ok: false, detail: problem });
    } catch (error) {
      results.push({ step, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const mcp = (id: number, method: string, params: Record<string, unknown> = {}) => fetch(`/openai/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }).then(rpcAnswer);

  await check('directory tool list is the submitted one', async () => {
    const answer = await mcp(1, 'tools/list');
    const tools = answer.result?.tools;
    if (same(tools, toolsForSurface(APPROVED_TOOLS, 'directory'))) return undefined;
    const names = Array.isArray(tools) ? tools.map((tool: { name?: string }) => tool.name).join(', ') : JSON.stringify(answer).slice(0, 200);
    return `differs from the submitted listing (live: ${names})`;
  });
  await check('directory resources are the submitted ones', async () => {
    const answer = await mcp(2, 'resources/list');
    return same(answer.result?.resources, APPROVED_RESOURCES) ? undefined : 'resources/list differs from the submitted listing';
  });
  const bundles: Array<[string, unknown]> = [
    ['dashboard', APPROVED_DASHBOARD_CONTENTS],
    ['private-answer', APPROVED_PRIVATE_ANSWER_CONTENTS],
    ['private-question', APPROVED_PRIVATE_QUESTION_CONTENTS],
  ];
  for (const [name, contents] of bundles) {
    const uri = (APPROVED_RESOURCES as Array<{ uri: string }>).find((resource) => resource.uri.startsWith(`ui://olympus/${name}`))!.uri;
    await check(`directory ${name} bundle is the submitted one`, async () => {
      const answer = await mcp(3, 'resources/read', { uri });
      return same(answer.result?.contents, contents) ? undefined : `resources/read ${uri} differs from the submitted bundle`;
    });
  }
  await check('protected resource document names /openai/mcp', async () => {
    const document = await (await fetch(`/.well-known/oauth-protected-resource/openai/mcp`)).json() as Record<string, unknown>;
    return document.resource === `${origin}/openai/mcp` && same(document.authorization_servers, [origin])
      ? undefined
      : `unexpected document ${JSON.stringify(document).slice(0, 200)}`;
  });
  await check('authorization server offers registration and S256', async () => {
    const document = await (await fetch(`/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    return document.registration_endpoint === `${origin}/connect/register`
      && document.authorization_endpoint === `${origin}/connect/authorize`
      && Array.isArray(document.code_challenge_methods_supported) && document.code_challenge_methods_supported.includes('S256')
      ? undefined
      : `unexpected document ${JSON.stringify(document).slice(0, 200)}`;
  });
  await check('ChatGPT registration returns ChatGPT\'s pinned client', async () => {
    const response = await fetch(`/connect/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [CHATGPT_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    return response.status === 201 && body.client_id === CHATGPT_CLIENT_ID && same(body.redirect_uris, [CHATGPT_REDIRECT])
      ? undefined
      : `HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}`;
  });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: CHATGPT_REDIRECT,
    state: 'reviewer-check',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: `${origin}/openai/mcp`,
  }).toString();
  await check('connect page names ChatGPT and offers the demo', async () => {
    const response = await fetch(`/connect/authorize?${query}`);
    const page = await response.text();
    if (response.status !== 200) return `HTTP ${response.status}`;
    if (!page.includes('<h1>Approve ChatGPT on your Mac</h1>')) return 'heading is not "Approve ChatGPT on your Mac"';
    if (!page.includes('Reviewing Olympus? Sign in to the demo')) return 'no demo sign-in button';
    return undefined;
  });
  if (options.demo) {
    await check('demo sign-in page comes from the demo engine', async () => {
      const response = await fetch(`/connect/demo/authorize?${query}`);
      const page = await response.text();
      if (response.status !== 200) return `HTTP ${response.status}: ${page.slice(0, 120)}`;
      if (!page.includes('Sign in to the Olympus demo') || !page.includes('type="password"')) return 'not the demo sign-in form';
      return undefined;
    });
  }
  await check('domain verification token is served', async () => {
    const response = await fetch(`/.well-known/openai-apps-challenge`);
    const text = (await response.text()).trim();
    return response.status === 200 && text.length > 0 ? undefined : `HTTP ${response.status}`;
  });
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const host = option('--host') ?? 'mcp.olympusplugin.ai';
  const waitMs = Number(option('--wait') ?? '0') * 1000;
  const demo = !args.includes('--no-demo');
  const deadline = Date.now() + waitMs;
  let results: CheckResult[];
  for (;;) {
    results = await checkReviewerPath(host, { demo, deadline });
    if (results.every((result) => result.ok) || Date.now() >= deadline) break;
    await Bun.sleep(5_000);
  }
  console.log(`Reviewer path on ${host} (submitted ${APPROVED.commit.slice(0, 12)}, plugin ${APPROVED.status}):`);
  for (const result of results) console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.step}${result.detail ? `: ${result.detail}` : ''}`);
  const failed = results.filter((result) => !result.ok).length;
  if (failed > 0) {
    console.error(`${failed} reviewer-path check(s) failed.`);
    process.exit(1);
  }
}
