import { describe, expect, test } from 'bun:test';
import {
  assertValidFileSourcePacket,
  assertValidMessageSourcePacket,
  defineSourceFamilyPosture,
  sourceFamilyPostureRegistry,
  type FileSourcePacket,
  type MessageSourcePacket,
} from '../src/core/source-family.ts';
import { buildSourceSensitivity, type SourceIndexProvenance } from '../src/core/source-index/types.ts';

describe('source-family posture and packet contracts', () => {
  test('records the current source onboarding split', () => {
    expect(sourceFamilyPostureRegistry.require('dropbox.files')).toMatchObject({
      ingestMode: 'live_credentialed',
      defaultTrustDomain: 'secure_local',
      packetKinds: ['file_packet'],
      credentialKinds: ['oauth2'],
      credentialHandles: ['dropbox.personal'],
      writePosture: 'read_only',
    });
    expect(sourceFamilyPostureRegistry.require('telegram.messages')).toMatchObject({
      status: 'working',
      ingestMode: 'live_credentialed',
      defaultTrustDomain: 'internal',
      packetKinds: ['message_packet'],
      credentialKinds: ['mtproto_session'],
      castorEvidenceForms: ['bounded_answer', 'safe_provenance', 'approved_context'],
    });
    expect(sourceFamilyPostureRegistry.require('readwise.library')).toMatchObject({
      defaultTrustDomain: 'internal',
      defaultTrustTier: 'S1',
      defaultSensitivity: {
        trustDomain: 'internal',
        trustTier: 'S1',
      },
    });
    expect(sourceFamilyPostureRegistry.require('signal.messages')).toMatchObject({
      status: 'deferred',
      ingestMode: 'deferred',
      castorEvidenceForms: ['none'],
    });
    expect(sourceFamilyPostureRegistry.require('reflect.archive')).toMatchObject({
      ingestMode: 'archive_import',
      credentialKinds: ['archive_path'],
    });
    expect(sourceFamilyPostureRegistry.require('roam.archive')).toMatchObject({
      ingestMode: 'archive_import',
      credentialKinds: ['archive_path'],
    });
  });

  test('keeps email account-aware without splitting the corpus by account', () => {
    const email = sourceFamilyPostureRegistry.require('gmail.email');

    expect(email.credentialHandles).toEqual(['gmail.personal', 'gmail.business_ocu']);
    expect(email.defaultSensitivity).toEqual({
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    });
  });

  test('rejects posture rows that blur deferred, live, or archive semantics', () => {
    expect(() =>
      defineSourceFamilyPosture({
        sourceId: 'signal.bad',
        label: 'Signal Bad',
        family: 'chat',
        provider: 'signal',
        status: 'deferred',
        ingestMode: 'live_credentialed',
        defaultTrustDomain: 'secure_local',
        defaultTrustTier: 'S4',
        rawDataCustodian: 'none',
        packetKinds: ['message_packet'],
        credentialKinds: ['none'],
        castorEvidenceForms: ['none'],
        writePosture: 'deferred',
      }),
    ).toThrow('must use deferred ingest mode');

    expect(() =>
      defineSourceFamilyPosture({
        sourceId: 'dropbox.bad',
        label: 'Dropbox Bad',
        family: 'file',
        provider: 'dropbox',
        status: 'planned',
        ingestMode: 'live_credentialed',
        defaultTrustDomain: 'secure_local',
        defaultTrustTier: 'S4',
        rawDataCustodian: 'source_worker',
        packetKinds: ['file_packet'],
        credentialKinds: ['none'],
        castorEvidenceForms: ['safe_provenance'],
        writePosture: 'read_only',
      }),
    ).toThrow('cannot use credential kind none');

    expect(() =>
      defineSourceFamilyPosture({
        sourceId: 'reflect.bad',
        label: 'Reflect Bad',
        family: 'note',
        provider: 'reflect',
        status: 'planned',
        ingestMode: 'archive_import',
        defaultTrustDomain: 'internal',
        defaultTrustTier: 'S3',
        rawDataCustodian: 'archive_importer',
        packetKinds: ['archive_packet'],
        credentialKinds: ['none'],
        castorEvidenceForms: ['safe_provenance'],
        writePosture: 'read_only',
      }),
    ).toThrow('must include archive_path');
  });

  test('validates message packets without flattening communication provenance', () => {
    const packet: MessageSourcePacket = {
      kind: 'message_packet',
      packetId: 'packet-telegram-1',
      sourceId: 'telegram.messages',
      trustDomain: 'secure_local',
      generatedAt: '2026-05-20T12:00:00.000Z',
      rawSourceExposed: false,
      items: [{
        itemId: 'telegram:chat-1:msg-1',
        providerMessageId: 'msg-1',
        accountScope: 'personal',
        conversationId: 'chat-1',
        threadId: 'topic-1',
        sentAt: '2026-05-20T11:59:00.000Z',
        editedAt: '2026-05-20T12:01:00.000Z',
        participants: [{ providerParticipantId: 'user-1', displayName: 'Sam', role: 'sender' }],
        boundedText: 'Bounded local/private message text.',
        attachments: [{ attachmentId: 'att-1', type: 'image', mimeType: 'image/jpeg', contentHash: 'sha256:abc' }],
        sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
        provenance: provenanceFixture({
          family: 'chat',
          provider: 'telegram',
          accountScope: 'personal',
          providerItemId: 'msg-1',
          providerConversationId: 'chat-1',
          localItemId: 'telegram:chat-1:msg-1',
        }),
      }],
    };

    expect(() => assertValidMessageSourcePacket(packet)).not.toThrow();
  });

  test('validates file packets with provider revision and extraction state', () => {
    const packet: FileSourcePacket = {
      kind: 'file_packet',
      packetId: 'packet-dropbox-1',
      sourceId: 'dropbox.files',
      trustDomain: 'secure_local',
      generatedAt: '2026-05-20T12:00:00.000Z',
      rawSourceExposed: false,
      items: [{
        itemId: 'dropbox:file-1:rev-2',
        providerFileId: 'file-1',
        accountScope: 'personal',
        path: '/Approved/Receipts/example.pdf',
        name: 'example.pdf',
        revision: 'rev-2',
        modifiedAt: '2026-05-19T09:00:00.000Z',
        contentHash: 'sha256:def',
        mimeType: 'application/pdf',
        sizeBytes: 1200,
        sharedContext: 'personal-plus-business file spine',
        extractionStatus: 'metadata_only',
        sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
        provenance: provenanceFixture({
          family: 'file',
          provider: 'dropbox',
          accountScope: 'personal',
          providerItemId: 'file-1',
          providerFileId: 'file-1',
          localItemId: 'dropbox:file-1:rev-2',
          sourceVersion: 'rev-2',
        }),
      }],
    };

    expect(() => assertValidFileSourcePacket(packet)).not.toThrow();
  });

  test('accepts precise file extraction skip and block states', () => {
    for (const extractionStatus of ['skipped_unsupported', 'skipped_too_large', 'blocked_policy', 'failed'] as const) {
      const packet: FileSourcePacket = {
        kind: 'file_packet',
        packetId: `packet-dropbox-${extractionStatus}`,
        sourceId: 'dropbox.files',
        trustDomain: 'secure_local',
        generatedAt: '2026-05-20T12:00:00.000Z',
        rawSourceExposed: false,
        items: [{
          itemId: `dropbox:file-1:${extractionStatus}`,
          providerFileId: 'file-1',
          accountScope: 'personal',
          path: '/Approved/example.pdf',
          extractionStatus,
          sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
          provenance: provenanceFixture({
            family: 'file',
            provider: 'dropbox',
            accountScope: 'personal',
            providerItemId: 'file-1',
            providerFileId: 'file-1',
            localItemId: `dropbox:file-1:${extractionStatus}`,
          }),
        }],
      };

      expect(() => assertValidFileSourcePacket(packet)).not.toThrow();
    }
  });

  test('fails closed for unsafe or mismatched packets', () => {
    const unsafePacket = {
      kind: 'message_packet',
      packetId: 'packet-unsafe',
      sourceId: 'telegram.messages',
      trustDomain: 'secure_local',
      generatedAt: '2026-05-20T12:00:00.000Z',
      rawSourceExposed: true,
      items: [],
    } as unknown as MessageSourcePacket;

    expect(() => assertValidMessageSourcePacket(unsafePacket)).toThrow('rawSourceExposed=false');

    const mismatchedPacket: FileSourcePacket = {
      kind: 'file_packet',
      packetId: 'packet-mismatch',
      sourceId: 'dropbox.files',
      trustDomain: 'secure_local',
      generatedAt: '2026-05-20T12:00:00.000Z',
      rawSourceExposed: false,
      items: [{
        itemId: 'dropbox:file-1',
        providerFileId: 'file-1',
        accountScope: 'personal',
        path: '/Approved/example.pdf',
        extractionStatus: 'metadata_only',
        sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
        provenance: provenanceFixture({
          family: 'file',
          provider: 'dropbox',
          accountScope: 'personal',
          providerItemId: 'file-1',
          providerFileId: 'file-1',
          localItemId: 'dropbox:file-1',
        }),
      }],
    };

    expect(() => assertValidFileSourcePacket(mismatchedPacket)).toThrow('trust domain must match');
  });
});

function provenanceFixture(sourceItem: SourceIndexProvenance['sourceItem']): SourceIndexProvenance {
  return {
    sourceItem,
    providerIds: { provider_item_id: sourceItem.providerItemId },
    localIds: { local_item_id: sourceItem.localItemId },
    syncRunId: 'sync-test',
    citation: { title: 'Safe provenance title' },
  };
}
