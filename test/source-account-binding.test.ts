// One provider account per file source: the durable record and the decision
// the worker takes before every Dropbox, Drive and Gmail task.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideSourceAccountAction,
  readSourceAccountBindings,
  recordFileSourceConnect,
  recordFileSourceConnectIntent,
  sourceAccountBindingsPath,
  updateSourceAccountBinding,
  type SourceAccountBinding,
} from '../src/core/source-account-binding.ts';
import {
  dropboxAccountIdFromTokenPayload,
  fetchProviderAccountId,
  googleAccountIdFromAddress,
} from '../src/core/provider-account-identity.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-11T00:00:00.000Z');

function registryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-source-account-'));
  dirs.push(dir);
  return join(dir, 'handles.json');
}

function decide(input: {
  binding?: SourceAccountBinding | undefined;
  grant?: string;
  token?: string;
  holds?: boolean;
}) {
  return decideSourceAccountAction({
    binding: input.binding,
    grantAccountId: input.grant,
    tokenAccountId: input.token,
    laneHoldsItems: input.holds ?? true,
    now: NOW,
  });
}

describe('decideSourceAccountAction', () => {
  test('the incident: a token for one account serving a grant for another is refused', () => {
    expect(decide({ binding: { provider_account_id: 'dbid:a' }, grant: 'dbid:b', token: 'dbid:a' }))
      .toEqual({ action: 'refuse', reason: 'token_account_mismatch' });
  });

  test('the same account proceeds without writing', () => {
    expect(decide({ binding: { provider_account_id: 'dbid:a' }, grant: 'dbid:a', token: 'dbid:a' }))
      .toEqual({ action: 'proceed' });
  });

  test('a different account with stored items purges; with none it binds the new account', () => {
    expect(decide({ binding: { provider_account_id: 'dbid:a' }, grant: 'dbid:b', token: 'dbid:b' }))
      .toEqual({ action: 'purge', reason: 'account_changed' });
    expect(decide({ binding: { provider_account_id: 'dbid:a' }, grant: 'dbid:b', token: 'dbid:b', holds: false }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'dbid:b', bound_at: NOW.toISOString() } });
  });

  test('a standing removal marker blocks until the stores are empty or the previous account is back', () => {
    const binding: SourceAccountBinding = {
      provider_account_id: 'dbid:a',
      purge_required: { reason: 'account_changed', detected_at: NOW.toISOString() },
    };
    expect(decide({ binding, grant: 'dbid:b', token: 'dbid:b' })).toEqual({ action: 'purge', reason: 'account_changed' });
    expect(decide({ binding, grant: 'dbid:b', token: 'dbid:b', holds: false }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'dbid:b', bound_at: NOW.toISOString() } });
    // The previous account back: the marker lifts and its items stay.
    expect(decide({ binding, grant: 'dbid:a', token: 'dbid:a' }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'dbid:a', bound_at: NOW.toISOString() } });
  });

  test('a reconnect over unbound stored items cannot prove the account and purges', () => {
    expect(decide({ binding: { reconnected_at: NOW.toISOString() }, grant: 'dbid:b', token: 'dbid:b' }))
      .toEqual({ action: 'purge', reason: 'previous_account_unknown' });
    expect(decide({ binding: { reconnected_at: NOW.toISOString() }, token: 'google:b', holds: false }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'google:b', bound_at: NOW.toISOString() } });
  });

  test('a reconnect to the same bound account settles the marker', () => {
    expect(decide({
      binding: { provider_account_id: 'google:a', reconnected_at: NOW.toISOString() },
      token: 'google:a',
    })).toEqual({ action: 'proceed', write: { provider_account_id: 'google:a', bound_at: NOW.toISOString() } });
  });

  test('a bound source whose account cannot be read this run waits rather than purging', () => {
    expect(decide({ binding: { provider_account_id: 'google:a' } }))
      .toEqual({ action: 'refuse', reason: 'account_unverified' });
    expect(decide({ binding: { provider_account_id: 'google:a', reconnected_at: NOW.toISOString() } }))
      .toEqual({ action: 'refuse', reason: 'account_unverified' });
  });

  test('a bound source never proceeds on the grant\'s word alone (Codex round 1 #2)', () => {
    // Binding and grant both say B; the token in hand could be anything (an
    // environment token, a stale mint). Unidentified, it waits.
    expect(decide({ binding: { provider_account_id: 'dbid:b' }, grant: 'dbid:b' }))
      .toEqual({ action: 'refuse', reason: 'account_unverified' });
  });

  test('an emptied source with a standing purge binds only a proven account', () => {
    const binding: SourceAccountBinding = {
      purge_required: { reason: 'account_changed', detected_at: NOW.toISOString() },
    };
    expect(decide({ binding, grant: 'dbid:b', holds: false })).toEqual({ action: 'proceed', write: null });
  });

  test('a never-reconnected source adopts the connected account, or proceeds unbound when unknown', () => {
    expect(decide({ token: 'google:a' }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'google:a', bound_at: NOW.toISOString() } });
    expect(decide({})).toEqual({ action: 'proceed' });
  });
});

describe('recordFileSourceConnect', () => {
  test('a connect to the bound account changes nothing; a different account requires a purge', () => {
    const registry = registryPath();
    const path = sourceAccountBindingsPath(registry);
    updateSourceAccountBinding(path, 'dropbox.files', () => ({ provider_account_id: 'dbid:a', bound_at: NOW.toISOString() }));

    expect(recordFileSourceConnect({ registryPath: registry, provider: 'dropbox', providerAccountId: 'dbid:a', now: NOW }))
      .toBe('same_account');
    expect(recordFileSourceConnect({ registryPath: registry, provider: 'dropbox', providerAccountId: 'dbid:b', now: NOW }))
      .toBe('purge_required');
    const read = readSourceAccountBindings(path);
    expect(read.kind === 'ok' && read.bindings.sources['dropbox.files']).toEqual({
      provider_account_id: 'dbid:a',
      bound_at: NOW.toISOString(),
      purge_required: { reason: 'account_changed', detected_at: NOW.toISOString() },
    });
    // Another account while the purge stands keeps it...
    expect(recordFileSourceConnect({ registryPath: registry, provider: 'dropbox', providerAccountId: 'dbid:c', now: NOW }))
      .toBe('purge_required');
    // ...and the previous account coming back lifts it: its own items stay.
    expect(recordFileSourceConnect({ registryPath: registry, provider: 'dropbox', providerAccountId: 'dbid:a', now: NOW }))
      .toBe('same_account');
    const lifted = readSourceAccountBindings(path);
    expect(lifted.kind === 'ok' && lifted.bindings.sources['dropbox.files'])
      .toEqual({ provider_account_id: 'dbid:a', bound_at: NOW.toISOString() });
  });

  test('a connect with no binding, or an unknown account, leaves a reconnect marker', () => {
    const registry = registryPath();
    expect(recordFileSourceConnect({ registryPath: registry, provider: 'gmail', providerAccountId: undefined, now: NOW }))
      .toBe('reconnected');
    const read = readSourceAccountBindings(sourceAccountBindingsPath(registry));
    expect(read.kind === 'ok' && read.bindings.sources['gmail.email']).toEqual({ reconnected_at: NOW.toISOString() });
    const raw = readFileSync(sourceAccountBindingsPath(registry), 'utf8');
    expect(raw).not.toContain('@');
  });

  test('an unreadable record refuses rather than being overwritten', () => {
    const registry = registryPath();
    writeFileSync(sourceAccountBindingsPath(registry), '{not json');
    expect(readSourceAccountBindings(sourceAccountBindingsPath(registry))).toEqual({ kind: 'malformed' });
    expect(() => recordFileSourceConnect({ registryPath: registry, provider: 'dropbox', providerAccountId: 'dbid:a', now: NOW }))
      .toThrow('unreadable');
  });
});

describe('recordFileSourceConnectIntent (Codex round 2 #2)', () => {
  function binding(registry: string) {
    const read = readSourceAccountBindings(sourceAccountBindingsPath(registry));
    return read.kind === 'ok' ? read.bindings.sources['dropbox.files'] : undefined;
  }

  test('a connect that stops after publishing a different account still purges before syncing it', () => {
    const registry = registryPath();
    // Never bound; the replaced grant identified as A.
    recordFileSourceConnectIntent({ registryPath: registry, provider: 'dropbox', previousAccountId: 'dbid:a', now: NOW });
    expect(binding(registry)).toEqual({ provider_account_id: 'dbid:a', bound_at: NOW.toISOString(), reconnected_at: NOW.toISOString() });
    // B was published, then the process died before the completion record.
    expect(decide({ binding: binding(registry), grant: 'dbid:b', token: 'dbid:b' })).toEqual({ action: 'purge', reason: 'account_changed' });
    // Or the connect failed and A is still connected: settled, nothing purged.
    expect(decide({ binding: binding(registry), grant: 'dbid:a', token: 'dbid:a' }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'dbid:a', bound_at: NOW.toISOString() } });
  });

  test('an unidentified replaced grant over stored items cannot be adopted, so the change purges', () => {
    const registry = registryPath();
    recordFileSourceConnectIntent({ registryPath: registry, provider: 'dropbox', previousAccountId: undefined, now: NOW });
    expect(binding(registry)).toEqual({ reconnected_at: NOW.toISOString() });
    expect(decide({ binding: binding(registry), token: 'dbid:b' })).toEqual({ action: 'purge', reason: 'previous_account_unknown' });
  });

  test('a bound or already-reconnected source never adopts the replaced grant\'s account', () => {
    const registry = registryPath();
    const path = sourceAccountBindingsPath(registry);
    updateSourceAccountBinding(path, 'dropbox.files', () => ({ reconnected_at: '2026-10-10T00:00:00.000Z' }));
    recordFileSourceConnectIntent({ registryPath: registry, provider: 'dropbox', previousAccountId: 'dbid:a', now: NOW });
    expect(binding(registry)).toEqual({ reconnected_at: NOW.toISOString() });

    updateSourceAccountBinding(path, 'dropbox.files', () => ({ provider_account_id: 'dbid:a' }));
    recordFileSourceConnectIntent({ registryPath: registry, provider: 'dropbox', previousAccountId: 'dbid:z', now: NOW });
    expect(binding(registry)).toEqual({ provider_account_id: 'dbid:a', reconnected_at: NOW.toISOString() });
  });

  test('a standing purge is left exactly as it is', () => {
    const registry = registryPath();
    const purge = { provider_account_id: 'dbid:a', purge_required: { reason: 'account_changed' as const, detected_at: NOW.toISOString() } };
    updateSourceAccountBinding(sourceAccountBindingsPath(registry), 'dropbox.files', () => purge);
    recordFileSourceConnectIntent({ registryPath: registry, provider: 'dropbox', previousAccountId: 'dbid:a', now: NOW });
    expect(binding(registry)).toEqual(purge);
  });
});

describe('provider account identity', () => {
  test('Dropbox names the account in its token response and its account lookup', async () => {
    expect(dropboxAccountIdFromTokenPayload({ account_id: 'dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc' }))
      .toBe('dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc');
    expect(dropboxAccountIdFromTokenPayload({ account_id: 'not an id' })).toBeUndefined();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const id = await fetchProviderAccountId({
      provider: 'dropbox',
      accessToken: 'access-token-fixture',
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ account_id: 'dbid:account-b' }), { status: 200 });
      },
    });
    expect(id).toBe('dbid:account-b');
    expect(seen[0]!.url).toBe('https://api.dropboxapi.com/2/users/get_current_account');
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.body).toBe('null');
  });

  test('Google accounts are an opaque digest of the address, the same from Gmail and Drive', async () => {
    const gmail = await fetchProviderAccountId({
      provider: 'gmail',
      accessToken: 'access-token-fixture',
      fetchImpl: async () => new Response(JSON.stringify({ emailAddress: 'Owner@Example.test' }), { status: 200 }),
    });
    const drive = await fetchProviderAccountId({
      provider: 'google_drive',
      accessToken: 'access-token-fixture',
      fetchImpl: async () => new Response(JSON.stringify({ user: { emailAddress: 'owner@example.test' } }), { status: 200 }),
    });
    expect(gmail).toBe(drive);
    expect(gmail).toBe(googleAccountIdFromAddress('owner@example.test'));
    expect(gmail).toMatch(/^google:[0-9a-f]{40}$/);
  });

  test('a lookup whose body stalls is bounded by the same deadline (PR review)', async () => {
    const started = Date.now();
    await expect(fetchProviderAccountId({
      provider: 'dropbox',
      accessToken: 'access-token-fixture',
      timeoutMs: 100,
      fetchImpl: async () => new Response(new ReadableStream({ start() { /* headers sent, body never ends */ } }), { status: 200 }),
    })).rejects.toThrow('did not answer');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a refused lookup is an error, never a guessed account', async () => {
    await expect(fetchProviderAccountId({
      provider: 'dropbox',
      accessToken: 'access-token-fixture',
      fetchImpl: async () => new Response('{"error_summary":"missing_scope/"}', { status: 401 }),
    })).rejects.toThrow('status 401');
  });
});

describe('a connector store notices its file was deleted under it', () => {
  test('removed or replaced on disk, the open store says so; a fresh open does not', async () => {
    const { LocalConnectorStore } = await import('../src/workers/connector-store/local-index.ts');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'olympus-store-identity-'));
    try {
      const dbPath = join(dir, 'dropbox.sqlite');
      const open = () => new LocalConnectorStore({ dbPath, corpusId: 'dropbox.files', family: 'file', trustDomain: 'internal' });
      const before = open();
      expect(before.fileReplacedOrRemoved()).toBe(false);
      // What `olympus data delete --source` does while the worker stays up.
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
      expect(before.fileReplacedOrRemoved()).toBe(true);
      const after = open();
      expect(after.fileReplacedOrRemoved()).toBe(false);
      expect(after.holdsAnyItem()).toBe(false);
      // The old handle stays stale: its file is not the one at the path.
      expect(before.fileReplacedOrRemoved()).toBe(true);
      before.close();
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Dropbox account evidence for legacy grants without account_info.read', () => {
  test('true only when every sampled id opens; false on a not-found; unknown otherwise', async () => {
    const { dropboxItemsOpenForToken } = await import('../src/core/provider-account-identity.ts');
    const answer = (byId: Record<string, Response>) => async (_url: string, init: RequestInit) => {
      const id = (JSON.parse(String(init.body)) as { path: string }).path;
      return byId[id]?.clone() ?? new Response('{}', { status: 200 });
    };
    const notFound = new Response('{"error_summary":"path/not_found/..","error":{".tag":"path","path":{".tag":"not_found"}}}', { status: 409 });
    expect(await dropboxItemsOpenForToken({ accessToken: 't', itemIds: ['id:a', 'id:b'], fetchImpl: answer({}) })).toBe(true);
    expect(await dropboxItemsOpenForToken({ accessToken: 't', itemIds: ['id:a', 'id:b'], fetchImpl: answer({ 'id:b': notFound }) })).toBe(false);
    expect(await dropboxItemsOpenForToken({ accessToken: 't', itemIds: ['id:a'], fetchImpl: answer({ 'id:a': new Response('{}', { status: 500 }) }) })).toBeUndefined();
    expect(await dropboxItemsOpenForToken({ accessToken: 't', itemIds: ['not-an-id'], fetchImpl: answer({}) })).toBeUndefined();
  });

  test('own-folder evidence lists only unshared folders at the root', async () => {
    const { dropboxOwnRootFolderIds } = await import('../src/core/provider-account-identity.ts');
    const entries = [
      { '.tag': 'folder', id: 'id:own1', name: 'Photos' },
      { '.tag': 'folder', id: 'id:shared', name: 'Team', sharing_info: { read_only: false, shared_folder_id: '1' } },
      { '.tag': 'file', id: 'id:file', name: 'a.txt' },
      { '.tag': 'folder', id: 'id:own2', name: 'Notes' },
    ];
    let request: { path?: string; recursive?: boolean } = {};
    const ids = await dropboxOwnRootFolderIds({
      accessToken: 't',
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ entries, has_more: false }), { status: 200 });
      },
    });
    expect(request).toMatchObject({ path: '', recursive: false });
    expect(ids).toEqual(['id:own1', 'id:own2']);
    expect(await dropboxOwnRootFolderIds({ accessToken: 't', fetchImpl: async () => new Response('{}', { status: 401 }) })).toBeUndefined();
  });
});
