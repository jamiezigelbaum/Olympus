import type { ConnectorStoreApprovedScopeFilterCodec } from '../connector-store/index.ts';
import { locatorPathApprovedScopeCodec } from '../connector-store/locator-path-scope-codec.ts';

export const LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC: ConnectorStoreApprovedScopeFilterCodec =
  locatorPathApprovedScopeCodec('local files');
