// Live canary 2026-10-29: source_index_status labelled Files on this computer
// "Files", because its corpus ids (*.local.files) read as provider "local".

import { describe, expect, test } from 'bun:test';
import { defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { providerSourceLabel } from '../src/core/remote-result.ts';

describe('source_index_status provider', () => {
  test('Files on this computer reports its own provider, so the remote label names it', async () => {
    const definitions = () => ['secure_local.local.files', 'internal.local.files', 'internal.dropbox.files'].map((corpusId) => defineConnectorCorpus({
      corpusId, family: 'file', trustDomain: corpusId.startsWith('secure_local') ? 'secure_local' : 'internal',
    }));
    const status = await createSourceIndexStatusHandler({ corpusDefinitions: definitions }).status({});
    expect(status.corpora.map((corpus) => corpus.provider)).toEqual(['local_files', 'local_files', 'dropbox']);
    expect(providerSourceLabel('local_files')).toBe('Files on this computer');
  });
});
