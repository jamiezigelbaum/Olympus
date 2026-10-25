// One account, live and imported (docs/design/source-storage.md, delivery step
// 4e): the registry names the provider account an account's history belongs to,
// the first value stays, and an import joins the account it proves, creates one
// when there is none, waits for the owner when it cannot be matched, and stays
// apart when it is another account's.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeProviderAccountId,
  googleAccountIdFromAddress,
  googleSubjectLabel,
} from '../src/core/provider-account-identity.ts';
import {
  forgetProviderAccounts,
  readSourceRegistry,
  sourceRegistryPath,
  updateSourceRegistry,
  type SourceRegistryAccountState,
} from '../src/core/source-registry.ts';
import {
  SourceStorageUnavailableError,
  recordedProviderAccount,
  recordProviderAccount,
  resolveImportAccount,
} from '../src/core/source-storage.ts';

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-account-identity-'));
  env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data') };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ADDRESS = googleAccountIdFromAddress('owner@example.com');
const SUB = googleSubjectLabel('1001');
const OTHER_SUB = googleSubjectLabel('2002');
const GMAIL = composeProviderAccountId([SUB, ADDRESS])!;

function entry(sourceId: string, providerAccountHash?: string, state: SourceRegistryAccountState = 'active'): void {
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({
      source_id: sourceId,
      slot: '1',
      state,
      layout: 'folder',
      corpus_ids: [`secure_local.${sourceId}`],
      ...(providerAccountHash ? { provider_account_hash: providerAccountHash } : {}),
      created_at: '2026-10-25T00:00:00.000Z',
    });
  });
}

function hashOf(sourceId: string): string | undefined {
  return readSourceRegistry(env).accounts.find((account) => account.source_id === sourceId)?.provider_account_hash;
}

function registryText(): string {
  return readFileSync(sourceRegistryPath(env), 'utf8');
}

describe('recording the account a history belongs to', () => {
  test('the first value is recorded, and the same account only adds labels', () => {
    entry('gmail.email');
    expect(recordProviderAccount({ sourceId: 'gmail.email' }, ADDRESS, env)).toBe('recorded');
    expect(hashOf('gmail.email')).toBe(ADDRESS);
    // A token that knows the account's subject: the same account, by more labels.
    expect(recordProviderAccount({ sourceId: 'gmail.email' }, GMAIL, env)).toBe('same');
    expect(hashOf('gmail.email')).toBe(GMAIL);
    const before = registryText();
    expect(recordProviderAccount({ sourceId: 'gmail.email' }, GMAIL, env)).toBe('same');
    expect(registryText()).toBe(before);
  });

  test('another account, or one that cannot be matched, leaves the first value', () => {
    entry('gmail.email', GMAIL);
    expect(recordProviderAccount({ sourceId: 'gmail.email' }, composeProviderAccountId([OTHER_SUB, ADDRESS])!, env)).toBe('different');
    // An address alone against a record that knows the subject: never decided by the address.
    expect(recordProviderAccount({ sourceId: 'gmail.email' }, ADDRESS, env)).toBe('unproven');
    expect(hashOf('gmail.email')).toBe(GMAIL);
  });

  test('no entry is created, and an account being deleted is refused', () => {
    expect(recordProviderAccount({ sourceId: 'gmail.email' }, GMAIL, env)).toBe('no_entry');
    expect(readSourceRegistry(env).accounts).toEqual([]);
    entry('telegram.messages', undefined, 'deleting');
    expect(() => recordProviderAccount({ sourceId: 'telegram.messages' }, 'telegram:0123456789abcdef', env))
      .toThrow(SourceStorageUnavailableError);
    expect(recordedProviderAccount({ sourceId: 'telegram.messages' }, env)).toBeUndefined();
  });

  test('a Delete forgets it for the deleted sources only', () => {
    entry('gmail.email', GMAIL);
    entry('telegram.messages', 'telegram:0123456789abcdef');
    expect(forgetProviderAccounts(env, ['telegram.messages'])).toEqual(['telegram.messages']);
    expect(hashOf('telegram.messages')).toBeUndefined();
    expect(hashOf('gmail.email')).toBe(GMAIL);
    const before = registryText();
    expect(forgetProviderAccounts(env, ['telegram.messages'])).toEqual([]);
    expect(registryText()).toBe(before);
  });
});

describe('an import finds its account', () => {
  test('the account the source names: it joins, and the entry takes the labels it lacked', () => {
    entry('gmail.email', ADDRESS);
    expect(resolveImportAccount('gmail.email', GMAIL, { env })).toEqual({ match: 'same', account: { sourceId: 'gmail.email', slot: '1' } });
    expect(hashOf('gmail.email')).toBe(GMAIL);
  });

  test('another account: it stays apart and changes nothing', () => {
    entry('gmail.email', GMAIL);
    const before = registryText();
    expect(resolveImportAccount('gmail.email', composeProviderAccountId([OTHER_SUB])!, { env })).toEqual({ match: 'different' });
    expect(registryText()).toBe(before);
  });

  test('no entry: one is made, naming the import\'s account, and the next import of that account joins it', () => {
    expect(resolveImportAccount('telegram.messages', 'telegram:0123456789abcdef', { env }))
      .toEqual({ match: 'new', account: { sourceId: 'telegram.messages', slot: '1' } });
    const made = readSourceRegistry(env).accounts.find((account) => account.source_id === 'telegram.messages');
    expect(made).toMatchObject({ state: 'active', layout: 'folder', corpus_ids: [], provider_account_hash: 'telegram:0123456789abcdef' });
    expect(resolveImportAccount('telegram.messages', 'telegram:0123456789abcdef', { env }).match).toBe('same');
    expect(resolveImportAccount('telegram.messages', 'telegram:fedcba9876543210', { env }).match).toBe('different');
  });

  test('no entry and no id: one is made that names no account', () => {
    expect(resolveImportAccount('whatsapp.personal.messages', undefined, { env }).match).toBe('new');
    expect(readSourceRegistry(env).accounts).toMatchObject([{ source_id: 'whatsapp.personal.messages' }]);
    expect(hashOf('whatsapp.personal.messages')).toBeUndefined();
  });

  test('an entry that names no account waits for the owner, then takes the import\'s', () => {
    entry('telegram.messages');
    const before = registryText();
    expect(resolveImportAccount('telegram.messages', 'telegram:0123456789abcdef', { env }))
      .toEqual({ match: 'unproven', account: { sourceId: 'telegram.messages', slot: '1' } });
    expect(registryText()).toBe(before);
    expect(resolveImportAccount('telegram.messages', 'telegram:0123456789abcdef', { env, ownerConfirmed: true }).match).toBe('same');
    expect(hashOf('telegram.messages')).toBe('telegram:0123456789abcdef');
  });

  test('ids that cannot decide wait for the owner, and a confirmation writes nothing it cannot prove', () => {
    entry('gmail.email', GMAIL);
    // A mailbox export names its address; the live account is known by its subject.
    expect(resolveImportAccount('gmail.email', ADDRESS, { env }).match).toBe('unproven');
    expect(resolveImportAccount('gmail.email', ADDRESS, { env, ownerConfirmed: true }).match).toBe('same');
    expect(hashOf('gmail.email')).toBe(GMAIL);
    // An archive with no id at all, the same way.
    expect(resolveImportAccount('gmail.email', undefined, { env }).match).toBe('unproven');
    expect(resolveImportAccount('gmail.email', undefined, { env, ownerConfirmed: true }).match).toBe('same');
  });

  test('an account being deleted takes no import', () => {
    entry('telegram.messages', 'telegram:0123456789abcdef', 'deleting');
    expect(() => resolveImportAccount('telegram.messages', 'telegram:0123456789abcdef', { env })).toThrow(SourceStorageUnavailableError);
  });
});
