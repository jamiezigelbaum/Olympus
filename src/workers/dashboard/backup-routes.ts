/**
 * Settings › Back up and restore's routes (#1065). Every one is served only
 * to the unlocked dashboard session minted on this computer (workers/http.ts
 * injects the local grade only after proving the cookie, origin and CSRF
 * token; the worker bearer, the relay, agents and remote sessions are refused).
 *
 * Folders and files are chosen through the same listing the Local files
 * folder picker uses (local-files/scope-browser.ts): the home folder and the
 * disks mounted now, Olympus's own folders not offered, and on a Mac a
 * guarded folder opened only through the helper's question. The page sends
 * the listing's opaque keys back, never a typed path.
 */
import { BACKUP_FILE_EXTENSION, listBackups } from '../../data-backup.ts';
import { OperationError } from '../../core/operation-error.ts';
import type { BackupSchedule, BackupService, BackupStatus } from '../backup-service.ts';
import { BACKUP_SCHEDULES } from '../backup-service.ts';
import { createArchivePathResolver, createLocalFilesFolderScopeBrowser } from '../local-files/scope-browser.ts';
import { realPathOfScopePath, scopePathOfRealPath } from '../local-files/locations.ts';
import { defaultExclusionContext, isInsideOwnRoot, normalizeScopePath } from '../local-files/paths.ts';
import { VolumeResolver } from '../local-files/volume-identity.ts';

export { DASHBOARD_BACKUP_PATHS } from './backup-paths.ts';

export interface DashboardBackupRouteDeps {
  backup: BackupService;
  /** Test seams: the folder listing and the path checks the Local files picker uses. */
  browser?: ReturnType<typeof createLocalFilesFolderScopeBrowser>;
  volumes?: VolumeResolver;
  resolver?: ReturnType<typeof createArchivePathResolver>;
}

/** The page's view of the status: the same facts, dates as ISO strings. */
export function backupStatusBody(status: BackupStatus): Record<string, unknown> {
  return {
    ok: true,
    folder: status.folder ?? null,
    schedule: status.schedule,
    passphrase_set: status.passphraseSet,
    passphrase_problem: status.passphraseProblem === true,
    last: status.last ?? null,
    last_error: status.lastError ?? null,
    running: status.running,
    backups: status.backups.map((backup) => ({ name: backup.name, bytes: backup.bytes, created_at: backup.createdAt, encrypted: backup.encrypted })),
    restore: status.restore ?? null,
    restore_available: status.restoreAvailable,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export async function handleDashboardBackupRoute(
  path: string,
  body: Record<string, unknown>,
  deps: DashboardBackupRouteDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const volumes = deps.volumes ?? new VolumeResolver();
  const resolver = deps.resolver ?? createArchivePathResolver({ volumes });
  const realOf = async (key: string, kind: 'file' | 'folder'): Promise<string> => {
    let real: string | undefined;
    try { real = realPathOfScopePath(volumes, normalizeScopePath(key)); } catch { real = undefined; }
    if (!real) throw new OperationError('invalid_params', 'That disk is not connected right now.');
    const resolved = await resolver.resolvePath(real);
    if (!resolved.ok) throw new OperationError('invalid_params', resolved.message);
    if (resolved.kind !== kind) throw new OperationError('invalid_params', kind === 'folder' ? 'Choose a folder.' : 'Choose a backup file.');
    return resolved.path;
  };
  const ok = (status: BackupStatus) => ({ status: 200, body: backupStatusBody(status) });
  try {
    switch (path) {
      case '/dashboard/backup/status':
        return ok(deps.backup.status());
      case '/dashboard/backup/settings': {
        const input: { folder?: string; schedule?: BackupSchedule } = {};
        const folderKey = text(body.folder_key);
        if (folderKey) {
          const folder = await realOf(folderKey, 'folder');
          // Never inside Olympus's own folders: a backup there is lost with them.
          if (isInsideOwnRoot(scopePathOfRealPath(volumes, folder), defaultExclusionContext())) {
            throw new OperationError('invalid_params', 'Choose a folder outside Olympus\'s own folders, ideally on another disk.');
          }
          input.folder = folder;
        }
        if (body.schedule !== undefined) {
          if (!BACKUP_SCHEDULES.includes(body.schedule as BackupSchedule)) throw new OperationError('invalid_params', 'Choose when to back up.');
          input.schedule = body.schedule as BackupSchedule;
        }
        return ok(deps.backup.saveSettings(input));
      }
      case '/dashboard/backup/passphrase': {
        if (body.passphrase === null) return ok(deps.backup.setPassphrase(null));
        if (typeof body.passphrase !== 'string') throw new OperationError('invalid_params', 'Enter a passphrase.');
        return ok(deps.backup.setPassphrase(body.passphrase));
      }
      case '/dashboard/backup/run': {
        // Started, not awaited: the page polls the status.
        const started = deps.backup.runNow();
        void started.catch(() => undefined);
        return ok(deps.backup.status());
      }
      case '/dashboard/backup/browse': {
        const browser = deps.browser ?? createLocalFilesFolderScopeBrowser({ volumes });
        const parentKey = text(body.parent_key);
        const page = await browser.browse({ ...(parentKey ? { parentKey } : {}) });
        const folders = page.nodes.map((node) => ({
          key: node.key,
          name: node.name,
          has_children: node.has_children,
          selectable: node.selectable,
          ...(node.access ? { note: node.access.message } : {}),
        }));
        let path: string | null = null;
        let files: Array<Record<string, unknown>> = [];
        if (parentKey) {
          path = realPathOfScopePath(volumes, normalizeScopePath(parentKey)) ?? null;
          if (path && body.files === true) {
            files = listBackups(path).map((backup) => ({
              key: scopePathOfRealPath(volumes, backup.path),
              name: backup.name,
              bytes: backup.bytes,
              created_at: backup.createdAt,
              encrypted: backup.encrypted,
            }));
          }
        }
        return { status: 200, body: { ok: true, path, folders, files, ...(page.access && !page.nodes.length ? { note: page.access.message } : {}) } };
      }
      case '/dashboard/backup/restore': {
        const fileKey = text(body.file_key);
        if (!fileKey) throw new OperationError('invalid_params', 'Choose a backup file.');
        const file = await realOf(fileKey, 'file');
        if (!file.endsWith(BACKUP_FILE_EXTENSION)) throw new OperationError('invalid_params', `Choose a file whose name ends in ${BACKUP_FILE_EXTENSION}.`);
        const passphrase = typeof body.passphrase === 'string' && body.passphrase !== '' ? body.passphrase : undefined;
        return ok(deps.backup.restore({ file, ...(passphrase !== undefined ? { passphrase } : {}) }));
      }
      default:
        return { status: 404, body: { ok: false } };
    }
  } catch (error) {
    const message = error instanceof OperationError || error instanceof Error ? error.message : 'That did not work. Try again.';
    return { status: 409, body: { ok: false, error: { code: 'backup_failed', message } } };
  }
}
