import {
  buildSourceSensitivity,
  type SourceFamily,
  type SourceIndexProvenance,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from './source-index/types.ts';

export const SOURCE_POSTURE_STATUSES = ['working', 'planned', 'deferred'] as const;
export const SOURCE_INGEST_MODES = ['live_credentialed', 'live_partial', 'archive_import', 'deferred'] as const;
export const SOURCE_PACKET_KINDS = ['message_packet', 'file_packet', 'archive_packet', 'source_specific'] as const;
export const SOURCE_CREDENTIAL_KINDS = [
  'oauth2',
  'bearer_token',
  'mtproto_session',
  'tdlib_session',
  'local_app_database',
  'local_filesystem',
  'webhook_token',
  'archive_path',
  'runtime_connector',
  'none',
] as const;
export const SOURCE_WRITE_POSTURES = ['read_only', 'approval_gated', 'deferred'] as const;
export const CASTOR_EVIDENCE_FORMS = ['bounded_answer', 'safe_provenance', 'approved_context', 'none'] as const;

export type SourcePostureStatus = (typeof SOURCE_POSTURE_STATUSES)[number];
export type SourceIngestMode = (typeof SOURCE_INGEST_MODES)[number];
export type SourcePacketKind = (typeof SOURCE_PACKET_KINDS)[number];
export type SourceCredentialKind = (typeof SOURCE_CREDENTIAL_KINDS)[number];
export type SourceWritePosture = (typeof SOURCE_WRITE_POSTURES)[number];
export type CastorEvidenceForm = (typeof CASTOR_EVIDENCE_FORMS)[number];

export interface SourceFamilyPostureInput {
  sourceId: string;
  label: string;
  family: SourceFamily;
  provider: string;
  status: SourcePostureStatus;
  ingestMode: SourceIngestMode;
  defaultTrustDomain: SourceTrustDomain;
  defaultTrustTier: SourceTrustTier;
  rawDataCustodian: 'source_worker' | 'secure_local_lane' | 'archive_importer' | 'provider_only' | 'none';
  packetKinds: readonly SourcePacketKind[];
  credentialKinds: readonly SourceCredentialKind[];
  credentialHandles?: readonly string[];
  castorEvidenceForms: readonly CastorEvidenceForm[];
  writePosture: SourceWritePosture;
  notes?: string;
}

export interface SourceFamilyPosture extends SourceFamilyPostureInput {
  defaultSensitivity: SourceSensitivity;
}

export interface SourceFamilyPostureRegistry {
  get(sourceId: string): SourceFamilyPosture | undefined;
  require(sourceId: string): SourceFamilyPosture;
  list(): SourceFamilyPosture[];
  liveCredentialed(): SourceFamilyPosture[];
  deferred(): SourceFamilyPosture[];
}

export const OLYMPUS_SOURCE_FAMILY_POSTURES: SourceFamilyPosture[] = [
  defineSourceFamilyPosture({
    sourceId: 'gmail.email',
    label: 'Gmail / Email',
    family: 'email',
    provider: 'gmail',
    status: 'working',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'secure_local',
    defaultTrustTier: 'S4',
    rawDataCustodian: 'source_worker',
    packetKinds: ['message_packet'],
    credentialKinds: ['oauth2'],
    credentialHandles: ['gmail.personal', 'gmail.business_ocu'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
    notes: 'Account-aware source family. Raw mail remains secure_local until row/chunk classification proves a lower lane.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'dropbox.files',
    label: 'Dropbox Files',
    family: 'file',
    provider: 'dropbox',
    status: 'working',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'secure_local',
    defaultTrustTier: 'S4',
    rawDataCustodian: 'source_worker',
    packetKinds: ['file_packet'],
    credentialKinds: ['oauth2'],
    credentialHandles: ['dropbox.personal'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
    notes: 'Live file source scoped by approved account/root/folder. Metadata/root mapping is working; content extraction remains a separate queued layer.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'telegram.messages',
    label: 'Telegram Messages',
    family: 'chat',
    provider: 'telegram',
    status: 'working',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'internal',
    defaultTrustTier: 'S3',
    rawDataCustodian: 'secure_local_lane',
    packetKinds: ['message_packet'],
    credentialKinds: ['mtproto_session'],
    credentialHandles: ['telegram.personal'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance', 'approved_context'],
    writePosture: 'read_only',
    notes: 'First live messaging source with green read/search proof. Approved ordinary chats default internal; protected chats route to secure_local. Send/control authority is separate and not active.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'whatsapp.business.messages',
    label: 'WhatsApp Business Messages',
    family: 'chat',
    provider: 'whatsapp_business',
    status: 'planned',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'secure_local',
    defaultTrustTier: 'S4',
    rawDataCustodian: 'source_worker',
    packetKinds: ['message_packet'],
    credentialKinds: ['oauth2', 'webhook_token'],
    credentialHandles: ['whatsapp.business'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
    notes: 'Keep distinct from personal WhatsApp capture; provider path may be WhatsApp Business Cloud API.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'whatsapp.personal.messages',
    label: 'WhatsApp Personal Messages',
    family: 'chat',
    provider: 'whatsapp_personal',
    status: 'planned',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'secure_local',
    defaultTrustTier: 'S4',
    rawDataCustodian: 'secure_local_lane',
    packetKinds: ['message_packet'],
    credentialKinds: ['local_app_database'],
    credentialHandles: ['whatsapp.personal_local'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
    notes: 'Personal/device-local capture is a separate posture from WhatsApp Business Cloud API.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'apple_messages.messages',
    label: 'Apple Messages',
    family: 'chat',
    provider: 'apple_messages',
    status: 'planned',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'secure_local',
    defaultTrustTier: 'S4',
    rawDataCustodian: 'secure_local_lane',
    packetKinds: ['message_packet'],
    credentialKinds: ['local_app_database'],
    credentialHandles: ['apple_messages.local'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
    notes: 'macOS local source; raw content stays local/private by default.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'x.bookmarks',
    label: 'X Bookmarks',
    family: 'x',
    provider: 'x',
    status: 'working',
    ingestMode: 'live_partial',
    defaultTrustDomain: 'internal',
    defaultTrustTier: 'S1',
    rawDataCustodian: 'source_worker',
    packetKinds: ['source_specific'],
    credentialKinds: ['oauth2'],
    credentialHandles: ['x.bookmarks.personal'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
    notes: 'Official API proof is authenticated but partial; full capture needs a separate collector preserving folders.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'readwise.library',
    label: 'Readwise Library',
    family: 'readwise',
    provider: 'readwise',
    status: 'working',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'internal',
    defaultTrustTier: 'S1',
    rawDataCustodian: 'source_worker',
    packetKinds: ['source_specific'],
    credentialKinds: ['bearer_token'],
    credentialHandles: ['readwise.personal'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance', 'approved_context'],
    writePosture: 'read_only',
    notes: 'Owner-classified S1/internal: the saved/read relationship is private context even when the original item is public.',
  }),
  defineSourceFamilyPosture({
    sourceId: 'google_drive.docs',
    label: 'Google Drive / Docs',
    family: 'file',
    provider: 'google_drive',
    status: 'working',
    ingestMode: 'live_credentialed',
    defaultTrustDomain: 'internal',
    defaultTrustTier: 'S3',
    rawDataCustodian: 'source_worker',
    packetKinds: ['file_packet'],
    credentialKinds: ['oauth2'],
    credentialHandles: ['google_drive.personal'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance', 'approved_context'],
    writePosture: 'read_only',
  }),
  defineSourceFamilyPosture({
    sourceId: 'reflect.archive',
    label: 'Reflect Archive',
    family: 'note',
    provider: 'reflect',
    status: 'planned',
    ingestMode: 'archive_import',
    defaultTrustDomain: 'internal',
    defaultTrustTier: 'S3',
    rawDataCustodian: 'archive_importer',
    packetKinds: ['archive_packet'],
    credentialKinds: ['archive_path'],
    credentialHandles: ['reflect.archive'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
  }),
  defineSourceFamilyPosture({
    sourceId: 'roam.archive',
    label: 'Roam Archive',
    family: 'note',
    provider: 'roam',
    status: 'planned',
    ingestMode: 'archive_import',
    defaultTrustDomain: 'internal',
    defaultTrustTier: 'S3',
    rawDataCustodian: 'archive_importer',
    packetKinds: ['archive_packet'],
    credentialKinds: ['archive_path'],
    credentialHandles: ['roam.archive'],
    castorEvidenceForms: ['bounded_answer', 'safe_provenance'],
    writePosture: 'read_only',
  }),
  defineSourceFamilyPosture({
    sourceId: 'signal.messages',
    label: 'Signal Messages',
    family: 'chat',
    provider: 'signal',
    status: 'deferred',
    ingestMode: 'deferred',
    defaultTrustDomain: 'secure_local',
    defaultTrustTier: 'S4',
    rawDataCustodian: 'none',
    packetKinds: ['message_packet'],
    credentialKinds: ['none'],
    castorEvidenceForms: ['none'],
    writePosture: 'deferred',
    notes: 'Explicitly out of current scope.',
  }),
];

export const sourceFamilyPostureRegistry = buildSourceFamilyPostureRegistry(OLYMPUS_SOURCE_FAMILY_POSTURES);

export function defineSourceFamilyPosture(input: SourceFamilyPostureInput): SourceFamilyPosture {
  const sourceId = input.sourceId.trim();
  const label = input.label.trim();
  const provider = input.provider.trim();
  if (!sourceId) throw new Error('Source-family posture requires a sourceId.');
  if (!label) throw new Error('Source-family posture requires a label.');
  if (!provider) throw new Error('Source-family posture requires a provider.');
  if (input.packetKinds.length === 0) throw new Error(`Source-family posture ${sourceId} requires at least one packet kind.`);
  if (input.credentialKinds.length === 0) {
    throw new Error(`Source-family posture ${sourceId} requires at least one credential kind.`);
  }
  if (input.castorEvidenceForms.length === 0) {
    throw new Error(`Source-family posture ${sourceId} requires at least one Castor evidence form.`);
  }
  if (input.status === 'deferred' && input.ingestMode !== 'deferred') {
    throw new Error(`Deferred source-family posture ${sourceId} must use deferred ingest mode.`);
  }
  if (input.ingestMode === 'deferred' && input.status !== 'deferred') {
    throw new Error(`Deferred ingest mode for ${sourceId} requires deferred status.`);
  }
  if (input.ingestMode === 'live_credentialed' && input.credentialKinds.includes('none')) {
    throw new Error(`Live credentialed source-family posture ${sourceId} cannot use credential kind none.`);
  }
  if (input.ingestMode === 'archive_import' && !input.credentialKinds.includes('archive_path')) {
    throw new Error(`Archive source-family posture ${sourceId} must include archive_path credential kind.`);
  }

  return {
    ...input,
    sourceId,
    label,
    provider,
    credentialHandles: input.credentialHandles ? [...input.credentialHandles] : [],
    defaultSensitivity: buildSourceSensitivity({
      trustTier: input.defaultTrustTier,
      trustDomain: input.defaultTrustDomain,
      cloudEmbeddingEligible: input.defaultTrustDomain !== 'secure_local' && input.defaultTrustTier !== 'S4' && input.defaultTrustTier !== 'S4+' && input.defaultTrustTier !== 'S5',
    }),
  };
}

export function buildSourceFamilyPostureRegistry(
  postures: readonly SourceFamilyPosture[],
): SourceFamilyPostureRegistry {
  const byId = new Map<string, SourceFamilyPosture>();
  for (const posture of postures) {
    if (byId.has(posture.sourceId)) {
      throw new Error(`Duplicate source-family posture id "${posture.sourceId}".`);
    }
    byId.set(posture.sourceId, posture);
  }

  return {
    get(sourceId: string): SourceFamilyPosture | undefined {
      return byId.get(sourceId);
    },
    require(sourceId: string): SourceFamilyPosture {
      const posture = byId.get(sourceId);
      if (!posture) throw new Error(`Unknown source-family posture "${sourceId}".`);
      return posture;
    },
    list(): SourceFamilyPosture[] {
      return Array.from(byId.values());
    },
    liveCredentialed(): SourceFamilyPosture[] {
      return Array.from(byId.values()).filter((posture) => posture.ingestMode === 'live_credentialed');
    },
    deferred(): SourceFamilyPosture[] {
      return Array.from(byId.values()).filter((posture) => posture.status === 'deferred');
    },
  };
}

export interface SourcePacketBase {
  packetId: string;
  sourceId: string;
  trustDomain: SourceTrustDomain;
  generatedAt: string;
  syncRunId?: string;
  rawSourceExposed: false;
}

export interface SourcePacketParticipant {
  providerParticipantId?: string;
  displayName?: string;
  address?: string;
  role?: 'sender' | 'recipient' | 'member' | 'author' | 'unknown';
}

export interface SourcePacketAttachment {
  attachmentId: string;
  type: 'file' | 'image' | 'audio' | 'video' | 'link' | 'other';
  name?: string;
  uri?: string;
  mimeType?: string;
  contentHash?: string;
  sizeBytes?: number;
}

export interface MessagePacketItem {
  itemId: string;
  providerMessageId: string;
  accountScope: string;
  conversationId: string;
  threadId?: string;
  sentAt?: string;
  editedAt?: string;
  deletedAt?: string;
  participants: readonly SourcePacketParticipant[];
  boundedText?: string;
  attachments?: readonly SourcePacketAttachment[];
  sensitivity: SourceSensitivity;
  provenance: SourceIndexProvenance;
}

export interface MessageSourcePacket extends SourcePacketBase {
  kind: 'message_packet';
  items: readonly MessagePacketItem[];
}

export type FileExtractionStatus =
  | 'metadata_only'
  | 'extracted'
  | 'skipped_unsupported'
  | 'skipped_too_large'
  | 'blocked_policy'
  | 'failed';

/**
 * `partial` is the page-level sibling of `truncated`: the extractor read the
 * document but could not transcribe every page, and the pages it did read are
 * indexed. It is not `truncated` (that is one continuous text cut short by the
 * evidence budget) and not `failed` (nothing was indexed at all).
 */
export type FileExtractionCompleteness =
  | 'complete'
  | 'truncated'
  | 'partial'
  | 'metadata_only'
  | 'failed';

export interface FilePacketItem {
  itemId: string;
  providerFileId: string;
  accountScope: string;
  path: string;
  name?: string;
  revision?: string;
  modifiedAt?: string;
  contentHash?: string;
  mimeType?: string;
  sizeBytes?: number;
  sharedContext?: string;
  extractionStatus: FileExtractionStatus;
  extractionCompleteness?: FileExtractionCompleteness;
  extractedChars?: number;
  sourceChars?: number;
  extractionTruncationReason?: string;
  /**
   * The indexed text was extracted from bytes this file no longer has: it was
   * edited upstream after the extraction that produced this content. A bounded
   * boolean, never the superseded revision id — it exists so answer-time
   * coverage can SAY the text predates the current version of the file, not so
   * a caller can reason about which version it came from.
   */
  extractionRevisionStale?: boolean;
  /** Pages the extractor could not transcribe, for a `partial` extraction. */
  extractionPageGapCount?: number;
  /** Pages the document has in total, when the extractor could read that. */
  extractionTotalPages?: number;
  /**
   * Pages the extractor actually rendered and attempted. Below
   * `extractionTotalPages` the page cap bit, and the pages beyond it were never
   * looked at — a coverage sentence that reports only the gap count would imply
   * they were read and found intact.
   */
  extractionRenderedPages?: number;
  /** The gapped page numbers, bounded — a long tail is reported by count only. */
  extractionGapPageNumbers?: readonly number[];
  boundedText?: string;
  sensitivity: SourceSensitivity;
  provenance: SourceIndexProvenance;
}

export interface FileSourcePacket extends SourcePacketBase {
  kind: 'file_packet';
  items: readonly FilePacketItem[];
}

export function assertValidMessageSourcePacket(packet: MessageSourcePacket): void {
  assertSourcePacketBase(packet, 'message_packet');
  for (const item of packet.items) {
    assertNonEmpty(item.itemId, 'message packet item requires itemId');
    assertNonEmpty(item.providerMessageId, 'message packet item requires providerMessageId');
    assertNonEmpty(item.accountScope, 'message packet item requires accountScope');
    assertNonEmpty(item.conversationId, 'message packet item requires conversationId');
    assertPacketItemSensitivity(packet, item.sensitivity);
    if (!item.provenance?.sourceItem) {
      throw new Error('message packet item requires source provenance.');
    }
  }
}

export function assertValidFileSourcePacket(packet: FileSourcePacket): void {
  assertSourcePacketBase(packet, 'file_packet');
  for (const item of packet.items) {
    assertNonEmpty(item.itemId, 'file packet item requires itemId');
    assertNonEmpty(item.providerFileId, 'file packet item requires providerFileId');
    assertNonEmpty(item.accountScope, 'file packet item requires accountScope');
    assertNonEmpty(item.path, 'file packet item requires path');
    assertPacketItemSensitivity(packet, item.sensitivity);
    if (!item.provenance?.sourceItem) {
      throw new Error('file packet item requires source provenance.');
    }
  }
}

function assertSourcePacketBase(packet: SourcePacketBase & { kind: SourcePacketKind; items: readonly unknown[] }, kind: SourcePacketKind): void {
  if (packet.kind !== kind) throw new Error(`source packet kind must be ${kind}.`);
  assertNonEmpty(packet.packetId, 'source packet requires packetId');
  assertNonEmpty(packet.sourceId, 'source packet requires sourceId');
  assertNonEmpty(packet.generatedAt, 'source packet requires generatedAt');
  if (packet.rawSourceExposed !== false) {
    throw new Error('source packet must set rawSourceExposed=false.');
  }
  if (!sourceFamilyPostureRegistry.get(packet.sourceId)) {
    throw new Error(`source packet references unknown sourceId "${packet.sourceId}".`);
  }
  if (!Array.isArray(packet.items)) throw new Error('source packet items must be an array.');
}

function assertPacketItemSensitivity(packet: SourcePacketBase, sensitivity: SourceSensitivity): void {
  if (sensitivity.trustDomain !== packet.trustDomain) {
    throw new Error('source packet item sensitivity trust domain must match packet trust domain.');
  }
}

function assertNonEmpty(value: string | undefined, message: string): void {
  if (!value?.trim()) throw new Error(message);
}
