// G0 declarations. Only the diagnostic consumes this catalog. Extraction homes
// are the roster entries that schedule work; a home may read sibling tier stores.
import { archiveCorpusId, archiveImportFamilies } from './archive-formats.ts';
import { mountedStoreSources } from './olympus-layout.ts';
import type { SourceCorpusConfig } from './source-corpus-registry.ts';
import { admitsSearchCorpus, type AdmissionRegistration } from './admission.ts';

export interface SourceAdmissionDefinition extends AdmissionRegistration {
  sourceId: string;
  corpora: readonly string[];
  extractionHomes: readonly string[];
}

export function sourceAdmissionDefinitions(): SourceAdmissionDefinition[] {
  const archives = archiveImportFamilies();
  return [
    { sourceId: 'gmail.email', matchers: ['account', 'label', 'sender'], liveScope: 'observed',
      retainedOnDevice: true, importObservationPrefix: 'archive.',
      corpora: ['internal.email', 'secure_local.email.private', 'public_safe.email'],
      extractionHomes: ['internal.email', 'secure_local.email.private'] },
    { sourceId: 'google_drive.docs', matchers: ['account', 'container_key'], selection: 'container_key',
      corpora: ['internal.drive.docs', 'secure_local.drive.docs', 'public_safe.drive.docs'],
      extractionHomes: ['internal.drive.docs', 'secure_local.drive.docs'] },
    { sourceId: 'dropbox.files', matchers: ['account', 'path_prefix'], selection: 'path_prefix',
      corpora: ['internal.dropbox.files', 'secure_local.dropbox.files', 'public_safe.dropbox.files'],
      extractionHomes: ['secure_local.dropbox.files'] },
    { sourceId: 'local.files', matchers: ['account', 'path_prefix'], selection: 'path_prefix', requiresRecovery: true,
      corpora: ['internal.local.files', 'secure_local.local.files', 'public_safe.local.files'],
      extractionHomes: ['secure_local.local.files'] },
    { sourceId: 'evernote.notes', matchers: ['account', 'container_key'], selection: 'container_key', exactKeys: true,
      corpora: ['internal.evernote.notes', 'secure_local.evernote.notes'], extractionHomes: ['secure_local.evernote.notes'] },
    { sourceId: 'telegram.messages', matchers: ['account', 'conversation', 'sender'],
      corpora: ['internal.telegram.messages', 'secure_local.telegram.protected.messages'],
      extractionHomes: ['internal.telegram.messages', 'secure_local.telegram.protected.messages'] },
    { sourceId: 'whatsapp.personal.messages', matchers: ['account', 'conversation', 'sender'],
      corpora: ['internal.whatsapp.messages', 'secure_local.whatsapp.messages'], extractionHomes: ['secure_local.whatsapp.messages'] },
    { sourceId: 'readwise.library', matchers: ['account'],
      corpora: ['internal.readwise.library', 'secure_local.readwise.library'], extractionHomes: [] },
    { sourceId: 'x.bookmarks', matchers: ['account', 'container_key'],
      corpora: ['internal.x.bookmarks', 'secure_local.x.bookmarks'], extractionHomes: [] },
    { sourceId: 'archive.imports', provenance: 'owner_import', matchers: ['account'],
      corpora: archives.flatMap(family => (['public_safe', 'internal', 'secure_local'] as const).map(tier => archiveCorpusId(tier, family))),
      extractionHomes: archives.map(family => archiveCorpusId('secure_local', family)) },
    ...mountedStoreSources().map(sourceId => ({ sourceId, corpora: [`secure_local.${sourceId}`],
      matchers: ['account'] as const, extractionHomes: [] })),
  ];
}

// The connector declares support. Installation settings can narrow each corpus
// independently, and extraction can also have an operator-configured roster entry.
export function corpusAdmissions(definition: SourceAdmissionDefinition, corpus: SourceCorpusConfig, input: {
  mounted: boolean;
  requested: ReadonlySet<string>;
  tierCorpusIds?: ReadonlySet<string>;
  configuredExtraction?: ReadonlySet<string>;
}) {
  const id = corpus.corpusId;
  const declared = definition.sourceId === corpus.sourceId && definition.corpora.includes(id);
  const registered = declared && corpus.enabled !== false;
  const extractionHome = declared && definition.extractionHomes.includes(id);
  return {
    registered,
    answer: registered && corpus.capabilities.includes('answer'),
    status: registered && corpus.capabilities.includes('status'),
    extract: input.mounted && (extractionHome || input.configuredExtraction?.has(id) === true),
    search: admitsSearchCorpus({ ...input, corpusId: id, enabled: registered, searchable: corpus.capabilities.includes('search') }),
  };
}
