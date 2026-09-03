export interface DropboxLocalFileRootConfig {
  rootPath: string;
  account?: string;
  approvedScopeKey?: string;
  dropboxPathPrefix?: string;
  rootId?: string;
}

export function parseDropboxLocalFileRootsFromEnv(
  env: Record<string, string | undefined> = process.env,
): DropboxLocalFileRootConfig[] {
  const raw = env.OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON;
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON must be a JSON array.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON must be a JSON array.');
  }
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Dropbox local root ${index} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const rootPath = optionalString(record.rootPath) ?? optionalString(record.root_path);
    if (!rootPath) {
      throw new Error(`Dropbox local root ${index} requires rootPath.`);
    }
    const account = optionalString(record.account);
    const approvedScopeKey = optionalString(record.approvedScopeKey) ?? optionalString(record.approved_scope_key);
    const dropboxPathPrefix = normalizeDropboxPath(
      optionalString(record.dropboxPathPrefix) ?? optionalString(record.dropbox_path_prefix),
    );
    const rootId = optionalString(record.rootId) ?? optionalString(record.root_id);
    const root: DropboxLocalFileRootConfig = { rootPath };
    if (account) root.account = account;
    if (approvedScopeKey) root.approvedScopeKey = approvedScopeKey;
    if (dropboxPathPrefix) root.dropboxPathPrefix = dropboxPathPrefix;
    if (rootId) root.rootId = rootId;
    return root;
  });
}

function normalizeDropboxPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!trimmed) return undefined;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
