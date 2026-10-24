// Several formats in one family and formats in other families: the store sets
// belong to the family and are named neutrally when its formats differ, every
// item keeps its own format's provider and citation, the Archives card holds
// every family's stores, and the dashboard names a family's items in its own
// words. Fake formats only; nothing here reads a file.

import { describe, expect, test } from 'bun:test';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_FORMATS,
  ARCHIVE_NEUTRAL_PROVIDER,
  MBOX_ARCHIVE_FORMAT,
  archiveFamilyProvider,
  archiveFormatForProvider,
  archiveFormatsOfFamily,
  archiveImportFamilies,
  isArchiveProvider,
  type ArchiveFormatDefinition,
} from '../src/core/archive-formats.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { archiveCorpusId, archiveImportCorpora, withArchiveImportCorpora } from '../src/workers/archive-import/store.ts';
import {
  DASHBOARD_ARCHIVE_COPY,
  DASHBOARD_ARCHIVE_NOUNS,
  archivePickIntro,
  dashboardArchiveNouns,
} from '../src/workers/dashboard/vocabulary.ts';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';

function fake(id: string, family: ArchiveFormatDefinition['family'], provider: string, extra: Partial<ArchiveFormatDefinition> = {}): ArchiveFormatDefinition {
  return { id, label: `Fake ${id}`, family, provider, detect: () => undefined, ...extra };
}

const SECOND_MAIL = fake('fakemail', 'email', 'fake_mail', { citationLabel: 'Imported fake mail' });
const NOTES = fake('fakenotes', 'note', 'fake_notes', { citationLabel: 'Imported notes', chooseHint: 'a notes export (a .zip file)' });

describe('store sets belong to the family, not to its first format', () => {
  test('one format in a family: its provider names the family\'s stores, as before', () => {
    const corpora = archiveImportCorpora([MBOX_ARCHIVE_FORMAT]);
    expect(corpora.map((corpus) => [corpus.corpusId, corpus.provider, corpus.family])).toEqual([
      ['secure_local.archive.email', 'mbox', 'email'],
      ['internal.archive.email', 'mbox', 'email'],
      ['public_safe.archive.email', 'mbox', 'email'],
    ]);
    // The default is the registered formats.
    expect(archiveImportCorpora().filter((corpus) => corpus.family === 'email').map((corpus) => corpus.corpusId)).toEqual(corpora.map((corpus) => corpus.corpusId));
    // Two chat formats share one family, so its stores carry the neutral provider.
    expect(archiveImportCorpora().filter((corpus) => corpus.family === 'chat').map((corpus) => [corpus.corpusId, corpus.provider])).toEqual([
      ['secure_local.archive.chat', ARCHIVE_NEUTRAL_PROVIDER],
      ['internal.archive.chat', ARCHIVE_NEUTRAL_PROVIDER],
      ['public_safe.archive.chat', ARCHIVE_NEUTRAL_PROVIDER],
    ]);
    expect(ARCHIVE_FORMATS).toContain(MBOX_ARCHIVE_FORMAT);
  });

  test('two formats in one family: the stores carry the neutral name, not whichever format came first', () => {
    for (const formats of [[MBOX_ARCHIVE_FORMAT, SECOND_MAIL], [SECOND_MAIL, MBOX_ARCHIVE_FORMAT]]) {
      const corpora = archiveImportCorpora(formats);
      expect(corpora).toHaveLength(3);
      expect(new Set(corpora.map((corpus) => corpus.provider))).toEqual(new Set([ARCHIVE_NEUTRAL_PROVIDER]));
      expect(archiveFamilyProvider('email', formats)).toBe(ARCHIVE_NEUTRAL_PROVIDER);
    }
  });

  test('a second family gets its own stores and keeps its own provider while it has one format', () => {
    const formats = [MBOX_ARCHIVE_FORMAT, SECOND_MAIL, NOTES];
    expect(archiveImportFamilies(formats)).toEqual(['email', 'note']);
    const byId = new Map(archiveImportCorpora(formats).map((corpus) => [corpus.corpusId, corpus]));
    expect(byId.size).toBe(6);
    expect(byId.get(archiveCorpusId('secure_local', 'email'))!.provider).toBe(ARCHIVE_NEUTRAL_PROVIDER);
    expect(byId.get(archiveCorpusId('secure_local', 'note'))).toMatchObject({ provider: 'fake_notes', family: 'note', sourceId: 'archive.imports' });
    for (const tier of ['secure_local', 'internal', 'public_safe'] as const) {
      expect(byId.get(archiveCorpusId(tier, 'note'))!.trustDomain).toBe(tier);
    }
  });

  test('the registry the runtime builds holds every family\'s stores under the archives source', () => {
    const registry = createSourceCorpusRegistry(withArchiveImportCorpora());
    const found = registry.list().filter((corpus) => corpus.sourceId === 'archive.imports');
    expect(found.map((corpus) => corpus.corpusId).sort()).toEqual(
      archiveImportCorpora().map((corpus) => corpus.corpusId).sort(),
    );
  });

  test('every item keeps its own format\'s provider and citation, whatever its family\'s stores are called', () => {
    const formats = [MBOX_ARCHIVE_FORMAT, SECOND_MAIL, NOTES];
    expect(archiveFormatForProvider('mbox', formats)?.citationLabel).toBe('Imported mail');
    expect(archiveFormatForProvider('fake_mail', formats)?.citationLabel).toBe('Imported fake mail');
    expect(archiveFormatForProvider('fake_notes', formats)?.citationLabel).toBe('Imported notes');
    expect(archiveFormatForProvider(ARCHIVE_NEUTRAL_PROVIDER, formats)).toBeUndefined();
    expect(archiveFormatsOfFamily('email', formats).map((format) => format.id)).toEqual(['mbox', 'fakemail']);
  });

  test('a provider is an archive\'s when a format has it or it is the neutral name; nothing else is', () => {
    const formats = [MBOX_ARCHIVE_FORMAT, NOTES];
    for (const provider of ['mbox', 'fake_notes', ARCHIVE_NEUTRAL_PROVIDER]) expect(isArchiveProvider(provider, formats)).toBe(true);
    for (const provider of ['gmail', 'local_files', 'fake_mail', '']) expect(isArchiveProvider(provider, formats)).toBe(false);
    expect(isArchiveProvider('mbox')).toBe(true);
  });
});

describe('the Archives card holds every family\'s stores', () => {
  test('a notes archive\'s store set is counted on the card, not set aside as unassigned', () => {
    const view = buildDashboardPreviewView('archives-notes');
    const card = view.sources.find((source) => source.source_id === 'archive.imports')!;
    expect(card.coverage.indexed_items).toBe(3_412);
    expect(view.unassigned_corpora).toMatchObject({ corpus_count: 0, entries: [] });
    // The card is the archives', not any one format's.
    expect(card.provider).toBe(ARCHIVE_NEUTRAL_PROVIDER);
  });

  test('a WhatsApp chat archive\'s store set is counted on the card, not set aside as unassigned', () => {
    const view = buildDashboardPreviewView('archives-chat-whatsapp');
    const card = view.sources.find((source) => source.source_id === 'archive.imports')!;
    expect(card.coverage.indexed_items).toBe(12_644);
    expect(view.unassigned_corpora).toMatchObject({ corpus_count: 0, entries: [] });
    expect(card.provider).toBe(ARCHIVE_NEUTRAL_PROVIDER);
  });

  test('a mail archive is on the card as before', () => {
    const view = buildDashboardPreviewView('archives-imported');
    const card = view.sources.find((source) => source.source_id === 'archive.imports')!;
    expect(card.coverage.indexed_items).toBe(48_210);
    expect(view.unassigned_corpora).toMatchObject({ corpus_count: 0, entries: [] });
  });
});

describe('the dashboard words come from the registry and the family', () => {
  test('the picker names each registered format in its own words, or its label', () => {
    // The shipped copy names every format the product reads, in the registry's order.
    expect(archivePickIntro()).toBe(DASHBOARD_ARCHIVE_COPY.pick.intro);
    for (const format of ARCHIVE_FORMATS) expect(DASHBOARD_ARCHIVE_COPY.pick.intro).toContain(format.chooseHint ?? format.label);
    const one = archivePickIntro([MBOX_ARCHIVE_FORMAT]);
    expect(one).toContain(MBOX_ARCHIVE_FORMAT.chooseHint!);
    // The words the dashboard ships name every registered format.
    expect(archivePickIntro(ARCHIVE_FORMATS)).toBe(DASHBOARD_ARCHIVE_COPY.pick.intro);
    for (const format of ARCHIVE_FORMATS) expect(DASHBOARD_ARCHIVE_COPY.pick.intro).toContain(format.chooseHint ?? format.label);
    const two = archivePickIntro([MBOX_ARCHIVE_FORMAT, NOTES, SECOND_MAIL]);
    expect(two).toContain('a notes export (a .zip file)');
    expect(two).toContain('; or Fake fakemail');
    expect(two.startsWith('Choose a file or folder on this computer: ')).toBe(true);
    expect(two.endsWith('Olympus reads it where it is and never changes it.')).toBe(true);
  });

  test('a family\'s nouns: messages for mail and chat, notes for notes, items for anything else', () => {
    expect(dashboardArchiveNouns('email').plural).toBe('messages');
    expect(dashboardArchiveNouns('chat').many).toBe('{n} messages');
    expect(dashboardArchiveNouns('note').one).toBe('1 note');
    expect(dashboardArchiveNouns('note').none).toBe('no notes');
    for (const family of ['file', 'unheard-of', undefined, 7, '__proto__', 'constructor']) {
      expect(dashboardArchiveNouns(family)).toBe(DASHBOARD_ARCHIVE_NOUNS.other);
    }
    for (const nouns of Object.values(DASHBOARD_ARCHIVE_NOUNS)) expect(nouns.many).toContain('{n}');
  });

  test('only a chat archive is a snapshot: the family says so beside its dates, mail and notes do not', () => {
    expect(dashboardArchiveNouns('chat').snapshot).toBe('Snapshot, not updated');
    for (const family of ['email', 'note', 'other', 'unheard-of', undefined]) expect(dashboardArchiveNouns(family).snapshot).toBe('');
  });

  test('what a chat export leaves out has its own plain sentence, one and many, never the catch-all', () => {
    for (const kind of ['system_message', 'message_empty', 'status_updates'] as const) {
      const sentence = DASHBOARD_ARCHIVE_COPY.gaps[kind];
      expect(sentence.one.length).toBeGreaterThan(10);
      expect(sentence.many).toContain('{n}');
      expect(sentence).not.toBe(DASHBOARD_ARCHIVE_COPY.gaps.other);
    }
  });

  test('every kind of finding the spine reports has its own sentence, one and many, never the catch-all', () => {
    for (const kind of Object.values(ARCHIVE_COMMON_FINDINGS)) {
      const sentence = (DASHBOARD_ARCHIVE_COPY.gaps as Record<string, { one: string; many: string } | undefined>)[kind];
      expect(sentence).toBeDefined();
      expect(sentence!.one.length).toBeGreaterThan(10);
      expect(sentence!.many).toContain('{n}');
      expect(sentence).not.toBe(DASHBOARD_ARCHIVE_COPY.gaps.other);
    }
  });
});
