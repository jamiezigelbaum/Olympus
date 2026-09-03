import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ConnectorStoreResultProjectionInput,
  ConnectorStoreResultProjectorCodec,
} from '../connector-store/index.ts';
import {
  parseDropboxLocalFileRootsFromEnv,
  type DropboxLocalFileRootConfig,
} from './local-file-resolver.ts';

interface DropboxLocator {
  display_path: string;
  parent_display_path: string;
  dropbox_web_url: string;
  parent_dropbox_web_url: string;
  finder_url?: string;
  parent_finder_url?: string;
}

export const DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC: ConnectorStoreResultProjectorCodec = Object.freeze({
  create(input: Readonly<{
    principal: Readonly<{ provider: string; accountScope: string }>;
    approvedScopeKey?: string;
  }>) {
    const localMapping = configuredStrictLocalMapping({
      accountScope: input.principal.accountScope,
      ...(input.approvedScopeKey !== undefined ? { approvedScopeKey: input.approvedScopeKey } : {}),
    });
    return Object.freeze({
      project(candidate: ConnectorStoreResultProjectionInput): Readonly<Record<string, unknown>> | undefined {
        if (
          input.principal.provider !== 'dropbox'
          || candidate.sourceItem.family !== 'file'
          || candidate.sourceItem.provider !== input.principal.provider
          || candidate.sourceItem.accountScope !== input.principal.accountScope
        ) {
          return undefined;
        }
        const locator = locatorFromRootedDropboxPath(candidate.readLocatorUri(), localMapping);
        return locator ? { locator } : undefined;
      },
    });
  },
});

function locatorFromRootedDropboxPath(
  value: string | undefined,
  localMapping: DropboxLocalFileRootConfig | undefined,
): DropboxLocator | undefined {
  const displayPath = normalizeRootedDropboxDisplayPath(value);
  if (!displayPath) return undefined;
  const segments = dropboxPathSegments(displayPath);
  if (segments.length === 0) return undefined;
  const parentDisplayPath = segments.length === 1 ? '/' : `/${segments.slice(0, -1).join('/')}`;
  const locator: DropboxLocator = {
    display_path: displayPath,
    parent_display_path: parentDisplayPath,
    dropbox_web_url: dropboxHomeUrlForSegments(segments),
    parent_dropbox_web_url: dropboxHomeUrlForSegments(segments.slice(0, -1)),
  };
  if (localMapping) {
    const finderUrl = finderUrlForDropboxPath(localMapping, displayPath);
    if (finderUrl) locator.finder_url = finderUrl;
    const parentFinderUrl = finderUrlForDropboxPath(localMapping, parentDisplayPath);
    if (parentFinderUrl) locator.parent_finder_url = parentFinderUrl;
  }
  return locator;
}

function normalizeRootedDropboxDisplayPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/' || !trimmed.startsWith('/')) return undefined;
  return trimmed;
}

function dropboxPathSegments(displayPath: string): string[] {
  return displayPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function dropboxHomeUrlForSegments(segments: readonly string[]): string {
  if (segments.length === 0) return 'https://www.dropbox.com/home';
  return `https://www.dropbox.com/home/${segments.map(encodeURIComponent).join('/')}`;
}

function finderUrlForDropboxPath(
  mapping: DropboxLocalFileRootConfig,
  displayPath: string,
): string | undefined {
  const relativeSegments = localRelativeDropboxPathSegments(displayPath, mapping.dropboxPathPrefix);
  if (!relativeSegments) return undefined;
  return pathToFileURL(join(mapping.rootPath, ...relativeSegments)).href;
}

function localRelativeDropboxPathSegments(
  displayPath: string,
  dropboxPathPrefix: string | undefined,
): string[] | undefined {
  const normalizedPrefix = normalizeOptionalDropboxPrefix(dropboxPathPrefix);
  if (!normalizedPrefix) return dropboxPathSegments(displayPath);
  if (displayPath === normalizedPrefix) return [];
  if (!displayPath.startsWith(`${normalizedPrefix}/`)) return undefined;
  return dropboxPathSegments(displayPath.slice(normalizedPrefix.length));
}

function normalizeOptionalDropboxPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return undefined;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function configuredStrictLocalMapping(input: {
  accountScope: string;
  approvedScopeKey?: string;
}): DropboxLocalFileRootConfig | undefined {
  const explicitRoot = optionalEnvironmentString(process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_LOCATOR_LOCAL_ROOT);
  if (explicitRoot) return { rootPath: explicitRoot };
  const legacyRoot = optionalEnvironmentString(process.env.DROPBOX_LOCAL_ROOT);
  if (legacyRoot) return { rootPath: legacyRoot };
  try {
    return parseDropboxLocalFileRootsFromEnv().find((root) => (
      (root.account === undefined || root.account === input.accountScope)
      && (
        root.approvedScopeKey === undefined
        || (
          input.approvedScopeKey !== undefined
          && root.approvedScopeKey === input.approvedScopeKey
        )
      )
    ));
  } catch {
    return undefined;
  }
}

function optionalEnvironmentString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
