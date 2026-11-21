import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitsSearchName, evaluate, mountedStoreFacts, type AdmissionContext } from '../src/core/admission.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { listFileScopeSources } from '../src/core/file-scope-sources.ts';
import { defaultMailScopeSelection, MAIL_SOURCE_SCOPE_CAPABILITY } from '../src/core/mail-source-scope.ts';
import { mountedStoreSources } from '../src/core/olympus-layout.ts';
import { createSourceCorpusRegistry, type SourceCorpusConfig } from '../src/core/source-corpus-registry.ts';
import { connectThisComputerSource, disconnectThisComputerSource, readThisComputerHandles } from '../src/core/this-computer.ts';
import { withArchiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { writeConnectedHandleRegistry, type ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';
import { readGmailRetainedAccountScope } from '../src/workers/email-source/gmail-status-scope.ts';
import { compareAdmissionScopes, type AdmissionDisagreement } from '../src/workers/engine/runtime/admission-shadow.ts';
import { corpusAdmissions, sourceAdmissionDefinitions } from '../src/core/source-admission-definitions.ts';
import { createStoreEmbeddingScopeFor, createStoreScopes, registeredStoreReadScope } from '../src/workers/engine/runtime/store-scope-policies.ts';
import {
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  gmailCursorConnectorId, gmailCursorConnectorIds,
} from '../src/workers/google-connectors/index.ts';
import { GMAIL_IMPORT_CONNECTOR_PREFIX } from '../src/workers/google-connectors/gmail-archive-target.ts';
import { SCHEDULER_SOURCE_IDS } from '../src/workers/source-scheduler.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';

import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { fileExtractionCorporaRoster } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import { archiveFileExtractionCorpora } from '../src/workers/archive-import/extraction-source.ts';
import { ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';
import { gmailAttachmentLanes } from '../src/workers/google-connectors/gmail-attachment-extraction.ts';
import { telegramMediaLanes } from '../src/workers/telegram-messages/media-extraction.ts';
import { INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID } from '../src/workers/telegram-messages/index.ts';
import { GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID } from '../src/workers/google-connectors/index.ts';
import { createEvernoteRuntime } from '../src/workers/evernote/runtime.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { defaultConfig } from '../src/core/config.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';

const corpusRoster = createSourceCorpusRegistry(withArchiveImportCorpora()).list();
// The private mount list's note corpora have no default registry rows.
const configuredMounts = mountedStoreSources().map((sourceId): SourceCorpusConfig => ({
  corpusId: `secure_local.${sourceId}`,
  sourceId,
  provider: sourceId.split('.')[0]!,
  family: 'note',
  trustDomain: 'secure_local',
  capabilities: ['answer', 'search', 'status'],
}));
const accountScope = 'personal';
const connectedAt = '2026-11-01T00:00:00.000Z';
const declarations = sourceAdmissionDefinitions();
const folderSources = listFileScopeSources();
const scratch: string[] = [];
const stores: LocalConnectorStore[] = [];

const registryEnv = 'OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH';
const originalRegistry = process.env[registryEnv];
afterEach(() => {
  if (originalRegistry === undefined) delete process.env[registryEnv];
  else process.env[registryEnv] = originalRegistry;
  for (const store of stores.splice(0)) store.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function open(corpus: SourceCorpusConfig, tierLedger: TierLedger | null = null): LocalConnectorStore {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: corpus.corpusId,
    family: corpus.family,
    trustDomain: corpus.trustDomain,
    tierLedger,
  });
  stores.push(store);
  return store;
}

// Same installed primary stores as fileExtractionCorpora() in server.ts. The
// separate child extractors have their own rosters, checked below.
const fileHomes = fileExtractionCorporaRoster({
  configured: [], dropbox: { extractionScopes: ['fixture'], resolveCredentialHandle: () => undefined },
  localFiles: { resolveExtractionScopes: () => [] }, whatsapp: true,
  googleDrive: { corpusIds: [GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID],
    resolveCredentialHandle: () => undefined, resolveAccountScope: () => accountScope },
});

function fixture(corpus: SourceCorpusConfig, store: LocalConnectorStore, destination?: 'device') {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-admission-parity-'));
  scratch.push(dir);
  const registryPath = join(dir, 'handles.json');
  const definition = folderSources.find(({ sourceId }) => sourceId === corpus.sourceId);
  const isMail = corpus.sourceId === MAIL_SOURCE_SCOPE_CAPABILITY.sourceId;
  const credentials = definition ?? (isMail ? MAIL_SOURCE_SCOPE_CAPABILITY : undefined);
  const handle: ConnectedCredentialHandle | undefined = credentials?.credentialCapability ? {
    provider: credentials.provider as ConnectedCredentialHandle['provider'],
    handle: `${credentials.provider}.fixture`,
    allowedCapabilities: [credentials.credentialCapability],
    scopes: [],
    accountRole: accountScope,
    providerAccountId: `owner-${credentials.provider}`,
    connectedAt,
  } : undefined;
  const historyOwner = handle?.providerAccountId;
  let ready = true;
  process.env[registryEnv] = registryPath;
  const writeHandle = (connected: boolean) =>
    writeConnectedHandleRegistry({ version: 1, handles: connected && handle ? [handle] : [] }, registryPath);
  writeHandle(true);
  if (definition?.account === 'this_computer') connectThisComputerSource(registryPath, definition.sourceId, new Date(connectedAt));
  const authority = new FileSourceScopeAuthority({ registryPath, statePath: join(dir, 'approval.json') });
  const logs: AdmissionDisagreement[] = [];
  const registration = declarations.find(d => d.sourceId === corpus.sourceId)!;
  const readScope = () => corpus.sourceId === SCHEDULER_SOURCE_IDS.localFiles && !ready
    ? { allowed: false as const } : registeredStoreReadScope(corpus.sourceId, authority);
  const input = {
    authority, sourceIdForStore: () => corpus.sourceId, readScope,
    gmailRetainedAccountScope: () => readGmailRetainedAccountScope({
      registryPath, historyAccountId: () => historyOwner, itemScope: () => accountScope,
    }),
  };
  const serving = createStoreScopes(input);
  const offlineScope = createStoreEmbeddingScopeFor(input);
  let connected = true;
  const provider: SourceEmbeddingProvider = {
    provider: 'built-in', backend: 'local', modelId: 'fixture', configHash: 'fixture', epochId: 'fixture', dimension: 1,
    runsOnThisComputer: () => destination === 'device', async embed() { throw new Error('scope setup must not embed'); },
  };
  return {
    logs, authority,
    approve(state: 'ingest' | 'metadata_only' = 'ingest') {
      if (definition) {
        const current = authority.snapshot(corpus.sourceId);
        const prefix = definition.filterFamily === 'locator_path' ? '/' : '';
        expect(authority.approve({
          sourceId: corpus.sourceId,
          accountGeneration: current.accountGeneration!,
          expectedRevision: current.revision,
          wholeAccount: false,
          explicitWholeAccountConfirmation: false,
          selections: [
            { key: `${prefix}selected`, state },
            { key: `${prefix}names`, state: 'metadata_only' },
            { key: `${prefix}skipped`, state: 'exclude' },
          ],
        }).status).toBe('approved');
      } else if (isMail) {
        const current = authority.mailSnapshot();
        expect(authority.approveMail({
          accountGeneration: current.accountGeneration!,
          expectedRevision: current.revision,
          scope: { ...defaultMailScopeSelection(), window: '2y' },
        }).status).toBe('approved');
      }
    },
    revoke() {
      connected = false;
      writeHandle(false);
      if (definition?.account === 'this_computer') disconnectThisComputerSource(registryPath, corpus.sourceId);
    },
    reconnect(ownerId?: string) {
      connected = true;
      if (!handle) throw new Error('fixture has no provider handle');
      if (ownerId !== undefined) handle.providerAccountId = ownerId;
      else delete handle.providerAccountId;
      handle.connectedAt = '2026-11-02T00:00:00.000Z';
      writeHandle(true);
    },
    blockRecovery() { ready = false; },
    statusScope: () => serving.statusScopeFor(store, provider),
    embeddingScope: () => serving.embeddingScopeFor(store, provider),
    run() {
      const search = readScope();
      const answer = search;
      const status = serving.statusScopeFor(store, provider);
      const embedding = serving.embeddingScopeFor(store, provider);
      const manual = offlineScope(store, provider);
      const approval = definition && authority.snapshot(corpus.sourceId);
      const computer = definition?.account === 'this_computer' ? readThisComputerHandles(registryPath)[0] : undefined;
      const owner = computer?.providerAccountId ?? historyOwner;
      const current = connected ? computer ?? handle : undefined;
      const readAuthority = {
        ownershipUnproven: isMail && connected && !handle?.providerAccountId,
        epoch: approval?.revision ?? '', approved: approval?.status === 'approved', owner: { id: current?.providerAccountId },
        ...(current?.accountRole ? { accountScope: current.accountRole } : {}),
        ...(approval?.accountGeneration ? { generation: approval.accountGeneration } : {}),
        ...(approval ? { selections: approval.selections, wholeAccount: approval.wholeAccount } : {}),
      };
      const mail = isMail ? authority.mailSnapshot() : undefined;
      const observed = mail?.status === 'approved' && mail.accountGeneration
        ? gmailCursorConnectorIds(accountScope, { generation: mail.accountGeneration, revision: mail.revision }) : undefined;
      const processingAuthority = mail ? {
        epoch: mail.revision, accountScope, approved: mail.status === 'approved',
        owner: { id: connected ? handle?.providerAccountId : owner },
        ownershipUnproven: connected && !handle?.providerAccountId,
        ...(observed ? { observedUnder: observed.connectorId, previousObservedUnder: observed.previousId } : {}),
        ...(mail.mailScope?.contentAfter ? { contentAfter: mail.mailScope.contentAfter } : {}),
      } : readAuthority;
      compareAdmissionScopes({
        corpus, definition: registration, ready, account: { id: owner }, readAuthority, processingAuthority,
        destination: destination ?? 'private_cloud', canEmbedHeld: store.canEmbedHeld(provider),
        read: search, scheduled: embedding, manual, status,
        ...(fileHomes.some(home => home.corpusId === corpus.corpusId) ? { extractionRead: search } : {}),
      }, event => logs.push(event));
      return { search, answer, status, embedding, manual };
    },
  };
}

const roster = [...corpusRoster, ...configuredMounts];
test('each registered corpus has exactly one definition with the same owner', () => {
  expect(declarations.flatMap(source => source.corpora.map(id => [id, source.sourceId])).sort())
    .toEqual(roster.map(c => [c.corpusId, c.sourceId]).sort());
  for (const source of folderSources) expect(declarations.some(d => d.sourceId === source.sourceId)).toBe(true);
});

import KNOWN_PARITY_GAPS_JSON from './fixtures/admission-parity-known-gaps.json';
const KNOWN_PARITY_GAPS = KNOWN_PARITY_GAPS_JSON as Record<string, string[]>;

for (const corpus of roster) {
  test(`${corpus.corpusId} agrees on read, scheduled and manual embedding, status and backlog`, () => {
    const f = fixture(corpus, open(corpus));
    const findings = [];
    for (const scenario of ['no approval', 'approved scope', 'revoked'] as const) {
      if (scenario === 'approved scope') f.approve();
      if (scenario === 'revoked') f.revoke();
      f.run();
      findings.push(...f.logs.splice(0).map(event => ({ scenario, ...event })));
    }
    // Older provider credentials may have a valid grant generation without
    // a durable owner. Keep any difference visible in the parity report.
    if (folderSources.some(source => source.sourceId === corpus.sourceId && source.account === 'provider_account')) {
      f.reconnect();
      f.approve();
      f.run();
      findings.push(...f.logs.map(event => ({ scenario: 'approved without a durable owner', ...event })));
    }
    const lines = findings.map(({ scenario, stage, layer, serving, shadow, reason, differingConstraints }) =>
      `${scenario} | ${stage}/${layer} | serving=${serving} shadow=${shadow} | ${reason} | ${differingConstraints.join(', ')}`);
    if (process.env.ADMISSION_PARITY_DUMP) {
      const { appendFileSync } = require('node:fs') as typeof import('node:fs');
      appendFileSync(process.env.ADMISSION_PARITY_DUMP, `${JSON.stringify([corpus.corpusId, lines])}\n`);
    }
    // Known disagreements are the remaining per-source decisions in serving
    // code (docs/design/source-definitions.md). The list only shrinks: a new
    // disagreement fails, and so does a fixed one still listed.
    expect(lines).toEqual(KNOWN_PARITY_GAPS[corpus.corpusId] ?? []);
  });
}

test('local file cleanup recovery fails closed under a saved scope', () => {
  const mount = corpusRoster.find((corpus) => corpus.sourceId === SCHEDULER_SOURCE_IDS.localFiles)!;
  const f = fixture(mount, open(mount));
  f.approve();
  expect(f.run().search.allowed).toBe(true);
  f.blockRecovery();
  expect(f.run()).toEqual({
    search: { allowed: false },
    answer: { allowed: false },
    status: { itemsAllowed: false, contentAllowed: false, embedding: { contentAllowed: false } },
    embedding: { allowed: false, skipQueue: true },
    manual: { allowed: false, skipQueue: true },
  });
  expect(f.logs).toEqual([]);
});

test('an approved notebook can allow names only and does not require the current revision stamp', () => {
  const mount = corpusRoster.find((corpus) => corpus.sourceId === SCHEDULER_SOURCE_IDS.evernote)!;
  const f = fixture(mount, open(mount));
  f.approve('metadata_only');
  expect(f.run().search).toEqual({
    allowed: true,
    accountScope,
    contentAllowed: false,
    filters: {
      provider: mount.provider,
      sourceScopeGeneration: f.authority.snapshot(mount.sourceId).accountGeneration!,
      sourceScopeFolderAnyKeys: ['names', 'selected'],
      sourceScopeFolderNoneKeys: ['skipped'],
      metadataOnlySourceScopeFolderKeys: ['names', 'selected'],
    },
  });
  expect(f.run().manual.allowed).toBe(false);
  expect(f.logs).toEqual([]);
});

function mailInput(corpus: SourceCorpusConfig, inputId: string, id: string): SourceConnector {
  const item: RawItem = {
    identity: { family: corpus.family, provider: corpus.provider, accountScope, providerItemId: id, localItemId: `${accountScope}:${id}` },
    mimeType: 'message/rfc822',
    content: { kind: 'text', text: 'Fixture message for scope parity' },
    metadata: { title: id },
    fetchedAt: connectedAt,
  };
  return {
    id: inputId,
    family: corpus.family,
    async authenticate() {},
    async *listItems() { yield { items: [item], done: true }; },
    async fetchItem() { return item; },
    classificationSignals() { return {}; },
  };
}

test('the Private mail scope includes observed live and owner-import mail under approval, then imports only after revocation', async () => {
  const mount = corpusRoster.find(({ corpusId }) => corpusId === GMAIL_SECURE_CONNECTOR_CORPUS_ID)!;
  const store = open(mount);
  const f = fixture(mount, store);
  f.approve();
  const ref = f.authority.mailPolicyRef()!;
  await store.syncFromConnector(mailInput(mount, gmailCursorConnectorId(accountScope, {
    generation: ref.accountGeneration,
    revision: ref.revision,
  }), 'live'), { fetchContent: true });
  await store.syncFromConnector(mailInput(mount, `${GMAIL_IMPORT_CONNECTOR_PREFIX}fixture`, 'imported'), { fetchContent: true });
  const admittedBy = () => {
    const scope = f.embeddingScope();
    if (!scope.allowed) throw new Error('expected a scope');
    const status = f.statusScope();
    return ['live', 'imported'].map((id) => [
      store.itemMatchesSearchFilters(`${accountScope}:${id}`, scope.accountScope, scope.filters),
      store.itemMatchesSearchFilters(`${accountScope}:${id}`, status?.accountScope, status?.contentFilters),
    ]);
  };
  f.run();
  expect(admittedBy()).toEqual([[true, true], [true, true]]);
  expect(f.logs).toEqual([]);
  f.revoke();
  f.logs.length = 0;
  f.run();
  expect(admittedBy()).toEqual([[false, false], [true, true]]);
  expect(f.logs).toEqual([]);
});

test('A3: retained live and imported mail are in both the on-device embedding scope and the status backlog', async () => {
  const mount = corpusRoster.find(({ corpusId }) => corpusId === GMAIL_SECURE_CONNECTOR_CORPUS_ID)!;
  const store = open(mount);
  const f = fixture(mount, store, 'device');
  f.approve();
  const ref = f.authority.mailPolicyRef()!;
  await store.syncFromConnector(mailInput(mount, gmailCursorConnectorId(accountScope, {
    generation: ref.accountGeneration,
    revision: ref.revision,
  }), 'retained'), { fetchContent: true });
  await store.syncFromConnector(mailInput(mount, `${GMAIL_IMPORT_CONNECTOR_PREFIX}fixture`, 'imported'), { fetchContent: true });
  f.revoke();
  const legacy = f.run();
  const backlog = legacy.status.embedding!;
  const scope = legacy.embedding;
  if (!scope.allowed) throw new Error('expected retained on-device embedding');
  expect(['retained', 'imported'].map(id => [
    store.itemMatchesSearchFilters(`${accountScope}:${id}`, scope.accountScope, scope.filters),
    store.itemMatchesSearchFilters(`${accountScope}:${id}`, backlog.accountScope, backlog.contentFilters),
  ])).toEqual([[true, true], [true, true]]);
  expect(f.logs).toEqual([]);
  f.reconnect(`owner-${mount.provider}`);
  expect(f.authority.mailPolicyRef()).toBeUndefined();
  expect(f.authority.mailSnapshot().accountGeneration).not.toBe(ref.accountGeneration);
  expect(f.run().embedding.allowed).toBe(true);
  expect(f.logs).toEqual([]);
});

test.each([['different owner', 'different-owner'], ['unproven owner', undefined]] as const)(
  'retained mail under a reconnected mailbox (%s)', (_scenario, owner) => {
  const mount = corpusRoster.find(c => c.corpusId === GMAIL_SECURE_CONNECTOR_CORPUS_ID)!;
  const f = fixture(mount, open(mount), 'device');
  f.approve();
  f.reconnect(owner);
  expect(f.run().manual.allowed).toBe(false);
  // Known gap, deferred to 1.6 (olympus-ops#236): serving still reads the
  // Private mail store for Search and Ask after a different or unproven
  // mailbox reconnects; the definition denies. Only those reads may differ.
  const reason = owner === undefined ? 'account_unproven' : 'account_mismatch';
  expect([...new Set(f.logs.map(event => `${event.stage}/${event.layer} serving=${event.serving} shadow=${event.shadow} ${event.reason}`))].sort())
    .toEqual(['answer/content', 'answer/names', 'search/content', 'search/names'].map(stage => `${stage} serving=true shadow=false ${reason}`));
});

test('owner imports and privileged purposes are independent of a live folder approval', () => {
  const facts = mountedStoreFacts({ trustDomain: 'secure_local' }, { selection: 'container_key', matchers: ['container_key'] });
  const context: AdmissionContext = {
    caller: 'owner',
    purpose: 'search',
    layer: 'content',
    destination: 'device',
    account: { id: 'durable-owner' },
    authority: { epoch: 'revoked' },
  };
  expect(evaluate(context, facts).admitted).toBe(false);
  expect(evaluate(context, { ...facts, item: { tier: 'S4', provenance: 'owner_import' } }))
    .toEqual({ admitted: true, reason: 'owner_import' });
  for (const [caller, purpose] of [['internal_judge', 'judge'], ['migrate', 'migrate'], ['backup', 'backup']] as const) {
    expect(evaluate({ ...context, caller, purpose }, facts))
      .toEqual({ admitted: true, reason: 'privileged_owner_scope_bypass' });
  }
});

test('a remote scope is bound to its account and epoch, and privilege bypasses only owner scope', () => {
  const facts = mountedStoreFacts({ trustDomain: 'internal' }, { matchers: ['account', 'conversation'] });
  const grant = { epoch: 'current', owner: { id: 'owner' }, scope: { matcher: 'conversation', value: 'chosen' } } as const;
  const context: AdmissionContext = {
    caller: 'remote_grant', purpose: 'search', destination: 'recipient', layer: 'content', account: grant.owner,
    authority: { epoch: grant.epoch, grant },
  };
  expect(evaluate(context, facts).scope?.grant).toEqual(grant.scope);
  expect(evaluate({ ...context, account: { id: 'other' } }, facts).admitted).toBe(false);
  expect(evaluate({ ...context, authority: { epoch: 'revoked', grant } }, facts).admitted).toBe(false);
  expect(evaluate({ ...context, requestScope: { matcher: 'path_prefix', value: '/folder' } }, facts).admitted).toBe(false);
  expect(evaluate({ ...context, caller: 'internal_judge', purpose: 'judge', destination: 'cloud' },
    { ...facts, item: { tier: 'S4' } }).admitted).toBe(false);
  expect(evaluate({ ...context, caller: 'owner', purpose: 'embed', destination: 'device' },
    { ...facts, item: { tier: 'S1', held: true } }).admitted).toBe(false);
});

test('every extraction home matches the file, attachment, media and archive rosters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-extraction-roster-'));
  scratch.push(dir);
  const env = { HOME: dir, XDG_DATA_HOME: dir, OPENCLAW_STATE_DIR: dir };
  const evernote = createEvernoteRuntime({
    env, registryPath: join(dir, 'handles.json'),
    secretStore: () => ({ label: 'fixture', async get() { throw new Error('roster read signed in'); },
      async set() {}, async delete() {}, async list() { return []; } }),
  });
  try {
    const notes = evernote.schedulerSource({
      config: defaultConfig(), handle: { provider: 'evernote', handle: 'evernote.fixture', connectedAt, scopes: [], allowedCapabilities: ['evernote.notes.sync'] },
      notebookGate: () => () => 'ingest', assertNotebookChoiceCurrent() {}, scope: { accountGeneration: 'fixture', scopeRevision: 'fixture' },
    });
    const requested = new Set(roster.map(c => c.corpusId));
    for (const override of [undefined, 'internal.readwise.library']) {
      const configured = override ? [{ corpusId: override, provider: 'fixture', scopes: ['fixture'] }] : [];
      const serving = [
        ...fileExtractionCorporaRoster({
          configured: [...fileHomes, ...configured],
          archive: archiveFileExtractionCorpora({ state: new ArchiveImportStateStore({ path: join(dir, 'archives.json') }) }),
        }).map(c => c.corpusId),
        ...gmailAttachmentLanes(accountScope).map(c => c.corpusId),
        ...telegramMediaLanes([INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID], accountScope).map(c => c.corpusId),
        ...notes.tasks.filter(t => t.kind === 'extract').map(task => task.id.replace(/^evernote\.attachments\./, '')),
      ];
      const shadow = roster.filter(c => corpusAdmissions(declarations.find(d => d.sourceId === c.sourceId)!, c, {
        mounted: true, requested, configuredExtraction: new Set(configured.map(config => config.corpusId)),
      }).extract).map(c => c.corpusId);
      expect(shadow.sort()).toEqual(serving.sort());
    }
  } finally {
    evernote.existingLane(false)?.ledger.close();
  }
});

async function search(worker: ReturnType<typeof createEmailSourceWorker>, body: Record<string, unknown>) {
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST', body: JSON.stringify({ query: 'fixture', retrieval_mode: 'keyword', ...body }),
    headers: { 'content-type': 'application/json' },
  }));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}

test('explicit all-sources requests intersect registry search, tier selection and mounted stores', async () => {
  const mounted = roster.map(c => open(c));
  for (const narrowed of [false, true]) {
    const registered = roster.map((c, i): SourceCorpusConfig => {
      if (!narrowed) return c;
      if (i % 6 === 0) return { ...c, enabled: false };
      if (i % 6 === 1) return { ...c, capabilities: ['status'] };
      return c;
    });
    const registry = createSourceCorpusRegistry({ schemaVersion: 2, corpora: registered });
    const ids = (mod: number) => new Set(roster.filter((_, i) => !narrowed || i % 6 !== mod).map(c => c.corpusId));
    const requested = ids(2);
    const tierCorpusIds = ids(3);
    const available = ids(4);
    const reads = new Set<string>();
    const worker = createEmailSourceWorker({
      connectorStores: mounted.filter(store => available.has(store.corpusId)),
      searchableCorpusIds: new Set(registry.ids('search')),
      connectorStoreReadScope: store => { reads.add(store.corpusId); return { allowed: true }; },
      connectorStoreTierSiblings: () => { throw new Error('explicit set expanded to siblings'); },
    });
    try {
      const expected: string[] = [];
      for (const c of registered) {
        const admission = corpusAdmissions(declarations.find(d => d.sourceId === c.sourceId)!, c,
          { mounted: available.has(c.corpusId), requested, tierCorpusIds });
        expect([admission.registered, admission.answer, admission.status], c.corpusId)
          .toEqual([registry.has(c.corpusId), registry.has(c.corpusId, 'answer'), registry.has(c.corpusId, 'status')]);
        if (admission.search) expected.push(c.corpusId);
      }
      const result = await search(worker, { corpus_ids: [...requested], tier_corpus_ids: [...tierCorpusIds] });
      expect(result.results.filter(Boolean).map((r: { corpus_id: string }) => r.corpus_id)).toEqual(expected);
      expect(reads).toEqual(new Set(expected));
      expect(result.audit.skipped_corpora).toEqual([...requested].filter(id => !expected.includes(id)));
    } finally { worker.close(); }
  }
});

test('Search compares the names verdict for the same rows in all-sources and single Private mode', async () => {
  const c = roster.find(c => c.corpusId === GMAIL_SECURE_CONNECTOR_CORPUS_ID)!;
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = open(c, ledger);
  const worker = createEmailSourceWorker({ connectorStores: [store] });
  try {
    const ids = ['ordinary', 'restricted', 'hidden'];
    for (const id of ids) {
      await store.syncFromConnector(mailInput(c, id, id), { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
    }
    ledger.setOverride({ provider: c.provider, accountScope, providerItemId: 'restricted' }, { kind: 'tier', tier: 'secure' });
    ledger.setOverride({ provider: c.provider, accountScope, providerItemId: 'hidden' }, { kind: 'tier', tier: 'secrets' });
    for (const includePrivateNames of [false, true]) {
      const result = await search(worker, includePrivateNames ? { corpus_id: c.corpusId, include_private_names: true }
        : { corpus_ids: [c.corpusId], personal_names_only: true });
      const expected = ids.filter((_, index) => admitsSearchName({
        names: (['public_or_personal', 'private', 'secret'] as const)[index]!, tier: 'S4',
        domain: c.trustDomain, includePrivateNames, searchedPrivateStore: true,
      }));
      const hits = includePrivateNames ? result.hits : result.results[0].hits;
      expect(hits.map((hit: { sourceItem: { providerItemId: string } }) => hit.sourceItem.providerItemId).sort()).toEqual(expected.sort());
    }
  } finally { worker.close(); ledger.close(); }
});

test('the all-sources client sends precisely the enabled public search entries, including Readwise', async () => {
  const config = defaultConfig();
  config.email.enabled = true;
  const corpora = config.sourceIndex.corpusRegistry.corpora;
  corpora.find(c => c.corpusId === 'secure_local.readwise.library')!.capabilities = ['status'];
  corpora.find(c => c.corpusId === 'internal.email')!.enabled = false;
  const requested = new Set(corpora.map(c => c.corpusId));
  const expected = corpora.filter(c => corpusAdmissions(declarations.find(d => d.sourceId === c.sourceId)!, c,
    { mounted: true, requested }).search).map(c => c.corpusId);
  const worker = createEmailSourceWorker({ connectorStores: [] });
  try {
    const client = new EmailClient(config, new DirectHttpEmailTransport(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.personal_names_only).toBe(true);
      expect(body.corpus_ids.sort()).toEqual([...expected].sort());
      return worker.fetch(new Request(String(url).replace(config.email.baseUrl, 'http://worker.test/v1'), init));
    }));
    expect((await client.sourceIndexSearchMany({ query: 'fixture' })).skipped.sort()).toEqual(expected.sort());
  } finally { worker.close(); }
});

test('parity detects changed values under identical filter keys without logging them', () => {
  const corpus = roster.find(c => c.sourceId === SCHEDULER_SOURCE_IDS.evernote)!;
  const definition = declarations.find(d => d.sourceId === corpus.sourceId)!;
  const owner = { id: 'fixture-private-owner-id' };
  const authority = { owner, approved: true, accountScope, epoch: 'v1', generation: 'g1',
    selections: [{ state: 'ingest' as const, key: 'fixture-private-notebook' }] };
  const filters = { provider: corpus.provider, sourceScopeGeneration: 'g1', sourceScopeFolderAnyKeys: ['different-private-notebook'] };
  const scope = { allowed: true as const, accountScope, filters };
  const events: AdmissionDisagreement[] = [];
  compareAdmissionScopes({
    corpus, definition, ready: true, account: owner, readAuthority: authority, processingAuthority: authority,
    destination: 'device', canEmbedHeld: false, read: { ...scope, contentAllowed: true, contentFilters: filters },
    scheduled: scope, manual: scope, status: { accountScope, itemFilters: filters, contentFilters: filters,
      embedding: { accountScope, contentFilters: filters } },
  }, event => events.push(event));
  expect(events).toHaveLength(9);
  for (const event of events) expect(event.differingConstraints).toEqual(['sourceScopeFolderAnyKeys']);
  for (const value of [owner.id, accountScope, ...filters.sourceScopeFolderAnyKeys, authority.selections[0]!.key]) {
    expect(JSON.stringify(events)).not.toContain(value);
  }
});
