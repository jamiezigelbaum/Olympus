// The private answer panel's sources: where each one opens. A source synced
// to this Mac carries a one-time capability token (inside the sealed answer
// only) that the panel POSTs to `/private/<job id>/open`; the engine opens
// the file it mapped that token to, never a path from the request. A source
// that is not on this Mac carries its https web address instead.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrivateAnswerModel, PrivateAnswerPlaintextV1 } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { createDropboxOpenTargets, dropboxPreviewUrl, localDropboxRoots } from '../src/workers/dropbox-files/open-target.ts';

const INSTALL = 'a'.repeat(32);
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const EVIDENCE = [{ title: 'evidence', trust_domain: 'secure_local' }];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-open-'));
  dirs.push(dir);
  return dir;
}

function sourcesModel(citations: Array<Record<string, unknown>>): PrivateAnswerModel {
  return {
    status: () => ({ state: 'ready' }),
    answerPrivately: async () => ({ answer: 'the answer', citations }),
  };
}

function makeJobs(
  model: PrivateAnswerModel,
  opened: string[],
  extra: Partial<ConstructorParameters<typeof PrivateAnswerJobs>[0]> & { noOpener?: boolean } = {},
) {
  const clock = { now: 1_000_000 };
  const { noOpener, ...rest } = extra;
  const jobs = new PrivateAnswerJobs({
    model: () => model,
    installId: () => INSTALL,
    now: () => clock.now,
    log: () => {},
    claimHoldMs: 0,
    ...(noOpener ? {} : { openFile: async (path: string) => { opened.push(path); } }),
    ...rest,
  });
  return { jobs, clock };
}

async function collect(jobs: PrivateAnswerJobs, jobId: string): Promise<PrivateAnswerPlaintextV1> {
  const panel = await generatePanelKeyPair();
  await jobs.claim(jobId, panel.publicKey);
  await Bun.sleep(30);
  const ready = await jobs.claim(jobId, panel.publicKey);
  expect(ready.body.status).toBe('ready');
  return JSON.parse(await openPrivateAnswer(jobId, panel.privateKey, ready.body as unknown as SealedPrivateAnswer));
}

describe('open targets in the sealed answer', () => {
  test('a local file becomes a mac token, a web address stays a web link; the path never enters the payload', async () => {
    const dir = tempDir();
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const opened: string[] = [];
    const { jobs } = makeJobs(sourcesModel([
      { title: 'On this Mac', url: 'https://www.dropbox.com/home/Labs?preview=report.pdf', localPath: file },
      { title: 'Web only', url: 'https://www.dropbox.com/home/Labs?preview=other.pdf' },
      { title: 'Not a link', url: 'javascript:alert(1)' },
      { title: 'Plain' },
    ]), opened);
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    await Bun.sleep(20);
    const plaintext = await collect(jobs, jobId!);
    expect(JSON.stringify(plaintext)).not.toContain(dir);
    expect(JSON.stringify(plaintext)).not.toContain('localPath');
    const [mac, web, bad, plain] = plaintext.citations;
    const token = (mac!.open as { kind: string; token: string }).token;
    expect(mac!.title).toBe('On this Mac');
    expect(mac!.open?.kind).toBe('mac');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(web).toEqual({ title: 'Web only', open: { kind: 'web', url: 'https://www.dropbox.com/home/Labs?preview=other.pdf' } });
    expect(bad).toEqual({ title: 'Not a link' });
    expect(plain).toEqual({ title: 'Plain' });

    expect(await jobs.open(jobId!, token)).toMatchObject({ status: 204 });
    expect(opened).toEqual([file]);
  });

  test('without an opener (not a Mac), a local file keeps its web link and no token is minted', async () => {
    const dir = tempDir();
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const opened: string[] = [];
    const { jobs } = makeJobs(sourcesModel([{ title: 'f', url: 'https://www.dropbox.com/home?preview=report.pdf', localPath: file }]), opened, { noOpener: true });
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    await Bun.sleep(20);
    const plaintext = await collect(jobs, jobId!);
    expect(plaintext.citations).toEqual([{ title: 'f', open: { kind: 'web', url: 'https://www.dropbox.com/home?preview=report.pdf' } }]);
  });

  test('two jobs sharing one analysis get different tokens; a token opens only within its own job', async () => {
    const dir = tempDir();
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const opened: string[] = [];
    const { jobs } = makeJobs(sourcesModel([{ title: 'f', localPath: file }]), opened);
    const first = jobs.begin({ question: 'same question', count: 1, evidence: EVIDENCE }).jobId!;
    const second = jobs.begin({ question: 'same question', count: 1, evidence: EVIDENCE }).jobId!;
    await Bun.sleep(20);
    const a = (await collect(jobs, first)).citations[0]!.open as { kind: 'mac'; token: string };
    const b = (await collect(jobs, second)).citations[0]!.open as { kind: 'mac'; token: string };
    expect(a.kind).toBe('mac');
    expect(a.token).not.toBe(b.token);
    expect(await jobs.open(first, b.token)).toMatchObject({ status: 410 });
    expect(await jobs.open(second, a.token)).toMatchObject({ status: 410 });
    expect(opened).toEqual([]);
  });
});

describe('the /private/<id>/open endpoint', () => {
  const relayed = (request: Request) => request.headers.has('x-olympus-relay');
  const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`http://127.0.0.1:8010${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN, 'x-olympus-relay': 's', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));

  async function sealedJob(opened: string[], extra: Partial<ConstructorParameters<typeof PrivateAnswerJobs>[0]> = {}) {
    const dir = tempDir();
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x');
    const made = makeJobs(sourcesModel([{ title: 'f', localPath: file }]), opened, extra);
    const { jobId } = made.jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    await Bun.sleep(20);
    const token = ((await collect(made.jobs, jobId!)).citations[0]!.open as { token: string }).token;
    return { ...made, jobId: jobId!, token, file };
  }

  test('opens the mapped file for a relayed panel POST, and nothing for any other shape', async () => {
    const opened: string[] = [];
    const { jobs, jobId, token, file } = await sealedJob(opened);
    const handler = createPrivateAnswerHandler({ jobs, isRelayed: relayed });
    const ok = await post(handler, `/private/${jobId}/open`, { v: 1, open: token });
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    expect(opened).toEqual([file]);

    // Not relayed, not a panel origin, wrong version, junk: refused, nothing opened.
    expect((await handler(new Request(`http://127.0.0.1:8010/private/${jobId}/open`, { method: 'POST', headers: { origin: PANEL_ORIGIN }, body: JSON.stringify({ v: 1, open: token }) }))).status).toBe(404);
    expect((await post(handler, `/private/${jobId}/open`, { v: 1, open: token }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(handler, `/private/${jobId}/open`, { v: 2, open: token })).status).toBe(400);
    expect((await post(handler, `/private/${jobId}/open`, '{nope')).status).toBe(400);
    expect((await post(handler, `/private/${jobId}/open`, { v: 1, open: 'short' })).status).toBe(400);
    expect((await post(handler, `/private/${jobId}/open?x=1`, { v: 1, open: token })).status).toBe(404);
    expect((await post(handler, `/private/${jobId}/open/x`, { v: 1, open: token })).status).toBe(404);
    expect(opened).toEqual([file]);
  });

  test('a path in the request is never used: only a token this job minted opens anything', async () => {
    const opened: string[] = [];
    const { jobs, jobId } = await sealedJob(opened);
    const handler = createPrivateAnswerHandler({ jobs, isRelayed: relayed });
    for (const body of [
      { v: 1, open: '/etc/passwd' },
      { v: 1, open: '../../../../etc/passwd' },
      { v: 1, path: '/etc/passwd' },
      { v: 1, open: 'B'.repeat(43), path: '/etc/passwd' },
      { v: 1, open: { kind: 'mac', path: '/etc/passwd' } },
    ]) {
      const response = await post(handler, `/private/${jobId}/open`, body);
      expect([400, 410], JSON.stringify(body)).toContain(response.status);
    }
    expect(opened).toEqual([]);
  });

  test('tokens expire with their job; an unknown job or another install is gone', async () => {
    const opened: string[] = [];
    const { jobs, jobId, token, clock } = await sealedJob(opened);
    expect(await jobs.open(`oly2p.${'b'.repeat(32)}.${jobId.split('.')[2]}`, token)).toMatchObject({ status: 410 });
    clock.now += 10 * 60_000 + 1;
    expect(await jobs.open(jobId, token)).toMatchObject({ status: 410, body: { status: 'gone' } });
    expect(opened).toEqual([]);
  });

  test('open requests are rate limited per job and across jobs', async () => {
    const opened: string[] = [];
    const { jobs, jobId, token } = await sealedJob(opened, { openRate: { capacity: 2, refillPerSecond: 0 } });
    expect(await jobs.open(jobId, token)).toMatchObject({ status: 204 });
    expect(await jobs.open(jobId, token)).toMatchObject({ status: 204 });
    expect(await jobs.open(jobId, token)).toMatchObject({ status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: 5 });
    expect(opened).toHaveLength(2);

    const across: string[] = [];
    const global = await sealedJob(across, { openRateGlobal: { capacity: 1, refillPerSecond: 0 } });
    expect(await global.jobs.open(global.jobId, global.token)).toMatchObject({ status: 204 });
    expect(await global.jobs.open(global.jobId, global.token)).toMatchObject({ status: 429 });
  });

  test('a file removed since the answer was sealed is gone; an opener failure reports failed', async () => {
    const opened: string[] = [];
    const { jobs, jobId, token, file } = await sealedJob(opened);
    rmSync(file);
    expect(await jobs.open(jobId, token)).toMatchObject({ status: 410 });
    const failing = await sealedJob([], { openFile: async () => { throw new Error('no'); } });
    expect(await failing.jobs.open(failing.jobId, failing.token)).toMatchObject({ status: 200, body: { status: 'failed' } });
  });
});

describe('Dropbox open targets', () => {
  test('the web preview address encodes the folder and the name', () => {
    expect(dropboxPreviewUrl('/2 Areas/Health/Labs/2026-06-29 blood work 1.pdf'))
      .toBe('https://www.dropbox.com/home/2%20Areas/Health/Labs?preview=2026-06-29%20blood%20work%201.pdf');
    expect(dropboxPreviewUrl('/top.pdf')).toBe('https://www.dropbox.com/home?preview=top.pdf');
    expect(dropboxPreviewUrl('/a/b?c#d&e.pdf')).toBe('https://www.dropbox.com/home/a?preview=b%3Fc%23d%26e.pdf');
    expect(dropboxPreviewUrl('relative/x.pdf')).toBeUndefined();
    expect(dropboxPreviewUrl('/a/../x.pdf')).toBeUndefined();
    expect(dropboxPreviewUrl('/')).toBeUndefined();
  });

  test('the Dropbox folder is found from info.json, CloudStorage or ~/Dropbox; a synced file gets its local path', () => {
    const home = tempDir();
    const synced = join(home, 'Sync', 'MyDropbox');
    mkdirSync(join(synced, 'Labs'), { recursive: true });
    writeFileSync(join(synced, 'Labs', 'report.pdf'), 'x');
    mkdirSync(join(home, '.dropbox'));
    writeFileSync(join(home, '.dropbox', 'info.json'), JSON.stringify({ personal: { path: synced } }));
    mkdirSync(join(home, 'Library', 'CloudStorage', 'Dropbox-Team'), { recursive: true });
    const roots = localDropboxRoots({ home, env: {} });
    expect(roots[0]).toContain('MyDropbox');
    expect(roots.some((root) => root.endsWith('Dropbox-Team'))).toBe(true);

    const resolve = createDropboxOpenTargets({ home, env: {} });
    const target = resolve('/Labs/report.pdf');
    expect(target?.url).toBe('https://www.dropbox.com/home/Labs?preview=report.pdf');
    expect(target?.localPath).toMatch(/MyDropbox\/Labs\/report\.pdf$/);
    // Not synced here: the web address only.
    expect(resolve('/Labs/missing.pdf')).toEqual({ url: 'https://www.dropbox.com/home/Labs?preview=missing.pdf' });
    // A folder is not a file to open.
    expect(resolve('/Labs')?.localPath).toBeUndefined();
  });

  test('a symlink out of the Dropbox folder, or a parent segment, never yields a local path', () => {
    const home = tempDir();
    const root = join(home, 'Dropbox');
    mkdirSync(root);
    const outside = join(home, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'link.txt'));
    const resolve = createDropboxOpenTargets({ home, env: {} });
    expect(resolve('/link.txt')).toEqual({ url: 'https://www.dropbox.com/home?preview=link.txt' });
    expect(resolve('/../outside.txt')).toBeUndefined();
  });
});
