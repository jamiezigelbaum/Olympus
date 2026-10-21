import type { ConnectorStoreApprovedScopeFilterCodec } from '../connector-store/index.ts';
import { locatorPathApprovedScopeCodec } from '../connector-store/locator-path-scope-codec.ts';

export const DROPBOX_APPROVED_SCOPE_FILTER_CODEC: ConnectorStoreApprovedScopeFilterCodec =
  locatorPathApprovedScopeCodec('Dropbox');
