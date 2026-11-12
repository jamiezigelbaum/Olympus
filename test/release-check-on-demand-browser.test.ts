import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { createTestClock } from './helpers/test-clock.ts';
import { browserSeedPlan, browserTimingSeeds, parseTimingSeedConfig, ON_DEMAND_FOLDER, type BrowserSeedUi, type TimingFile } from '../scripts/release-check/on-demand-seeds.ts';
import { providerListingExpression } from '../scripts/release-check/on-demand-browser.ts';
import { validateCanaryTimingMode, parseCanaryAccounts, renderCanaryHtml, type CanaryReport } from '../scripts/release-check/canary.ts';
import { runFreshOnDemand } from '../scripts/release-check/fresh-on-demand.ts';
import { enableTimingSplit, resolveTimingFile } from '../scripts/release-check/on-demand-probe.ts';
import { renderOnDemandTiming } from '../scripts/release-check/report.ts';
import type { FreshDashboard } from '../scripts/release-check/fresh-dashboard.ts';
import type { TimingDashboard, TimingDiagnostics } from '../scripts/release-check/on-demand-timing.ts';
import type { EngineMcp } from '../scripts/release-check/live-accounts.ts';
import type { Machine } from '../scripts/release-check/machine.ts';

describe('fresh read-on-demand without write tokens', () => {
  test('mode checks allow fresh timing, require accounts, reject web sign-in and non-Linux fresh runs', () => {
    const mode = { enabled: true, accounts: true, freshInstall: true, webSignIn: false, os: 'linux' };
    expect(() => validateCanaryTimingMode(mode)).not.toThrow();
    expect(() => validateCanaryTimingMode({ ...mode, freshInstall: false, os: 'macos' })).not.toThrow();
    expect(() => validateCanaryTimingMode({ ...mode, accounts: false })).toThrow('--accounts');
    expect(() => validateCanaryTimingMode({ ...mode, webSignIn: true })).toThrow('--web-sign-in');
    expect(() => validateCanaryTimingMode({ ...mode, os: 'macos' })).toThrow('Linux');
    expect(parseCanaryAccounts({ on_demand_timing: {} }, () => null).on_demand_timing).toBeUndefined();
    expect(parseTimingSeedConfig({ dropbox: { accountId: 'id:test' } })).toBeUndefined();
    expect(() => parseTimingSeedConfig({ drive: { tokenCommand: ['token'], accountId: 'x' } })).toThrow('dropbox');
    expect(() => parseTimingSeedConfig({ dropbox: { tokenCommand: [] } })).toThrow();
  });

  test('browser plan has eight topic questions, fixed facts, a middle paragraph, a scan, a native Doc and one owner read', async () => {
    const plan = [...browserSeedPlan('dropbox'), ...browserSeedPlan('google_drive')];
    expect(plan.map(f => f.id)).toEqual(['dropbox-text', 'dropbox-long', 'dropbox-scan', 'dropbox-owner', 'google_drive-text', 'google_drive-long', 'google_drive-native', 'google_drive-scan']);
    expect(plan).toEqual([...browserSeedPlan('dropbox'), ...browserSeedPlan('google_drive')]);
    expect(plan[0]!.fact).toBe('ZULC007ECA34BED');
    expect(new Set(plan.map(f => f.fact)).size).toBe(8);
    expect(plan.filter(f => f.owner)).toHaveLength(1);
    for (const file of plan) {
      if (file.kind !== 'native') expect(file.question).not.toContain(file.name);
      expect(file.question).not.toMatch(/\.pdf|the file/i);
      expect(file.name).not.toContain(file.fact);
      expect(file.sentence).toContain(file.fact);
      expect(file.providerItemId).toBe(''); // Only Olympus's actual metadata can fill these in.
      expect(file.version).toBe('');
    }
    const uploads: Array<{ file: TimingFile; bytes: Buffer }> = [];
    const native: TimingFile[] = [];
    const existing = new Map<string, string[]>();
    const ui: BrowserSeedUi = {
      folder: async (source, name) => { expect(name).toBe(ON_DEMAND_FOLDER); return { source, id: source }; },
      names: async folder => existing.get(folder.source) ?? [],
      upload: async (folder, file, bytes) => { uploads.push({ file, bytes }); existing.set(folder.source, [...(existing.get(folder.source) ?? []), file.name]); },
      native: async (folder, file) => { native.push(file); existing.set(folder.source, [...(existing.get(folder.source) ?? []), file.name]); },
      close: async () => {},
    };
    const seeds = browserTimingSeeds(ui);
    const folders = await seeds.folders();
    const first = [];
    for (const folder of folders) first.push(...await seeds.upload(folder));
    const again = [];
    for (const folder of folders) again.push(...await seeds.upload(folder));
    expect(again).toEqual(first);
    expect(uploads).toHaveLength(7); // The second run made no uploads or native edits.
    expect(native.map(f => f.id)).toEqual(['google_drive-native']);
    for (const upload of uploads.filter(u => u.file.id.endsWith('-long'))) {
      const pdf = upload.bytes.toString('latin1');
      expect(pdf).toContain('/Count 200');
      expect(pdf.match(new RegExp(upload.file.fact, 'g'))).toHaveLength(1);
      expect(pdf.slice(0, pdf.indexOf(upload.file.fact)).match(/\/Type \/Page\b/g)).toHaveLength(100);
    }
    for (const upload of uploads.filter(u => u.file.id.endsWith('-scan'))) {
      expect(upload.bytes.toString('latin1')).toContain('/Subtype /Image');
      expect(upload.bytes.includes(Buffer.from(upload.file.fact))).toBe(false);
    }
    existing.set('dropbox', [plan[0]!.name, plan[0]!.name]);
    await expect(seeds.upload(folders[0]!)).rejects.toThrow('duplicate seed');
  });

  test('provider listing counts each file once while detecting real duplicate rows', async () => {
    const window = new Window();
    const name = browserSeedPlan('google_drive')[0]!.name;
    try {
      window.document.body.innerHTML = `<div role="grid"><div role="row"><div data-tooltip="${name}"><span aria-label="${name}">${name}</span></div></div></div>`;
      expect(new Function('document', `return ${providerListingExpression('google_drive')}`)(window.document)).toEqual([name]);
      window.document.querySelector('[role=grid]')!.append(window.document.querySelector('[role=row]')!.cloneNode(true));
      expect(new Function('document', `return ${providerListingExpression('google_drive')}`)(window.document)).toEqual([name, name]);
    } finally { await window.happyDOM.close(); }
  });

  test('metadata resolution uses listed provider identity/version, deduplicates twins and refuses ambiguity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ondemand-metadata-'));
    const paths = [join(dir, 'secure.sqlite'), join(dir, 'personal.sqlite')];
    const file = browserSeedPlan('dropbox')[0]!;
    try {
      for (const path of paths) {
        const db = new Database(path);
        db.exec('PRAGMA synchronous=OFF; CREATE TABLE items(provider TEXT,title TEXT,provider_item_id TEXT,source_version TEXT,tombstoned INTEGER)');
        db.query('INSERT INTO items VALUES (?,?,?,?,0)').run(file.source, file.name, 'id:real', 'rev-real');
        db.close();
      }
      expect(resolveTimingFile(file, paths)).toMatchObject({ providerItemId: 'id:real', version: 'rev-real', fact: file.fact });
      const db = new Database(paths[1]!);
      db.exec('PRAGMA synchronous=OFF');
      db.query('INSERT INTO items VALUES (?,?,?,?,0)').run(file.source, file.name, 'id:duplicate', 'rev-other'); db.close();
      expect(() => resolveTimingFile(file, paths)).toThrow('ambiguous');
      expect(() => resolveTimingFile({ ...file, name: 'missing' }, paths)).toThrow('missing');
      const configPath = join(dir, 'engine.json');
      const config = { worker: { scheduler: { enabled: true }, engineSplit: false }, other: { untouched: true } };
      writeFileSync(configPath, JSON.stringify(config));
      enableTimingSplit(configPath);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ ...config, worker: { ...config.worker, engineSplit: true } });
    } finally { rmSync(dir, { force: true, recursive: true }); }
  });

  for (const connection of ['web', 'connected', 'unavailable'] as const) test(`fresh timing report: Drive ${connection}, real observations and no fabricated reads`, async () => {
    const events: string[] = [];
    const clock = createTestClock();
    const timingClock = { now: clock.now, sleep: (ms: number) => clock.advance(ms) };
    const files = [...browserSeedPlan('dropbox'), ...browserSeedPlan('google_drive')];
    const engine: EngineMcp = { call: async (_tool, args) => {
      const file = files.find(f => f.question === args.question)!;
      await clock.advance(1000);
      return { ok: true, text: '', structured: { answer: file.fact, citations: [{ title: file.name }] } };
    }, close: async () => {} };
    const dashboard: FreshDashboard & TimingDashboard = {
      privacyChoice: async () => '', indexed: async () => 1, scope: async () => {}, close: async () => {},
      connection: async () => connection,
      connect: async s => { events.push(`connect:${s.id}`); }, consent: async s => { events.push(`consent:${s.id}`); }, callback: async s => { events.push(`callback:${s.id}`); },
      folderMode: async () => '', setFolderMode: async (folder, mode) => { events.push(`${folder.source}:${mode}`); }, sync: async folder => { events.push(`sync:${folder.source}`); },
      prepareRead: async (name, unread) => { expect(unread).toBe(true); events.push(`listed:${name}`); return async () => 'Reading. Ask again in about a minute.'; },
    };
    let startup = false;
    const diagnostics: TimingDiagnostics = {
      enableSplit: async () => { events.push('split-on-and-restart'); },
      preflight: async () => { if (!startup) { startup = true; throw new Error('restarting'); } events.push('split-verified'); return 'engine split on; healthy front and background; installed build test'; },
      resolve: async file => { events.push(`resolve:${file.id}`); return { ...file, providerItemId: `provider:${file.id}`, version: 'listed-revision' }; },
      begin: async file => { expect(file.version).toBe('listed-revision'); events.push(`begin:${file.id}`); },
      finish: async file => ({ indexed: true, jobIds: [`job:${file.id}`], attribution: 'single read in log interval', log: ['fetch', 'extract', 'judge', 'embed'].map(step => `[olympus:on-demand] step=${step} count=1 ms=12`).join('\n') }),
      close: async () => { events.push('diagnostics.close'); },
    };
    const result = await runFreshOnDemand({} as Machine, '127.0.0.1:9334', engine, dashboard, {
      clock: timingClock, diagnostics: async () => diagnostics,
      seeds: async (_machine, endpoint) => {
        expect(endpoint).toBe('127.0.0.1:9334'); events.push('browser-seeds');
        return { folders: async () => [{ source: 'dropbox', id: 'db' }, { source: 'google_drive', id: 'drive' }], upload: async folder => files.filter(file => file.source === folder.source), close: async () => { events.push('seeds.close'); } };
      },
    }, timingClock.sleep);
    expect(result.rows).toHaveLength(connection === 'unavailable' ? 4 : 8);
    expect(result.checks.filter(c => c.status === 'fail')).toEqual([]);
    expect(events.slice(0, 2)).toEqual(['split-on-and-restart', 'split-verified']);
    expect(events.slice(-2)).toEqual(['seeds.close', 'diagnostics.close']);
    expect(events.includes('connect:google_drive')).toBe(connection === 'web');
    expect(result.preflight).toContain('engine split on');
    const firstRead = events.findIndex(event => event.startsWith('begin:'));
    for (const file of files.filter(file => connection !== 'unavailable' || file.source !== 'google_drive')) expect(events.indexOf(`listed:${file.name}`)).toBeLessThan(firstRead);
    for (const row of result.rows) {
      expect(row).toMatchObject({ foundFile: true, indexed: true, foundParagraph: true, secondsToAnswer: 1, asks: 1 });
      expect(result.checks.find(c => c.id === `ondemand.${row.id}.slow`)?.status).toBe('pass');
      expect(result.checks.find(c => c.id === `ondemand.${row.id}.silent`)?.status).toBe('pass');
      expect(events.indexOf(`listed:${row.file}`)).toBeLessThan(events.indexOf(`begin:${row.id}`));
    }
    const html = renderOnDemandTiming(result.rows, result.notRun);
    expect(html).toContain('Found paragraph');
    if (connection === 'unavailable') {
      expect(result.notRun).toHaveLength(4);
      expect(result.notRun!.every(row => row.reason === 'product has no web connect for Drive')).toBe(true);
      expect(result.rows.every(row => row.source === 'dropbox')).toBe(true);
      expect(html).toContain('Not run');
      expect(html).toContain('product has no web connect for Drive');
    }
    const report = { startedAt: '2026-01-01', finishedAt: '2026-01-01', machine: { handle: 'test-omarchy', os: 'linux' }, candidate: { label: 'test', source: 'installed' }, checks: result.checks, screens: [], verdict: 'pass', onDemandTiming: result } as unknown as CanaryReport;
    expect(renderCanaryHtml(report, x => x)).toContain('engine split on; healthy front and background');
  });

  test('the real probe bundles and separates fresh execution from browser-user transfers and scratch cleanup', async () => {
    const { openTimingDiagnostics } = await import('../scripts/release-check/on-demand-machine.ts');
    const events: string[] = [];
    const commandResult = (stdout = '{}') => ({ code: 0, stdout, stderr: '', ms: 0, timedOut: false });
    const fresh = { exec: async (script: string) => { events.push(`fresh:${script}`); return commandResult('{"detail":"engine split on"}'); } } as Machine;
    const transport = {
      put: async (from: string, to: string) => { expect(from.startsWith('/tmp/')).toBe(true); expect(to.startsWith('/tmp/')).toBe(true); events.push('put'); },
      exec: async (script: string) => { events.push(`transport:${script}`); return commandResult(); },
    } as Machine;
    const probe = await openTimingDiagnostics(fresh, transport);
    try {
      await probe.enableSplit!();
      expect(await probe.preflight()).toBe('engine split on');
    } finally { await probe.close(); }
    expect(events[0]).toBe('put');
    expect(events[1]).toStartWith('transport:chmod 644');
    expect(events.filter(event => event.startsWith('fresh:'))).toHaveLength(2);
    expect(events.at(-1)).toStartWith('transport:rm -f');
  });

  test('setup failure closes probe and cannot be reported as a successful timing row', async () => {
    let closed = false;
    const result = await runFreshOnDemand({} as Machine, '127.0.0.1:9334', {} as EngineMcp, {} as FreshDashboard, {
      diagnostics: async () => ({ enableSplit: async () => { throw new Error('restart failed'); }, preflight: async () => '', begin: async () => {}, finish: async () => { throw new Error('must not read'); }, close: async () => { closed = true; } }),
    }, async () => {});
    expect(result.rows).toEqual([]);
    expect(result.checks).toMatchObject([{ id: 'ondemand.setup', status: 'fail', detail: 'Error: restart failed' }]);
    expect(closed).toBe(true);
  });
});
