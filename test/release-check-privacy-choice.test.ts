import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveFreshInstallPrivacyChoice } from '../scripts/release-check/machine-agent.ts';
import { createPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, writeSovereigntyConfigFile } from '../src/core/sovereignty.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, withWorkerBearerAuth } from '../src/workers/http.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });

test.each([false, true])('fresh release check saves through the real local dashboard route (computer choice pending: %s)', async computerPending => {
  const dir = mkdtempSync(join(tmpdir(), 'release-privacy-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sovereignty.json');
  const config = createPendingPrivacyPolicy();
  writeSovereigntyConfigFile({ path, config });
  let pending = computerPending;
  const seen: Array<{ path: string; grade: string | null; csrf: boolean }> = [];
  const worker = createEmailSourceWorker({ sourceDashboard: {
    sovereigntyEngine: createSovereigntyEngine(config), registryPath: join(dir, 'handles.json'),
    computerSetup: () => ({ engine_server_mode: { enabled: false, pending: false }, computer_use_pending: pending }),
    saveComputerUseChoice: () => { pending = false; return { ok: true, status_message: 'Saved.' }; },
    saveFirstRunPrivacyChoice: choice => {
      const result = saveFirstRunPrivacyChoice(path, choice);
      return result.ok && result.changed;
    },
  } });
  cleanup.push(() => worker.close());
  const authenticated = withWorkerBearerAuth(request => {
    seen.push({ path: new URL(request.url).pathname, grade: request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER), csrf: request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) });
    return worker.fetch(request);
  }, { authToken: 'release-fixture-bearer', sessionSecret: 'release-fixture-session-secret' });
  const workerFetch = async (route: string, init?: RequestInit) => {
    // The bearer opens the owner's session, and only that: never the local unlock or a save.
    expect(new Headers(init?.headers).has('authorization')).toBe(route === '/dashboard/control/session');
    const request = new Request(`http://127.0.0.1:8010${route}`, init);
    recordRequestPeer(request, '127.0.0.1');
    return authenticated(request);
  };
  await saveFreshInstallPrivacyChoice({ workerFetch, readPolicy: () => JSON.parse(readFileSync(path, 'utf8')), computerChoicePending: computerPending, bearer: () => 'release-fixture-bearer' });
  expect(seen.at(-1)).toEqual({ path: '/dashboard/models/first-run-privacy', grade: 'local', csrf: true });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadSovereigntyPreset('no-sensitive'));
  expect(pending).toBe(false);
});

test('a missing dashboard POST or a save that does not persist fails the release leg', async () => {
  const mint = () => Response.json({ csrf_token: 'csrf' }, { headers: { 'set-cookie': 'session=fixture; Path=/dashboard' } });
  const minted = (path: string) => path.endsWith('/local') || path === '/dashboard/control/session';
  await expect(saveFreshInstallPrivacyChoice({
    workerFetch: async path => minted(path) ? mint() : new Response('missing', { status: 404 }),
    readPolicy: () => createPendingPrivacyPolicy(),
    bearer: () => 'fixture',
  })).rejects.toThrow('404');
  await expect(saveFreshInstallPrivacyChoice({
    workerFetch: async path => minted(path) ? mint() : Response.json({ ok: true }),
    readPolicy: () => createPendingPrivacyPolicy(),
    bearer: () => 'fixture',
  })).rejects.toThrow('does not match');
});
