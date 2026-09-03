// The token-endpoint body is redacted because a provider that echoes the
// submitted grant hands back a credential that is still live. Redaction that
// runs after the detail has been cut to length cannot match a secret the cut
// went through: the tail is gone, `replaceAll` finds nothing, and the head is
// emitted raw into an operator-visible error. Redact the whole body, then
// truncate.

import { describe, expect, test } from 'bun:test';
import {
  CredentialBrokerError,
  createEnvCredentialBroker,
} from '../src/workers/credential-broker/index.ts';

const PAD_BEFORE = 'x'.repeat(300);
const PAD_AFTER = `${'y'.repeat(400)}TAIL-MARKER`;

describe('provider error bodies are redacted before they are truncated', () => {
  test('a refresh token echoed across the truncation boundary is not emitted in fragments', async () => {
    const refreshToken = `dropbox-refresh-token-fixture-${'z'.repeat(370)}`;
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: 'dropbox-app-key-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: 'dropbox-app-secret-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: refreshToken,
      },
      oauth2CacheNamespace: 'test-dropbox-provider-echo-straddle',
      fetch: async () => new Response(JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: `${PAD_BEFORE}${refreshToken}${PAD_AFTER}`,
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    });

    const thrown = await broker.issueSession({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local',
    }).catch((reason: unknown) => reason);

    expect(thrown).toBeInstanceOf(CredentialBrokerError);
    const message = String(thrown);
    expect(message).toContain('[redacted]');
    // The secret starts before the 500-character window ends and runs past it,
    // so a truncate-then-redact order leaves this prefix unredacted.
    expect(message).not.toContain(refreshToken.slice(0, 64));
    expect(message).not.toContain(refreshToken);
    // Redacting first must not turn the detail into an unbounded body dump.
    expect(message).not.toContain('TAIL-MARKER');
    expect(message.length).toBeLessThan(700);
  });
});
