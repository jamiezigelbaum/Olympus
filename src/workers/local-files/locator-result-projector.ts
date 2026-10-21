import { pathToFileURL } from 'node:url';
import type {
  ConnectorStoreResultProjectionInput,
  ConnectorStoreResultProjectorCodec,
} from '../connector-store/index.ts';
import { LOCAL_FILES_PROVIDER } from './scope.ts';
import { splitScopePath } from './paths.ts';

interface LocalFileLocator {
  display_path: string;
  parent_display_path: string;
  finder_url?: string;
  parent_finder_url?: string;
}

/**
 * What a search result tells the client about where a file is. A file on the
 * computer's own volume also gets a `file://` link; one on another disk is
 * named by its path inside that disk only, since where the disk is mounted
 * can change.
 */
export const LOCAL_FILES_LOCATOR_RESULT_PROJECTOR_CODEC: ConnectorStoreResultProjectorCodec = Object.freeze({
  create(input: Readonly<{ principal: Readonly<{ provider: string; accountScope: string }>; approvedScopeKey?: string }>) {
    return Object.freeze({
      project(candidate: ConnectorStoreResultProjectionInput): Readonly<Record<string, unknown>> | undefined {
        if (
          input.principal.provider !== LOCAL_FILES_PROVIDER
          || candidate.sourceItem.family !== 'file'
          || candidate.sourceItem.provider !== input.principal.provider
          || candidate.sourceItem.accountScope !== input.principal.accountScope
        ) return undefined;
        const locator = locatorFromScopePath(candidate.readLocatorUri());
        return locator ? { locator } : undefined;
      },
    });
  },
});

function locatorFromScopePath(value: string | undefined): LocalFileLocator | undefined {
  if (!value?.startsWith('/')) return undefined;
  let split;
  try { split = splitScopePath(value); } catch { return undefined; }
  if (split.path === '/') return undefined;
  const parent = split.path.slice(0, split.path.lastIndexOf('/')) || '/';
  const locator: LocalFileLocator = {
    display_path: split.path,
    parent_display_path: parent,
  };
  if (!split.volumeId) {
    locator.finder_url = pathToFileURL(split.path).href;
    locator.parent_finder_url = pathToFileURL(parent).href;
  }
  return locator;
}
