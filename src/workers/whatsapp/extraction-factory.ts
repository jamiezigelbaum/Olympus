// The WhatsApp extraction source of an account, as the extraction runtime
// builds it: voice notes by their saved path, and children (a picture or
// video the bridge saved, a file an imported export carries) by the locator
// the store keeps for them, through the account's one child reader
// (child-media.ts). The engine passes the archive imports so an export's
// files can be read; without them only what the bridge saved is.

import type { LayoutEnv } from '../../core/olympus-layout.ts';
import { whatsappMovedPathMapper } from '../../core/source-placement.ts';
import type { ArchiveInputMediaDeps } from '../archive-import/input-media.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredExtractionView } from '../connector-store/tiered-extraction.ts';
import { connectorStoreExtractionCandidateReader } from '../connector-store/extraction-candidate-reader.ts';
import { deferredBytesAnswerFor } from '../file-extraction/connector-source.ts';
import { createWhatsAppChildReader, type WhatsAppChildReader } from './child-media.ts';
import { WhatsAppExtractionSource } from './extraction-source.ts';
import { WHATSAPP_PERSONAL_ACCOUNT_SCOPE, defaultWhatsAppMediaRoots } from './store-sync.ts';

/** The account's child reader: the bridge's media folders, and the archive imports when the engine has them. */
export function whatsAppChildReader(env: LayoutEnv, archive?: () => ArchiveInputMediaDeps | undefined): WhatsAppChildReader {
  return createWhatsAppChildReader({
    mediaRoots: defaultWhatsAppMediaRoots(env),
    relocate: whatsappMovedPathMapper(env),
    ...(archive ? { archive } : {}),
  });
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
    return new WhatsAppExtractionSource({
      id: `${input.config.corpusId}:extraction`,
      corpusId: input.config.corpusId,
      provider: input.config.provider,
      accountScope: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
      approvedScopeKey: input.config.scopes[0]!,
      candidates: connectorStoreExtractionCandidateReader(reader),
      locators: reader,
      mediaRoots: defaultWhatsAppMediaRoots(env),
      relocateLocator: whatsappMovedPathMapper(env),
      deferredBytes: (ref) => deferredBytesAnswerFor(reader.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
      readChild,
    });
  };
}
