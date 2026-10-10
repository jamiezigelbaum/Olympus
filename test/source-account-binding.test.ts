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
  binding?: SourceAccountBinding;
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

  test('a standing purge blocks until the stores are empty', () => {
    const binding: SourceAccountBinding = {
      provider_account_id: 'dbid:a',
      purge_required: { reason: 'account_changed', detected_at: NOW.toISOString() },
    };
    expect(decide({ binding, grant: 'dbid:b', token: 'dbid:b' })).toEqual({ action: 'purge', reason: 'account_changed' });
    expect(decide({ binding, grant: 'dbid:b', token: 'dbid:b', holds: false }))
      .toEqual({ action: 'proceed', write: { provider_account_id: 'dbid:b', bound_at: NOW.toISOString() } });
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
    // A second connect while the purge stands keeps it.
    expect(recordFileSourceConnect({ registryPath: registry, provider: 'dropbox', providerAccountId: 'dbid:a', now: NOW }))
      .toBe('purge_required');
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

  test('a refused lookup is an error, never a guessed account', async () => {
    await expect(fetchProviderAccountId({
      provider: 'dropbox',
      accessToken: 'access-token-fixture',
      fetchImpl: async () => new Response('{"error_summary":"missing_scope/"}', { status: 401 }),
    })).rejects.toThrow('status 401');
  });
});
