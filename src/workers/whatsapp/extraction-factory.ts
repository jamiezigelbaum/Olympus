// The WhatsApp extraction source of an account, as the extraction runtime
// builds it: voice notes by their saved path, and children (a picture or
// video the bridge saved, a file an imported export carries) through the
// shared connector adapter (`createConnectorFileExtractionSource`) over the
// account's child connector (child-media.ts), as Gmail's attachments are
// read. The engine passes the archive imports so an export's files can be
// read; without them only what the bridge saved is.

import type { LayoutEnv } from '../../core/olympus-layout.ts';
import type { ExtractionCandidateReader } from '../../core/file-extraction-source.ts';
import { whatsappMovedPathMapper } from '../../core/source-placement.ts';
import type { ArchiveInputMediaDeps } from '../archive-import/input-media.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredExtractionView } from '../connector-store/tiered-extraction.ts';
import { connectorStoreExtractionCandidateReader } from '../connector-store/extraction-candidate-reader.ts';
import { createConnectorFileExtractionSource, deferredBytesAnswerFor, type DeferredBytesAnswer } from '../file-extraction/connector-source.ts';
import type { ExtractionItemRef } from '../file-extraction/types.ts';
import { createWhatsAppChildReader, whatsAppChildConnector, type WhatsAppChildReader } from './child-media.ts';
import { WhatsAppExtractionSource, type WhatsAppChildExtraction } from './extraction-source.ts';
import { WHATSAPP_PERSONAL_ACCOUNT_SCOPE, defaultWhatsAppMediaRoots } from './store-sync.ts';

/** The account's child reader: the bridge's media folders, and the archive imports when the engine has them. */
export function whatsAppChildReader(env: LayoutEnv, archive?: () => ArchiveInputMediaDeps | undefined): WhatsAppChildReader {
  return createWhatsAppChildReader({
    mediaRoots: defaultWhatsAppMediaRoots(env),
    relocate: whatsappMovedPathMapper(env),
    ...(archive ? { archive } : {}),
  });
}

/**
 * How an account's children are read for extraction: the shared connector
 * adapter over the account's child connector. The adapter owns the store's
 * deferred locator, its version refusals and the byte bound; the connector
 * only reads the locator's bytes through the child reader.
 */
export function whatsAppChildExtraction(input: {
  id: string;
  corpusId: string;
  provider: string;
  accountScope: string;
  approvedScopeKey: string;
  candidates: ExtractionCandidateReader;
  deferredBytes: (ref: ExtractionItemRef) => DeferredBytesAnswer;
  readChild: WhatsAppChildReader;
}): WhatsAppChildExtraction {
  const connector = whatsAppChildConnector({ account: input.accountScope, readChild: input.readChild });
  const adapter = createConnectorFileExtractionSource({
    id: input.id,
    corpusId: input.corpusId,
    provider: input.provider,
    connector: (accountScope) => accountScope === input.accountScope ? connector : undefined,
    // Only a child is read here: a row the store no longer keeps as one is not found.
    deferredBytes: (ref) => input.deferredBytes(ref) ?? { refusal: 'source_item_not_found' },
    candidates: input.candidates,
    lanes: [{ approvedScopeKey: input.approvedScopeKey }],
  });
  const fetchFile = adapter.fetchFile;
  if (!fetchFile) throw new Error('The shared connector adapter hands no file.');
  return {
    fetch: (ref, options) => adapter.fetch(ref, options),
    fetchFile: (ref, options) => fetchFile.call(adapter, ref, options),
  };
}

export function whatsAppExtractionSourceFactory(env: LayoutEnv, archive?: () => ArchiveInputMediaDeps | undefined) {
  const readChild = whatsAppChildReader(env, archive);
  return (input: {
    config: { corpusId: string; provider: string; scopes: readonly string[] };
    store: LocalConnectorStore;
    view?: TieredExtractionView;
  }): WhatsAppExtractionSource => {
    // Across the lane's tier stores when it has them: a child routed out of the Private store is still read and judged.
    const reader = input.view ?? input.store;
    const id = `${input.config.corpusId}:extraction`;
    const candidates = connectorStoreExtractionCandidateReader(reader);
    const approvedScopeKey = input.config.scopes[0]!;
    return new WhatsAppExtractionSource({
      id,
      corpusId: input.config.corpusId,
      provider: input.config.provider,
      accountScope: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
      approvedScopeKey,
      candidates,
      locators: reader,
      mediaRoots: defaultWhatsAppMediaRoots(env),
      relocateLocator: whatsappMovedPathMapper(env),
      children: whatsAppChildExtraction({
        id,
        corpusId: input.config.corpusId,
        provider: input.config.provider,
        accountScope: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
        approvedScopeKey,
        candidates,
        deferredBytes: (ref) => deferredBytesAnswerFor(reader.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
        readChild,
      }),
    });
  };
}
