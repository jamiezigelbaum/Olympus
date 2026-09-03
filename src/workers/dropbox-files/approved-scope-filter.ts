import type {
  ConnectorStoreApprovedScopeFilterCodec,
  ConnectorStoreApprovedScopeResolution,
} from '../connector-store/index.ts';

const MAX_APPROVED_SCOPE_KEY_LENGTH = 4_096;
const UNSAFE_SCOPE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export const DROPBOX_APPROVED_SCOPE_FILTER_CODEC: ConnectorStoreApprovedScopeFilterCodec = Object.freeze({
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
      return invalidDropboxApprovedScope(expectedPrefix);
    }

    if (scopedValue.startsWith('folder_id:')) {
      return {
        kind: 'invalid',
        message: 'The "approved_scope_key" folder_id form cannot be served from connector-store data because ancestor folder ids are not persisted. Use a path-form Dropbox scope.',
      };
    }

    if (
      !scopedValue.startsWith('/')
      || scopedValue !== scopedValue.trim()
      || (scopedValue !== '/' && scopedValue.endsWith('/'))
    ) {
      return invalidDropboxApprovedScope(expectedPrefix);
    }

    return {
      kind: 'path',
      accountScope: principal.accountScope,
      locatorPath: scopedValue,
    };
  },
});

function invalidDropboxApprovedScope(expectedPrefix: string): ConnectorStoreApprovedScopeResolution {
  return {
    kind: 'invalid',
    message: `"approved_scope_key" must exactly match "${expectedPrefix}:<rooted path>" with no surrounding whitespace.`,
  };
}
