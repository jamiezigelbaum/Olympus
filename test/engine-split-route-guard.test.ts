// The engine split's route guard (#1224). In the split the front serves every
// route and is forbidden to open anything writable that the background owns,
// so each route the worker serves to a writing method must say where it runs:
// forwarded to the background (ENGINE_FORWARDED_ROUTES) or front-only with
// the reason that is safe (ENGINE_FRONT_ONLY_ROUTES).
//
// The list of writing routes is exhaustive by construction, not by a scan:
// the worker answers 404 to a writing method on any path its registries do
// not name (workerRouteAllowed), the dashboard's V0_4_PUBLIC_DASHBOARD_ROUTES
// and the worker's WORKER_WRITE_ROUTES, one method and path per prefix action. A scan of
// the worker's dispatch then holds the registry to the handlers, and fails on
// any dispatch form it does not know, so the registry cannot drift either.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V0_4_PUBLIC_DASHBOARD_ROUTES } from '../src/core/public-surface.ts';
import { ENGINE_FORWARDED_ROUTES, ENGINE_FRONT_ONLY_ROUTES } from '../src/workers/engine-split/commands.ts';
import { WORKER_WRITE_ROUTES, workerRouteAllowed } from '../src/workers/email-source/write-routes.ts';
import { scanFileExtractionAliases, scanWorkerWriteRoutes } from './helpers/worker-route-scan.ts';

const WORKER = readFileSync(join(import.meta.dir, '../src/workers/engine/index.ts'), 'utf8');
const FILE_EXTRACTION = readFileSync(join(import.meta.dir, '../src/workers/engine/http/file-extraction.ts'), 'utf8');
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every route the worker serves to a writing method: the public dashboard's and its /v1 routes. */
function workerWriteRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const route of V0_4_PUBLIC_DASHBOARD_ROUTES) if (!READ_METHODS.has(route.method)) routes.add(route.path);
  for (const route of WORKER_WRITE_ROUTES) routes.add(`/v1${route.path}`);
  return routes;
}

/** What the worker's dispatch serves to a writing method that the registry does not name, and the reverse. */
function registryDrift(source: string): { unregistered: string[]; unserved: string[]; unrecognized: string[] } {
  const scan = scanWorkerWriteRoutes(source);
  const served = new Set([
    ...scan.writes,
    ...scanFileExtractionAliases(FILE_EXTRACTION).map((path) => `POST ${path}`),
  ]);
  const registered = new Set(WORKER_WRITE_ROUTES.map((route) => `${route.method} ${route.path}`));
  return {
    unregistered: [...served].filter((path) => !registered.has(path)).sort(),
    unserved: [...registered].filter((path) => !served.has(path)).sort(),
    unrecognized: scan.unrecognized,
  };
}

const forwarded = new Set<string>(Object.values(ENGINE_FORWARDED_ROUTES).flat());

describe('every writing route says where it runs in the split', () => {
  test('each writing route is forwarded to the background or marked front-only with a reason', () => {
    const routes = workerWriteRoutes();
    const unclassified = [...routes].filter((route) => !forwarded.has(route) && !ENGINE_FRONT_ONLY_ROUTES[route]?.trim()).sort();
    expect(unclassified).toEqual([]);
  });

  test('both lists name only exact routes that exist, and none is in both', () => {
    const routes = workerWriteRoutes();
    expect(Object.keys(ENGINE_FRONT_ONLY_ROUTES).filter((route) => !routes.has(route)).sort()).toEqual([]);
    expect([...forwarded].filter((route) => !routes.has(route)).sort()).toEqual([]);
    expect(Object.keys(ENGINE_FRONT_ONLY_ROUTES).filter((route) => forwarded.has(route)).sort()).toEqual([]);
  });

  test('no dashboard writer is a prefix route, so each action has its own entry', () => {
    expect(V0_4_PUBLIC_DASHBOARD_ROUTES.filter((route) => route.prefix && !READ_METHODS.has(route.method))).toEqual([]);
  });
});

describe('the worker serves a writing method only on a registered route', () => {
  test('anything else is refused before any handler runs', () => {
    expect(workerRouteAllowed('POST', '/v1/privacy-item/raise', '/v1')).toBe(true);
    expect(workerRouteAllowed('POST', '/v1/privacy-item/lower', '/v1')).toBe(false);
    expect(workerRouteAllowed('POST', '/v1/source/answer', '/v1')).toBe(true);
    expect(workerRouteAllowed('PUT', '/v1/source/answer', '/v1')).toBe(false);
    expect(workerRouteAllowed('DELETE', '/v1/source/index/embed', '/v1')).toBe(false);
    expect(workerRouteAllowed('PUT', '/v1/brand/new', '/v1')).toBe(false);
    expect(workerRouteAllowed('DELETE', '/elsewhere', '/v1')).toBe(false);
    expect(workerRouteAllowed('GET', '/v1/health', '/v1')).toBe(true);
    expect(workerRouteAllowed('POST', '/dashboard/people', '/v1')).toBe(true);
    expect(workerRouteAllowed('PATCH', '/dashboard/people', '/v1')).toBe(false);
    expect(workerRouteAllowed('POST', '/dashboard/not-a-route', '/v1')).toBe(false);
    expect(workerRouteAllowed('POST', '/api/cli/data-export', '/api')).toBe(true);
  });

  test('the worker asks before its first handler', () => {
    const fetchAt = WORKER.indexOf('async fetch(request: Request): Promise<Response> {');
    const gate = WORKER.indexOf('if (!workerRouteAllowed(request.method, url.pathname, basePath))', fetchAt);
    expect(fetchAt).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(fetchAt);
    expect(WORKER.slice(fetchAt, gate)).not.toMatch(/request\.method ===/);
  });

  test('the registry matches the handlers, and every dispatch form is one the scan knows', () => {
    expect(registryDrift(WORKER)).toEqual({ unregistered: [], unserved: [], unrecognized: [] });
  });
});

describe('the scan catches the writers a narrower one missed', () => {
  const anchor = 'if (request.method === \'POST\' && url.pathname === `${basePath}/consult/ask`) {';
  const insert = (handler: string) => {
    expect(WORKER).toContain(anchor);
    return WORKER.replace(anchor, `${handler}\n        ${anchor}`);
  };

  test('a double-quoted "POST"', () => {
    expect(registryDrift(insert('if (request.method === "POST" && url.pathname === `${basePath}/brand/new`) { return json({}); }')).unregistered).toEqual(['POST /brand/new']);
  });

  test('a PUT, PATCH or DELETE writer', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(registryDrift(insert(`if (request.method === '${method}' && url.pathname === \`\${basePath}/brand/new\`) { return json({}); }`)).unregistered).toEqual([`${method} /brand/new`]);
    }
  });

  test('a new method on a path that is already registered', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(registryDrift(insert(`if (request.method === '${method}' && url.pathname === \`\${basePath}/source/index/embed\`) { return json({}); }`)).unregistered).toEqual([`${method} /source/index/embed`]);
    }
  });

  test('a new method on the CLI prefix', () => {
    const cli = "if (request.method === 'POST' && url.pathname.startsWith(`${basePath}${WORKER_CLI_ROUTE_PREFIX}`)) {";
    expect(WORKER).toContain(cli);
    const drift = registryDrift(WORKER.replace(cli, cli.replace("'POST'", "'PUT'")));
    expect(drift.unregistered).toContain('PUT /cli/data-export');
    expect(drift.unserved).toContain('POST /cli/data-export');
  });

  test('every writer the split router must route is a POST, the one method it forwards', () => {
    expect(WORKER_WRITE_ROUTES.filter((route) => route.method !== 'POST')).toEqual([]);
    expect(V0_4_PUBLIC_DASHBOARD_ROUTES.filter((route) => !READ_METHODS.has(route.method) && route.method !== 'POST')).toEqual([]);
  });

  test('a new action beneath a prefix route', () => {
    const raise = "          if (action === 'raise') {";
    expect(WORKER).toContain(raise);
    const mutated = WORKER.replace(raise, `          if (action === "lower") { return json({}); }\n${raise}`);
    expect(registryDrift(mutated).unregistered).toEqual(['POST /privacy-item/lower']);
  });

  test('a dispatch form it does not know', () => {
    for (const handler of [
      'switch (request.method) { case \'PUT\': return json({}); }',
      'if ([\'PUT\', \'POST\'].includes(request.method) && url.pathname === `${basePath}/brand/new`) { return json({}); }',
      'if (request.method !== \'GET\' && url.pathname === `${basePath}/brand/new`) { return json({}); }',
      'if (request.method === \'POST\' && url.pathname === basePath + \'/brand/new\') { return json({}); }',
      'if (request.method === \'POST\') { return json({}); }',
      'if (request.method === \'POST\' && url.pathname === \'/mcp\') { return json({}); }',
    ]) {
      expect(registryDrift(insert(handler)).unrecognized, handler).toHaveLength(1);
    }
    const prefix = "          const action = url.pathname.slice(`${basePath}/privacy-item/`.length);";
    expect(WORKER).toContain(prefix);
    expect(registryDrift(WORKER.replace(prefix, `${prefix}\n          switch (action) { case 'lower': return json({}); }`)).unrecognized).toHaveLength(1);
  });
});
