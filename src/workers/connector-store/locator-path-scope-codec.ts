// The approved-scope read filter for a file source whose scope keys are rooted
// paths matched against the item locator: `<provider>.<account>:<rooted path>`.
// Shared by every such source (Dropbox, local files); only the name used in
// messages differs.

import type {
  ConnectorStoreApprovedScopeFilterCodec,
  ConnectorStoreApprovedScopeResolution,
} from './index.ts';

const MAX_APPROVED_SCOPE_KEY_LENGTH = 4_096;
const UNSAFE_SCOPE_CHARACTERS = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']');

export function locatorPathApprovedScopeCodec(sourceLabel: string): ConnectorStoreApprovedScopeFilterCodec {
  const invalid = (expectedPrefix: string): ConnectorStoreApprovedScopeResolution => ({
    kind: 'invalid',
    message: `"approved_scope_key" must exactly match "${expectedPrefix}:<rooted path>" with no surrounding whitespace.`,
  });
  return Object.freeze({
    resolveLocatorPath(
      value: string,
      principal: Readonly<{ provider: string; accountScope: string }>,
    ): ConnectorStoreApprovedScopeResolution {
      const expectedPrefix = `${principal.provider}.${principal.accountScope}`;
      const separator = value.indexOf(':');
      const prefix = separator < 0 ? undefined : value.slice(0, separator);
      const scopedValue = separator < 0 ? undefined : value.slice(separator + 1);

      if (
        value.length === 0
        || value.length > MAX_APPROVED_SCOPE_KEY_LENGTH
        || value !== value.trim()
        || UNSAFE_SCOPE_CHARACTERS.test(value)
        || prefix !== expectedPrefix
        || scopedValue === undefined
        || scopedValue.length === 0
      ) {
        return invalid(expectedPrefix);
      }

      if (scopedValue.startsWith('folder_id:')) {
        return {
          kind: 'invalid',
          message: `The "approved_scope_key" folder_id form cannot be served from connector-store data because ancestor folder ids are not persisted. Use a path-form ${sourceLabel} scope.`,
        };
      }

      if (
        !scopedValue.startsWith('/')
        || scopedValue !== scopedValue.trim()
        || (scopedValue !== '/' && scopedValue.endsWith('/'))
      ) {
        return invalid(expectedPrefix);
      }

      return { kind: 'path', accountScope: principal.accountScope, locatorPath: scopedValue };
    },
  });
}
