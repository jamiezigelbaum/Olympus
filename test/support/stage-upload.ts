// What the dashboard does for a dropped file or folder, for tests that start an import from a path on disk: the
// files are received into the staging folder as an upload (the same streaming receive the route uses), and the
// import is approved by the upload's id. A copy of an export is a new upload each time, as in the product.

import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ArchiveAccountAnswer, ArchiveApproveResult, ArchiveImportDashboard } from '../../src/workers/archive-import/dashboard.ts';

type Uploader = Pick<ArchiveImportDashboard, 'upload' | 'approve'>;

/** Receives a file or folder as one upload, keeping its name and the relative paths under it. */
export async function stageUpload(dashboard: Pick<ArchiveImportDashboard, 'upload'>, path: string): Promise<string> {
  const { uploadId } = dashboard.upload.start();
  const send = async (absolute: string, relative: string): Promise<void> => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) await send(join(absolute, entry), `${relative}/${entry}`);
      return;
    }
    if (!stat.isFile()) return;
    await dashboard.upload.receive(uploadId, relative, Bun.file(absolute).stream(), { modified: stat.mtimeMs });
  };
  await send(path, basename(path));
  return uploadId;
}

/** Drops `path` on the dashboard and approves it. */
export async function approveStaged(
  dashboard: Uploader,
  path: string,
  extra: ArchiveAccountAnswer & { sourceId?: string } = {},
): Promise<ArchiveApproveResult> {
  return dashboard.approve({ uploadId: await stageUpload(dashboard, path), ...extra });
}
