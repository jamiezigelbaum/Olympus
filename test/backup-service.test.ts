// Settings › Back up and restore (#1065): the schedule, retention when the
// scheduler runs, the passphrase key kept owner-only, restore through a
// restart, and routes served only to the unlocked local dashboard session.
import { lifecycleViews } from './helpers/lifecycle-view.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { exportOlympusData, lifecycleEnv } from '../src/data-lifecycle.ts';
import { BACKUP_WRONG_PASSPHRASE, listBackups } from '../src/data-backup.ts';
import { BACKUP_KEY_INVALID, applyPendingRestoreAtBoot, backupDue, createBackupService, type BackupServicePaths, type BackupSettingsFile } from '../src/workers/backup-service.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, withWorkerBearerAuth } from '../src/workers/http.ts';
import { renderDashboardSettingsPage } from '../src/workers/dashboard/pages/local.ts';
import { DASHBOARD_BACKUP_PATHS } from '../src/workers/dashboard/backup-paths.ts';
import { handleDashboardBackupRoute } from '../src/workers/dashboard/backup-routes.ts';
import { scopePathOfRealPath } from '../src/workers/local-files/locations.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';

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

function install(home: string, now: () => Date, restarts: { count: number } = { count: 0 }, resolveFolderKey?: (key: string) => string | undefined, keep?: number) {
  const env = lifecycleEnv({ homeDir: home });
  const paths: BackupServicePaths = { settings: join(home, 'cfg', 'backup.json'), key: join(home, 'cfg', 'backup-key.json'), staging: sharedDataPath('backup-staging', env) };
  const service = createBackupService({
    paths, env, now,
    ...(resolveFolderKey ? { resolveFolderKey } : {}),
    ...(keep !== undefined ? { keep } : {}),
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

  test('a set passphrase whose kept key is malformed, unreadable or fails its check fails the backup: never an unencrypted file', async () => {
    const dir = tempDir();
    const home = join(dir, 'a');
    seed(storeOf(home), 'a bookmark');
    const { service, paths } = install(home, () => new Date(2026, 10, 1, 4, 0));
    const folder = join(dir, 'Backups');
    mkdirSync(folder);
    service.saveSettings({ folder });
    service.setPassphrase('correct horse battery');
    const good = JSON.parse(readFileSync(paths.key, 'utf8'));
    const cases: Array<[string, () => void]> = [
      ['malformed', () => writeFileSync(paths.key, '{"schema": "olympus.backup.key.v1", "key": ')],
      ['wrong check', () => writeFileSync(paths.key, JSON.stringify({ ...good, key_check: Buffer.alloc(16).toString('base64') }))],
      ['wrong key', () => writeFileSync(paths.key, JSON.stringify({ ...good, key: Buffer.alloc(32, 7).toString('base64') }))],
      // A key that checks out but names a key setting no backup could be opened with.
      ['kdf without N', () => { const { N: _n, ...kdf } = good.kdf; writeFileSync(paths.key, JSON.stringify({ ...good, kdf })); }],
      ['kdf N 0', () => writeFileSync(paths.key, JSON.stringify({ ...good, kdf: { ...good.kdf, N: 0 } }))],
      ['kdf short salt', () => writeFileSync(paths.key, JSON.stringify({ ...good, kdf: { ...good.kdf, salt: 'AAAA' } }))],
      // Unreadable: a folder where the file should be (root ignores chmod 000).
      ['unreadable', () => { rmSync(paths.key, { force: true }); mkdirSync(paths.key); }],
    ];
    for (const [name, breakKey] of cases) {
      rmSync(paths.key, { recursive: true, force: true });
      breakKey();
      const status = service.status();
      expect(`${name}: ${status.passphraseProblem}`).toBe(`${name}: true`);
      const after = await service.runNow();
      expect(`${name}: ${after.lastError?.message}`).toBe(`${name}: ${BACKUP_KEY_INVALID}`);
      expect(`${name}: ${readdirSync(folder).length}`).toBe(`${name}: 0`);
      expect(renderDashboardSettingsPage({ backup: after, outsideHelpLocalSession: true, controlSessionCsrfToken: 'csrf' })).toContain('Set the passphrase again');
    }
    // An absent key is no passphrase: that backup is unencrypted by the owner's choice.
    rmSync(paths.key, { recursive: true, force: true });
    expect(service.status().passphraseProblem).toBeUndefined();
    expect((await service.runNow()).last?.encrypted).toBe(false);
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
    // The local session is minted as the owner's browser does it: from the control session its launch opened (#1153).
    const request = new Request(origin + '/dashboard/control/session', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer test-worker-token' } });
    recordRequestPeer(request, '127.0.0.1');
    const response = local ? await ownerLocalMint(fetch, origin, 'test-worker-token') : await fetch(request);
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

  test('a folder with more than 100 subfolders: the picker pages on, and a folder past the first page can be chosen', async () => {
    const dir = tempDir();
    const parent = join(dir, 'Many');
    const names = Array.from({ length: 130 }, (_, i) => `Folder ${String(i).padStart(3, '0')}`);
    for (const name of names) mkdirSync(join(parent, name), { recursive: true });
    const volumes = new VolumeResolver();
    const saved: Array<{ folder?: string; folderKey?: string }> = [];
    const backup = {
      status: () => ({ schedule: 'manual' as const, passphraseSet: false, running: false, backups: [], restoreAvailable: true }),
      saveSettings: (input: { folder?: string; folderKey?: string }) => { saved.push(input); return backup.status(); },
      setPassphrase: () => backup.status(),
      runNow: async () => backup.status(),
      tick: async () => false,
      restore: () => backup.status(),
    };
    const deps = { backup: backup as never, volumes };
    const parentKey = scopePathOfRealPath(volumes, parent);
    const first = await handleDashboardBackupRoute('/dashboard/backup/browse', { parent_key: parentKey }, deps);
    expect(first.status).toBe(200);
    const firstFolders = first.body.folders as Array<{ key: string; name: string; selectable: boolean }>;
    expect(firstFolders).toHaveLength(100);
    expect(typeof first.body.next_cursor).toBe('string');
    const second = await handleDashboardBackupRoute('/dashboard/backup/browse', { parent_key: parentKey, cursor: first.body.next_cursor }, deps);
    expect(second.status).toBe(200);
    const secondFolders = second.body.folders as Array<{ key: string; name: string; selectable: boolean }>;
    expect(secondFolders.map((f) => f.name)).toEqual(names.slice(100));
    expect(second.body.next_cursor).toBeUndefined();
    const last = secondFolders.at(-1)!;
    expect(last.selectable).toBe(true);
    const chosen = await handleDashboardBackupRoute('/dashboard/backup/settings', { folder_key: last.key }, deps);
    expect(chosen.status).toBe(200);
    // The folder's key is kept with it: it names the disk, so a missing or replaced disk is caught.
    expect(saved).toEqual([{ folder: realpathSync(join(parent, 'Folder 129')), folderKey: scopePathOfRealPath(volumes, realpathSync(join(parent, 'Folder 129'))) }]);
    // A cursor is the listing's own and bound to its folder: another folder's, a forged or a non-string one is refused.
    for (const body of [{ parent_key: scopePathOfRealPath(volumes, dir), cursor: first.body.next_cursor }, { parent_key: parentKey, cursor: 'forged' }, { parent_key: parentKey, cursor: 100 }]) {
      const refused = await handleDashboardBackupRoute('/dashboard/backup/browse', body, deps);
      expect(refused.status).toBe(409);
      expect((refused.body.error as { message: string }).message).toStartWith('Folder browse cursor is invalid');
    }
    // The page offers Show more for the next page.
    const page = renderDashboardSettingsPage({ backup: backup.status(), outsideHelpLocalSession: true, controlSessionCsrfToken: 'csrf' });
    expect(page).toContain('data-browser-more hidden>Show more</button>');
    expect(page).toContain('cursor: cursor');
  });

  test('the restore picker lists a renamed or duplicated backup the restore can open', async () => {
    const dir = tempDir();
    const home = join(dir, 'a');
    const { service } = install(home, () => new Date(2026, 10, 1, 4, 0));
    const folder = join(dir, 'Backups');
    mkdirSync(folder);
    service.saveSettings({ folder });
    await service.runNow();
    const [made] = listBackups(folder);
    const bytes = readFileSync(made!.path);
    writeFileSync(join(folder, `${made!.name.replace('.olympusbackup', '')} (1).olympusbackup`), bytes);
    writeFileSync(join(folder, 'renamed.olympusbackup'), bytes);
    writeFileSync(join(folder, 'notes.olympusbackup'), 'hello');
    const volumes = new VolumeResolver();
    const listed = await handleDashboardBackupRoute('/dashboard/backup/browse', { parent_key: scopePathOfRealPath(volumes, folder), files: true }, { backup: service, volumes });
    expect(listed.status).toBe(200);
    expect((listed.body.files as Array<{ name: string }>).map((file) => file.name).sort()).toEqual(
      [made!.name, `${made!.name.replace('.olympusbackup', '')} (1).olympusbackup`, 'renamed.olympusbackup'].sort(),
    );
  });

  test('a backup disk that is not connected, or was replaced, gets no backup and loses none', async () => {
    const dir = tempDir();
    const home = join(dir, 'a');
    seed(storeOf(home), 'a bookmark');
    const folder = join(dir, 'Backups');
    mkdirSync(folder);
    // The chosen disk's key; what it resolves to changes as the disk comes and goes.
    let mounted: string | undefined = folder;
    let resolutions = 0;
    let unmountAfter = Number.POSITIVE_INFINITY;
    const { service, paths } = install(home, () => new Date(2026, 10, 1, 4, 0), { count: 0 }, (key) => {
      expect(key).toBe('/@vol:backup-disk/Backups');
      resolutions += 1;
      return resolutions > unmountAfter ? undefined : mounted;
    }, 1);
    service.saveSettings({ folder, folderKey: '/@vol:backup-disk/Backups' });
    expect(JSON.parse(readFileSync(paths.settings, 'utf8')).folder_key).toBe('/@vol:backup-disk/Backups');
    const first = await service.runNow();
    expect(first.lastError).toBeUndefined();
    const [kept] = readdirSync(folder);

    // Gone: nothing is written anywhere, nothing is pruned, and the page says why.
    mounted = undefined;
    const absent = await service.runNow();
    expect(absent.lastError?.message).toContain('isn\'t connected');
    expect(readdirSync(folder)).toEqual([kept!]);

    // Gone while the export is prepared: the vacated path gets nothing.
    mounted = folder;
    resolutions = 0;
    unmountAfter = 1;
    const duringExport = await service.runNow();
    expect(duringExport.lastError?.message).toContain('isn\'t connected');
    expect(readdirSync(folder)).toEqual([kept!]);

    // Gone between the backup and the clean-up: the new backup stays, nothing is pruned.
    resolutions = 0;
    unmountAfter = 2;
    const midway = await service.runNow();
    expect(midway.lastError?.message).toContain('isn\'t connected');
    expect(readdirSync(folder).filter((name) => name.endsWith('.olympusbackup'))).toHaveLength(2);
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

describe('restore passphrase form', () => {
  test('opening another folder drops the picked backup, so Enter in the passphrase restores nothing', async () => {
    const { Window } = await import('happy-dom');
    const status = { folder: '/Volumes/T7/Backup/Olympus', schedule: 'nightly' as const, passphraseSet: true, running: false, backups: [], restoreAvailable: true };
    const html = renderDashboardSettingsPage({ backup: status, outsideHelpLocalSession: true, controlSessionCsrfToken: 'csrf' });
    const section = html.slice(html.indexOf('<section class="setpane" id="backup"'));
    const start = section.indexOf('<script>') + '<script>'.length;
    const script = section.slice(start, section.indexOf('</script>', start));
    const win = new Window({ url: 'http://127.0.0.1:4100/dashboard?settings' });
    const posts: string[] = [];
    const fetchStub = async (url: string, init: { body?: string }) => {
      const path = url.split('/').pop()!;
      posts.push(path);
      const body = JSON.parse(init.body ?? '{}') as { parent_key?: string };
      if (path === 'browse') {
        return new win.Response(JSON.stringify(body.parent_key === 'other'
          ? { ok: true, path: '/other', folders: [], files: [] }
          : { ok: true, path: '/Volumes/T7', folders: [{ key: 'other', name: 'other', selectable: true }], files: [{ key: 'b1', name: 'olympus-backup.olyb', bytes: 2000, encrypted: true }] }), { status: 200 });
      }
      return new win.Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      win.document.body.innerHTML = section.slice(0, start - '<script>'.length) + '</section>';
      new Function('window', 'document', 'HTMLInputElement', 'HTMLFormElement', 'HTMLElement', 'Element', 'fetch', script)(win, win.document, win.HTMLInputElement, win.HTMLFormElement, win.HTMLElement, win.Element, fetchStub);
      const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
      (win.document.querySelector('[data-backup-browse="restore"]') as unknown as HTMLElement).click();
      await settle();
      (win.document.querySelector('.bkpick') as unknown as HTMLElement).click();
      const form = win.document.querySelector('[data-backup-restore]') as unknown as HTMLFormElement;
      expect(form.hidden).toBe(false);
      (form.querySelector('input[name="passphrase"]') as unknown as HTMLInputElement).value = 'correct horse battery';
      const folder = Array.from(win.document.querySelectorAll('[data-browser-folders] button')).find((b) => b.textContent?.includes('other')) as unknown as HTMLElement;
      folder.click();
      await settle();
      expect(form.hidden).toBe(true);
      expect((form.querySelector('input[name="passphrase"]') as unknown as HTMLInputElement).value).toBe('');
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }) as never);
      await settle();
      expect(posts).not.toContain('restore');
    } finally {
      await win.happyDOM.close();
    }
  });

  test('Enter in the restore passphrase starts the restore, never a native submit that would put it in the URL', async () => {
    const { Window } = await import('happy-dom');
    const status = { folder: '/Volumes/T7/Backup/Olympus', schedule: 'nightly' as const, passphraseSet: true, running: false, backups: [], restoreAvailable: true };
    const html = renderDashboardSettingsPage({ backup: status, outsideHelpLocalSession: true, controlSessionCsrfToken: 'csrf' });
    const section = html.slice(html.indexOf('<section class="setpane" id="backup"'));
    const start = section.indexOf('<script>') + '<script>'.length;
    const script = section.slice(start, section.indexOf('</script>', start));
    const win = new Window({ url: 'http://127.0.0.1:4100/dashboard?settings' });
    try {
      win.document.body.innerHTML = section.slice(0, start - '<script>'.length) + '</section>';
      new Function('window', 'document', 'HTMLInputElement', 'HTMLFormElement', 'HTMLElement', 'Element', script)(win, win.document, win.HTMLInputElement, win.HTMLFormElement, win.HTMLElement, win.Element);
      const form = win.document.querySelector('[data-backup-restore]') as unknown as HTMLFormElement;
      form.hidden = false;
      (form.querySelector('input[name="passphrase"]') as unknown as HTMLInputElement).value = 'correct horse battery';
      let used = 0;
      win.document.querySelector('[data-browser-use]')!.addEventListener('click', () => { used += 1; });
      const submit = new win.Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(submit as never);
      expect(submit.defaultPrevented).toBe(true);
      expect(used).toBe(1);
    } finally {
      await win.happyDOM.close();
    }
  });
});
