import { defineSourceIndexCorpus, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';

export const DROPBOX_FILES_CORPUS_ID = 'secure_local.dropbox.files';

/**
 * The scheduler/allowlist identity for this source. Deliberately NOT the
 * ingestion policy's `source` field: that field holds `dropbox.personal`, a
 * credential handle name from a different namespace, and the scheduler factory
 * once stamped it onto the source. An admitted `dropbox.files` then went
 * missing while every gate input read true (2026-07-28).
 */
export const DROPBOX_FILES_SOURCE_ID = 'dropbox.files';

export function defineDropboxFilesCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    description: 'Secure-local Dropbox file metadata, revisions, and bounded extraction state for approved scopes.',
  });
}
