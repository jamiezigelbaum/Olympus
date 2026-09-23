import {
  approveFileSourceScope,
  assertFileSourceScopeApproved,
  defaultFileSourceScopeStatePath,
  fileSourceScopeAllowsContent,
  fileSourceScopeAllowsMetadata,
  readFileSourceScopeApproval,
  type FileSourceScopeApprovalSnapshot,
  type FileSourceScopeId,
  type FileSourceScopeSelection,
} from '../core/source-scope-approval.ts';
import {
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
  type ConnectedHandleRegistry,
} from './credential-broker/connected-handles.ts';
import type { ConnectorStoreSearchFilters } from './connector-store/index.ts';
import type { GoogleDriveContentScope } from './google-connectors/drive.ts';
import type { DropboxContentScope } from './dropbox-files/connector.ts';
import type { SourceEmbeddingProvider } from './source-index/embeddings.ts';
import type { SourceSchedulerSource } from './source-scheduler.ts';
import type { SourceIngestionPolicy } from '../core/source-ingestion-policy.ts';
import {
  approveMailSourceScope,
  assertMailSourceScopeApproved,
  compileGmailMailScope,
  defaultMailSourceScopeStatePath,
  readMailSourceScopeApproval,
  type MailScopeSelection,
  type MailSourceScopeApprovalSnapshot,
  type MailSourceScopeId,
} from '../core/mail-source-scope.ts';
import type { GmailConnectorScope } from './google-connectors/gmail.ts';

export interface FileSourceScopePolicyRef {
  sourceId: FileSourceScopeId;
  accountGeneration: string;
  revision: string;
}

export interface MailSourceScopePolicyRef {
  sourceId: MailSourceScopeId;
  accountGeneration: string;
  revision: string;
}

/** Any approval a lane can be bound to: a folder scope or a mail scope. */
export type SourceScopePolicyRef = FileSourceScopePolicyRef | MailSourceScopePolicyRef;

/**
 * The one scope authority for every scope-gated source. Folder sources
 * (Drive, Dropbox) and the mail source (Gmail) share the grant generation,
 * revision, pending state and the scheduler/embedding binding below; each
 * keeps its own state file.
 */
export class FileSourceScopeAuthority {
  readonly registryPath: string;
  readonly statePath: string;
  readonly mailStatePath: string;
  private readonly readRegistry: () => ConnectedHandleRegistry;
  private readonly mailPinnedHandle: () => string | undefined;

  constructor(options: {
    registryPath?: string;
    statePath?: string;
    mailStatePath?: string;
    readRegistry?: () => ConnectedHandleRegistry;
    /** The handle the Gmail lane is pinned to, when more than one is registered. */
    mailPinnedHandle?: () => string | undefined;
  } = {}) {
    this.registryPath = options.registryPath ?? defaultHandleRegistryPath();
    this.statePath = options.statePath ?? defaultFileSourceScopeStatePath(this.registryPath);
    this.mailStatePath = options.mailStatePath ?? defaultMailSourceScopeStatePath(this.registryPath);
    this.readRegistry = options.readRegistry ?? (() => readConnectedHandleRegistry(this.registryPath));
    this.mailPinnedHandle = options.mailPinnedHandle ?? (() => undefined);
  }

  mailSnapshot(): MailSourceScopeApprovalSnapshot {
    try {
      return readMailSourceScopeApproval(this.mailInput());
    } catch {
      return { sourceId: 'gmail.email', status: 'scope_pending', revision: 'unreadable', reason: 'malformed' };
    }
  }

  approveMail(input: {
    accountGeneration: string;
    expectedRevision: string;
    scope: Omit<MailScopeSelection, 'contentAfter'>;
  }): MailSourceScopeApprovalSnapshot {
    return approveMailSourceScope({ ...this.mailInput(), ...input });
  }

  mailPolicyRef(): MailSourceScopePolicyRef | undefined {
    const snapshot = this.mailSnapshot();
    if (snapshot.status !== 'approved' || !snapshot.accountGeneration) return undefined;
    return { sourceId: 'gmail.email', accountGeneration: snapshot.accountGeneration, revision: snapshot.revision };
  }

  assertCurrentMail(ref: MailSourceScopePolicyRef): ReturnType<typeof assertMailSourceScopeApproved> {
    return assertMailSourceScopeApproved({
      ...this.mailInput(),
      expectedAccountGeneration: ref.accountGeneration,
      expectedRevision: ref.revision,
    });
  }

  /** Throws unless the approval `ref` names is still the current one. */
  assertRefCurrent(ref: SourceScopePolicyRef): void {
    if (ref.sourceId === 'gmail.email') this.assertCurrentMail(ref);
    else this.assertCurrent(ref);
  }

  private mailInput(): { registry: ConnectedHandleRegistry; statePath: string; pinnedHandle?: string } {
    const pinnedHandle = this.mailPinnedHandle()?.trim();
    return {
      registry: this.readRegistry(),
      statePath: this.mailStatePath,
      ...(pinnedHandle ? { pinnedHandle } : {}),
    };
  }

  snapshot(sourceId: FileSourceScopeId): FileSourceScopeApprovalSnapshot {
    try {
      return readFileSourceScopeApproval({
        sourceId,
        registry: this.readRegistry(),
        statePath: this.statePath,
      });
    } catch {
      return {
        sourceId,
        status: 'scope_pending',
        revision: 'unreadable',
        selections: [],
        wholeAccount: false,
        reason: 'malformed',
      };
    }
  }

  approve(input: {
    sourceId: FileSourceScopeId;
    accountGeneration: string;
    expectedRevision: string;
    selections: readonly FileSourceScopeSelection[];
    wholeAccount: boolean;
    explicitWholeAccountConfirmation: boolean;
  }): FileSourceScopeApprovalSnapshot {
    return approveFileSourceScope({
      ...input,
      registry: this.readRegistry(),
      statePath: this.statePath,
    });
  }

  assertCurrent(ref: FileSourceScopePolicyRef): FileSourceScopeApprovalSnapshot {
    return assertFileSourceScopeApproved({
      sourceId: ref.sourceId,
      registry: this.readRegistry(),
      statePath: this.statePath,
      expectedAccountGeneration: ref.accountGeneration,
      expectedRevision: ref.revision,
    });
  }

  policyRef(sourceId: FileSourceScopeId): FileSourceScopePolicyRef | undefined {
    const snapshot = this.snapshot(sourceId);
    if (snapshot.status !== 'approved' || !snapshot.accountGeneration) return undefined;
    return {
      sourceId,
      accountGeneration: snapshot.accountGeneration,
      revision: snapshot.revision,
    };
  }
}

export function fileSourceScopeContentFilters(
  approval: FileSourceScopeApprovalSnapshot,
): { allowed: false } | { allowed: true; filters?: ConnectorStoreSearchFilters } {
  if (approval.status !== 'approved' || !approval.accountGeneration) return { allowed: false };
  const deniedKeys = approval.selections
    .filter((selection) => selection.state !== 'ingest')
    .map((selection) => selection.key);
  if (approval.wholeAccount) {
    return {
      allowed: true,
      filters: {
        provider: approval.sourceId === 'dropbox.files' ? 'dropbox' : 'google_drive',
        sourceScopeGeneration: approval.accountGeneration,
        sourceScopeRevision: approval.revision,
        ...(approval.sourceId === 'dropbox.files' && deniedKeys.length > 0
          ? { locatorPathExcludedScopes: deniedKeys }
          : {}),
        ...(approval.sourceId === 'google_drive.docs' && deniedKeys.length > 0
          ? { sourceScopeFolderNoneKeys: deniedKeys }
          : {}),
      },
    };
  }
  const ingestKeys = approval.selections
    .filter((selection) => selection.state === 'ingest')
    .map((selection) => selection.key);
  if (ingestKeys.length === 0) return { allowed: false };
  return approval.sourceId === 'dropbox.files'
    ? {
        allowed: true,
        filters: {
          provider: 'dropbox',
          sourceScopeGeneration: approval.accountGeneration,
          sourceScopeRevision: approval.revision,
          locatorPathScopes: ingestKeys,
          ...(deniedKeys.length > 0 ? { locatorPathExcludedScopes: deniedKeys } : {}),
        },
      }
    : {
        allowed: true,
        filters: {
          provider: 'google_drive',
          sourceScopeGeneration: approval.accountGeneration,
          sourceScopeRevision: approval.revision,
          sourceScopeFolderAnyKeys: ingestKeys,
          ...(deniedKeys.length > 0
            ? { sourceScopeFolderNoneKeys: deniedKeys }
            : {}),
        },
      };
}

export function fileSourceScopeMetadataFilters(
  approval: FileSourceScopeApprovalSnapshot,
): { allowed: false } | { allowed: true; filters: ConnectorStoreSearchFilters } {
  if (approval.status !== 'approved' || !approval.accountGeneration) return { allowed: false };
  const excludedKeys = approval.selections
    .filter((selection) => selection.state === 'exclude')
    .map((selection) => selection.key);
  const metadataOnlyKeys = approval.selections
    .filter((selection) => selection.state === 'metadata_only')
    .map((selection) => selection.key);
  const base: ConnectorStoreSearchFilters = {
    provider: approval.sourceId === 'dropbox.files' ? 'dropbox' : 'google_drive',
    sourceScopeGeneration: approval.accountGeneration,
    sourceScopeRevision: approval.revision,
    ...(approval.sourceId === 'dropbox.files' && excludedKeys.length > 0
      ? { locatorPathExcludedScopes: excludedKeys }
      : {}),
    ...(approval.sourceId === 'google_drive.docs' && excludedKeys.length > 0
      ? { sourceScopeFolderNoneKeys: excludedKeys }
      : {}),
    ...(approval.sourceId === 'dropbox.files' && metadataOnlyKeys.length > 0
      ? { metadataOnlyLocatorPathScopes: metadataOnlyKeys }
      : {}),
    ...(approval.sourceId === 'google_drive.docs' && metadataOnlyKeys.length > 0
      ? { metadataOnlySourceScopeFolderKeys: metadataOnlyKeys }
      : {}),
  };
  if (approval.wholeAccount) return { allowed: true, filters: base };
  const includedKeys = approval.selections
    .filter((selection) => selection.state !== 'exclude')
    .map((selection) => selection.key);
  if (includedKeys.length === 0) return { allowed: false };
  return {
    allowed: true,
    filters: {
      ...base,
      ...(approval.sourceId === 'dropbox.files'
        ? { locatorPathScopes: includedKeys }
        : { sourceScopeFolderAnyKeys: includedKeys }),
    },
  };
}

export function fileSourceScopeMetadataEnabled(approval: FileSourceScopeApprovalSnapshot): boolean {
  return approval.status === 'approved'
    && (approval.wholeAccount || approval.selections.some((selection) => selection.state !== 'exclude'));
}

export function fileSourceScopeDropboxPolicy(
  base: SourceIngestionPolicy,
  approval: FileSourceScopeApprovalSnapshot,
): SourceIngestionPolicy {
  if (approval.sourceId !== 'dropbox.files' || approval.status !== 'approved') {
    return { ...base, roots: [] };
  }
  const roots = approval.wholeAccount
    ? [{
        path: '/',
        approved_scope_key: `${base.source}:/`,
        default_action: 'full_extract' as const,
      }]
    : approval.selections
        .filter((selection) => selection.state !== 'exclude')
        .map((selection) => ({
          path: normalizeDropboxScopePath(selection.key),
          approved_scope_key: `${base.source}:${normalizeDropboxScopePath(selection.key)}`,
          default_action: selection.state === 'ingest' ? 'full_extract' as const : 'metadata_only' as const,
        }));
  return { ...base, roots };
}

export function createScopeBoundGoogleDriveContentScope(input: {
  authority: FileSourceScopeAuthority;
  ref: FileSourceScopePolicyRef;
}): GoogleDriveContentScope {
  const current = (): FileSourceScopeApprovalSnapshot => input.authority.assertCurrent(input.ref);
  return {
    generation: input.ref.accountGeneration,
    revision: input.ref.revision,
    allowsMetadata(folderAncestorIds) {
      return fileSourceScopeAllowsMetadata(current(), folderAncestorIds);
    },
    allowsContent(folderAncestorIds) {
      return fileSourceScopeAllowsContent(current(), folderAncestorIds);
    },
  };
}

export function createScopeBoundDropboxContentScope(input: {
  authority: FileSourceScopeAuthority;
  ref: FileSourceScopePolicyRef;
}): DropboxContentScope {
  const current = (): FileSourceScopeApprovalSnapshot => input.authority.assertCurrent(input.ref);
  const matching = (path: string): FileSourceScopeSelection[] => {
    const normalized = normalizeDropboxScopePath(path);
    return current().selections.filter((selection) => {
      const root = normalizeDropboxScopePath(selection.key);
      return normalized === root || (root !== '/' && normalized.startsWith(`${root}/`)) || root === '/';
    });
  };
  return {
    generation: input.ref.accountGeneration,
    revision: input.ref.revision,
    assertCurrent() {
      current();
    },
    allowsMetadata(path) {
      const approval = current();
      const selected = matching(path);
      if (selected.some((entry) => entry.state === 'exclude')) return false;
      return approval.wholeAccount || selected.some((entry) => entry.state !== 'exclude');
    },
    allowsContent(path) {
      const approval = current();
      const selected = matching(path);
      if (selected.some((entry) => entry.state !== 'ingest')) return false;
      return approval.wholeAccount || selected.some((entry) => entry.state === 'ingest');
    },
  };
}

function normalizeDropboxScopePath(path: string): string {
  const normalized = path.trim().replace(/\/{2,}/g, '/').toLowerCase();
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function scopeBoundEmbeddingProvider(
  provider: SourceEmbeddingProvider,
  authority: FileSourceScopeAuthority,
  ref: SourceScopePolicyRef,
): SourceEmbeddingProvider {
  return {
    ...provider,
    async embed(inputs, options) {
      authority.assertRefCurrent(ref);
      return provider.embed(inputs, options);
    },
  };
}

/**
 * The approved mail scope as the Gmail connector's query binding. The
 * operator's hidden OLYMPUS_SOURCE_INDEX_GMAIL_QUERY override is not folded in
 * here: the connector reads it and ANDs it with this.
 */
export function gmailConnectorScopeFromApproval(approval: { mailScope: MailScopeSelection }): GmailConnectorScope {
  const compiled = compileGmailMailScope(approval.mailScope);
  return {
    ...(compiled.baseQuery ? { baseQuery: compiled.baseQuery } : {}),
    ...(compiled.contentAfterMs !== undefined ? { contentAfterMs: compiled.contentAfterMs } : {}),
    skippedCategoryLabelIds: compiled.skippedCategoryLabelIds,
    ...(compiled.skippedLabelIds.length > 0 ? { skippedLabelIds: compiled.skippedLabelIds } : {}),
    ...(approval.mailScope.skipSenders.length > 0 ? { skipSenders: approval.mailScope.skipSenders } : {}),
    ...(approval.mailScope.alwaysPrivateSenders.length > 0
      ? { alwaysPrivateSenders: approval.mailScope.alwaysPrivateSenders }
      : {}),
  };
}

export function scopeBoundSchedulerSource(input: {
  source: SourceSchedulerSource;
  authority: FileSourceScopeAuthority;
  ref: SourceScopePolicyRef;
}): SourceSchedulerSource {
  const suffix = input.ref.revision.replaceAll('-', '').slice(0, 16);
  return {
    ...input.source,
    tasks: input.source.tasks.map((task) => ({
      ...task,
      id: `${task.id}:scope:${suffix}`,
      async run(context) {
        input.authority.assertRefCurrent(input.ref);
        return task.run(context);
      },
    })),
  };
}
