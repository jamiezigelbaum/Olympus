import { describe, expect, test } from 'bun:test';
import { createTestClock } from './helpers/test-clock.ts';
import { onDemandChecks, runOnDemandTiming, timeOnDemandFile, timingReply, timingSteps,
  type FolderMode, type TimingDashboard, type TimingDiagnostics } from '../scripts/release-check/on-demand-timing.ts';
import { parseTimingAccounts, scannedPdf, textPdf, type SeedFolder, type TimingFile, type TimingSeeds } from '../scripts/release-check/on-demand-seeds.ts';
import { renderOnDemandTiming } from '../scripts/release-check/report.ts';
import { parseCanaryAccounts, renderCanaryHtml, type CanaryReport } from '../scripts/release-check/canary.ts';
import { mcpCallScript, type EngineMcp } from '../scripts/release-check/live-accounts.ts';
import { parseCli } from '../scripts/release-check/run.ts';

const file: TimingFile = { id: 'dropbox-long', source: 'dropbox', name: 'RC dropbox long.pdf', providerItemId: 'id:abc', version: 'rev-new', fact: 'ZULFA9C1832', question: 'What is the imaginary archive token in RC dropbox long.pdf?' };
const log = ['fetch', 'extract', 'judge', 'embed'].map((step, i) => `[olympus:on-demand] step=${step} count=1 ms=${i * 10}`).join('\n');
const proof = (): TimingDiagnostics => ({ preflight: async () => 'split on', begin: async () => {}, finish: async () => ({ indexed: true, jobIds: ['job-one'], log, attribution: 'single read in log interval' }), close: async () => {} });
const response = (answer: string, cited = false) => ({ ok: true, text: '', structured: { answer, citations: cited ? [{ label: 'Dropbox', title: file.name }] : [] } });
const statusOf = (checks: ReturnType<typeof onDemandChecks>) => Object.fromEntries(checks.map(check => [check.id.split('.').at(-1), check.status]));
function scripted(replies: Awaited<ReturnType<EngineMcp['call']>>[], elapsedMs = 0) {
  const clock = createTestClock();
  const calls: Array<{ tool: string; args: Record<string, unknown>; timeoutMs?: number }> = [];
  const engine: EngineMcp = { call: async (tool, args, options) => {
    calls.push({ tool, args, ...(options ? { timeoutMs: options.timeoutMs } : {}) });
    await clock.advance(elapsedMs);
    return replies[Math.min(calls.length - 1, replies.length - 1)]!;
  }, close: async () => {} };
  return { calls, engine, clock: { now: clock.now, sleep: (ms: number) => clock.advance(ms) } };
}

describe('release-check opt-in on-demand timing', () => {
  test('records question to answer, polls at ten seconds, and shapes the HTML table and JSON observations', async () => {
    const wait = `${file.name}: Reading 1 file(s) for this question. Ask again in about a minute.`;
    const s = scripted([response(wait), response('Reading 1 file(s) for this question. Ask again in about a minute.'), response(`The token is ${file.fact}.`, true)], 3000);
    const row = await timeOnDemandFile(file, s.engine, proof(), undefined, s.clock);
    expect(row).toMatchObject({ t0: '2026-01-01T12:00:00.000Z', foundFile: true, indexed: true, foundParagraph: true, secondsToAnswer: 23, asks: 3, firstReply: wait, jobIds: ['job-one'], steps: { fetch: 0, extract: 10, judge: 20, embed: 30 } });
    expect(row.replies.map(reply => reply.atSeconds)).toEqual([3, 13, 23]);
    expect(s.calls.every(call => call.tool === 'source_answer')).toBe(true);
    expect(s.calls[0]!.args).toEqual({ question: file.question });
    expect(row.waitMessage).toContain('Ask again in about a minute.');
    expect(Object.values(statusOf(onDemandChecks(row)))).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    const html = renderOnDemandTiming([{ ...row, firstReply: '<script>bad</script>' }]);
    for (const heading of ['Found file', 'Read (job indexed)', 'Found paragraph (fact, cited)', 'Seconds to answer', 'Asks', 'First reply names file', 'Wait message shown', 'Fetch ms', 'Extract ms', 'Judge ms', 'Embed ms']) expect(html).toContain(heading);
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).not.toContain('<script>bad</script>');
    const json = JSON.parse(JSON.stringify(row));
    expect(json.replies[0]).toMatchObject({ text: wait, namesFile: true, reading: true });
    const report: CanaryReport = { schema: 'olympus.release-check.canary.v1', runId: 'r', machine: { handle: 'test-mac', os: 'macos' }, candidate: { label: 'main', source: 'installed' }, startedAt: row.t0, finishedAt: row.t0, verdict: 'pass', counts: { pass: 6, fail: 0, skip: 0, warn: 0 }, checks: onDemandChecks(row), screens: [], onDemandTiming: { rows: [row], checks: onDemandChecks(row) } };
    expect(renderCanaryHtml(report, x => x)).toContain('Names with read on demand');
  });

  test('30 seconds passes; over 30 fails with the requested id, including an answer that arrives late', async () => {
    const s = scripted([response(file.fact, true)], 30_000);
    const row = await timeOnDemandFile(file, s.engine, proof(), undefined, s.clock);
    expect(onDemandChecks(row)[0]).toMatchObject({ id: 'ondemand.dropbox-long.slow', status: 'pass' });
    expect(onDemandChecks({ ...row, secondsToAnswer: 30.001 })[0]!.status).toBe('fail');
  });

  test('a silent middle reply fails even when the first explains reading and the final answer succeeds', async () => {
    const s = scripted([response('Reading 1 file(s) for this question. Ask again in about a minute.'), response('I found no answer yet.'), response(file.fact, true)]);
    const row = await timeOnDemandFile(file, s.engine, proof(), undefined, s.clock);
    expect(statusOf(onDemandChecks(row))).toMatchObject({ slow: 'pass', silent: 'fail', paragraph: 'pass' });
    expect(onDemandChecks(row)[1]).toMatchObject({ id: 'ondemand.dropbox-long.silent', detail: '10.0 s: I found no answer yet.' });
  });

  test('facts in excerpts and citations to another file cannot masquerade as an answered, cited paragraph', () => {
    const echoed = { ok: true, text: JSON.stringify({ evidence: [{ excerpt: file.fact }] }), structured: { evidence: [{ title: file.name, excerpt: file.fact }] } };
    expect(timingReply(file, echoed, 'source_answer', 0)).toMatchObject({ answers: false, cited: false, reading: false });
    expect(timingReply(file, response(file.fact), 'source_answer', 0)).toMatchObject({ answers: true, cited: false });
    expect(timingReply(file, { ok: true, text: '', structured: { answer: file.fact, citations: [{ title: 'other.pdf' }] } }, 'source_answer', 0).cited).toBe(false);
    expect(timingReply(file, response('I cannot read this file.'), 'source_answer', 0).reading).toBe(false);
  });

  test('follows the agent pending-result protocol without issuing duplicate questions while an answer runs', async () => {
    const s = scripted([{ ok: true, text: '', structured: { status: 'working', job_id: 'answer-job', message: 'Still working.' } }, response(file.fact, true)]);
    const row = await timeOnDemandFile(file, s.engine, proof(), undefined, s.clock);
    expect(s.calls.map(call => call.tool)).toEqual(['source_answer', 'source_answer_result']);
    expect(s.calls[1]!.args).toEqual({ job_id: 'answer-job' });
    expect(row.asks).toBe(1);
    expect(row.secondsToAnswer).toBe(10);
    expect(statusOf(onDemandChecks(row)).silent).toBe('fail');
  });

  test('stops at 180 seconds and caps each MCP request by the remaining wall time', async () => {
    const s = scripted([response('Reading 1 file(s) for this question. Ask again in about a minute.')]);
    const row = await timeOnDemandFile(file, s.engine, proof(), undefined, s.clock);
    expect(row.secondsToAnswer).toBeNull();
    expect(row.elapsedSeconds).toBe(180);
    expect(row.asks).toBe(18);
    expect(s.calls[0]!.timeoutMs).toBe(180_000);
    expect(s.calls.at(-1)!.timeoutMs).toBe(10_000);
    expect(statusOf(onDemandChecks(row))).toMatchObject({ slow: 'fail', silent: 'pass', paragraph: 'fail' });
    expect(mcpCallScript('macos', 'token', {}, 10_000)).toContain('--max-time 10');
  });

  test('times the dashboard owner action and preserves its words before asking for the answer', async () => {
    const s = scripted([response(file.fact, true)], 1000);
    const row = await timeOnDemandFile(file, s.engine, proof(), async () => { await s.clock.sleep(2000); return 'Reading. Ask again in about a minute.'; }, s.clock);
    expect(row).toMatchObject({ action: 'owner', secondsToAnswer: 3, asks: 1, firstReply: 'Reading. Ask again in about a minute.' });
    expect(row.replies[0]).toMatchObject({ tool: 'dashboard:Read this file', atSeconds: 2, reading: true });
  });

  test('missing and ambiguous engine timings remain visible and fail proof; durations are never invented', () => {
    expect(timingSteps(`${log}\n[olympus:on-demand] step=judge count=1 ms=7`)).toEqual({ fetch: 0, extract: 10, judge: 27, embed: 30 });
    expect(timingSteps('unrelated ms=99')).toEqual({});
  });

  for (const failure of ['upload', 'answer', 'mode-save', 'none'] as const) test(`restores previous explicit and inherited modes after ${failure}`, async () => {
    const folders: SeedFolder[] = [{ source: 'dropbox', id: '/seed' }, { source: 'google_drive', id: 'folder-id' }];
    const calls: string[] = [];
    const modes = new Map<string, FolderMode>([['dropbox', ''], ['google_drive', 'ingest']]);
    const dashboard: TimingDashboard = {
      folderMode: async folder => modes.get(folder.source)!,
      setFolderMode: async (folder, mode) => {
        modes.set(folder.source, mode); calls.push(`${folder.source}:${mode}`);
        if (failure === 'mode-save' && folder.source === 'google_drive' && mode === 'on_demand') throw new Error('lost save reply');
      },
      sync: async folder => { calls.push(`sync:${folder.source}`); },
      prepareRead: async () => async () => 'Reading. Ask again in about a minute.',
    };
    const seeds: TimingSeeds = { folders: async () => folders, upload: async folder => {
      expect(modes.get(folder.source)).toBe('on_demand');
      if (failure === 'upload' && folder.source === 'google_drive') throw new Error('API refused');
      return folder.source === 'dropbox' ? [{ ...file, owner: true }] : [];
    } };
    const s = scripted([response(file.fact, true)]);
    if (failure === 'answer') s.engine.call = async () => { throw new Error('machine disconnected'); };
    const result = await runOnDemandTiming(s.engine, seeds, dashboard, proof(), s.clock);
    expect(modes).toEqual(new Map([['dropbox', ''], ['google_drive', 'ingest']]));
    expect(calls.slice(-2)).toEqual(['google_drive:ingest', 'dropbox:']);
    expect(result.checks.filter(check => check.id.endsWith('.restore')).map(c => c.status)).toEqual(['pass', 'pass']);
    if (failure === 'none') expect(calls).toContain('dropbox:metadata_only');
    else expect(result.checks.some(check => check.status === 'fail')).toBe(true);
  });

  test('preflight failure makes no provider or dashboard writes', async () => {
    const diagnostics = proof(); diagnostics.preflight = async () => { throw new Error('split off'); };
    const s = scripted([]);
    const result = await runOnDemandTiming(s.engine, { folders: async () => { throw new Error('must not seed'); }, upload: async () => [] }, {} as TimingDashboard, diagnostics, s.clock);
    expect(result.checks).toMatchObject([{ id: 'ondemand.setup', status: 'fail', detail: 'Error: split off' }]);
  });

  test('fixtures include a real 200-page PDF with one middle paragraph, and a scan with no text layer', () => {
    const long = textPdf(file.fact, 200).toString('latin1');
    expect(long).toContain('/Count 200');
    expect(long.match(new RegExp(file.fact, 'g'))).toHaveLength(1);
    const page = long.slice(0, long.indexOf(file.fact)).match(/\/Type \/Page\b/g) ?? [];
    expect(page).toHaveLength(100);
    const scan = scannedPdf(`The imaginary archive token is ${file.fact}.`).toString('latin1');
    expect(scan).toContain('/Subtype /Image');
    expect(scan).not.toContain(file.fact);
    expect(scan).not.toContain(' Tj');
  });

  test('account config is opt-in and uses credential commands plus pinned test identities; throwaway runs reject the flag', () => {
    expect(parseCanaryAccounts({ sources: [] }, () => null).on_demand_timing).toBeUndefined();
    const config = { dropbox: { tokenCommand: ['test-token', 'dropbox'], accountId: 'dbid:test' }, drive: { tokenCommand: ['test-token', 'drive'], accountId: 'test@example.invalid' } };
    expect(parseTimingAccounts(config)).toEqual(config);
    expect(parseCanaryAccounts({ on_demand_timing: config }, () => null).on_demand_timing).toEqual(config);
    expect(() => parseTimingAccounts({ drive: config.drive })).toThrow('dropbox');
    expect(() => parseCli(['--on-demand-timing'])).toThrow('accounts legs');
    expect(renderOnDemandTiming(undefined)).toBe('');
  });
});

test('real API seeder reuses provider file ids, refreshes facts/revisions, and imports native Docs on Drive only', async () => {
  const { realTimingSeeds, ON_DEMAND_FOLDER } = await import('../scripts/release-check/on-demand-seeds.ts');
  const config = { dropbox: { tokenCommand: [process.execPath, '-e', 'process.stdout.write("test-token")'], accountId: 'dbid:approved-test' }, drive: { tokenCommand: [process.execPath, '-e', 'process.stdout.write("test-token")'], accountId: 'rc@example.invalid' } };
  let dbFolder = false, googleFolder = false, revision = 0;
  const uploads: Array<{ url: string; method: string; body: string }> = [];
  const driveFiles: Array<{ id: string; name: string; mimeType: string }> = [];
  const dbFiles = new Map<string, string>();
  const api = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    let output: unknown;
    if (url.pathname.endsWith('users/get_current_account')) output = { account_id: config.dropbox.accountId };
    else if (url.pathname.endsWith('/about')) output = { user: { emailAddress: config.drive.accountId } };
    else if (url.pathname.endsWith('files/list_folder')) output = { entries: dbFolder ? [{ '.tag': 'folder', name: ON_DEMAND_FOLDER, id: 'id:folder' }] : [], has_more: false };
    else if (url.pathname.endsWith('files/create_folder_v2')) {
      expect(JSON.parse(String(init?.body)).path).toBe(`/${ON_DEMAND_FOLDER}`);
      expect(dbFolder).toBe(false); dbFolder = true;
      output = { metadata: { id: 'id:folder', name: ON_DEMAND_FOLDER } };
    } else if (url.pathname === '/drive/v3/files' && init?.method === 'POST') {
      expect(googleFolder).toBe(false); googleFolder = true;
      output = { id: 'drive-folder', mimeType: 'application/vnd.google-apps.folder' };
    } else if (url.pathname === '/drive/v3/files') {
      const root = url.searchParams.get('q')?.includes("'root'");
      output = { files: root ? googleFolder ? [{ id: 'drive-folder', name: ON_DEMAND_FOLDER, mimeType: 'application/vnd.google-apps.folder' }] : [] : driveFiles };
    } else if (url.pathname.endsWith('files/upload')) {
      const args = JSON.parse((init!.headers as Record<string, string>)['Dropbox-API-Arg']!);
      expect(args).toMatchObject({ mode: 'overwrite', autorename: false });
      const id = dbFiles.get(args.path) ?? `id:file${dbFiles.size}`;
      dbFiles.set(args.path, id);
      output = { id, rev: `rev${++revision}` };
      uploads.push({ url: String(input), method: init!.method!, body: Buffer.from(init!.body as Uint8Array).toString('latin1') });
    } else if (url.pathname.startsWith('/upload/drive/v3/files')) {
      const body = Buffer.from(init!.body as Uint8Array).toString('latin1');
      uploads.push({ url: String(input), method: init!.method!, body });
      const metadata = JSON.parse(body.split('\r\n\r\n')[1]!.split('\r\n--')[0]!);
      const previous = driveFiles.find(f => f.name === metadata.name);
      if (previous) {
        expect(init?.method).toBe('PATCH');
        expect(url.pathname.endsWith(`/${previous.id}`)).toBe(true);
        expect(metadata.parents).toBeUndefined();
      } else {
        expect(init?.method).toBe('POST');
        expect(metadata.parents).toEqual(['drive-folder']);
        driveFiles.push({ id: `gfile${driveFiles.length}`, name: metadata.name, mimeType: metadata.mimeType });
      }
      output = { id: (previous ?? driveFiles.at(-1))!.id, version: String(++revision) };
    } else throw new Error(`unexpected test API route ${url.pathname}`);
    return Response.json(output);
  }) as typeof fetch;
  const seeds = await realTimingSeeds(config, api);
  const folders = await seeds.folders();
  expect(folders).toEqual([{ source: 'dropbox', id: 'id:folder' }, { source: 'google_drive', id: 'drive-folder' }]);
  expect(await seeds.folders()).toEqual(folders);
  const before = (await Promise.all(folders.map(folder => seeds.upload(folder)))).flat();
  const after = (await Promise.all(folders.map(folder => seeds.upload(folder)))).flat();
  expect(before).toHaveLength(8);
  expect(after.map(file => file.providerItemId)).toEqual(before.map(file => file.providerItemId));
  expect(after.every((file, i) => file.fact !== before[i]!.fact && file.version !== before[i]!.version)).toBe(true);
  expect(before.filter(file => file.id.endsWith('-native')).map(file => file.source)).toEqual(['google_drive']);
  expect(before.filter(file => file.owner)).toHaveLength(1);
  for (const file of before) { expect(file.name).not.toContain(file.fact); expect(file.question).not.toContain(file.fact); }
  expect(uploads.filter(u => u.body.includes('application/vnd.google-apps.document'))).toHaveLength(2);
  expect(uploads.filter(u => u.body.includes('/Count 200'))).toHaveLength(4);
  const wrong = await realTimingSeeds({ ...config, dropbox: { ...config.dropbox, accountId: 'other-account' } }, api).catch(error => error);
  expect(String(wrong)).toContain('configured test account');
});

test('read-only diagnostics match provider identity and version, exclude old log bytes, and expose warm or concurrent reads', async () => {
  const { Database } = await import('bun:sqlite');
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readCursor, finishRead } = await import('../scripts/release-check/on-demand-probe.ts');
  const dir = mkdtempSync(join(tmpdir(), 'ondemand-probe-test-'));
  const dbPath = join(dir, 'queue.sqlite');
  const logPath = join(dir, 'engine.log');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE extraction_jobs(job_id TEXT, status TEXT, source_version TEXT); CREATE TABLE on_demand_reads(job_id TEXT, provider_item_id TEXT);');
    const add = (id: string, providerId: string, version: string, status = 'indexed') => {
      db.query('INSERT INTO extraction_jobs VALUES (?, ?, ?)').run(id, status, version);
      db.query('INSERT INTO on_demand_reads VALUES (?, ?)').run(id, providerId);
    };
    add('old-version', file.providerItemId, 'rev-old');
    writeFileSync(logPath, `${log}\n`);
    const cursor = readCursor({ dbPath, logPaths: [logPath] });
    add('current-job', file.providerItemId, file.version);
    appendFileSync(logPath, `ordinary log text\n${log}\n`);
    expect(finishRead(file, cursor, dbPath)).toEqual({ indexed: true, jobIds: ['current-job'], log, attribution: 'single read in log interval' });
    expect(finishRead({ ...file, version: 'not-seeded' }, cursor, dbPath).indexed).toBe(false);
    const warm = readCursor({ dbPath, logPaths: [logPath] });
    expect(finishRead(file, warm, dbPath)).toMatchObject({ indexed: true, log: '', attribution: expect.stringContaining('ambiguous') });
    appendFileSync(logPath, '[olympus:on-demand] step=embed count=1 ms=100\n');
    expect(finishRead(file, cursor, dbPath).attribution).toContain('ambiguous');
    add('other-read', 'other-file', 'v1', 'leased');
    expect(finishRead(file, cursor, dbPath).attribution).toContain('ambiguous');
    expect(readCursor({ dbPath, logPaths: [logPath] }).busy).toBe(1);
    writeFileSync(logPath, 'rotated');
    expect(finishRead(file, cursor, dbPath)).toMatchObject({ indexed: true, attribution: expect.stringContaining('rotated'), log: '' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ambiguous timing lines are retained as evidence without being attributed to the file', async () => {
  const s = scripted([response(file.fact, true)]);
  const diagnostics = proof();
  diagnostics.finish = async () => ({ indexed: true, jobIds: ['job-one'], log, attribution: 'ambiguous: concurrent reads' });
  const row = await timeOnDemandFile(file, s.engine, diagnostics, undefined, s.clock);
  expect(row.steps).toEqual({});
  expect(row.timingLog).toBe(log);
  expect(statusOf(onDemandChecks(row)).timings).toBe('fail');
});
