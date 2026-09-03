import { describe, expect, test } from 'bun:test';
import { resolveConnectorStoreOptions } from '../scripts/connector-store-embed.ts';

describe('connector-store:embed corpus identity resolution', () => {
  test('accepts a built-in family and trust domain from explicit flags', () => {
    expect(resolveConnectorStoreOptions({
      db: '/tmp/olympus-embed.sqlite',
      corpusId: 'dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
    }, {})).toEqual({
      dbPath: '/tmp/olympus-embed.sqlite',
      corpusId: 'dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
  });

  test('accepts an x- extension id in either slot', () => {
    expect(resolveConnectorStoreOptions({
      db: '/tmp/olympus-embed.sqlite',
      corpusId: 'ext.corpus',
      family: 'x-vendor',
      trustDomain: 'x-vendor-band',
    }, {})).toEqual({
      dbPath: '/tmp/olympus-embed.sqlite',
      corpusId: 'ext.corpus',
      family: 'x-vendor',
      trustDomain: 'x-vendor-band',
    });
  });

  test('refuses an unknown family passed as an explicit flag', () => {
    expect(() => resolveConnectorStoreOptions({
      db: '/tmp/olympus-embed.sqlite',
      corpusId: 'dropbox.files',
      family: 'files',
      trustDomain: 'secure_local',
    }, {})).toThrow(/family must be one of/);
  });

  test('refuses a typo\'d trust domain that would leave the secure band silently', () => {
    expect(() => resolveConnectorStoreOptions({
      db: '/tmp/olympus-embed.sqlite',
      corpusId: 'dropbox.files',
      family: 'file',
      trustDomain: 'secure-local',
    }, {})).toThrow(/trustDomain must be one of/);
  });

  test('refuses a bogus family declared in the connector stores env JSON', () => {
    expect(() => resolveConnectorStoreOptions({ db: '/tmp/olympus-embed.sqlite' }, {
      OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([
        {
          dbPath: '/tmp/olympus-embed.sqlite',
          corpusId: 'dropbox.files',
          family: 'flie',
          trustDomain: 'secure_local',
        },
      ]),
    })).toThrow(/family must be one of/);
  });

  test('refuses a bogus trust domain declared in the connector stores env JSON', () => {
    expect(() => resolveConnectorStoreOptions({ db: '/tmp/olympus-embed.sqlite' }, {
      OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([
        {
          dbPath: '/tmp/olympus-embed.sqlite',
          corpusId: 'dropbox.files',
          family: 'file',
          trustDomain: 'secure-local',
        },
      ]),
    })).toThrow(/trustDomain must be one of/);
  });

  test('resolves a well-formed connector stores env JSON entry', () => {
    expect(resolveConnectorStoreOptions({ db: '/tmp/olympus-embed.sqlite' }, {
      OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([
        {
          dbPath: '/tmp/olympus-other.sqlite',
          corpusId: 'other.files',
          family: 'file',
          trustDomain: 'internal',
        },
        {
          dbPath: '/tmp/olympus-embed.sqlite',
          corpusId: 'dropbox.files',
          family: 'file',
          trustDomain: 'secure_local',
        },
      ]),
    })).toEqual({
      dbPath: '/tmp/olympus-embed.sqlite',
      corpusId: 'dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
  });
});
