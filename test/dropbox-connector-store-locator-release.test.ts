import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { buildSourceSensitivity, type SourceFamily } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreFilterCapabilityRegistry,
  type ConnectorStoreResultProjectionInput,
  type ConnectorStoreResultProjectorCodec,
} from '../src/workers/connector-store/index.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_FILES_CORPUS_ID,
} from '../src/workers/dropbox-files/index.ts';
import { DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC } from '../src/workers/dropbox-files/locator-result-projector.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const DEFAULT_FIXTURE: FixtureSpec = {
  id: 'locator-file',
  locatorUri: '/2 Areas/Locator File.txt',
  text: 'locator release fixture',
};

describe('Dropbox connector-store locator release', () => {
  test('declared Dropbox include_locators=true releases the exact legacy web locator shape', async () => {
    await withLocatorEnvironment(() => withDropboxStore(async (store) => {
      const worker = dropboxWorker(store);
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpus_id: DROPBOX_FILES_CORPUS_ID,
          query: 'locator release fixture',
          include_locators: true,
        }),
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.hits[0].locator).toEqual({
        display_path: '/2 Areas/Locator File.txt',
        parent_display_path: '/2 Areas',
        dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Locator%20File.txt',
        parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
      });
      expect(body.audit.locators_requested).toBe(true);
      expect(body.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
    }));
  });

  test('declares include_locators=false as accepted without releasing locator data or flags', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(store);
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpus_id: DROPBOX_FILES_CORPUS_ID,
          query: 'locator release fixture',
          include_locators: false,
        }),
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0]).not.toHaveProperty('locator');
      expect(body.audit).not.toHaveProperty('locators_requested');
      expect(body.policy).not.toHaveProperty('locators_exposed');
      expect(body.policy).not.toHaveProperty('locator_release');
    });
  });

  test('omission is locator-free and true without releasable rows reports intent without exposure', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(store);
      const omitted = await workerSearch(worker, { query: 'locator release fixture' });
      expect(omitted.status).toBe(200);
      expect(omitted.body.hits[0]).not.toHaveProperty('locator');
      expect(omitted.body.audit).not.toHaveProperty('locators_requested');
      expect(omitted.body.policy).not.toHaveProperty('locators_exposed');

      const zeroResults = await workerSearch(worker, {
        query: 'no matching result',
        include_locators: true,
      });
      expect(zeroResults.status).toBe(200);
      expect(zeroResults.body.hits).toEqual([]);
      expect(zeroResults.body.audit.locators_requested).toBe(true);
      expect(zeroResults.body.policy).not.toHaveProperty('locators_exposed');
      expect(zeroResults.body.policy).not.toHaveProperty('locator_release');

      const missingLocator = await workerSearch(worker, {
        query: 'missing path fixture',
        include_locators: true,
      });
      expect(missingLocator.status).toBe(200);
      expect(missingLocator.body.hits).toHaveLength(1);
      expect(missingLocator.body.hits[0]).not.toHaveProperty('locator');
      expect(missingLocator.body.audit.locators_requested).toBe(true);
      expect(missingLocator.body.policy).not.toHaveProperty('locators_exposed');
      expect(missingLocator.body.policy).not.toHaveProperty('locator_release');
    }, [
      DEFAULT_FIXTURE,
      { id: 'missing-path', text: 'missing path fixture' },
    ]);
  });

  test('refuses non-Dropbox locator values and safely maps traversal, Unicode, and spaces', async () => {
    const cases = [
      { id: 'root', locatorUri: '/', expected: undefined },
      { id: 'blank', locatorUri: '   ', expected: undefined },
      { id: 'url', locatorUri: 'https://example.test/private', expected: undefined },
      { id: 'relative', locatorUri: '2 Areas/private.txt', expected: undefined },
      {
        id: 'trimmed',
        locatorUri: '  /2 Areas/Trim Me.txt  ',
        expected: {
          display_path: '/2 Areas/Trim Me.txt',
          parent_display_path: '/2 Areas',
          dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Trim%20Me.txt',
          parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
        },
      },
      {
        id: 'traversal',
        locatorUri: '/2 Areas/./Unsafe/../Safe File.txt',
        expected: {
          display_path: '/2 Areas/./Unsafe/../Safe File.txt',
          parent_display_path: '/2 Areas/Unsafe',
          dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Unsafe/Safe%20File.txt',
          parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Unsafe',
        },
      },
      {
        id: 'unicode',
        locatorUri: '/2 Areas/Crème brûlée/Ångström note.txt',
        expected: {
          display_path: '/2 Areas/Crème brûlée/Ångström note.txt',
          parent_display_path: '/2 Areas/Crème brûlée',
          dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Cr%C3%A8me%20br%C3%BBl%C3%A9e/%C3%85ngstr%C3%B6m%20note.txt',
          parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Cr%C3%A8me%20br%C3%BBl%C3%A9e',
        },
      },
    ] as const;
    await withLocatorEnvironment(() => withDropboxStore(async (store) => {
      const worker = dropboxWorker(store);
      for (const item of cases) {
        const result = await workerSearch(worker, {
          query: `edge ${item.id}`,
          include_locators: true,
        });
        expect({ id: item.id, status: result.status }).toEqual({ id: item.id, status: 200 });
        if (item.expected === undefined) {
          expect(result.body.hits[0]).not.toHaveProperty('locator');
          expect(result.body.policy).not.toHaveProperty('locators_exposed');
        } else {
          expect(result.body.hits[0].locator).toEqual(item.expected);
          expect(result.body.policy.locators_exposed).toBe(true);
        }
      }
    }, cases.map((item) => ({
      id: item.id,
      locatorUri: item.locatorUri,
      text: `edge ${item.id}`,
    }))));
  });

  test('adds Finder fields only for a strict account/scope root match and never falls back to the first root', async () => {
    await withLocatorEnvironment(async () => {
      process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON = JSON.stringify([
        {
          rootPath: '/mismatch-first',
          account: 'work',
          approvedScopeKey: 'dropbox.work:/2 Areas',
          dropboxPathPrefix: '/2 Areas',
        },
        {
          rootPath: '/matched-root',
          account: 'personal',
          approvedScopeKey: 'dropbox.personal:/2 Areas',
          dropboxPathPrefix: '/2 Areas',
        },
      ]);
      await withDropboxStore(async (store) => {
        const worker = dropboxWorker(store);
        const matched = await workerSearch(worker, {
          query: 'locator release fixture',
          account: 'personal',
          approved_scope_key: 'dropbox.personal:/2 Areas',
          authored_after: '2026-07-31T00:00:00Z',
          authored_before: '2026-07-31T23:59:59Z',
          trust_domain: 'secure_local',
          include_locators: true,
        });
        expect(matched.status).toBe(200);
        expect(matched.body.hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['locator-file']);
        expect(matched.body.hits[0].locator).toEqual({
          display_path: '/2 Areas/Locator File.txt',
          parent_display_path: '/2 Areas',
          dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Locator%20File.txt',
          parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
          finder_url: 'file:///matched-root/Locator%20File.txt',
          parent_finder_url: 'file:///matched-root',
        });

        const traversal = await workerSearch(worker, {
          query: 'local traversal fixture',
          account: 'personal',
          approved_scope_key: 'dropbox.personal:/2 Areas',
          include_locators: true,
        });
        expect(traversal.body.hits[0].locator.finder_url).toBe(
          'file:///matched-root/Unsafe/Safe%20File.txt',
        );
        expect(traversal.body.hits[0].locator.finder_url).not.toContain('..');

        const unscoped = await workerSearch(worker, {
          query: 'locator release fixture',
          account: 'personal',
          include_locators: true,
        });
        expect(unscoped.status).toBe(200);
        expect(unscoped.body.hits[0].locator).not.toHaveProperty('finder_url');
        expect(unscoped.body.hits[0].locator).not.toHaveProperty('parent_finder_url');
        expect(JSON.stringify(unscoped.body)).not.toContain('mismatch-first');

        process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON = JSON.stringify([{
          rootPath: '/still-mismatched',
          account: 'work',
          approvedScopeKey: 'dropbox.work:/2 Areas',
          dropboxPathPrefix: '/2 Areas',
        }]);
        const fullyScopedMismatch = await workerSearch(worker, {
          query: 'locator release fixture',
          account: 'personal',
          approved_scope_key: 'dropbox.personal:/2 Areas',
          include_locators: true,
        });
        expect(fullyScopedMismatch.status).toBe(200);
        expect(fullyScopedMismatch.body.hits[0].locator).not.toHaveProperty('finder_url');
        expect(JSON.stringify(fullyScopedMismatch.body)).not.toContain('still-mismatched');
      }, [
        DEFAULT_FIXTURE,
        {
          id: 'out-of-date',
          locatorUri: '/2 Areas/Old.txt',
          text: 'locator release fixture',
          authoredAt: '2026-07-30T10:00:00.000Z',
        },
        {
          id: 'out-of-scope-date',
          locatorUri: '/1 Projects/Other.txt',
          text: 'locator release fixture',
          authoredAt: '2026-07-31T10:00:00.000Z',
        },
        {
          id: 'local-traversal',
          locatorUri: '/2 Areas//./Unsafe/../Safe File.txt',
          text: 'local traversal fixture',
        },
      ]);
    });
  });

  test('projects only final in-scope live hits after retrieval', async () => {
    const projectedIds: string[] = [];
    const spyCodec: ConnectorStoreResultProjectorCodec = Object.freeze({
      create: () => ({
        project(input: ConnectorStoreResultProjectionInput) {
          projectedIds.push(input.sourceItem.providerItemId);
          input.readLocatorUri();
          return undefined;
        },
      }),
    });
    await withDropboxStore(async (store) => {
      await store.syncFromConnector(dropboxFixtureConnector([
        { id: 'tombstoned', locatorUri: '/2 Areas/Tombstoned.txt', text: 'eligibility fixture', deleted: true },
      ]));
      const worker = createEmailSourceWorker({
        connectorStores: [store],
        connectorStorePrincipals: new Map([
          [DROPBOX_FILES_CORPUS_ID, { provider: 'dropbox', accountScope: 'personal' }],
        ]),
        connectorStoreFilterCapabilities: connectorStoreFilterCapabilityRegistry([
          [{ family: 'file', provider: 'dropbox' }, {
            approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
            resultProjector: spyCodec,
          }],
        ]),
      });
      const result = await workerSearch(worker, {
        query: 'eligibility fixture',
        approved_scope_key: 'dropbox.personal:/2 Areas',
        include_locators: true,
      });
      expect(result.status).toBe(200);
      expect(result.body.hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['in-scope']);
      expect(projectedIds).toEqual(['in-scope']);
    }, [
      { id: 'in-scope', locatorUri: '/2 Areas/In Scope.txt', text: 'eligibility fixture' },
      { id: 'out-of-scope', locatorUri: '/1 Projects/Out.txt', text: 'eligibility fixture' },
      { id: 'other-provider', provider: 'google_drive', locatorUri: '/2 Areas/Drive.txt', text: 'eligibility fixture' },
    ]);
  });

  test('rechecks the request scope when a matched row moves outside it before lazy locator lookup', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        movingDropboxProjector(store, '/Outside/After.txt'),
      );
      const result = await workerSearch(worker, {
        query: 'scope move fixture',
        approved_scope_key: 'dropbox.personal:/Approved',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits).toHaveLength(1);
      expect(result.body.hits[0]).not.toHaveProperty('locator');
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).not.toHaveProperty('locators_exposed');
      expect(result.body.policy).not.toHaveProperty('locator_release');
      expect(JSON.stringify(result.body)).not.toContain('/Outside/After.txt');
    }, [{
      id: 'scope-move',
      locatorUri: '/Approved/Before.txt',
      text: 'scope move fixture',
    }]);
  });

  test('keeps surviving locators and truthful exposure when only some matched rows leave scope', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        mutatingDropboxProjector(store, (candidate) => (
          candidate.sourceItem.providerItemId === 'partial-moved'
            ? '/Outside/After.txt'
            : undefined
        )),
      );
      const result = await workerSearch(worker, {
        query: 'partial suppression fixture',
        approved_scope_key: 'dropbox.personal:/Approved',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits).toHaveLength(2);
      const hitsById = new Map<string, Record<string, any>>(result.body.hits.map((hit: any) => [
        hit.sourceItem.providerItemId,
        hit,
      ]));
      expect(hitsById.get('partial-survivor')?.locator).toMatchObject({
        display_path: '/Approved/Survivor.txt',
      });
      expect(hitsById.get('partial-moved')).not.toHaveProperty('locator');
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
      expect(JSON.stringify(result.body)).not.toContain('/Outside/After.txt');
    }, [
      {
        id: 'partial-survivor',
        locatorUri: '/Approved/Survivor.txt',
        text: 'partial suppression fixture',
      },
      {
        id: 'partial-moved',
        locatorUri: '/Approved/Moved.txt',
        text: 'partial suppression fixture',
      },
    ]);
  });

  test('reports locator intent without exposure when every matched row leaves scope', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        mutatingDropboxProjector(
          store,
          (candidate) => `/Outside/${candidate.sourceItem.providerItemId}.txt`,
        ),
      );
      const result = await workerSearch(worker, {
        query: 'all suppression fixture',
        approved_scope_key: 'dropbox.personal:/Approved',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits).toHaveLength(2);
      for (const hit of result.body.hits) expect(hit).not.toHaveProperty('locator');
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).not.toHaveProperty('locators_exposed');
      expect(result.body.policy).not.toHaveProperty('locator_release');
      expect(JSON.stringify(result.body)).not.toContain('/Outside/');
    }, [
      {
        id: 'all-moved-one',
        locatorUri: '/Approved/One.txt',
        text: 'all suppression fixture',
      },
      {
        id: 'all-moved-two',
        locatorUri: '/Approved/Two.txt',
        text: 'all suppression fixture',
      },
    ]);
  });

  test('does not treat a sibling-prefix move as remaining inside the request scope', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        movingDropboxProjector(store, '/ApprovedX/After.txt'),
      );
      const result = await workerSearch(worker, {
        query: 'sibling prefix move fixture',
        approved_scope_key: 'dropbox.personal:/Approved',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits[0]).not.toHaveProperty('locator');
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).not.toHaveProperty('locators_exposed');
      expect(result.body.policy).not.toHaveProperty('locator_release');
      expect(JSON.stringify(result.body)).not.toContain('/ApprovedX/After.txt');
    }, [{
      id: 'sibling-prefix-move',
      locatorUri: '/Approved/Before.txt',
      text: 'sibling prefix move fixture',
    }]);
  });

  test('suppresses a locator mutated to NULL or HTTPS during the release recheck', async () => {
    for (const mutation of [null, 'https://example.test/private'] as const) {
      await withDropboxStore(async (store) => {
        const worker = dropboxWorker(
          store,
          undefined,
          mutatingDropboxProjector(store, () => mutation),
        );
        const result = await workerSearch(worker, {
          query: 'invalid locator mutation fixture',
          approved_scope_key: 'dropbox.personal:/Approved',
          include_locators: true,
        });

        expect({ mutation, status: result.status }).toEqual({ mutation, status: 200 });
        expect(result.body.hits[0]).not.toHaveProperty('locator');
        expect(result.body.audit.locators_requested).toBe(true);
        expect(result.body.policy).not.toHaveProperty('locators_exposed');
        expect(result.body.policy).not.toHaveProperty('locator_release');
        expect(JSON.stringify(result.body)).not.toContain('example.test');
      }, [{
        id: mutation === null ? 'null-mutation' : 'url-mutation',
        locatorUri: '/Approved/Before.txt',
        text: 'invalid locator mutation fixture',
      }]);
    }
  });

  test('rechecks non-ASCII scope matching with symmetric SQLite casefolding', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        movingDropboxProjector(store, '/Ångström/After.txt'),
      );
      const result = await workerSearch(worker, {
        query: 'non ascii recheck fixture',
        approved_scope_key: 'dropbox.personal:/ÅNGSTRöM',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits[0].locator).toMatchObject({
        display_path: '/Ångström/After.txt',
        parent_display_path: '/Ångström',
      });
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
    }, [{
      id: 'non-ascii-recheck',
      locatorUri: '/ÅNGSTRöM/Before.txt',
      text: 'non ascii recheck fixture',
    }]);
  });

  test('releases the current path when a matched row moves within the request scope', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        movingDropboxProjector(store, '/Approved/After.txt'),
      );
      const result = await workerSearch(worker, {
        query: 'within scope move fixture',
        approved_scope_key: 'dropbox.personal:/Approved',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits[0].locator).toMatchObject({
        display_path: '/Approved/After.txt',
        parent_display_path: '/Approved',
      });
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
    }, [{
      id: 'within-scope-move',
      locatorUri: '/Approved/Before.txt',
      text: 'within scope move fixture',
    }]);
  });

  test('does not invent a scope when an unscoped matched row moves before lazy locator lookup', async () => {
    await withDropboxStore(async (store) => {
      const worker = dropboxWorker(
        store,
        undefined,
        movingDropboxProjector(store, '/Outside/After.txt'),
      );
      const result = await workerSearch(worker, {
        query: 'unscoped move fixture',
        include_locators: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.hits[0].locator).toMatchObject({
        display_path: '/Outside/After.txt',
        parent_display_path: '/Outside',
      });
      expect(result.body.audit.locators_requested).toBe(true);
      expect(result.body.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
    }, [{
      id: 'unscoped-move',
      locatorUri: '/Approved/Before.txt',
      text: 'unscoped move fixture',
    }]);
  });

  test('keyword and hybrid retrieval release identical locator shapes', async () => {
    await withDropboxStore(async (store) => {
      const provider = fakeEmbeddingProvider();
      await store.embedChunks({ provider });
      const worker = dropboxWorker(store, provider);
      const keyword = await workerSearch(worker, {
        query: 'locator release fixture',
        retrieval_mode: 'keyword',
        include_locators: true,
      });
      const hybrid = await workerSearch(worker, {
        query: 'locator release fixture',
        retrieval_mode: 'hybrid',
        include_locators: true,
      });
      expect(keyword.status).toBe(200);
      expect(hybrid.status).toBe(200);
      expect(hybrid.body.hits[0].locator).toEqual(keyword.body.hits[0].locator);
      expect(hybrid.body.policy).toMatchObject(keyword.body.policy);
    });
  });

  test('the real client accepts a zero-result locator request as truthful non-release', async () => {
    await withDropboxStore(async (store) => {
      const client = realClient(dropboxWorker(store));
      const result = await client.sourceIndexSearch({
        corpusId: DROPBOX_FILES_CORPUS_ID,
        query: 'no matching result',
        includeLocators: true,
      });

      expect(result.hits).toEqual([]);
      expect(result.audit.locators_requested).toBe(true);
      expect(result.policy).not.toHaveProperty('locators_exposed');
      expect(result.policy).not.toHaveProperty('locator_release');
    });
  });

  test('the real client accepts hybrid locator release through the worker envelope', async () => {
    await withDropboxStore(async (store) => {
      const provider = fakeEmbeddingProvider();
      await store.embedChunks({ provider });
      const client = realClient(dropboxWorker(store, provider));
      const result = await client.sourceIndexSearch({
        corpusId: DROPBOX_FILES_CORPUS_ID,
        query: 'locator release fixture',
        retrievalMode: 'hybrid',
        includeLocators: true,
      });

      expect((result.hits[0] as Record<string, any> | undefined)?.locator).toEqual({
        display_path: '/2 Areas/Locator File.txt',
        parent_display_path: '/2 Areas',
        dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/Locator%20File.txt',
        parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
      });
      expect(result.audit.locators_requested).toBe(true);
      expect(result.policy).toMatchObject({
        locators_exposed: true,
        locator_release: 'explicit_request',
      });
    });
  });

  test('every other built-in family/provider keeps include_locators as typed unsupported_filter and X stays locator-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-locator-family-matrix-'));
    const specs: Array<{ family: SourceFamily; provider: string; corpusId: string }> = [
      { family: 'email', provider: 'gmail', corpusId: 'internal.fixture.gmail' },
      { family: 'file', provider: 'google_drive', corpusId: 'internal.fixture.drive' },
      { family: 'chat', provider: 'telegram', corpusId: 'internal.fixture.telegram' },
      { family: 'chat', provider: 'whatsapp', corpusId: 'internal.fixture.whatsapp' },
      { family: 'calendar', provider: 'google_calendar', corpusId: 'internal.fixture.calendar' },
      { family: 'note', provider: 'reflect', corpusId: 'internal.fixture.note' },
      { family: 'task', provider: 'linear', corpusId: 'internal.fixture.task' },
      { family: 'readwise', provider: 'readwise', corpusId: 'internal.fixture.readwise' },
      { family: 'x', provider: 'x', corpusId: 'internal.fixture.x' },
    ];
    const stores = specs.map((spec) => new LocalConnectorStore({
      dbPath: join(dir, `${spec.provider}.sqlite`),
      corpusId: spec.corpusId,
      family: spec.family,
      trustDomain: 'internal',
    }));
    try {
      const xSpec = specs.at(-1)!;
      await stores.at(-1)!.syncFromConnector(dropboxFixtureConnector([{
        id: 'x-url',
        family: 'x',
        provider: xSpec.provider,
        accountScope: 'personal',
        locatorUri: 'https://x.com/example/status/123',
        text: 'x locator suppression fixture',
      }]), { fetchContent: true });
      const worker = createEmailSourceWorker({
        connectorStores: stores,
        connectorStorePrincipals: new Map(specs.map((spec) => [spec.corpusId, {
          provider: spec.provider,
          accountScope: 'personal',
        }])),
      });
      for (const spec of specs) {
        for (const includeLocators of [false, true]) {
          const result = await workerSearch(worker, {
            corpus_id: spec.corpusId,
            query: 'family locator fixture',
            include_locators: includeLocators,
          });
          expect({ corpusId: spec.corpusId, includeLocators, status: result.status }).toEqual({
            corpusId: spec.corpusId,
            includeLocators,
            status: 400,
          });
          expect(result.body.error.code).toBe('unsupported_filter');
        }
      }
      const xResult = await workerSearch(worker, {
        corpus_id: xSpec.corpusId,
        query: 'x locator suppression fixture',
      });
      expect(xResult.status).toBe(200);
      expect(JSON.stringify(xResult.body)).not.toContain('https://x.com/example/status/123');
      expect(xResult.body.policy).not.toHaveProperty('locators_exposed');
    } finally {
      for (const store of stores) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function dropboxWorker(
  store: LocalConnectorStore,
  embeddingProvider?: SourceEmbeddingProvider,
  resultProjector?: ConnectorStoreResultProjectorCodec,
) {
  return createEmailSourceWorker({
    connectorStores: [store],
    ...(embeddingProvider
      ? { connectorStoreEmbeddingProviders: new Map([[DROPBOX_FILES_CORPUS_ID, embeddingProvider]]) }
      : {}),
    connectorStorePrincipals: new Map([
      [DROPBOX_FILES_CORPUS_ID, { provider: 'dropbox', accountScope: 'personal' }],
    ]),
    ...(resultProjector
      ? {
          connectorStoreFilterCapabilities: connectorStoreFilterCapabilityRegistry([
            [{ family: 'file', provider: 'dropbox' }, {
              approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
              resultProjector,
            }],
          ]),
        }
      : {}),
  });
}

function realClient(worker: ReturnType<typeof createEmailSourceWorker>): EmailClient {
  const config = defaultConfig();
  config.email.enabled = true;
  config.sourceIndex.enabled = true;
  return new EmailClient(
    config,
    new DirectHttpEmailTransport((url, init) => worker.fetch(new Request(url, init))),
  );
}

function movingDropboxProjector(
  store: LocalConnectorStore,
  destinationPath: string,
): ConnectorStoreResultProjectorCodec {
  return mutatingDropboxProjector(store, () => destinationPath);
}

function mutatingDropboxProjector(
  store: LocalConnectorStore,
  mutation: (candidate: ConnectorStoreResultProjectionInput) => string | null | undefined,
): ConnectorStoreResultProjectorCodec {
  return Object.freeze({
    create(input: Parameters<ConnectorStoreResultProjectorCodec['create']>[0]) {
      const delegate = DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC.create(input);
      const mutated = new Set<string>();
      return Object.freeze({
        project(candidate: ConnectorStoreResultProjectionInput) {
          const destinationPath = mutation(candidate);
          if (destinationPath !== undefined && !mutated.has(candidate.sourceItem.localItemId)) {
            const secondConnection = new Database(store.dbPath, { strict: true });
            try {
              secondConnection.exec('PRAGMA busy_timeout = 10000;');
              const updatedRows = secondConnection.query(`
                UPDATE items
                SET locator_uri = ?
                WHERE family = ?
                  AND provider = ?
                  AND account_scope = ?
                  AND provider_item_id = ?
                  AND local_item_id = ?
                RETURNING item_pk
              `).all(
                destinationPath,
                candidate.sourceItem.family,
                candidate.sourceItem.provider,
                candidate.sourceItem.accountScope,
                candidate.sourceItem.providerItemId,
                candidate.sourceItem.localItemId,
              );
              if (updatedRows.length !== 1) {
                throw new Error(`expected one locator fixture row to move, changed ${updatedRows.length}`);
              }
              mutated.add(candidate.sourceItem.localItemId);
            } finally {
              secondConnection.close();
            }
          }
          return delegate.project(candidate);
        },
      });
    },
  });
}

async function workerSearch(
  worker: ReturnType<typeof createEmailSourceWorker>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corpus_id: DROPBOX_FILES_CORPUS_ID, ...body }),
  }));
  return { status: response.status, body: await response.json() };
}

async function withLocatorEnvironment(run: () => Promise<void>): Promise<void> {
  const names = [
    'OLYMPUS_SOURCE_INDEX_DROPBOX_LOCATOR_LOCAL_ROOT',
    'DROPBOX_LOCAL_ROOT',
    'OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON',
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    await run();
  } finally {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'locator-release-fixture',
    modelId: 'locator-release-fixture-v1',
    dimension: 2,
    configHash: 'locator-release-fixture-config',
    epochId: 'locator-release-fixture-epoch',
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      return inputs.map(() => [1, 0]);
    },
  };
}

interface FixtureSpec {
  id: string;
  family?: SourceFamily;
  locatorUri?: string;
  text?: string;
  provider?: string;
  accountScope?: string;
  deleted?: boolean;
  authoredAt?: string;
}

async function withDropboxStore(
  run: (store: LocalConnectorStore) => Promise<void>,
  items: readonly FixtureSpec[] = [DEFAULT_FIXTURE],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dropbox-locator-release-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'dropbox.sqlite'),
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await store.syncFromConnector(dropboxFixtureConnector(items), { fetchContent: true });
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function dropboxFixtureConnector(specs: readonly FixtureSpec[]): SourceConnector {
  const items: RawItem[] = specs.map((spec) => {
    const family = spec.family ?? 'file';
    const provider = spec.provider ?? 'dropbox';
    const accountScope = spec.accountScope ?? 'personal';
    const authoredAt = spec.authoredAt ?? '2026-07-31T10:00:00.000Z';
    return {
      identity: {
        family,
        provider,
        accountScope,
        providerItemId: spec.id,
        providerFileId: spec.id,
        localItemId: `${accountScope}:${spec.id}`,
        sourceVersion: `${spec.id}:v1`,
      },
      mimeType: 'text/plain; charset=utf-8',
      content: { kind: 'text', text: spec.text ?? `locator release ${spec.id}` },
      metadata: {
        title: spec.id,
        authoredAt,
        updatedAt: authoredAt,
        deleted: spec.deleted === true,
        ...(spec.locatorUri !== undefined
          ? { locatorUri: spec.locatorUri, pathDisplay: spec.locatorUri }
          : {}),
      },
      fetchedAt: authoredAt,
    };
  });
  const byId = new Map(items.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'dropbox-locator-release-fixture',
    family: specs[0]?.family ?? 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing Dropbox locator fixture ${localItemId}`);
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}
