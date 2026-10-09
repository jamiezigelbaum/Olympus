import { describe, expect, test } from 'bun:test';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { standaloneDashboardControllerScript } from '../src/workers/dashboard/components.ts';
import {
  PRIVACY_FOLDER_SOURCE_NAMES,
  privacyLogic,
  type PrivacyViewRule,
} from '../src/workers/dashboard/shared-privacy-logic.ts';

/**
 * The privacy rules the ChatGPT panel and the local Privacy editor share
 * (shared-privacy-logic.ts), pinned on their own: the behaviours
 * test/chatgpt-privacy-ui.test.ts covers through the panel, held here for
 * both editors.
 */
const L = privacyLogic({ mailSourceId: 'gmail.email', folderSources: { ...PRIVACY_FOLDER_SOURCE_NAMES } });

const view = (rule: Record<string, unknown>, display = '') => L.viewRule(rule, display || L.displayOf(rule, 'A folder in Dropbox'));

describe('rules in the engine\'s shape', () => {
  test('a sender, a label and a folder each have their own shape; display is a folder\'s, and optional', () => {
    expect(L.validRule({ kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' })).toBe(true);
    expect(L.validRule({ kind: 'sender', source_id: 'dropbox.files', value: '@clinic.example' })).toBe(false);
    expect(L.validRule({ kind: 'label', source_id: 'gmail.email', key: 'Label_12', value: 'Lawyer' })).toBe(true);
    expect(L.validRule({ kind: 'label', source_id: 'gmail.email', key: 'Label_12' })).toBe(false);
    expect(L.validRule({ kind: 'folder', source_id: 'dropbox.files', key: '/health' })).toBe(true);
    expect(L.validRule({ kind: 'folder', source_id: 'google_drive.docs', key: 'opaque', display: 'Health' })).toBe(true);
    expect(L.validRule({ kind: 'folder', source_id: 'gmail.email', key: '/health' })).toBe(false);
    expect(L.validRule({ kind: 'folder', source_id: 'dropbox.files', key: '/x', display: 5 })).toBe(false);
    expect(L.validRule({ kind: 'public', source_id: 'gmail.email', value: 'x' })).toBe(false);
  });

  test('a folder saved without its name is named for its account, and goes back exactly as saved', () => {
    const raw = { kind: 'folder', source_id: 'dropbox.files', key: '/Taxes/2025' };
    expect(L.displayOf(raw, 'A folder in Dropbox')).toBe('A folder in Dropbox');
    expect(L.displayOf({ ...raw, display: 'Taxes' }, 'unused')).toBe('Taxes');
    expect(L.displayOf({ kind: 'label', source_id: 'gmail.email', key: 'L1', value: 'Lawyer' }, 'unused')).toBe('Lawyer');
    const loaded = view(raw);
    expect(loaded.saved).toBe(true);
    expect(L.ruleOut(loaded)).toEqual(raw);
    expect(L.ruleOut(loaded)).not.toHaveProperty('display');
  });

  test('a new rule goes out in the contract\'s shape: a folder with its name, no local flags', () => {
    expect(L.ruleOut({ kind: 'folder', source_id: 'dropbox.files', key: '/Therapy', display: 'Therapy', removed: false }))
      .toEqual({ kind: 'folder', source_id: 'dropbox.files', key: '/Therapy', display: 'Therapy' });
    expect(L.ruleOut({ kind: 'sender', source_id: 'gmail.email', value: 'a@b.example', display: 'a@b.example', removed: false }))
      .toEqual({ kind: 'sender', source_id: 'gmail.email', value: 'a@b.example' });
  });
});

describe('one rule, one identity', () => {
  test('a label renamed elsewhere is the same rule; a sender in another case or with spaces too', () => {
    expect(L.identity({ kind: 'label', source_id: 'gmail.email', key: 'Label_12', value: 'Lawyer' }))
      .toBe(L.identity({ kind: 'label', source_id: 'gmail.email', key: 'Label_12', value: 'Legal' }));
    expect(L.identity({ kind: 'sender', source_id: 'gmail.email', value: ' Billing@Clinic.Example ' }))
      .toBe(L.identity({ kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' }));
    expect(L.identity({ kind: 'folder', source_id: 'dropbox.files', key: '/a' }))
      .not.toBe(L.identity({ kind: 'folder', source_id: 'google_drive.docs', key: '/a' }));
  });

  test('adding a rule already on the list brings it back instead of adding it twice', () => {
    const rules: PrivacyViewRule[] = [{ ...view({ kind: 'sender', source_id: 'gmail.email', value: 'a@b.example' }), removed: true }];
    L.addTo(rules, { kind: 'sender', source_id: 'gmail.email', value: 'A@B.example', display: 'A@B.example', removed: false });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.removed).toBe(false);
  });

  test('a typed sender becomes a trimmed lower-case address or @domain, or nothing', () => {
    expect(L.senderValue('  Name@Example.COM ')).toBe('name@example.com');
    expect(L.senderValue('@clinic.example')).toBe('@clinic.example');
    expect(L.senderValue('not an address')).toBe('');
  });
});

describe('what a save lowers', () => {
  const saved = () => [
    view({ kind: 'label', source_id: 'gmail.email', key: 'L1', value: 'Lawyer' }),
    view({ kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' }),
  ];

  test('adding protection lowers nothing; removing a saved rule or changing the words does', () => {
    const rules = saved();
    rules.push({ kind: 'sender', source_id: 'gmail.email', value: 'new@x.example', display: 'new@x.example', removed: false });
    expect(L.lowers(rules, 'health', 'health')).toBe(false);
    // The words changed back are no change.
    expect(L.lowers(rules, ' health ', 'health')).toBe(false);
    expect(L.lowers(rules, 'health and money', 'health')).toBe(true);
    rules[0]!.removed = true;
    const change = L.lowering(rules, 'health', 'health');
    expect(change.removed.map((rule: PrivacyViewRule) => rule.display)).toEqual(['Lawyer']);
    expect(change.described).toBe(false);
  });

  test('removing a rule added in this draft lowers nothing: it was never saved', () => {
    const rules: PrivacyViewRule[] = [{ kind: 'sender', source_id: 'gmail.email', value: 'a@b.example', display: 'a@b.example', removed: true }];
    expect(L.lowers(rules, '', '')).toBe(false);
  });
});

describe('replaying a draft onto settings changed elsewhere', () => {
  test('removals stay removed by identity, additions come back, a changed description is kept, new saved rules stay', () => {
    const draft = [
      { ...view({ kind: 'label', source_id: 'gmail.email', key: 'L1', value: 'Lawyer' }), removed: true },
      view({ kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' }),
      { kind: 'sender', source_id: 'gmail.email', value: 'me@here.example', display: 'me@here.example', removed: false } as PrivacyViewRule,
    ];
    const fresh = [
      // Renamed elsewhere: still the rule the person removed.
      view({ kind: 'label', source_id: 'gmail.email', key: 'L1', value: 'Legal' }),
      view({ kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' }),
      view({ kind: 'sender', source_id: 'gmail.email', value: 'new@elsewhere.example' }),
    ];
    const replayed = L.replay({ rules: draft, description: 'my kids', savedDescription: 'health' }, fresh);
    expect(replayed.description).toBe('my kids');
    expect(replayed.rules.map((rule: PrivacyViewRule) => [rule.display, rule.removed, !!rule.saved])).toEqual([
      ['Legal', true, true],
      ['billing@clinic.example', false, true],
      ['new@elsewhere.example', false, true],
      ['me@here.example', false, false],
    ]);
    // Measured against what is saved now, the replayed draft still lowers (the label).
    expect(L.lowers(replayed.rules, 'my kids', 'health')).toBe(true);
    expect(L.replay({ rules: [], description: 'health', savedDescription: 'health' }, []).description).toBeNull();
  });
});

describe('one implementation in both pages', () => {
  test('the logic is self-contained, so either page can inline it', () => {
    // A copy evaluated with nothing in scope behaves like the imported one.
    const copy = new Function(`return (${privacyLogic.toString()});`)() as typeof privacyLogic;
    const inlined = copy({ mailSourceId: 'gmail.email', folderSources: { 'dropbox.files': 'Dropbox' } });
    expect(inlined.identity({ kind: 'sender', source_id: 'gmail.email', value: ' A@B.example' })).toBe(L.identity({ kind: 'sender', source_id: 'gmail.email', value: 'a@b.example' }));
    expect(inlined.validRule({ kind: 'folder', source_id: 'dropbox.files', key: '/x' })).toBe(true);
  });

  // Unified dashboard phase 4: the panel is the only privacy editor.
  test('the ChatGPT panel carries it', () => {
    const source = privacyLogic.toString().split('\n')[0]!.trim();
    expect(chatgptDashboardPageHtml()).toContain(source);
  });
});
