// The engine split's route guard (#1224). In the split the front serves every
// route and is forbidden to open anything writable that the background owns,
// so each POST route the worker serves must say where it runs: forwarded to
// the background (ENGINE_FORWARDED_ROUTES) or front-only with the reason that
// is safe (ENGINE_FRONT_ONLY_ROUTES). A new writer added to main then fails
// here instead of failing in review or with the switch on.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_CLI_OPERATIONS } from '../src/core/cli-via-worker.ts';
import { V0_4_PUBLIC_DASHBOARD_ROUTES } from '../src/core/public-surface.ts';
import { ENGINE_FORWARDED_ROUTES, ENGINE_FRONT_ONLY_ROUTES } from '../src/workers/engine-split/commands.ts';

/** Every POST route the worker serves: the public dashboard's, its /v1 routes and the CLI's. */
function workerPostRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const route of V0_4_PUBLIC_DASHBOARD_ROUTES) if (route.method === 'POST') routes.add(route.path);
  const worker = readFileSync(join(import.meta.dir, '../src/workers/email-source/index.ts'), 'utf8');
  for (const line of worker.split('\n')) {
    if (!line.includes("'POST'")) continue;
    for (const match of line.matchAll(/url\.pathname(?: === |\.startsWith\()`\$\{basePath\}(\/[^`]*)`/g)) routes.add(`/v1${match[1]}`);
  }
  for (const operation of WORKER_CLI_OPERATIONS) routes.add(`/v1/cli/${operation}`);
  return routes;
}

const forwarded = new Set<string>(Object.values(ENGINE_FORWARDED_ROUTES).flat());

describe('every writing route says where it runs in the split', () => {
  test('each POST route is forwarded to the background or marked front-only with a reason', () => {
    const routes = workerPostRoutes();
    // The scan finds the worker's routes (a broken scan must not pass by finding none).
    expect(routes.size).toBeGreaterThan(80);
    const unclassified = [...routes].filter((route) => !forwarded.has(route) && !ENGINE_FRONT_ONLY_ROUTES[route]?.trim()).sort();
    expect(unclassified).toEqual([]);
  });

  test('the front-only list names only routes that exist, and none that is forwarded', () => {
    const routes = workerPostRoutes();
    const stale = Object.keys(ENGINE_FRONT_ONLY_ROUTES).filter((route) => !routes.has(route)).sort();
    expect(stale).toEqual([]);
    const both = Object.keys(ENGINE_FRONT_ONLY_ROUTES).filter((route) => forwarded.has(route)).sort();
    expect(both).toEqual([]);
  });
});
