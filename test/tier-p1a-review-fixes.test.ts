// Critical-review findings on PR #77, each pinned by its reproduction.
//
// A. A decision made without reading the text must never replace or lower a
//    content tier decided from text; late-arriving text (the extraction
//    factory) gets its own content decision.
// C. Map v2 lowering categories match only real structured fields; only a
//    Personal-target owner match silences the sniffer.
// D. Secure-only lanes declare secure_local placement, and a mismatch is refused.
// E. Provider floors apply after force rules and force priors.
// Nits: slug-only basis codes and rule ids; owner-only -wal/-shm files; per-lane
//    parity with the retired connector classify() answers.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  USER_FACING_TIER_MAPPING,
  parseSensitivityMap,
  type SensitivityMap,
} from '../src/core/sensitivity-map.ts';
import { buildSourceSensitivity, type SourceSensitivity } from '../src/core/source-index/types.ts';
import { classifyItemTier } from '../src/workers/classification/engine.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger, tierLedgerPathForStore } from '../src/workers/classification/tier-ledger.ts';
import { APPLE_MESSAGES_STORE_PLACEMENT } from '../src/workers/apple-messages/connector.ts';
import { LocalConnectorStore, connectorStoreItemPlacement } from '../src/workers/connector-store/index.ts';
import { scanDropboxContentPolicyText } from '../src/workers/dropbox-files/content-policy.ts';
import { DROPBOX_STORE_PLACEMENT } from '../src/workers/dropbox-files/connector-store.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import { gmailConnectorStoreClassification } from '../src/workers/google-connectors/gmail.ts';
import { READWISE_STORE_PLACEMENT } from '../src/workers/readwise/connector.ts';
import { WHATSAPP_STORE_PLACEMENT } from '../src/workers/whatsapp/store-sync.ts';
import { X_BOOKMARKS_STORE_PLACEMENT } from '../src/workers/x-bookmarks/connector.ts';

// Built at runtime so the repository's credential-pattern check never sees a
// literal key in the diff (the same approach as test/credential-pattern-check.test.ts).
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const ID = { provider: 'fixture', accountScope: 'personal', providerItemId: 'item-1' };
const HEALTH = 'The lab results confirm the diagnosis; the patient starts treatment.';

function mapV2(categories: Array<{ id: string; tier: 'public' | 'private' | 'secure' | 'secrets'; keywords?: string[]; pathPatterns?: string[] }>): SensitivityMap {
  return parseSensitivityMap({
    schemaVersion: 2,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: categories.map((category) => ({
      id: category.id,
      label: category.id,
      targetTierName: category.tier,
      targetTrustTier: USER_FACING_TIER_MAPPING[category.tier].targetTrustTier,
      targetTrustDomain: USER_FACING_TIER_MAPPING[category.tier].targetTrustDomain,
      examples: ['example'],
      match: { keywords: category.keywords ?? [], senderPatterns: [], pathPatterns: category.pathPatterns ?? [] },
    })),
  });
}

function withDir<T>(run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-review-'));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('A: an unread decision never lowers a content tier', () => {
  test('reproduction: text-read Private, then a metadata-only listing, stays Private', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      const read = classifyItemTiers({ signals: { title: 'Report' }, text: HEALTH });
      expect(read.contentTier).toBe('secure');
      ledger.recordDecision(ID, read);

      const unread = classifyItemTiers({ signals: { title: 'Report' } });
      expect(unread.contentRead).toBe(false);
      expect(unread.contentPending).toBe(true);
      expect(unread.state).toBe('pending');
      const after = ledger.recordDecision(ID, unread).record;
      expect(after.contentTier).toBe('secure');
      expect(after.contentRead).toBe(true);
      expect(after.reasons).toContain('content:detector:health:vocabulary');
      expect(after.generation).toBe(1);
    } finally {
      ledger.close();
    }
  });

  test('an unread decision can raise (names now demand more) but never lowers an unread one', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      ledger.recordDecision(ID, classifyItemTiers({ signals: { title: 'x', floor: { tier: 'secure', basis: 'provider:fact' } } }));
      const lowered = ledger.recordDecision(ID, classifyItemTiers({ signals: { title: 'x' } })).record;
      expect(lowered.contentTier).toBe('secure');
      expect(lowered.metadataTier).toBe('private');
      expect(lowered.contentRead).toBe(false);

      ledger.recordDecision({ ...ID, providerItemId: 'item-2' }, classifyItemTiers({ signals: { title: 'x' }, text: 'weekly notes' }));
      const raised = ledger.recordDecision(
        { ...ID, providerItemId: 'item-2' },
        classifyItemTiers({ signals: { title: 'x', floor: { tier: 'secure', basis: 'provider:fact' } } }),
      ).record;
      expect(raised.contentTier).toBe('secure');
    } finally {
      ledger.close();
    }
  });

  test('a lane whose text arrives later gets its content decision when the text is read', async () => {
    await withDir(async (dir) => {
      const store = new LocalConnectorStore({
        dbPath: join(dir, 'store.sqlite'),
        corpusId: 'secure_local.fixture.files',
        family: 'file',
        trustDomain: 'secure_local',
      });
      try {
        const listed: RawItem = {
          identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: 'scan-1', localItemId: 'personal:scan-1', sourceVersion: 'v1' },
          mimeType: 'application/pdf',
          content: { kind: 'metadata_only' },
          metadata: { name: 'scan.pdf', pathDisplay: '/Files/scan.pdf', contentHash: 'digest-1' },
          fetchedAt: '2026-09-23T00:00:00.000Z',
        };
        await store.syncFromConnector(connectorFor([listed]), { fetchContent: false, placement: DROPBOX_STORE_PLACEMENT });
        const ledger = store.tierLedger()!;
        expect(ledger.getCurrent(listed.identity)).toMatchObject({ contentRead: false, contentPending: true, state: 'pending', contentTier: 'private' });

        const sink = createConnectorStoreExtractionSink({
          store,
          classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
          syncConnectorId: 'extraction-pass',
          ownerConnectorId: 'fixture',
          ownershipKind: 'observed',
        });
        const result = await sink.accept({
          ref: {
            corpusId: 'secure_local.fixture.files',
            provider: 'fixture',
            accountScope: 'personal',
            approvedScopeKey: 'scope',
            providerItemId: 'scan-1',
            localItemId: 'personal:scan-1',
            sourceVersion: 'v1',
            contentHash: 'digest-1',
            name: 'scan.pdf',
            mimeType: 'application/pdf',
          },
          text: HEALTH,
          extractorKind: 'fake-text',
          extractorVersion: '1',
          fetchedAt: '2026-09-23T01:00:00.000Z',
        });
        expect(result.accepted).toBe(true);
        expect(ledger.getCurrent(listed.identity)).toMatchObject({
          metadataTier: 'private',
          contentTier: 'secure',
          contentRead: true,
          contentPending: false,
          state: 'current',
        });

        // A later metadata-only re-listing leaves that content decision alone.
        await store.syncFromConnector(connectorFor([listed]), { fetchContent: false, placement: DROPBOX_STORE_PLACEMENT });
        expect(ledger.getCurrent(listed.identity)?.contentTier).toBe('secure');
      } finally {
        store.close();
      }
    });
  });
});

describe('C: lowering map categories and the sniffer', () => {
  test('reproduction: an email subject naming /blog/ is not Public', () => {
    const map = mapV2([{ id: 'blog', tier: 'public', pathPatterns: ['/blog/'] }]);
    const decision = classifyItemTiers({ signals: { title: 'Re: draft for /blog/ launch', sender: 'a@b.example' }, text: 'see attached' }, { sensitivityMap: map });
    expect(decision.metadataTier).toBe('private');
    expect(decision.reasons).not.toContain('metadata:sensitivity_map:blog');
  });

  test('reproduction: therapy notes under a Public work/ folder are still flagged for the sniffer', () => {
    const map = mapV2([{ id: 'work', tier: 'public', pathPatterns: ['/work/'] }]);
    const decision = classifyItemTiers({ signals: { title: 'therapy notes', path: '/work/therapy notes.txt' } }, { sensitivityMap: map });
    expect(decision.metadataTier).toBe('public');
    expect(decision.metadataPending).toBe(true);
    expect(decision.state).toBe('pending');
    expect(decision.reasons).toContain('metadata:possibly_private:names:personal_life');
  });
});

describe('D: secure-only lanes refuse any other store', () => {
  test('WhatsApp and Apple Messages declare secure_local placement', () => {
    expect(WHATSAPP_STORE_PLACEMENT).toEqual({ trustTier: 'S4', trustDomain: 'secure_local' });
    expect(APPLE_MESSAGES_STORE_PLACEMENT).toEqual({ trustTier: 'S4', trustDomain: 'secure_local' });
  });

  test('a secure-only lane wired to an internal store is rejected item by item', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.fixture.chat', family: 'chat', trustDomain: 'internal' });
    try {
      const item: RawItem = {
        identity: { family: 'chat', provider: 'fixture', accountScope: 'personal', providerItemId: 'm1', localItemId: 'personal:m1' },
        mimeType: 'text/plain',
        content: { kind: 'text', text: 'hello' },
        metadata: { chat: 'Family' },
        fetchedAt: '2026-09-23T00:00:00.000Z',
      };
      const summary = await store.syncFromConnector({ ...connectorFor([item]), family: 'chat' }, { fetchContent: true, placement: WHATSAPP_STORE_PLACEMENT });
      expect(summary.itemsIndexed).toBe(0);
      expect(summary.itemsRejected).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('E: provider floors apply after force rules', () => {
  const secretChat = { title: 'Chat', path: '/chats/42', floor: { tier: 'secure' as const, basis: 'provider:secret_chat' } };

  test('a force-Public rule cannot lower a Secret Chat below Private', () => {
    const decision = classifyItemTiers({ signals: secretChat, text: 'hello' }, {
      rules: [{ id: 'chats-public', match: { kind: 'pathPrefix', value: '/chats/' }, tier: 'public', strength: 'force' }],
    });
    expect(decision.metadataTier).toBe('secure');
    expect(decision.contentTier).toBe('secure');
    expect(decision.reasons).toContain('metadata:floor:provider:secret_chat');
  });

  test('neither can a source-level force prior', () => {
    const decision = classifyItemTiers({
      signals: { ...secretChat, prior: { tier: 'public', strength: 'force', basis: 'source_config:public' } },
      text: 'hello',
    });
    expect(decision.metadataTier).toBe('secure');
    expect(decision.metadataForced).toBe(true);
  });
});

describe('nits', () => {
  test('basis codes and rule ids that are not slugs never reach a reason', () => {
    const decision = classifyItemTiers({
      signals: { title: 'x', path: '/p/q', prior: { tier: 'private', strength: 'prior', basis: '/Users/ann/Private Folder' } },
      text: 'weekly notes',
    }, {
      rules: [{ id: 'Ann Smith secret folder', match: { kind: 'pathPrefix', value: '/p/' }, tier: 'secure', strength: 'prior' }],
    });
    expect(decision.reasons.join('\n')).not.toContain('Ann');
    expect(decision.reasons.join('\n')).not.toContain('/Users');
    expect(decision.reasons).toContain('metadata:owner_rule:pathPrefix:invalid:prior');
  });

  test('the ledger and its -wal/-shm files are owner-only', async () => {
    await withDir((dir) => {
      const dbPath = tierLedgerPathForStore(join(dir, 'store.sqlite'));
      const ledger = new TierLedger({ dbPath });
      try {
        ledger.recordDecision(ID, classifyItemTiers({ signals: { title: 'x' }, text: 'notes' }));
        for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          expect(`${path}:${(statSync(path).mode & 0o777).toString(8)}`).toBe(`${path}:600`);
        }
      } finally {
        ledger.close();
      }
    });
  });
});

describe('per-lane placement parity with the retired connector classify()', () => {
  const text = (value: string): RawItem['content'] => ({ kind: 'text', text: value });
  const bytes = (value: string, mimeType: string): RawItem['content'] => ({ kind: 'bytes', mimeType, bytes: new TextEncoder().encode(value) });
  const samples: RawItem['content'][] = [
    text('weekly notes'),
    text(`aws key ${FAKE_AWS_KEY}`),
    text(HEALTH),
    bytes('password = hunter2hunter2hunter2', 'text/plain'),
    bytes(FAKE_AWS_KEY, 'application/pdf'),
    { kind: 'metadata_only' },
  ];
  const item = (content: RawItem['content'], metadata: Record<string, unknown> = { name: 'a.txt' }): RawItem => ({
    identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: 'p', localItemId: 'personal:p' },
    mimeType: 'text/plain',
    content,
    metadata,
    fetchedAt: '2026-09-23T00:00:00.000Z',
  });

  // The retired answers, restated literally from the deleted classify() bodies.
  const legacy: Record<string, (raw: RawItem) => SourceSensitivity> = {
    readwise: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }),
    x: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }),
    whatsapp: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    apple: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    telegramInternal: () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }),
    telegramSecure: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    dropbox: (raw) => {
      const body = raw.content.kind === 'text'
        ? raw.content.text
        : raw.content.kind === 'bytes' && raw.content.mimeType.startsWith('text/')
          ? new TextDecoder().decode(raw.content.bytes)
          : undefined;
      const scan = body === undefined ? undefined : scanDropboxContentPolicyText({ text: body });
      return buildSourceSensitivity({ trustTier: scan?.trust_tier === 'S5' ? 'S5' : 'S4', trustDomain: 'secure_local' });
    },
  };
  const lanes: Record<string, [Parameters<typeof connectorStoreItemPlacement>[2], 'internal' | 'secure_local']> = {
    readwise: [READWISE_STORE_PLACEMENT, 'internal'],
    x: [X_BOOKMARKS_STORE_PLACEMENT, 'internal'],
    whatsapp: [WHATSAPP_STORE_PLACEMENT, 'secure_local'],
    apple: [APPLE_MESSAGES_STORE_PLACEMENT, 'secure_local'],
    telegramInternal: [{ trustTier: 'S3', trustDomain: 'internal' }, 'internal'],
    telegramSecure: [{ trustTier: 'S4', trustDomain: 'secure_local' }, 'secure_local'],
    dropbox: [DROPBOX_STORE_PLACEMENT, 'secure_local'],
  };

  for (const [lane, [placement, domain]] of Object.entries(lanes)) {
    test(`${lane} places every sample exactly as its classify() did`, () => {
      for (const content of samples) {
        const raw = item(content);
        expect(connectorStoreItemPlacement(raw, undefined, placement, domain)).toEqual(legacy[lane]!(raw));
      }
    });
  }

  test('Gmail keeps the shared raise-only policy: text-bearing samples match the retired raise-only answer', () => {
    const classification = gmailConnectorStoreClassification(undefined);
    for (const body of ['weekly notes', `aws key ${FAKE_AWS_KEY}`, HEALTH, 'bank statement for your account']) {
      const raw = item(text(body), { subject: 'Hello', from: 'a@b.example', labels: ['INBOX'] });
      // classifyGoogleItemRaiseOnly, restated: engine verdict, raise-only above S3/internal.
      const verdict = classifyItemTier({ subject: 'Hello', sender: 'a@b.example', labels: ['INBOX'], text: body });
      const rank = ['S0', 'S1', 'S2', 'S3', 'S4', 'S4+', 'S5'];
      const expected = verdict.decidedBy === 'default_secure' || rank.indexOf(verdict.tier) <= rank.indexOf('S3')
        ? buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' })
        : buildSourceSensitivity({ trustTier: verdict.tier, trustDomain: verdict.trustDomain });
      const actual = connectorStoreItemPlacement(raw, classification, undefined, 'internal');
      expect({ tier: actual.trustTier, domain: actual.trustDomain }).toEqual({ tier: expected.trustTier, domain: expected.trustDomain });
    }
  });
});

function connectorFor(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fixture',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () { yield { items, done: true }; })();
    },
    async fetchItem(localItemId) {
      const found = items.find((entry) => entry.identity.localItemId === localItemId);
      if (!found) throw new Error('missing');
      return found;
    },
    classificationSignals(raw) {
      return { title: String(raw.metadata['name'] ?? ''), ...(typeof raw.metadata['pathDisplay'] === 'string' ? { path: raw.metadata['pathDisplay'] } : {}) };
    },
  };
}
