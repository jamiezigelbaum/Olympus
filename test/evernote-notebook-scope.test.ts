// Choosing Evernote notebooks before anything is read: the picker's notebook
// list, the owner's exclusion rules on top of the choice, and an always-Private
// notebook rule matching the notes the connector emits.
import { describe, expect, test } from 'bun:test';
import { getFileScopeSource } from '../src/core/file-scope-sources.ts';
import { createSourceExclusionMatcher, loadSourceIngestionExclusions } from '../src/core/source-ingestion-exclusions.ts';
import { privacyRuleToTierRule } from '../src/workers/classification/privacy-profile.ts';
import { ownerRuleMatches } from '../src/workers/classification/tier-classifier.ts';
import { EVERNOTE_PROVIDER, EVERNOTE_SOURCE_ID, type EvernoteNotebookGate } from '../src/workers/evernote/connector.ts';
import { evernoteNotebookGate } from '../src/workers/evernote/live-sync.ts';
import { createEvernoteNotebookScopeBrowser } from '../src/workers/source-scope-browser.ts';

const NOTEBOOKS = [
  { id: 'nb-work', label: 'Work', owned: true },
  { id: 'nb-clients', label: 'Clients', owned: true },
  { id: 'nb-friend', label: 'From a friend', owned: false },
];

describe('the Evernote notebook picker', () => {
  test('Evernote is a folder-scoped source bound to its sign-in', () => {
    expect(getFileScopeSource(EVERNOTE_SOURCE_ID)).toMatchObject({
      provider: EVERNOTE_PROVIDER,
      account: 'provider_account',
      credentialCapability: 'evernote.notes.sync',
      filterFamily: 'folder_id',
      corpusIdsToInvalidate: ['secure_local.evernote.notes', 'internal.evernote.notes'],
    });
  });

  test('lists every notebook by name on one level; one the account does not own cannot be chosen', async () => {
    const browser = createEvernoteNotebookScopeBrowser({ listNotebooks: async () => NOTEBOOKS });
    const page = await browser.browse({});
    expect(page.nodes.map((node) => [node.name, node.selectable, node.has_children])).toEqual([
      ['Clients', true, false],
      ['From a friend', false, false],
      ['Work', true, false],
    ]);
    expect(page.nodes.find((node) => node.key === 'nb-friend')).toMatchObject({ excluded_by_default: true });
    expect((await browser.browse({ parentKey: 'nb-work' })).nodes).toEqual([]);
  });

  test('a save naming a notebook that is not one of the account\'s own is refused', async () => {
    const browser = createEvernoteNotebookScopeBrowser({ listNotebooks: async () => NOTEBOOKS });
    expect(await browser.validateSelections([{ key: 'nb-clients', state: 'exclude' }]))
      .toEqual([{ key: 'nb-clients', state: 'exclude', ancestorKeys: [] }]);
    await expect(browser.validateSelections([{ key: 'nb-friend', state: 'ingest' }])).rejects.toThrow('Reload the picker');
    await expect(browser.validateSelections([{ key: 'nb-gone', state: 'exclude' }])).rejects.toThrow('Reload the picker');
  });
});

describe('the owner\'s exclusion rules on top of the choice', () => {
  const rules = (list: unknown[]) => createSourceExclusionMatcher(
    loadSourceIngestionExclusions({ inlineExclusions: { schemaVersion: 1, rules: list } }),
    EVERNOTE_SOURCE_ID,
    { enforceable: ['path_prefix', 'folder_id'] },
  );
  const all: EvernoteNotebookGate = () => 'ingest';

  test('a rule naming a notebook by id or by name excludes it even when the picker chose to read it', () => {
    const gate = evernoteNotebookGate(all, rules([
      { id: 'clients', sources: [EVERNOTE_SOURCE_ID], folder_ids: [{ id: 'nb-clients', name: 'Clients' }], reason: 'client records' },
      { id: 'journal', sources: [EVERNOTE_SOURCE_ID], mode: 'metadata_only', path_prefixes: ['/Journal'], reason: 'titles only' },
    ]));
    expect(gate({ id: 'nb-clients', label: 'Clients' })).toBe('exclude');
    expect(gate({ id: 'nb-journal', label: 'Journal' })).toBe('metadata_only');
    expect(gate({ id: 'nb-work', label: 'Work' })).toBe('ingest');
  });

  test('the stricter of the choice and the rules wins', () => {
    const gate = evernoteNotebookGate(() => 'exclude', rules([
      { id: 'journal', sources: [EVERNOTE_SOURCE_ID], mode: 'metadata_only', path_prefixes: ['/Journal'], reason: 'titles only' },
    ]));
    expect(gate({ id: 'nb-journal', label: 'Journal' })).toBe('exclude');
  });

  test('no rules for Evernote: the choice stands', () => {
    const gate = evernoteNotebookGate((book) => (book.id === 'nb-work' ? 'ingest' : 'metadata_only'), rules([]));
    expect(gate({ id: 'nb-work', label: 'Work' })).toBe('ingest');
    expect(gate({ id: 'nb-clients', label: 'Clients' })).toBe('metadata_only');
  });
});

describe('an always-Private notebook', () => {
  test('the rule the privacy page saves for a notebook matches the notebook\'s notes, by id', () => {
    const rule = privacyRuleToTierRule({ kind: 'folder', source_id: 'evernote.notes', key: 'nb-clients' });
    expect(rule).toMatchObject({ source: EVERNOTE_PROVIDER, tier: 'secure' });
    // The connector publishes a note's notebook name and id as its folder keys (evernote-connector.test.ts).
    expect(ownerRuleMatches(rule, { folderKeys: ['Clients', 'nb-clients'] }, EVERNOTE_PROVIDER)).toBe(true);
    expect(ownerRuleMatches(rule, { folderKeys: ['Work', 'nb-work'] }, EVERNOTE_PROVIDER)).toBe(false);
  });
});
