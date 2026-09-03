import { describe, expect, test } from 'bun:test';
import {
  connectorStoreLaneHandle,
  selectedSourceCredentialHandle,
} from '../src/workers/email-source/server.ts';
import type { ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';

const handles: ConnectedCredentialHandle[] = [
  { handle: 'dropbox.business', provider: 'dropbox', accountRole: 'business', allowedCapabilities: ['dropbox.files.sync'], scopes: [], connectedAt: '2026-01-01T00:00:00Z' },
  { handle: 'dropbox.personal', provider: 'dropbox', accountRole: 'personal', allowedCapabilities: ['dropbox.files.sync'], scopes: [], connectedAt: '2026-01-01T00:00:00Z' },
];

describe('Dropbox credential handle selection', () => {
  test('refuses ambiguity instead of selecting the alphabetically first account', () => {
    const warnings: string[] = [];
    const selected = selectedSourceCredentialHandle({
      env: {}, pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
      provider: 'dropbox', capability: 'dropbox.files.sync', handles,
      warn: (message) => warnings.push(message),
    });
    expect(selected).toBeUndefined();
    expect(warnings.join('\n')).toContain('dropbox.business, dropbox.personal');
  });

  test('uses the exact operator pin for the Dropbox lane', () => {
    const selected = connectorStoreLaneHandle({
      env: {
        OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED: 'true',
        OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE: 'dropbox.personal',
      },
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
      provider: 'dropbox', capability: 'dropbox.files.sync', handles,
    });
    expect(selected?.handle).toBe('dropbox.personal');
  });
});
