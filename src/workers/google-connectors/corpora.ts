import { defineSourceIndexCorpus, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
} from './gmail.ts';
import { GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID } from './drive.ts';

export const GMAIL_SECURE_LOCAL_CORPUS_ID = GMAIL_SECURE_CONNECTOR_CORPUS_ID;
export const INTERNAL_EMAIL_CORPUS_ID = GMAIL_INTERNAL_CONNECTOR_CORPUS_ID;
export const GOOGLE_DRIVE_DOCS_CORPUS_ID = GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID;

export type GmailEmailCorpusId =
  | typeof GMAIL_SECURE_LOCAL_CORPUS_ID
  | typeof INTERNAL_EMAIL_CORPUS_ID;

export function defineGmailSecureLocalCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: GMAIL_SECURE_LOCAL_CORPUS_ID,
    family: 'email',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    description: 'Private Gmail evidence stored and retrieved through the shared connector store.',
  });
}

export function defineInternalEmailCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: INTERNAL_EMAIL_CORPUS_ID,
    family: 'email',
    trustDomain: 'internal',
    activationMode: 'hybrid_shadow',
    storageProfileInput: {
      placement: 'local_private',
      embeddingBackend: 'local',
      cloudQueryApproved: false,
    },
    description: 'Internal Gmail evidence stored and retrieved through the shared connector store.',
  });
}

export function gmailEmailCorpusTrustDomainForCorpusId(
  corpusId: GmailEmailCorpusId,
): 'internal' | 'secure_local' {
  return corpusId === INTERNAL_EMAIL_CORPUS_ID ? 'internal' : 'secure_local';
}

export function defineGoogleDriveDocsCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: GOOGLE_DRIVE_DOCS_CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
    activationMode: 'hybrid_primary',
    storageProfileInput: {
      cloudEmbeddingApproved: true,
      cloudQueryApproved: true,
    },
    description: 'Internal Google Drive evidence stored and retrieved through the shared connector store.',
  });
}
