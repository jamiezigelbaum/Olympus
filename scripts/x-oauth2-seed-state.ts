import {
  JsonCredentialOAuth2StateStore,
  type CredentialOAuth2HandleState,
} from '../src/workers/credential-broker/index.ts';

const handle = process.env.OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE?.trim()
  || 'x.bookmarks.personal';
const statePath = process.env.OLYMPUS_CREDENTIAL_BROKER_STATE_PATH?.trim();
const refreshToken = process.env.OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_REFRESH_TOKEN?.trim()
  || process.env.OLYMPUS_SOURCE_INDEX_X_OAUTH2_REFRESH_TOKEN?.trim()
  || process.env.X_OAUTH2_REFRESH_TOKEN?.trim();
const providerAccountId = process.env.OLYMPUS_SOURCE_INDEX_X_USER_ID?.trim();
const scopes = (process.env.OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_SCOPES?.trim()
  || 'tweet.read users.read bookmark.read offline.access')
  .split(/\s+/)
  .map((scope) => scope.trim())
  .filter(Boolean);

if (!statePath) {
  fail('OLYMPUS_CREDENTIAL_BROKER_STATE_PATH is required.');
}
if (!refreshToken) {
  fail('An OAuth2 refresh token env value is required.');
}

const state: CredentialOAuth2HandleState = {
  refreshToken,
  scopes,
  status: 'available',
  updatedAt: new Date().toISOString(),
  ...(providerAccountId ? { providerAccountId } : {}),
};

const store = new JsonCredentialOAuth2StateStore(statePath);
await store.save(handle, state);

console.log(JSON.stringify({
  ok: true,
  handle,
  provider: 'x',
  status: 'available',
  scopes,
  provider_account_id_present: !!providerAccountId,
  raw_credential_exposed: false,
}, null, 2));

function fail(message: string): never {
  console.error(JSON.stringify({
    ok: false,
    error: message,
    raw_credential_exposed: false,
  }, null, 2));
  process.exit(1);
}
