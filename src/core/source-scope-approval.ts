import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';
import { OperationError } from './operation-error.ts';

export interface SourceScopeConnectedHandle {
  handle: string;
  provider: string;
  allowedCapabilities: string[];
  connectedAt: string;
  accountRole?: string;
  providerAccountId?: string;
  backendState?: { status?: unknown; [key: string]: unknown };
}

export interface SourceScopeConnectedHandleRegistry {
  handles: SourceScopeConnectedHandle[];
}

export const FILE_SOURCE_SCOPE_IDS = ['google_drive.docs', 'dropbox.files'] as const;
export type FileSourceScopeId = typeof FILE_SOURCE_SCOPE_IDS[number];
export type FileSourceScopeDisposition = 'ingest' | 'metadata_only' | 'exclude';

export interface FileSourceScopeCapability {
  sourceId: FileSourceScopeId;
  provider: 'google_drive' | 'dropbox';
  credentialCapability: 'google_drive.docs.sync' | 'dropbox.files.sync';
  scopeRequirement: 'explicit_folder_scope';
}

export const FILE_SOURCE_SCOPE_CAPABILITIES: Readonly<Record<FileSourceScopeId, FileSourceScopeCapability>> = {
  'google_drive.docs': {
    sourceId: 'google_drive.docs',
    provider: 'google_drive',
    credentialCapability: 'google_drive.docs.sync',
    scopeRequirement: 'explicit_folder_scope',
  },
  'dropbox.files': {
    sourceId: 'dropbox.files',
    provider: 'dropbox',
    credentialCapability: 'dropbox.files.sync',
    scopeRequirement: 'explicit_folder_scope',
  },
};

export interface FileSourceScopeSelection {
  key: string;
  state: FileSourceScopeDisposition;
  /** Provider-verified root-to-parent keys, retained for later lazy browsing. */
  ancestorKeys?: string[];
}

export interface FileSourceScopeApprovalSnapshot {
  sourceId: FileSourceScopeId;
  status: 'scope_pending' | 'approved';
  accountGeneration?: string;
  revision: string;
  selections: FileSourceScopeSelection[];
  wholeAccount: boolean;
  reason?: 'not_connected' | 'missing' | 'malformed' | 'account_changed';
}

interface PersistedFileSourceScopeApproval {
  source_id: FileSourceScopeId;
  account_generation: string;
  revision: string;
  status: 'approved';
  selections: FileSourceScopeSelection[];
  whole_account: boolean;
  approved_at: string;
}

interface PersistedFileSourceScopeState {
  version: 1;
  approvals: PersistedFileSourceScopeApproval[];
}

export function defaultFileSourceScopeStatePath(handleRegistryPath: string): string {
  return join(dirname(handleRegistryPath), 'file-source-scopes.json');
}

export function isFileSourceScopeId(value: string): value is FileSourceScopeId {
  return (FILE_SOURCE_SCOPE_IDS as readonly string[]).includes(value);
}

export function fileSourceScopeIdForProvider(provider: string): FileSourceScopeId | undefined {
  if (provider === 'google_drive') return 'google_drive.docs';
  if (provider === 'dropbox') return 'dropbox.files';
  return undefined;
}

/**
 * An opaque generation for the exact connected grant. Reconnecting under the
 * same account still changes connectedAt, invalidating prior approval and work.
 */
export function connectedFileSourceAccountGeneration(
  sourceId: FileSourceScopeId,
  registry: SourceScopeConnectedHandleRegistry,
): { generation: string; handle: SourceScopeConnectedHandle } | undefined {
  const capability = FILE_SOURCE_SCOPE_CAPABILITIES[sourceId];
  const handles = registry.handles.filter((handle) =>
    handle.provider === capability.provider
    && handle.allowedCapabilities.includes(capability.credentialCapability)
    && handle.backendState?.status !== 'reauth_required'
  );
  if (handles.length !== 1) return undefined;
  const handle = handles[0]!;
  const generation = createHash('sha256').update(JSON.stringify([
    sourceId,
    handle.handle,
    handle.providerAccountId ?? '',
    handle.accountRole ?? '',
    handle.connectedAt,
  ])).digest('hex');
  return { generation, handle };
}

export function readFileSourceScopeApproval(input: {
  sourceId: FileSourceScopeId;
  registry: SourceScopeConnectedHandleRegistry;
  statePath: string;
}): FileSourceScopeApprovalSnapshot {
  const account = connectedFileSourceAccountGeneration(input.sourceId, input.registry);
  if (!account) {
    return pendingSnapshot(input.sourceId, 'not-connected', undefined, 'not_connected');
  }
  const read = readState(input.statePath);
  if (read.kind === 'missing') {
    return pendingSnapshot(input.sourceId, `missing:${account.generation}`, account.generation, 'missing');
  }
  if (read.kind === 'malformed') {
    return pendingSnapshot(input.sourceId, `malformed:${read.digest}`, account.generation, 'malformed');
  }
  const approval = read.state.approvals.find((candidate) => candidate.source_id === input.sourceId);
  if (!approval) {
    return pendingSnapshot(input.sourceId, `missing:${account.generation}`, account.generation, 'missing');
  }
  if (approval.account_generation !== account.generation) {
    return pendingSnapshot(
      input.sourceId,
      `stale:${approval.revision}:${account.generation}`,
      account.generation,
      'account_changed',
    );
  }
  return {
    sourceId: input.sourceId,
    status: 'approved',
    accountGeneration: account.generation,
    revision: approval.revision,
    selections: approval.selections,
    wholeAccount: approval.whole_account,
  };
}

export function approveFileSourceScope(input: {
  sourceId: FileSourceScopeId;
  registry: SourceScopeConnectedHandleRegistry;
  statePath: string;
  accountGeneration: string;
  expectedRevision: string;
  selections: readonly FileSourceScopeSelection[];
  wholeAccount: boolean;
  explicitWholeAccountConfirmation: boolean;
  now?: Date;
}): FileSourceScopeApprovalSnapshot {
  return withFileLeaseSync(input.statePath, (lease) => {
    const current = readFileSourceScopeApproval({
      sourceId: input.sourceId,
      registry: input.registry,
      statePath: input.statePath,
    });
    if (!current.accountGeneration || current.accountGeneration !== input.accountGeneration) {
      throw new OperationError('source_index_policy_violation', 'The connected account changed. Browse the current account and choose its scope again.');
    }
    if (current.revision !== input.expectedRevision) {
      throw new OperationError('source_index_policy_violation', 'The source scope changed. Reload it before saving.');
    }
    if (input.wholeAccount && input.explicitWholeAccountConfirmation !== true) {
      throw new OperationError('invalid_request', 'Whole-account access requires its visible confirmation.');
    }
    const selections = normalizeSelections(input.selections);
    if (!input.wholeAccount && selections.some((selection) =>
      selection.key === '/' || (input.sourceId === 'google_drive.docs' && selection.key.toLowerCase() === 'root')
    )) {
      throw new OperationError('invalid_request', 'Choose Whole account and confirm it explicitly to approve the provider root.');
    }
    const existing = readState(input.statePath);
    const approvals = existing.kind === 'valid'
      ? existing.state.approvals.filter((candidate) => candidate.source_id !== input.sourceId)
      : [];
    const revision = randomUUID();
    approvals.push({
      source_id: input.sourceId,
      account_generation: input.accountGeneration,
      revision,
      status: 'approved',
      selections,
      whole_account: input.wholeAccount,
      approved_at: (input.now ?? new Date()).toISOString(),
    });
    const state: PersistedFileSourceScopeState = { version: 1, approvals };
    lease.commit(() => writePrivateFileAtomicSync(input.statePath, `${JSON.stringify(state, null, 2)}\n`));
    return {
      sourceId: input.sourceId,
      status: 'approved',
      accountGeneration: input.accountGeneration,
      revision,
      selections,
      wholeAccount: input.wholeAccount,
    };
  });
}

export function assertFileSourceScopeApproved(input: {
  sourceId: FileSourceScopeId;
  registry: SourceScopeConnectedHandleRegistry;
  statePath: string;
  expectedAccountGeneration?: string;
  expectedRevision?: string;
}): FileSourceScopeApprovalSnapshot {
  const approval = readFileSourceScopeApproval(input);
  if (
    approval.status !== 'approved'
    || (input.expectedAccountGeneration !== undefined
      && approval.accountGeneration !== input.expectedAccountGeneration)
    || (input.expectedRevision !== undefined && approval.revision !== input.expectedRevision)
  ) {
    throw new OperationError('source_index_policy_violation', 'File-source scope approval is required for this connected account.');
  }
  return approval;
}

/**
 * True only for a selected full-ingestion scope. Callers supply the item's
 * provider folder identities (Drive ids or normalized Dropbox paths).
 */
export function fileSourceScopeAllowsContent(
  approval: FileSourceScopeApprovalSnapshot,
  itemScopeKeys: readonly string[],
): boolean {
  if (approval.status !== 'approved') return false;
  const matching = matchingSelections(approval, itemScopeKeys);
  if (matching.some((selection) => selection.state !== 'ingest')) return false;
  if (approval.wholeAccount) return true;
  return matching.some((selection) => selection.state === 'ingest')
    && matching.every((selection) => selection.state === 'ingest');
}

export function fileSourceScopeAllowsMetadata(
  approval: FileSourceScopeApprovalSnapshot,
  itemScopeKeys: readonly string[],
): boolean {
  if (approval.status !== 'approved') return false;
  const matching = matchingSelections(approval, itemScopeKeys);
  if (matching.some((selection) => selection.state === 'exclude')) return false;
  if (approval.wholeAccount) return true;
  return matching.some((selection) => selection.state !== 'exclude')
    && matching.every((selection) => selection.state !== 'exclude');
}

function matchingSelections(
  approval: FileSourceScopeApprovalSnapshot,
  itemScopeKeys: readonly string[],
): FileSourceScopeSelection[] {
  const byKey = new Map(approval.selections.map((selection) => [selection.key, selection]));
  return itemScopeKeys
    .map((key) => byKey.get(key))
    .filter((selection): selection is FileSourceScopeSelection => selection !== undefined);
}

function pendingSnapshot(
  sourceId: FileSourceScopeId,
  revision: string,
  accountGeneration: string | undefined,
  reason: NonNullable<FileSourceScopeApprovalSnapshot['reason']>,
): FileSourceScopeApprovalSnapshot {
  return {
    sourceId,
    status: 'scope_pending',
    ...(accountGeneration ? { accountGeneration } : {}),
    revision,
    selections: [],
    wholeAccount: false,
    reason,
  };
}

function normalizeSelections(input: readonly FileSourceScopeSelection[]): FileSourceScopeSelection[] {
  const byKey = new Map<string, { state: FileSourceScopeDisposition; ancestorKeys?: string[] }>();
  for (const selection of input) {
    const key = selection.key.trim();
    if (!key || key.length > 1_024) throw new OperationError('invalid_request', 'Every selected folder requires a valid key.');
    if (!['ingest', 'metadata_only', 'exclude'].includes(selection.state)) {
      throw new OperationError('invalid_request', 'Every selected folder requires a valid disposition.');
    }
    if (byKey.has(key)) throw new OperationError('invalid_request', 'A folder may be selected only once.');
    const ancestorKeys = selection.ancestorKeys === undefined
      ? undefined
      : normalizeAncestorKeys(selection.ancestorKeys);
    byKey.set(key, { state: selection.state, ...(ancestorKeys?.length ? { ancestorKeys } : {}) });
  }
  return [...byKey]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, ...value }));
}

function normalizeAncestorKeys(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > 100) {
    throw new OperationError('invalid_request', 'Folder ancestry is invalid.');
  }
  const keys = input.map((value) => value.trim());
  if (keys.some((value) => !value || value.length > 1_024)) {
    throw new OperationError('invalid_request', 'Folder ancestry is invalid.');
  }
  return [...new Set(keys)];
}

type StateRead =
  | { kind: 'missing' }
  | { kind: 'malformed'; digest: string }
  | { kind: 'valid'; state: PersistedFileSourceScopeState };

function readState(path: string): StateRead {
  if (!existsSync(path)) return { kind: 'missing' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'malformed', digest: 'unreadable' };
  }
  const digest = createHash('sha256').update(raw).digest('hex');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('record');
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.approvals)) throw new Error('version');
    const approvals = record.approvals.map(parseApproval);
    if (new Set(approvals.map((entry) => entry.source_id)).size !== approvals.length) throw new Error('duplicate');
    return { kind: 'valid', state: { version: 1, approvals } };
  } catch {
    return { kind: 'malformed', digest };
  }
}

function parseApproval(value: unknown): PersistedFileSourceScopeApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('approval');
  const record = value as Record<string, unknown>;
  if (
    typeof record.source_id !== 'string' || !isFileSourceScopeId(record.source_id)
    || typeof record.account_generation !== 'string' || !/^[a-f0-9]{64}$/.test(record.account_generation)
    || typeof record.revision !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.revision)
    || record.status !== 'approved'
    || typeof record.whole_account !== 'boolean'
    || typeof record.approved_at !== 'string' || !Number.isFinite(Date.parse(record.approved_at))
    || !Array.isArray(record.selections)
  ) throw new Error('approval');
  const selections = normalizeSelections(record.selections.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('selection');
    const selection = entry as Record<string, unknown>;
    if (typeof selection.key !== 'string' || typeof selection.state !== 'string') throw new Error('selection');
    const ancestorKeys = selection.ancestorKeys;
    if (ancestorKeys !== undefined && (!Array.isArray(ancestorKeys)
      || ancestorKeys.some((key) => typeof key !== 'string'))) throw new Error('selection');
    return {
      key: selection.key,
      state: selection.state as FileSourceScopeDisposition,
      ...(ancestorKeys ? { ancestorKeys: ancestorKeys as string[] } : {}),
    };
  }));
  return {
    source_id: record.source_id,
    account_generation: record.account_generation,
    revision: record.revision,
    status: 'approved',
    selections,
    whole_account: record.whole_account,
    approved_at: record.approved_at,
  };
}
