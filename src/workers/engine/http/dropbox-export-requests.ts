import {
  type DropboxSourceExportRequest,
  DROPBOX_FILES_CORPUS_ID,
  type DropboxSourceExportItemRequest,
  type DropboxEvalShardExportRequest,
} from '../../dropbox-files/index.ts';
import {
  parseObjectBody,
  asOptionalString,
  asOptionalBoolean,
  asOptionalNumber,
  asOptionalStringArray,
} from './request-fields.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';

export async function parseDropboxSourceExportRequest(request: Request): Promise<DropboxSourceExportRequest> {
  const record = await parseObjectBody(request);
  const corpusId = asOptionalString(record.corpus_id);
  if (corpusId !== undefined && corpusId !== DROPBOX_FILES_CORPUS_ID) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_id must be ${DROPBOX_FILES_CORPUS_ID} when provided.`);
  }
  const destinationRoot = asOptionalString(record.destination_root);
  if (!destinationRoot) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'destination_root must be a non-empty Dropbox folder path.');
  }
  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'items must be a non-empty array of export items.');
  }
  const items = record.items.map((item, index) => parseDropboxSourceExportItem(item, index));
  const account = asOptionalString(record.account);
  const dryRun = asOptionalBoolean(record.dry_run);
  return {
    ...(account !== undefined ? { account } : {}),
    destination_root: destinationRoot,
    items,
    ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
  };
}

function parseDropboxSourceExportItem(value: unknown, index: number): DropboxSourceExportItemRequest {
  if (typeof value === 'string' && value.trim()) {
    return { path: value.trim() };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `items.${index} must be a path string or an object with a path.`);
  }
  const record = value as Record<string, unknown>;
  const path = asOptionalString(record.path);
  if (!path) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `items.${index}.path must be a non-empty string.`);
  }
  const destSubfolder = asOptionalString(record.dest_subfolder);
  return {
    path,
    ...(destSubfolder !== undefined ? { dest_subfolder: destSubfolder } : {}),
  };
}

export async function parseDropboxEvalShardExportRequest(request: Request): Promise<DropboxEvalShardExportRequest> {
  const record = await parseObjectBody(request);
  const corpusId = asOptionalString(record.corpus_id);
  if (corpusId !== undefined && corpusId !== DROPBOX_FILES_CORPUS_ID) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_id must be ${DROPBOX_FILES_CORPUS_ID} when provided.`);
  }
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  const count = asOptionalNumber(record.count);
  const outDir = asOptionalString(record.out_dir);
  if (!approvedScopeKey || count === undefined || !outDir) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'approved_scope_key, count, and out_dir are required for Dropbox eval shard export.',
    );
  }
  const account = asOptionalString(record.account);
  const dryRun = asOptionalBoolean(record.dry_run);
  const docTypes = asOptionalStringArray(record.doc_types, 'doc_types');
  return {
    ...(account !== undefined ? { account } : {}),
    approved_scope_key: approvedScopeKey,
    count,
    out_dir: outDir,
    ...(docTypes !== undefined ? { doc_types: docTypes } : {}),
    ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
  };
}
