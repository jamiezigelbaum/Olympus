/**
 * The release check's stand-in for an update (#1063, journey `update-from-dashboard`): a page with the dashboard's own update notice
 * (renderUpdateNotice, the program Home and Settings › Updates carry) and the engine's two Update now routes, backed by the engine's own
 * updater (core/self-update.ts) with everything it checks left in: the signed manifest, the installer against the manifest, the runner
 * that records the installer's exit, and how the result is read back (done, or the previous version put back).
 *
 * What it stands in for, and why. The candidate on the machine ships no release key yet (release-signing.ts, PLACEHOLDER) and the site
 * it updates from is the live one, so the installed engine refuses every update, as it must. The release check never touches the live
 * site or a release key, so here a key pair is made in memory for this one page, the way #1144's own tests do (test/self-update.test.ts),
 * and is gone when the page stops. The installer is a test script, not the real one: it never touches the install. What it prints and
 * how it exits is the outcome under test:
 *
 *   ?outcome=rolled-back   the new version "did not start" and the installer says the previous one was put back (exit 1)
 *   ?outcome=done          the installer exits 0 and the engine comes back on the new version (a 502 while it restarts)
 *   ?outcome=bad-signature the manifest is signed with another key: nothing runs
 *
 * Each visit to a different outcome starts over with a fresh state folder. Nothing here reads or writes the owner's install.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfUpdater, type SelfUpdater } from '../../src/core/self-update.ts';
import { installerForPlatform } from '../../src/core/update-check.ts';
import { renderUpdateNotice, UPDATE_NOTICE_CSS } from '../../src/workers/dashboard/update-now.ts';
import { DASHBOARD_SELF_UPDATE_PATHS } from '../../src/workers/http.ts';
import { publicKeyPem, signInstaller } from '../sign-release-manifest.ts';

export type UpdateOutcome = 'rolled-back' | 'done' | 'bad-signature';
export const UPDATE_OUTCOMES: readonly UpdateOutcome[] = ['rolled-back', 'done', 'bad-signature'];
/** The versions the stand-in updates between; not the candidate's, which this page never changes. */
export const STAND_IN_FROM = '1.5.0';
export const STAND_IN_TO = '1.5.1';
/** The page's control session: the notice sends it with every call, and the routes refuse a call without it. */
const STAND_IN_CSRF = 'release-check-stand-in';
/** What the Linux lifecycle prints when it put the previous install back (engine-service.ts). */
export const ROLLED_BACK_LINE = 'Previous installation restoration proved healthy.';

const SHA = (c: string) => c.repeat(64);

/** A rendered installer with complete release pins, whose body only prints and exits as the outcome says. */
export function standInInstaller(version: string, outcome: UpdateOutcome, pauseS = 2): string {
  const body = outcome === 'rolled-back'
    ? `echo "Olympus ${version} did not prove healthy."\necho "${ROLLED_BACK_LINE}"\nexit 1\n`
    : 'echo "Olympus is ready."\nexit 0\n';
  return `#!/bin/sh\nset -eu\nOLYMPUS_VERSION=${version}\nOLYMPUS_SHA256=${SHA('a')}\nOLYMPUS_BYTES=1234\nWHATSAPP_BRIDGE_NAME=none\nMACOS_HELPER_NAME=none\n`
    // The step the page shows while the installer runs needs a moment to be seen.
    + `${pauseS > 0 ? `sleep ${pauseS}\n` : ''}${body}`;
}

interface Scenario { outcome: UpdateOutcome; dir: string; files: Record<string, string>; updater: SelfUpdater; restarted: boolean; downOnce: boolean }

export interface UpdateStandIn { url: string; stop(): void }

/** Starts the stand-in on a loopback port; `url` is its page. */
export function startUpdateStandIn(options: { port?: number; installerPauseS?: number } = {}): UpdateStandIn {
  const installer = installerForPlatform('linux')!;
  const key = generateKeyPairSync('ed25519').privateKey;
  const publicPem = publicKeyPem(key);
  let scenario: Scenario | undefined;

  const updaterFor = (dir: string, runningVersion: string, pid: number, files: Record<string, string>): SelfUpdater => createSelfUpdater({
    platform: 'linux',
    runningVersion,
    stateDir: join(dir, 'state'),
    standaloneEngine: true,
    available: () => ({ version: STAND_IN_TO }),
    publicKeyPem: publicPem,
    pid,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = files[url];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
    }) as typeof fetch,
    // The engine's runner, in its own session, as the Mac handoff starts it: the outcome is what it records.
    launch: (runner, runDir) => new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [runner, runDir], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    }),
  });

  const begin = (outcome: UpdateOutcome): Scenario => {
    if (scenario) rmSync(scenario.dir, { recursive: true, force: true });
    const dir = mkdtempSync(join(tmpdir(), 'rc-update-'));
    const script = standInInstaller(STAND_IN_TO, outcome, options.installerPauseS);
    const installerPath = join(dir, 'install-linux.sh');
    writeFileSync(installerPath, script);
    // bad-signature: signed with a key the updater does not hold.
    const signer = outcome === 'bad-signature' ? generateKeyPairSync('ed25519').privateKey : key;
    const envelope = signInstaller(installerPath, signer, publicKeyPem(signer));
    const files = { [installer.url]: readFileSync(installerPath, 'utf8'), [`${installer.url}.release.json`]: envelope };
    return { outcome, dir, files, updater: updaterFor(dir, STAND_IN_FROM, 1001, files), restarted: false, downOnce: false };
  };

  /** done: once the installer recorded success, the engine "restarts" on the new version (a new process reading the same record). */
  const current = (): { updater: SelfUpdater; down: boolean } => {
    const s = scenario!;
    if (s.outcome === 'done' && !s.restarted) {
      const state = s.updater.status();
      if (state.state === 'running' && state.step === 4) {
        s.restarted = true;
        s.updater = updaterFor(s.dir, STAND_IN_TO, 1002, s.files);
        return { updater: s.updater, down: true };
      }
    }
    return { updater: s.updater, down: false };
  };

  const page = (outcome: UpdateOutcome): string => {
    const status = scenario!.updater.status();
    const notice = renderUpdateNotice({
      command: installer.command,
      available: scenario!.restarted ? undefined : { version: STAND_IN_TO },
      selfUpdate: true,
      status: status.state === 'idle' ? undefined : status,
      csrfToken: STAND_IN_CSRF,
      localSession: true,
    });
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Olympus update (release check)</title>`
      + `<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}.btn{font:inherit;cursor:pointer}${UPDATE_NOTICE_CSS}</style></head>`
      + `<body data-update-outcome="${outcome}"><main><h1>Home</h1>${notice}</main></body></html>`;
  };

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        const asked = url.searchParams.get('outcome') ?? 'rolled-back';
        const outcome = (UPDATE_OUTCOMES as readonly string[]).includes(asked) ? asked as UpdateOutcome : 'rolled-back';
        if (!scenario || scenario.outcome !== outcome) scenario = begin(outcome);
        return new Response(page(outcome), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      if (request.method === 'POST' && (url.pathname === DASHBOARD_SELF_UPDATE_PATHS.start || url.pathname === DASHBOARD_SELF_UPDATE_PATHS.status)) {
        if (!scenario || request.headers.get('X-Olympus-CSRF') !== STAND_IN_CSRF) return json({ ok: false, error: { code: 'forbidden', message: 'no session' } }, 403);
        const { updater, down } = current();
        // The engine is restarting: the proxy in front of it answers 502 once.
        if (down && !scenario.downOnce) { scenario.downOnce = true; return new Response(null, { status: 502 }); }
        if (url.pathname === DASHBOARD_SELF_UPDATE_PATHS.status) return json({ ok: true, update: updater.status() });
        const started = updater.start();
        return started.ok ? json({ ok: true, update: started.status }) : json({ ok: false, error: { code: started.refusal, message: started.refusal } }, 409);
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop() {
      server.stop(true);
      if (scenario) rmSync(scenario.dir, { recursive: true, force: true });
      scenario = undefined;
    },
  };
}
