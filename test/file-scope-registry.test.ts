import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connectedFileSourceAccountGeneration } from '../src/core/source-scope-approval.ts';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getFileScopeSource,
  isFileScopeRootKey,
  listFileScopeSources,
  registerFileScopeSource,
  unregisterFileScopeSource,
  type FileScopeSourceDefinition,
} from '../src/core/file-scope-sources.ts';
import {
  fileSourceScopeIdForProvider,
  isFileSourceScopeId,
  readFileSourceScopeApproval,
} from '../src/core/source-scope-approval.ts';
import {
  connectThisComputerSource,
  defaultThisComputerStatePath,
  disconnectThisComputerSource,
  readThisComputerHandles,
} from '../src/core/this-computer.ts';
import {
  FileSourceScopeAuthority,
  fileSourceScopeContentFilters,
  fileSourceScopeMetadataFilters,
} from '../src/workers/source-scope-runtime.ts';
import {
  createFileScopeBrowser,
  registerFileScopeBrowserFactory,
  unregisterFileScopeBrowserFactory,
} from '../src/workers/source-scope-browser.ts';
import { DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID, DROPBOX_INGESTION_EXCLUSION_SOURCE } from '../src/workers/dropbox-files/connector-store.ts';
import {
  GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
} from '../src/workers/google-connectors/drive.ts';

const LOCAL: FileScopeSourceDefinition = {
  sourceId: 'test.local_files',
  provider: 'test_this_computer',
  account: 'this_computer',
  corpusIdsToInvalidate: ['secure_local.test.local_files'],
  filterFamily: 'locator_path',
  normalizeKey: (key) => key.trim(),
  rootKeys: ['/'],
  label: 'Test files',
  dispositionSourceId: 'test.local_files.personal',
};
const OTHER_LOCAL: FileScopeSourceDefinition = {
  ...LOCAL,
  sourceId: 'test.other_files',
  provider: 'test_other_computer',
  label: 'Other test files',
  dispositionSourceId: 'test.other_files.personal',
};

describe('file-scope registry', () => {
  test('Dropbox and Drive are registered with their historical values', () => {
    expect(listFileScopeSources().map((definition) => definition.sourceId)).toEqual(['google_drive.docs', 'dropbox.files']);
    const drive = getFileScopeSource('google_drive.docs')!;
    const dropbox = getFileScopeSource('dropbox.files')!;
    expect(drive).toMatchObject({
      provider: 'google_drive',
      account: 'provider_account',
      credentialCapability: 'google_drive.docs.sync',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE',
      filterFamily: 'folder_id',
      label: 'Google Drive',
    });
    expect(dropbox).toMatchObject({
      provider: 'dropbox',
      account: 'provider_account',
      credentialCapability: 'dropbox.files.sync',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
      filterFamily: 'locator_path',
      label: 'Dropbox',
    });
    // The registry's literals equal the constants the lanes use.
    expect([...drive.corpusIdsToInvalidate]).toEqual([
      GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
    ]);
    expect([...dropbox.corpusIdsToInvalidate]).toEqual([DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID]);
    expect(drive.dispositionSourceId).toBe(GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE);
    expect(dropbox.dispositionSourceId).toBe(DROPBOX_INGESTION_EXCLUSION_SOURCE);
  });

  test('key normalization and root keys match the previous per-source rules', () => {
    const drive = getFileScopeSource('google_drive.docs')!;
    const dropbox = getFileScopeSource('dropbox.files')!;
    expect(dropbox.normalizeKey('  /Docs/Taxes ')).toBe('/docs/taxes');
    expect(drive.normalizeKey('  AbC_123 ')).toBe('AbC_123');
    expect(isFileScopeRootKey(drive, '/')).toBe(true);
    expect(isFileScopeRootKey(drive, 'ROOT')).toBe(true);
    expect(isFileScopeRootKey(dropbox, '/')).toBe(true);
    expect(isFileScopeRootKey(dropbox, 'root')).toBe(false);
  });

  test('provider and id lookups go through the registry; unknown ids are rejected', () => {
    expect(fileSourceScopeIdForProvider('dropbox')).toBe('dropbox.files');
    expect(fileSourceScopeIdForProvider('google_drive')).toBe('google_drive.docs');
    expect(fileSourceScopeIdForProvider('gmail')).toBeUndefined();
    expect(isFileSourceScopeId('dropbox.files')).toBe(true);
    expect(isFileSourceScopeId('nope.files')).toBe(false);
  });

  test('registration is validated and built-ins cannot be removed', () => {
    expect(() => registerFileScopeSource({ ...LOCAL, sourceId: 'dropbox.files' })).toThrow();
    expect(() => registerFileScopeSource({ ...LOCAL, provider: 'dropbox' })).toThrow();
    expect(() => registerFileScopeSource({ ...LOCAL, sourceId: 'test.needs_cred', account: 'provider_account' })).toThrow();
    expect(() => registerFileScopeSource({ ...LOCAL, sourceId: 'test.no_cred_allowed', credentialCapability: 'x.sync' })).toThrow();
    expect(unregisterFileScopeSource('dropbox.files')).toBe(false);
    expect(getFileScopeSource('dropbox.files')).toBeDefined();
  });

  test('a registered source gets filters from its family without per-source branches', () => {
    registerFileScopeSource(LOCAL);
    try {
      const approval = {
        sourceId: LOCAL.sourceId,
        status: 'approved' as const,
        accountGeneration: 'a'.repeat(64),
        revision: 'r',
        selections: [{ key: '/home/a', state: 'ingest' as const }, { key: '/home/b', state: 'exclude' as const }],
        wholeAccount: false,
      };
      expect(fileSourceScopeContentFilters(approval)).toEqual({
        allowed: true,
        filters: {
          provider: 'test_this_computer',
          sourceScopeGeneration: 'a'.repeat(64),
          sourceScopeRevision: 'r',
          locatorPathScopes: ['/home/a'],
          locatorPathExcludedScopes: ['/home/b'],
        },
      });
      expect(fileSourceScopeMetadataFilters(approval)).toMatchObject({
        allowed: true,
        filters: { provider: 'test_this_computer', locatorPathScopes: ['/home/a'], locatorPathExcludedScopes: ['/home/b'] },
      });
    } finally {
      unregisterFileScopeSource(LOCAL.sourceId);
    }
    // Once unregistered the same approval grants nothing.
    expect(fileSourceScopeContentFilters({
      sourceId: LOCAL.sourceId, status: 'approved', accountGeneration: 'a'.repeat(64), revision: 'r',
      selections: [{ key: '/x', state: 'ingest' }], wholeAccount: false,
    })).toEqual({ allowed: false });
  });

  test('browser factories resolve by source id and fail closed when missing', () => {
    expect(() => createFileScopeBrowser('nope.files', {})).toThrow();
    // Provider-account built-ins refuse to build without a credential.
    expect(() => createFileScopeBrowser('dropbox.files', {})).toThrow();
    const browser = { sourceId: 'test.local_files', browse: async () => ({ nodes: [] }), validateSelections: async () => [] };
    registerFileScopeBrowserFactory('test.local_files', () => browser);
    try {
      expect(createFileScopeBrowser('test.local_files', {})).toBe(browser);
      expect(() => registerFileScopeBrowserFactory('test.local_files', () => browser)).toThrow();
    } finally {
      unregisterFileScopeBrowserFactory('test.local_files');
    }
    expect(() => createFileScopeBrowser('test.local_files', {})).toThrow();
    unregisterFileScopeBrowserFactory('dropbox.files');
    expect(() => createFileScopeBrowser('dropbox.files', {})).toThrow(/credential/);
  });
});

describe('sources without an account (this computer)', () => {
  let dir: string;
  let registryPath: string;
  const NOW = new Date('2026-10-20T10:00:00.000Z');
  const authority = () => new FileSourceScopeAuthority({
    registryPath,
    readRegistry: () => ({ version: 1, handles: [] }),
  });

  beforeEach(() => {
    registerFileScopeSource(LOCAL);
    registerFileScopeSource(OTHER_LOCAL);
    dir = mkdtempSync(join(tmpdir(), 'olympus-this-computer-'));
    registryPath = join(dir, 'handles.json');
  });
  afterEach(() => {
    unregisterFileScopeSource(LOCAL.sourceId);
    unregisterFileScopeSource(OTHER_LOCAL.sourceId);
  });

  test('is not connected until it is connected, and connecting needs no secret', () => {
    expect(authority().snapshot(LOCAL.sourceId)).toMatchObject({ status: 'scope_pending', reason: 'not_connected' });
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW);
    const snapshot = authority().snapshot(LOCAL.sourceId);
    expect(snapshot).toMatchObject({ status: 'scope_pending', reason: 'missing' });
    expect(snapshot.accountGeneration).toMatch(/^[a-f0-9]{64}$/);
    const stored = JSON.parse(readFileSync(defaultThisComputerStatePath(registryPath), 'utf8'));
    // The host binding is a digest; the host's own identity is never stored.
    expect(Object.keys(stored).filter((key) => key !== 'host_binding').sort()).toEqual(['machine_id', 'sources', 'version']);
    if (stored.host_binding !== undefined) expect(stored.host_binding).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(defaultThisComputerStatePath(registryPath)).mode & 0o077).toBe(0);
  });

  test('a record copied to another computer connects nothing there, and connecting starts a new machine id', () => {
    const hostA = () => 'host-a-identity';
    const hostB = () => 'host-b-identity';
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW, hostA);
    const id = JSON.parse(readFileSync(defaultThisComputerStatePath(registryPath), 'utf8')).machine_id;
    expect(readThisComputerHandles(registryPath, hostA)).toHaveLength(1);
    expect(readFileSync(defaultThisComputerStatePath(registryPath), 'utf8')).not.toContain('host-a-identity');
    // The same file, read on another host.
    expect(readThisComputerHandles(registryPath, hostB)).toEqual([]);
    expect(disconnectThisComputerSource(registryPath, LOCAL.sourceId, hostB)).toBe(false);
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW, hostB);
    const moved = readThisComputerHandles(registryPath, hostB);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.providerAccountId).not.toBe(id);
    // And the original host no longer matches the rewritten record.
    expect(readThisComputerHandles(registryPath, hostA)).toEqual([]);
  });

  test('a record made where the host has no identity is not accepted where one appears', () => {
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW, () => undefined);
    expect(readThisComputerHandles(registryPath, () => undefined)).toHaveLength(1);
    expect(readThisComputerHandles(registryPath, () => 'host-a-identity')).toEqual([]);
  });

  test('the machine id is a random uuid, generated once, and the generation is stable across reads', () => {
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW);
    const first = authority().snapshot(LOCAL.sourceId).accountGeneration;
    expect(authority().snapshot(LOCAL.sourceId).accountGeneration).toBe(first);
    const id = JSON.parse(readFileSync(defaultThisComputerStatePath(registryPath), 'utf8')).machine_id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Connecting again changes nothing; a second source shares the machine id.
    connectThisComputerSource(registryPath, LOCAL.sourceId, new Date(NOW.getTime() + 60_000));
    connectThisComputerSource(registryPath, OTHER_LOCAL.sourceId, NOW);
    expect(authority().snapshot(LOCAL.sourceId).accountGeneration).toBe(first);
    expect(JSON.parse(readFileSync(defaultThisComputerStatePath(registryPath), 'utf8')).machine_id).toBe(id);
    // Another install gets another id.
    const otherDir = mkdtempSync(join(tmpdir(), 'olympus-this-computer-'));
    connectThisComputerSource(join(otherDir, 'handles.json'), LOCAL.sourceId, NOW);
    expect(JSON.parse(readFileSync(defaultThisComputerStatePath(join(otherDir, 'handles.json')), 'utf8')).machine_id).not.toBe(id);
  });

  test('approval holds on this computer and resets when the machine id changes', () => {
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW);
    const before = authority().snapshot(LOCAL.sourceId);
    const approved = authority().approve({
      sourceId: LOCAL.sourceId,
      accountGeneration: before.accountGeneration!,
      expectedRevision: before.revision,
      selections: [{ key: '/home/me/Documents', state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    });
    expect(approved.status).toBe('approved');
    expect(authority().snapshot(LOCAL.sourceId)).toMatchObject({ status: 'approved', revision: approved.revision });
    expect(authority().policyRef(LOCAL.sourceId)).toBeDefined();
    // The provider root needs the explicit whole-account path, as for any source.
    expect(() => authority().approve({
      sourceId: LOCAL.sourceId,
      accountGeneration: approved.accountGeneration!,
      expectedRevision: approved.revision,
      selections: [{ key: '/', state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    })).toThrow();

    // A reinstall or a different computer: same data, new machine id.
    const path = defaultThisComputerStatePath(registryPath);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...state, machine_id: '11111111-1111-4111-8111-111111111111' }));
    const moved = authority().snapshot(LOCAL.sourceId);
    // On a host with an identity the edited record no longer matches its host
    // binding, so it reads as not connected; without one, as a changed account.
    expect(moved).toMatchObject({ status: 'scope_pending', selections: [] });
    expect(['account_changed', 'not_connected'] as Array<string | undefined>).toContain(moved.reason);
    expect(moved.accountGeneration).not.toBe(approved.accountGeneration);
    expect(authority().policyRef(LOCAL.sourceId)).toBeUndefined();
    expect(() => authority().assertCurrent({
      sourceId: LOCAL.sourceId,
      accountGeneration: approved.accountGeneration!,
      revision: approved.revision,
    })).toThrow();
  });

  test('disconnect reads as not connected, drops the approval, and a reconnect starts clean', () => {
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW);
    const before = authority().snapshot(LOCAL.sourceId);
    authority().approve({
      sourceId: LOCAL.sourceId,
      accountGeneration: before.accountGeneration!,
      expectedRevision: before.revision,
      selections: [{ key: '/home/me/Documents', state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    });
    expect(disconnectThisComputerSource(registryPath, LOCAL.sourceId)).toBe(true);
    expect(disconnectThisComputerSource(registryPath, LOCAL.sourceId)).toBe(false);
    expect(authority().snapshot(LOCAL.sourceId)).toMatchObject({ status: 'scope_pending', reason: 'not_connected' });
    expect(readThisComputerHandles(registryPath)).toEqual([]);
    connectThisComputerSource(registryPath, LOCAL.sourceId, new Date(NOW.getTime() + 3_600_000));
    expect(authority().snapshot(LOCAL.sourceId)).toMatchObject({ status: 'scope_pending', reason: 'account_changed' });
  });

  test('a this-computer source can never inherit another source\'s approval or a real credential', () => {
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW);
    connectThisComputerSource(registryPath, OTHER_LOCAL.sourceId, NOW);
    const local = authority().snapshot(LOCAL.sourceId);
    authority().approve({
      sourceId: LOCAL.sourceId,
      accountGeneration: local.accountGeneration!,
      expectedRevision: local.revision,
      selections: [{ key: '/home/me/Documents', state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    });
    const other = authority().snapshot(OTHER_LOCAL.sourceId);
    expect(other).toMatchObject({ status: 'scope_pending', reason: 'missing', selections: [] });
    expect(other.accountGeneration).not.toBe(local.accountGeneration);
    // The other source's generation cannot approve this source's slot either.
    expect(() => authority().approve({
      sourceId: OTHER_LOCAL.sourceId,
      accountGeneration: local.accountGeneration!,
      expectedRevision: other.revision,
      selections: [{ key: '/x', state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    })).toThrow();

    // A credential handle carrying the same provider label does not connect it,
    // and a real provider's handle does not connect a this-computer source.
    const realHandles = {
      version: 1 as const,
      handles: [{
        handle: 'impostor', provider: LOCAL.provider as never, allowedCapabilities: ['test.local_files.this_computer'],
        scopes: [], connectedAt: NOW.toISOString(),
      }],
    };
    disconnectThisComputerSource(registryPath, LOCAL.sourceId);
    const withImpostor = new FileSourceScopeAuthority({ registryPath, readRegistry: () => realHandles });
    expect(withImpostor.snapshot(LOCAL.sourceId)).toMatchObject({ status: 'scope_pending', reason: 'not_connected' });
  });

  test('state naming an unregistered source is rejected as malformed', () => {
    connectThisComputerSource(registryPath, LOCAL.sourceId, NOW);
    const before = authority().snapshot(LOCAL.sourceId);
    authority().approve({
      sourceId: LOCAL.sourceId,
      accountGeneration: before.accountGeneration!,
      expectedRevision: before.revision,
      selections: [{ key: '/home/me', state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    });
    unregisterFileScopeSource(LOCAL.sourceId);
    // The Dropbox slot reads the same file: an unknown id makes it malformed, never approved.
    const dropbox = readFileSourceScopeApproval({
      sourceId: 'dropbox.files',
      statePath: authority().statePath,
      registry: {
        handles: [{
          handle: 'd', provider: 'dropbox', allowedCapabilities: ['dropbox.files.sync'],
          connectedAt: NOW.toISOString(),
        }],
      },
    });
    expect(dropbox).toMatchObject({ status: 'scope_pending', reason: 'malformed' });
    registerFileScopeSource(LOCAL);
  });

  test('connecting a source that does not bind to this computer is refused', () => {
    expect(() => connectThisComputerSource(registryPath, 'dropbox.files', NOW)).toThrow();
    expect(() => connectThisComputerSource(registryPath, 'unknown.files', NOW)).toThrow();
  });
});

// Persisted approvals stay valid only while the generation inputs never move.
// Literals, computed outside the code under test, pin Dropbox and Drive.
describe('account generation is pinned', () => {
  const registry = {
    handles: [
      { handle: 'h1', provider: 'dropbox', allowedCapabilities: ['dropbox.files.sync'], connectedAt: '2026-01-01T00:00:00.000Z', accountRole: 'personal', providerAccountId: 'acct-1' },
      { handle: 'h1', provider: 'google_drive', allowedCapabilities: ['google_drive.docs.sync'], connectedAt: '2026-01-01T00:00:00.000Z', accountRole: 'personal', providerAccountId: 'acct-1' },
    ],
  };
  test('Dropbox', () => {
    expect(connectedFileSourceAccountGeneration('dropbox.files', registry)?.generation)
      .toBe('cf905ee9fb0c0c47eb3b73fdb6a8b09ca260e0dfcd07fc49447e6d17c1ad928f');
  });
  test('Drive', () => {
    expect(connectedFileSourceAccountGeneration('google_drive.docs', registry)?.generation)
      .toBe('c4cc6d9797b5e8165c94e9e20fbe34deeb1dbf48fdf46e0304b2e6234806de58');
  });
});
