// Settings › Back up and restore (#1065): the schedule, retention when the
// scheduler runs, the passphrase key kept owner-only, restore through a
// restart, and routes served only to the unlocked local dashboard session.
import { lifecycleViews } from './helpers/lifecycle-view.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { exportOlympusData, lifecycleEnv } from '../src/data-lifecycle.ts';
import { BACKUP_WRONG_PASSPHRASE, listBackups } from '../src/data-backup.ts';
import { applyPendingRestoreAtBoot, backupDue, createBackupService, type BackupServicePaths, type BackupSettingsFile } from '../src/workers/backup-service.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';
import { renderDashboardSettingsPage } from '../src/workers/dashboard/pages/local.ts';
import { DASHBOARD_BACKUP_PATHS } from '../src/workers/dashboard/backup-paths.ts';
import { createTestClock } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0)) run(); });

function seed(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.query('INSERT INTO rows (value) VALUES (?)').run(value);
  db.close();
}
const storeOf = (homeDir: string) => lifecycleViews().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({ homeDir })[0]!;

function install(home: string, now: () => Date, restarts: { count: number } = { count: 0 }) {
  const env = lifecycleEnv({ homeDir: home });
  const paths: BackupServicePaths = { settings: join(home, 'cfg', 'backup.json'), key: join(home, 'cfg', 'backup-key.json'), staging: sharedDataPath('backup-staging', env) };
  const service = createBackupService({
    paths, env, now,
    exportInto: (destination) => exportOlympusData({ destination, homeDir: home }),
    canRestart: () => true,
    requestRestart: () => { restarts.count += 1; return true; },
  });
  return { service, paths, env };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-backup-service-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('backup schedule', () => {
  const base = (over: Partial<BackupSettingsFile>): BackupSettingsFile => ({ schema: 'olympus.backup.settings.v1', folder: '/Volumes/T7/Backup', schedule: 'nightly', ...over });
  test('nightly runs once a day from 03:00; weekly once seven days have passed; manual never', () => {
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0);
    expect(backupDue(base({}), at(10, 2))).toBe(false);
    expect(backupDue(base({}), at(10, 3))).toBe(true);
    expect(backupDue(base({ last_attempt_at: at(10, 3).toISOString(), last: { at: at(10, 3).toISOString(), file: 'x', bytes: 1, encrypted: true } }), at(10, 23))).toBe(false);
    expect(backupDue(base({ last_attempt_at: at(10, 3).toISOString() }), at(11, 3))).toBe(true);
    expect(backupDue(base({ schedule: 'weekly', last_attempt_at: at(10, 3).toISOString() }), at(16, 9))).toBe(false);
    expect(backupDue(base({ schedule: 'weekly', last_attempt_at: at(10, 3).toISOString() }), at(17, 3))).toBe(true);
    expect(backupDue(base({ schedule: 'manual' }), at(10, 9))).toBe(false);
    const { folder: _none, ...noFolder } = base({});
    expect(backupDue(noFolder, at(10, 9))).toBe(false);
    // A failure is tried again an hour later, not the next night.
    const failed = base({ last_attempt_at: at(10, 3).toISOString(), last_error: { at: at(10, 3).toISOString(), message: 'disk gone' } });
    expect(backupDue(failed, new Date(2026, 10, 10, 3, 30))).toBe(false);
    expect(backupDue(failed, at(10, 4))).toBe(true);
  });
});

describe('backup service', () => {
  test('choosing a folder turns on nightly backups; the scheduler keeps the newest seven', async () => {
    const dir = tempDir();
    const home = join(dir, 'a');
    seed(storeOf(home), 'a bookmark');
    const clock = createTestClock(new Date(2026, 10, 1, 3, 30).getTime());
    const { service } = install(home, () => new Date(clock.now()));
    const folder = join(dir, 'Backups');
    mkdirSync(folder);
    expect(service.saveSettings({ folder }).schedule).toBe('nightly');
    for (let day = 0; day < 9; day += 1) {
      expect(await service.tick()).toBe(true);
      expect(await service.tick()).toBe(false);
      await clock.advance(24 * 60 * 60 * 1000);
    }
    const kept = listBackups(folder);
    expect(kept).toHaveLength(7);
    expect(kept[0]!.name).toBe('olympus-backup-2026-11-09-0330.olympusbackup');
    const status = service.status();
    expect(status.last?.file).toBe(kept[0]!.path);
    expect(status.lastError).toBeUndefined();
  });

  test('a passphrase is never stored: the key file is owner-only and holds no passphrase', () => {
    const dir = tempDir();
    const { service, paths } = install(join(dir, 'a'), () => new Date());
    expect(() => service.setPassphrase('short')).toThrow('at least 8 characters');
    expect(service.setPassphrase('correct horse battery').passphraseSet).toBe(true);
    expect(statSync(paths.key).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.key, 'utf8')).not.toContain('correct horse');
    expect(service.setPassphrase(null).passphraseSet).toBe(false);
    expect(existsSync(paths.key)).toBe(false);
  });

  test('restore opens and checks the backup, restarts, and the restart restores it', async () => {
    const dir = tempDir();
    const homeA = join(dir, 'a');
    seed(storeOf(homeA), 'a bookmark');
    const a = install(homeA, () => new Date());
    const folder = join(dir, 'Backups');
    mkdirSync(folder);
    a.service.saveSettings({ folder, schedule: 'manual' });
    a.service.setPassphrase('correct horse battery');
    await a.service.runNow();
    const file = listBackups(folder)[0]!.path;
    expect(listBackups(folder)[0]!.encrypted).toBe(true);

    const homeB = join(dir, 'b');
    const restarts = { count: 0 };
    const b = install(homeB, () => new Date(), restarts);
    expect(() => b.service.restore({ file, passphrase: 'wrong horse battery' })).toThrow(BACKUP_WRONG_PASSPHRASE);
    expect(restarts.count).toBe(0);
    expect(existsSync(b.paths.staging) ? readdirSync(b.paths.staging) : []).toEqual([]);

    expect(b.service.restore({ file, passphrase: 'correct horse battery' }).restore?.state).toBe('restarting');
    expect(restarts.count).toBe(1);
    // Nothing is written until the restart.
    expect(existsSync(storeOf(homeB))).toBe(false);
    const result = applyPendingRestoreAtBoot(b.paths, b.env);
    expect(result?.state).toBe('done');
    expect(result?.sign_in_again).toContain('x.bookmarks');
    expect(existsSync(storeOf(homeB))).toBe(true);
    // Only the result is left for the page; the opened backup is gone.
    expect(readdirSync(b.paths.staging)).toEqual(['restore-result.json']);
    expect(b.service.status().restore?.state).toBe('done');
  });
});

describe('backup routes', () => {
  const origin = 'http://127.0.0.1:28191';
  function worker() {
    const dir = tempDir();
    const calls: string[] = [];
    const backup = {
      status: () => { calls.push('status'); return { schedule: 'manual' as const, passphraseSet: false, running: false, backups: [], restoreAvailable: true }; },
      saveSettings: () => { throw new Error('unused'); },
      setPassphrase: () => { calls.push('passphrase'); return backup.status(); },
      runNow: async () => backup.status(),
      tick: async () => false,
      restore: () => { throw new Error('unused'); },
    };
    const instance = createEmailSourceWorker({ sourceDashboard: { sovereigntyEngine: {} as never, registryPath: join(dir, 'handles.json'), backup } });
    cleanup.push(() => instance.close());
    return { fetch: withWorkerBearerAuth(instance.fetch, { authToken: 'test-worker-token' }), calls };
  }
  async function mint(fetch: ReturnType<typeof worker>['fetch'], local: boolean) {
    const request = new Request(origin + (local ? DASHBOARD_LOCAL_CONTROL_SESSION_PATH : '/dashboard/control/session'), { method: 'POST', headers: { Origin: origin, ...(local ? {} : { Authorization: 'Bearer test-worker-token' }) } });
    recordRequestPeer(request, '127.0.0.1');
    const response = await fetch(request);
    expect(response.status).toBe(200);
    return { Cookie: response.headers.get('Set-Cookie')!.split(';')[0]!, Origin: origin, 'X-Olympus-CSRF': (await response.json() as { csrf_token: string }).csrf_token };
  }
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) => {
    const request = new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    recordRequestPeer(request, '127.0.0.1');
    return request;
  };

  test('the bearer, a bearer-minted (remote) session and forged context are refused; the local session is served', async () => {
    const { fetch, calls } = worker();
    for (const path of DASHBOARD_BACKUP_PATHS) {
      expect((await fetch(post(path, { Origin: origin }))).status).toBe(401);
      expect((await fetch(post(path, { Authorization: 'Bearer test-worker-token', Origin: origin, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local', [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: 'forged' }))).status).toBe(403);
    }
    const remote = await mint(fetch, false);
    for (const path of DASHBOARD_BACKUP_PATHS) expect((await fetch(post(path, remote, { passphrase: 'correct horse battery' }))).status).toBe(403);
    expect(calls).toEqual([]);
    const local = await mint(fetch, true);
    expect((await fetch(post('/dashboard/backup/status', { ...local, 'X-Olympus-CSRF': 'wrong' }))).status).toBe(403);
    const response = await fetch(post('/dashboard/backup/status', local));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true, schedule: 'manual', passphrase_set: false });
  });

  test('Settings shows the folder only to the unlocked local session, and the section is linkable as #backup', () => {
    const status = { folder: '/Volumes/T7/Backup/Olympus', schedule: 'nightly' as const, passphraseSet: true, running: false, backups: [], restoreAvailable: true };
    const local = renderDashboardSettingsPage({ backup: status, outsideHelpLocalSession: true, controlSessionCsrfToken: 'csrf' });
    expect(local).toContain('<section class="setpane" id="backup"');
    expect(local).toContain('href="#backup">Back up and restore</a>');
    expect(local).toContain('/Volumes/T7/Backup/Olympus');
    expect(local).toContain('Restore from a backup…');
    expect(local.indexOf('id="backup"')).toBeLessThan(local.indexOf('id="updates"'));
    const remote = renderDashboardSettingsPage({ backup: status, outsideHelpLocalSession: false, controlSessionCsrfToken: 'csrf' });
    expect(remote).not.toContain('/Volumes/T7');
    expect(remote).toContain('Open dashboard controls on this computer to back up or restore.');
    // A remote page carries the section's words, not its controls.
    expect(remote).not.toContain('data-backup-run');
  });

  test('a scheduled backup that fails is reported, and nothing half-written is left', async () => {
    const dir = tempDir();
    const home = join(dir, 'a');
    const { service, env } = install(home, () => new Date(2026, 10, 1, 4, 0));
    const folder = join(dir, 'Backups');
    mkdirSync(folder);
    writeFileSync(join(dir, 'not-a-folder'), '');
    service.saveSettings({ folder: join(dir, 'not-a-folder', 'x') });
    await service.tick();
    expect(service.status().lastError?.message).toBeTruthy();
    expect(readdirSync(sharedDataPath('backup-staging', env))).toEqual([]);
  });
});
