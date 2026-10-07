/**
 * The ChatGPT page's privacy setup and the dashboard's Privacy row, driven
 * against a fake MCP Apps host that serves the dashboard, privacy and scope
 * tools over JSON-RPC postMessage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { CHATGPT_PICKER_TOOLS, CHATGPT_SCOPE_META_KEY } from '../src/workers/dashboard/chatgpt/picker.ts';
import { CHATGPT_PRIVACY_META_KEY, CHATGPT_PRIVACY_TOOLS } from '../src/workers/dashboard/chatgpt/privacy.ts';
import { privacyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import type { PrivacyRuleView } from '../src/workers/chatgpt/dashboard-contract.ts';
import { DASHBOARD_CHATGPT_PRIVACY_COPY as W } from '../src/workers/dashboard/vocabulary.ts';

const P = CHATGPT_PRIVACY_TOOLS;
const S = CHATGPT_PICKER_TOOLS;
type Result = { structuredContent?: unknown; isError?: boolean; _meta?: Record<string, unknown> };
type Serve = (args: any) => Result | 'hang' | 'fail';

interface Host {
  win: Window;
  sent: any[];
  calls: Array<[string, unknown]>;
  serve: Record<string, Serve>;
  doc: Document;
  text(): string;
  button(label: string): HTMLButtonElement;
  hasButton(label: string): boolean;
  push(result: unknown): void;
  toolCalls(name?: string): any[];
  settle(): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(serve: Record<string, Serve>, openai: Record<string, any> = { displayMode: 'fullscreen' }): Host {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Host['calls'] = [];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      sent.push(message);
      if (message.method !== 'tools/call') return;
      const handler = serve[message.params.name];
      if (!handler) return;
      const answer = handler(message.params.arguments);
      if (answer === 'hang') return;
      setTimeout(() => dispatch(answer === 'fail'
        ? { jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'gone' } }
        : { jsonrpc: '2.0', id: message.id, result: answer }), 0);
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  (win as any).openai = {
    ...openai,
    notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
    requestDisplayMode: (args: unknown) => calls.push(['requestDisplayMode', args]),
    openExternal: (args: unknown) => calls.push(['openExternal', args]),
    setWidgetState: (args: unknown) => calls.push(['setWidgetState', args]),
  };
  new Function('window', 'document', script)(win, win.document);
  const buttons = () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[];
  const host: Host = {
    win,
    sent,
    calls,
    serve,
    doc: win.document as unknown as Document,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    button: (label) => {
      const found = buttons().find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
      if (!found) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    hasButton: (label) => buttons().some((node) => node.textContent === label),
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    toolCalls: (name) => sent.filter((message) => message.method === 'tools/call' && (!name || message.params.name === name))
      .map((message) => message.params.arguments),
    settle: async () => {
      for (let i = 0; i < 5; i++) await sleep(1);
    },
  };
  hosts.push(host);
  return host;
}

const ASK = { id: 'privacy', sentence: 'Tell Olympus what\'s private for you', fix: { label: 'Set up', tool: P.get, args: {} } };
const DROPBOX = { id: 'dropbox.files', label: 'Dropbox', group: 'cloud' as const, status: 'Fresh' as const };
const DRIVE = { id: 'google_drive.docs', label: 'Google Drive', group: 'cloud' as const, status: 'Fresh' as const };
const GMAIL = { id: 'gmail.email', label: 'Gmail', group: 'cloud' as const, status: 'Fresh' as const };

function model(privacy: Record<string, unknown> | null, overrides: Partial<DashboardViewModelV1> = {}): DashboardViewModelV1 {
  const base: any = {
    v: 1, connection: { state: 'ready' }, needsYou: [], sources: [DROPBOX, GMAIL],
    models: { embedding: { kind: 'built_in', state: 'ready' } }, generatedAt: new Date().toISOString(), ...overrides,
  };
  if (privacy) base.privacy = privacy;
  return base;
}
const unconfigured = () => model({ configured: false, pendingCount: 0 }, { needsYou: [ASK] });

// Private-looking names: they may appear only in the privacy and picker views and those tools' calls.
const DESCRIPTION = 'my health and my divorce';
const NAMES = ['Medical Records', 'Lawyer Letters', 'doctor@clinic.example', 'Therapy Notes', 'Tax Returns 2024', 'Kids School', DESCRIPTION];
const SAVED_RULES = [
  { kind: 'folder', source_id: 'dropbox.files', key: 'k-b', display: 'Medical Records' },
  { kind: 'label', source_id: 'gmail.email', key: 'Label_7', value: 'Lawyer Letters' },
  { kind: 'sender', source_id: 'gmail.email', value: 'doctor@clinic.example' },
];

/**
 * A privacy tool result exactly as the engine serializes it (response-builder.ts):
 * senders carry only `value`, labels `key` and `value`, folders `key` and an
 * optional `display`; the confirmation rides `_meta` only.
 */
function privacyResult(description: string, rules: unknown[], pendingCount = 0,
  extra: { revision?: string; confirmation?: string; status?: 'current' | 'saved' | 'conflict' } = {}): Result {
  return privacyToolResult(
    { configured: true, description, rules: rules as PrivacyRuleView[], pendingCount, revision: extra.revision ?? 'rev1' },
    extra.status ?? 'current',
    extra.confirmation,
  ) as Result;
}

const folderNode = (key: string, name: string, extra: Record<string, unknown> = {}) => ({ key, name, kind: 'folder', has_children: false, selectable: true, ...extra });
function browse(nodes: unknown[], source = 'dropbox.files'): Result {
  const list = { kind: 'folders', source_id: source, account_generation: 'g1', scope_revision: 'r1', status: 'approved', nodes, selections: [], whole_account_selected: false };
  return { structuredContent: { kind: 'folders', shown: nodes.length }, _meta: { [CHATGPT_SCOPE_META_KEY]: list } };
}
const LABELS = [{ id: 'SENT', name: 'SENT', system: true }, { id: 'Label_7', name: 'Lawyer Letters', system: false }, { id: 'Label_9', name: 'Kids School', system: false }];
function mailList(): Result {
  const list = {
    kind: 'mail', source_id: 'gmail.email', account_generation: 'g1', scope_revision: 'r1', status: 'approved',
    draft: { window: '2y', skipped_categories: [], skipped_labels: [], always_private_senders: [], skip_senders: [] },
    labels: LABELS, categories: [], sender_suggestions: [],
  };
  return { structuredContent: { kind: 'mail', shown: LABELS.length }, _meta: { [CHATGPT_SCOPE_META_KEY]: list } };
}
function scopeServer(args: any): Result {
  if (args.source_id === 'gmail.email') return mailList();
  if (args.parent_key === 'k-a') return browse([folderNode('k-a1', 'Therapy Notes')], args.source_id);
  if (args.parent_key) return browse([], args.source_id);
  return browse([folderNode('k-a', 'Tax Returns 2024', { has_children: true }), folderNode('k-b', 'Medical Records')], args.source_id);
}

interface Setup {
  host: Host;
  saves: any[];
}

async function openPrivacy(options: { description?: string; rules?: unknown[]; pending?: number; sources?: unknown[]; dashboard?: DashboardViewModelV1; setResult?: Serve; getResult?: Serve } = {}): Promise<Setup> {
  let issued = 0;
  const saves: any[] = [];
  const dashboard = options.dashboard ?? model({ configured: false, pendingCount: 0 }, { needsYou: [ASK], sources: (options.sources ?? [DROPBOX, GMAIL]) as any });
  const host = mount({
    olympus_dashboard: () => ({ structuredContent: dashboard }),
    // Like the engine: every get issues a fresh confirmation, only in _meta.
    [P.get]: options.getResult ?? (() => privacyResult(options.description ?? '', options.rules ?? [], options.pending ?? 0, { confirmation: `conf${++issued}` })),
    [P.set]: options.setResult ?? ((args) => {
      saves.push(args);
      return privacyResult(args.description ?? '', args.rules ?? [], 0, { status: 'saved' });
    }),
    [S.scopeList]: scopeServer,
  });
  host.push({ structuredContent: dashboard });
  host.button(dashboard.needsYou.length ? 'Set up' : W.edit).click();
  await host.settle();
  return { host, saves };
}

const JARGON = ['lane', 'guard', 'supervisor', 'chunk', 'epoch', 'reauth', 'embed', 'ingest', 'metadata', 'tier', 'scope'];
function expectNoJargon(host: Host) {
  const text = host.text().toLowerCase();
  for (const word of JARGON) expect(text).not.toContain(word);
}

/** Names leave the page only in the privacy tools' and the scope list's arguments. */
function expectNamesOnlyInPrivacy(host: Host) {
  const allowed = [P.get, P.set, S.scopeList];
  for (const message of host.sent) {
    if (message.method === 'tools/call' && allowed.includes(message.params.name)) continue;
    const raw = JSON.stringify(message);
    for (const name of NAMES) expect(raw).not.toContain(name);
  }
  for (const message of host.toolCalls(S.scopeList)) {
    const raw = JSON.stringify(message);
    for (const name of NAMES) expect(raw).not.toContain(name);
  }
  expect(host.sent.some((message) => String(message.method).includes('update-model-context'))).toBe(false);
  expect(host.calls.some(([name]) => name === 'setWidgetState')).toBe(false);
  expect(host.win.location.href).toBe('https://sandbox.test/');
}

/** The control in the list row that names this folder or label. */
function rowButton(host: Host, name: string): HTMLButtonElement {
  const row = Array.from(host.doc.querySelectorAll('.frow')).find((node) => (node.querySelector('.fname-text')?.textContent ?? '') === name);
  if (!row) throw new Error(`no row ${name}`);
  return row.querySelector('.btn') as unknown as HTMLButtonElement;
}

function ruleRows(host: Host): string[] {
  return Array.from(host.doc.querySelectorAll('.rule')).map((row) => (row.textContent ?? '').replace(/Remove|Undo/g, '').trim());
}

describe('the Privacy screen', () => {
  test('the needs-you item opens it and it renders the description, rules and waiting count from _meta', async () => {
    const { host } = await openPrivacy({ description: DESCRIPTION, rules: SAVED_RULES, pending: 12 });
    expect(host.toolCalls(P.get)).toEqual([{}]);
    const text = host.text();
    expect(text).toContain(W.title);
    expect(text).toContain(W.intro);
    expect(text).toContain(W.back);
    const area = host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    expect(area.value).toBe(DESCRIPTION);
    expect(area.placeholder).toBe(W.descriptionPlaceholder);
    expect(area.closest('label')!.textContent).toContain(W.descriptionLabel);
    expect(text).toContain(W.rulesTitle);
    expect(ruleRows(host)).toEqual(['Medical RecordsFolder in Dropbox', 'Lawyer LettersGmail label', 'doctor@clinic.exampleSender']);
    for (const label of [W.addFolder, W.addLabel, W.addSender]) expect(host.button(label).disabled).toBe(false);
    expect(text).toContain('12 items are waiting to be checked on your Mac.');
    // One accent: Save. Cancel is quiet.
    const primary = Array.from(host.doc.querySelectorAll('.btn.primary'));
    expect(primary.map((node) => node.textContent)).toEqual([W.save]);
    expect(host.button(W.cancel).className).not.toContain('primary');
    expectNoJargon(host);
    expectNamesOnlyInPrivacy(host);
  });

  test('says plainly what ChatGPT sees: under the description box, and under the always-private rules', async () => {
    const { host } = await openPrivacy({ description: DESCRIPTION, rules: SAVED_RULES });
    expect(W.descriptionShared).toBe('ChatGPT sees what you type here so it can save it; keep it to topics, like "my health", not details.');
    const field = host.doc.querySelector('label.field')!;
    const note = field.nextElementSibling!;
    expect(note.textContent).toBe(W.descriptionShared);
    expect(host.doc.querySelector('textarea')!.getAttribute('aria-describedby')).toBe(note.id);
    const rules = Array.from(host.doc.querySelectorAll('section.fsection')).find((node) => node.querySelector('h2')?.textContent === W.rulesTitle)!;
    expect(rules.lastElementChild!.textContent).toBe(W.namesShared);
    expect(W.namesShared).toContain('shown to ChatGPT');
  });

  test('no waiting line when nothing is waiting; one item reads in the singular', async () => {
    const none = await openPrivacy();
    expect(none.host.text()).not.toContain('waiting to be checked');
    expect(none.host.text()).toContain(W.rulesEmpty);
    const one = await openPrivacy({ pending: 1 });
    expect(one.host.text()).toContain('1 item is waiting to be checked on your Mac.');
  });

  test('a load failure says so inline and Try again loads again', async () => {
    let fail = true;
    const host = mount({
      [P.get]: () => (fail ? 'fail' : privacyResult(DESCRIPTION, [])),
    });
    host.push({ structuredContent: unconfigured() });
    host.button('Set up').click();
    await host.settle();
    expect(host.text()).toContain(W.loadFailed);
    fail = false;
    host.button(W.tryAgain).click();
    await host.settle();
    expect((host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe(DESCRIPTION);
  });
});

describe('adding rules', () => {
  test('Add a folder browses one level per screen and Make private adds the folder and returns', async () => {
    const { host } = await openPrivacy({ rules: [SAVED_RULES[0]] });
    host.button(W.addFolder).click();
    await host.settle();
    expect(host.toolCalls(S.scopeList)).toEqual([{ source_id: 'dropbox.files' }]);
    expect(host.text()).toContain(W.folderTitle);
    expect(host.text()).toContain(W.backToPrivacy);
    // No choices sheet, no Save in pick mode; an already-private folder says so.
    expect(host.doc.querySelector('.fstatus')).toBeNull();
    expect(host.doc.querySelector('.picker-footer')).toBeNull();
    expect(rowButton(host, 'Medical Records').textContent).toBe(W.alreadyPrivate);
    expect(rowButton(host, 'Medical Records').disabled).toBe(true);
    // Tapping a name drills in.
    host.button('Tax Returns 2024›').click();
    await host.settle();
    expect(host.toolCalls(S.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files', parent_key: 'k-a' });
    expect(host.text()).toContain('Therapy Notes');
    host.button('Make Therapy Notes private').click();
    await host.settle();
    expect(host.text()).toContain(W.title);
    expect(ruleRows(host)).toEqual(['Medical RecordsFolder in Dropbox', 'Therapy NotesFolder in Dropbox']);
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:add:folder');
    expectNamesOnlyInPrivacy(host);
  });

  test('with two folder sources the account comes first; Back from the picker returns without a rule', async () => {
    const { host } = await openPrivacy({ sources: [DROPBOX, DRIVE, GMAIL] });
    host.button(W.addFolder).click();
    expect(host.text()).toContain(W.folderSourceIntro);
    host.button('Google Drive›').click();
    await host.settle();
    expect(host.toolCalls(S.scopeList)).toEqual([{ source_id: 'google_drive.docs' }]);
    host.button(W.backToPrivacy).click();
    expect(host.text()).toContain(W.title);
    expect(ruleRows(host)).toEqual([]);
  });

  test('Add a folder is unavailable, with a reason, when no folder source is connected', async () => {
    const { host } = await openPrivacy({ sources: [GMAIL, { ...DROPBOX, status: 'Off' }] });
    expect(host.button(W.addFolder).disabled).toBe(true);
    expect(host.text()).toContain(W.needFolderSource);
  });

  test('Add a Gmail label lists the labels with Make private on each', async () => {
    const { host } = await openPrivacy({ rules: [SAVED_RULES[1]] });
    host.button(W.addLabel).click();
    await host.settle();
    expect(host.toolCalls(S.scopeList)).toEqual([{ source_id: 'gmail.email' }]);
    expect(host.text()).toContain(W.labelTitle);
    expect(host.text()).toContain('Sent');
    expect(rowButton(host, 'Lawyer Letters').textContent).toBe(W.alreadyPrivate);
    expect(rowButton(host, 'Lawyer Letters').disabled).toBe(true);
    host.button('Make Kids School private').click();
    expect(ruleRows(host)).toEqual(['Lawyer LettersGmail label', 'Kids SchoolGmail label']);
    expectNamesOnlyInPrivacy(host);
  });

  test('Add a sender checks for an address or @domain inline', async () => {
    const { host } = await openPrivacy({ rules: [SAVED_RULES[2]] });
    host.button(W.addSender).click();
    const input = () => host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    expect(input().closest('label')!.textContent).toContain(W.senderLabel);
    for (const bad of ['', 'clinic', 'name@', '@', '@nodot', 'two words@x.com']) {
      input().value = bad;
      input().dispatchEvent(new host.win.Event('input') as unknown as Event);
      host.button(W.senderAdd).click();
      expect(host.text()).toContain(W.senderInvalid);
      expect(input().getAttribute('aria-invalid')).toBe('true');
    }
    input().value = 'Doctor@Clinic.example';
    input().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    expect(host.text()).toContain(W.senderDuplicate);
    input().value = '@Example.com';
    input().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    expect(host.text()).toContain(W.title);
    expect(ruleRows(host)).toEqual(['doctor@clinic.exampleSender', '@example.comSender']);
  });

  test('Remove offers an inline Undo, no dialog', async () => {
    const { host } = await openPrivacy({ rules: SAVED_RULES });
    host.button('Remove Medical Records').click();
    expect(host.text()).toContain('Removed: Medical Records');
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:rule:0');
    host.button('Undo removing Medical Records').click();
    expect(host.text()).not.toContain('Removed:');
    expect(ruleRows(host)[0]).toBe('Medical RecordsFolder in Dropbox');
  });
});

describe('saving', () => {
  test('Save sends exactly the description and the kept rules, then returns to the dashboard', async () => {
    const { host, saves } = await openPrivacy({ description: 'old words', rules: SAVED_RULES });
    const area = host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    area.value = `  ${DESCRIPTION}\n`;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button('Remove Lawyer Letters').click();
    host.button(W.addSender).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    host.button(W.save).click();
    // Removing a rule and new words lower protection: an inline step names what goes, before anything is sent.
    const box = host.doc.querySelector('.confirm-box')!;
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain('This removes protection from Lawyer Letters.');
    expect(box.textContent).toContain(W.confirmDescription);
    expect(host.toolCalls(P.set)).toEqual([]);
    host.button(W.confirm).click();
    await host.settle();
    expect(saves).toEqual([{
      description: DESCRIPTION,
      // Loaded rules go back exactly as the engine sent them.
      rules: [
        { kind: 'folder', source_id: 'dropbox.files', key: 'k-b', display: 'Medical Records' },
        { kind: 'sender', source_id: 'gmail.email', value: 'doctor@clinic.example' },
        { kind: 'sender', source_id: 'gmail.email', value: '@example.com' },
      ],
      revision: 'rev1',
      confirmation: 'conf1',
    }]);
    expect(host.text()).toContain(W.saved);
    expect(host.text()).not.toContain(W.title);
    expect(host.toolCalls('olympus_dashboard').length).toBe(1);
    expectNamesOnlyInPrivacy(host);
  });

  test('a failed save keeps the changes and says so inline', async () => {
    const { host } = await openPrivacy({ setResult: () => ({ isError: true, structuredContent: {} }) });
    const area = host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    area.value = DESCRIPTION;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.save).click();
    host.button(W.confirm).click();
    await host.settle();
    expect(host.text()).toContain(W.saveFailed);
    expect((host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe(DESCRIPTION);
  });

  test('adding protection saves at once, with the revision and no confirmation', async () => {
    const { host, saves } = await openPrivacy({ description: 'old words', rules: SAVED_RULES });
    host.button(W.addSender).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    host.button(W.save).click();
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].revision).toBe('rev1');
    expect(saves[0].confirmation).toBeUndefined();
    expect(host.text()).toContain(W.saved);
  });

  test('Cancel in the confirmation step sends nothing and keeps the changes', async () => {
    const { host } = await openPrivacy({ rules: SAVED_RULES });
    host.button('Remove Medical Records').click();
    host.button(W.save).click();
    expect(host.text()).toContain('This removes protection from Medical Records.');
    host.button(W.cancel).click();
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    expect(host.text()).toContain('Removed: Medical Records');
    expect(host.toolCalls(P.set)).toEqual([]);
    // Undoing the removal leaves nothing to confirm.
    host.button('Undo removing Medical Records').click();
    host.button(W.save).click();
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
  });

  test('settings changed elsewhere: the draft stays, the saved settings are shown, and the person applies their changes again or discards them', async () => {
    const theirs = [...SAVED_RULES, { kind: 'sender', source_id: 'gmail.email', value: 'lawyer@firm.example' }];
    const sent: any[] = [];
    const { host } = await openPrivacy({
      description: 'old words',
      rules: SAVED_RULES,
      setResult: (args) => {
        sent.push(args);
        if (sent.length === 1) return privacyResult('their words', theirs, 0, { revision: 'rev2', status: 'conflict' });
        return privacyResult(args.description ?? '', args.rules ?? [], 0, { revision: 'rev3', status: 'saved' });
      },
    });
    host.button(W.addSender).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    host.button(W.save).click();
    await host.settle();
    // Nothing saved, and it says so plainly; the draft is still here, the saved settings beside it.
    const box = host.doc.querySelector('.confirm-box')!;
    expect(box.textContent).toContain("Your changes weren't saved because the privacy settings changed elsewhere.");
    expect(box.textContent).toContain('Your description: their words');
    expect(box.textContent).toContain('lawyer@firm.example');
    expect((host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe('old words');
    expect(ruleRows(host)).toContain('@example.comSender');
    expect(host.button(W.save).disabled).toBe(true);
    // Apply again: the addition lands on their settings, their words and rules kept, against their revision.
    host.button(W.applyAgain).click();
    await host.settle();
    expect(sent.at(-1)).toEqual({
      description: 'their words',
      rules: [...theirs, { kind: 'sender', source_id: 'gmail.email', value: '@example.com' }],
      revision: 'rev2',
    });
    expect(host.text()).toContain(W.saved);
  });

  test('after a conflict, a re-applied removal still asks first, then saves against the new revision', async () => {
    let conflicted = false;
    const sent: any[] = [];
    const { host } = await openPrivacy({
      rules: SAVED_RULES,
      setResult: (args) => {
        sent.push(args);
        if (!conflicted) {
          conflicted = true;
          return privacyResult('their words', SAVED_RULES, 0, { revision: 'rev2', status: 'conflict' });
        }
        return privacyResult(args.description ?? '', args.rules ?? [], 0, { status: 'saved' });
      },
    });
    host.button('Remove Medical Records').click();
    host.button(W.save).click();
    host.button(W.confirm).click();
    await host.settle();
    expect(host.text()).toContain(W.conflict);
    host.button(W.applyAgain).click();
    expect(host.doc.querySelector('.confirm-box')!.textContent).toContain('This removes protection from Medical Records.');
    host.button(W.cancel).click();
    expect(host.text()).toContain('Removed: Medical Records');
    host.button(W.save).click();
    host.button(W.confirm).click();
    await host.settle();
    expect(sent.at(-1).revision).toBe('rev2');
    expect(sent.at(-1).description).toBe('their words');
    expect(sent.at(-1).rules).toEqual(SAVED_RULES.slice(1));
    expect(typeof sent.at(-1).confirmation).toBe('string');
    expect(host.text()).toContain(W.saved);
  });

  test('a label renamed elsewhere is the same rule: removing it survives the conflict replay', async () => {
    const before = [{ kind: 'label', source_id: 'gmail.email', key: 'Label_9', value: 'Old name' }];
    const after = [
      { kind: 'label', source_id: 'gmail.email', key: 'Label_9', value: 'New name' },
      { kind: 'sender', source_id: 'gmail.email', value: 'doctor@clinic.example' },
    ];
    const sent: any[] = [];
    const { host } = await openPrivacy({
      rules: before,
      setResult: (args) => {
        sent.push(args);
        if (sent.length === 1) return privacyResult('', after, 0, { revision: 'rev2', status: 'conflict' });
        return privacyResult(args.description ?? '', args.rules ?? [], 0, { status: 'saved' });
      },
    });
    host.button('Remove Old name').click();
    host.button(W.save).click();
    host.button(W.confirm).click();
    await host.settle();
    host.button(W.applyAgain).click();
    // Still a removal against the new settings, named by its new name, and still asked first.
    expect(host.doc.querySelector('.confirm-box')!.textContent).toContain('This removes protection from New name.');
    host.button(W.confirm).click();
    await host.settle();
    expect(sent.at(-1).rules).toEqual([{ kind: 'sender', source_id: 'gmail.email', value: 'doctor@clinic.example' }]);
    expect(sent.at(-1).revision).toBe('rev2');
    expect(host.text()).toContain(W.saved);
  });

  test('a sender already private in another case is not added twice', async () => {
    const { host } = await openPrivacy({ rules: [{ kind: 'sender', source_id: 'gmail.email', value: 'doctor@clinic.example' }] });
    host.button(W.addSender).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = 'Doctor@Clinic.example';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    expect(host.text()).toContain(W.senderDuplicate);
  });

  test('Discard my changes replaces the draft with the saved settings', async () => {
    const { host } = await openPrivacy({
      description: 'old words',
      rules: SAVED_RULES,
      setResult: () => privacyResult('their words', [], 0, { revision: 'rev2', status: 'conflict' }),
    });
    host.button('Remove Medical Records').click();
    host.button(W.save).click();
    host.button(W.confirm).click();
    await host.settle();
    host.button(W.discardMine).click();
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    expect((host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe('their words');
    expect(ruleRows(host)).toEqual([]);
    expect(host.button(W.save).disabled).toBe(false);
  });

  test('real engine rules without display load, show, and go back unchanged when only the description changes', async () => {
    const real = [
      { kind: 'folder', source_id: 'google_drive.docs', key: 'drive-folder-1' },
      { kind: 'label', source_id: 'gmail.email', key: 'Label_9', value: 'Medical' },
      { kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' },
    ];
    const serialized = (privacyResult('old words', real)._meta as any)[CHATGPT_PRIVACY_META_KEY].rules;
    expect(serialized.some((rule: any) => 'display' in rule)).toBe(false);
    const { host, saves } = await openPrivacy({ description: 'old words', rules: real });
    expect(ruleRows(host)).toEqual(['A folder in Google DriveFolder in Google Drive', 'MedicalGmail label', '@clinic.exampleSender']);
    const area = host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    area.value = 'new words';
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.save).click();
    // Asked only because the description changed: nothing is named as losing protection.
    const box = host.doc.querySelector('.confirm-box')!;
    expect(box.textContent).toContain(W.confirmDescription);
    expect(box.textContent).not.toContain('removes protection');
    host.button(W.confirm).click();
    await host.settle();
    expect(saves).toEqual([{ description: 'new words', rules: serialized, revision: 'rev1', confirmation: 'conf1' }]);
  });

  test('an additive save never carries the confirmation: add a sender, change the words, Save, change them back', async () => {
    const { host, saves } = await openPrivacy({ description: 'old words', rules: SAVED_RULES });
    host.button(W.addSender).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.senderAdd).click();
    const area = () => host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    area().value = 'new words';
    area().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.save).click();
    expect(host.doc.querySelector('.confirm-box')).not.toBeNull();
    area().value = 'old words';
    area().dispatchEvent(new host.win.Event('input') as unknown as Event);
    // The change closed the step; what it named is no longer true.
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    host.button(W.save).click();
    await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].confirmation).toBeUndefined();
    expect(saves[0].description).toBe('old words');
  });

  test('a confirmation the engine no longer accepts is fetched fresh once, then the save goes through', async () => {
    const sent: any[] = [];
    const { host } = await openPrivacy({
      rules: SAVED_RULES,
      setResult: (args) => {
        sent.push(args);
        if (args.confirmation === 'conf1') return { isError: true, structuredContent: { error: 'privacy_owner_only' }, content: [] };
        return privacyResult('', args.rules ?? []);
      },
    });
    host.button('Remove Medical Records').click();
    host.button(W.save).click();
    host.button(W.confirm).click();
    await host.settle();
    expect(host.toolCalls(P.get)).toHaveLength(2);
    expect(sent.map((args) => args.confirmation)).toEqual(['conf1', 'conf2']);
    expect(host.text()).toContain(W.saved);
  });

  test('Cancel with changes asks inline first; without changes it just goes back', async () => {
    const { host } = await openPrivacy({ rules: SAVED_RULES });
    host.button(W.cancel).click();
    expect(host.text()).not.toContain(W.title);
    host.button('Set up').click();
    await host.settle();
    host.button('Remove Medical Records').click();
    host.button(W.cancel).click();
    expect(host.text()).toContain(W.discardPrompt);
    host.button(W.keep).click();
    expect(host.text()).toContain('Removed: Medical Records');
    host.button(W.cancel).click();
    host.button(W.discard).click();
    expect(host.text()).not.toContain(W.title);
    expect(host.toolCalls(P.set)).toEqual([]);
  });
});

describe('follow-up questions', () => {
  const Q = W.questions;
  const OWNER = 'I want my family stuff to stay private';
  const radio = (host: Host, key: string) => host.doc.querySelector(`input[data-key="privacy:q:${key}"]`) as unknown as HTMLInputElement;

  test('a broad word asks short questions, each choice a labelled Private / Fine to share pair at its default', async () => {
    const { host } = await openPrivacy({ description: OWNER });
    const section = host.doc.querySelector('section.questions')!;
    expect(section.querySelector('h2')!.textContent).toBe(Q.title);
    expect(section.textContent).toContain(Q.intro);
    expect(section.querySelector('h3')!.textContent).toBe(Q.topics.family.question);
    const rows = Array.from(section.querySelectorAll('[role="radiogroup"]'));
    // Each pair is named by its question and its choice.
    expect(rows.map((row) => row.getAttribute('aria-labelledby')!.split(' ').map((id) => host.doc.getElementById(id)!.textContent).join(' / ')))
      .toEqual(Object.values(Q.topics.family.options).map((label) => `${Q.topics.family.question} / ${label}`));
    // Real labels around real radio buttons: keyboard operable as a group.
    const logistics = rows[3]!;
    const inputs = Array.from(logistics.querySelectorAll('input')) as unknown as HTMLInputElement[];
    expect(inputs.map((input) => [input.type, input.closest('label')!.textContent, input.checked])).toEqual([
      ['radio', Q.private, false], ['radio', Q.share, true]]);
    expect(radio(host, 'family:medical:private').checked).toBe(true);
    expectNoJargon(host);
    expectNamesOnlyInPrivacy(host);
  });

  test('no broad word, no questions; typing one asks them, keeping the caret in the box', async () => {
    const { host } = await openPrivacy({ description: 'my divorce' });
    expect(host.doc.querySelector('section.questions')).toBeNull();
    const area = host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    area.focus();
    area.value = 'my divorce and my finances';
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    expect(host.doc.querySelector('section.questions h3')!.textContent).toBe(Q.topics.money.question);
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:description');
  });

  test('a choice writes its sentence into the description, and Save (after the usual confirmation) sends it', async () => {
    const { host, saves } = await openPrivacy({ description: OWNER });
    const share = radio(host, 'family:medical:share');
    share.checked = true;
    share.dispatchEvent(new host.win.Event('change') as unknown as Event);
    const area = host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    const lines = area.value.split('\n');
    expect(lines[0]).toBe(OWNER);
    expect(lines[1]).toStartWith('About family: private — Family legal and money papers');
    expect(lines[1]).toContain('fine to share — Family members\' medical records, School plans and family logistics');
    expect(radio(host, 'family:medical:share').checked).toBe(true);
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:q:family:medical:share');
    // Changing it back replaces the sentence instead of adding one.
    const back = radio(host, 'family:medical:private');
    back.checked = true;
    back.dispatchEvent(new host.win.Event('change') as unknown as Event);
    const refined = (host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement).value;
    expect(refined.split('About family:')).toHaveLength(2);
    // A changed description lowers protection: the owner confirms, as when typing.
    host.button(W.save).click();
    expect(host.doc.querySelector('.confirm-box')!.textContent).toContain(W.confirmDescription);
    expect(host.toolCalls(P.set)).toEqual([]);
    host.button(W.confirm).click();
    await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].description).toBe(refined);
    expect(saves[0].confirmation).toBe('conf1');
    expectNamesOnlyInPrivacy(host);
  });

  test('a saved description pre-fills the choices it already answers', async () => {
    const saved = `${OWNER}\nAbout family: private — Alumni, contact and address lists; fine to share — Family members' medical records.`;
    const { host } = await openPrivacy({ description: saved });
    expect(radio(host, 'family:contacts:private').checked).toBe(true);
    expect(radio(host, 'family:medical:share').checked).toBe(true);
    // Not named in the sentence: its default.
    expect(radio(host, 'family:history:share').checked).toBe(true);
  });

  test('a choice too long to add changes nothing, keeps the radio, and says why until the words change', async () => {
    const long = `my family ${'x'.repeat(1_900)}`;
    const { host } = await openPrivacy({ description: long });
    const share = radio(host, 'family:medical:share');
    share.checked = true;
    share.dispatchEvent(new host.win.Event('change') as unknown as Event);
    expect((host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe(long);
    expect(radio(host, 'family:medical:private').checked).toBe(true);
    expect(radio(host, 'family:medical:share').checked).toBe(false);
    const note = host.doc.querySelector('section.questions [role="alert"]')!;
    expect(note.textContent).toBe(Q.tooLong);
    // Nothing changed, so leaving needs no discard prompt.
    host.button(W.cancel).click();
    expect(host.text()).not.toContain(W.discardPrompt);
  });

  test('a sentence edited by hand redraws the radios; an owner line that looks like one is left alone', async () => {
    const owner = 'About family: never share anything about my kids.\nmy family stuff';
    const { host } = await openPrivacy({ description: owner });
    const pick = radio(host, 'family:contacts:private');
    pick.checked = true;
    pick.dispatchEvent(new host.win.Event('change') as unknown as Event);
    const area = () => host.doc.querySelector('textarea') as unknown as HTMLTextAreaElement;
    expect(area().value.split('\n').slice(0, 2)).toEqual(owner.split('\n'));
    expect(area().value.split('\n')[2]).toStartWith('About family: private — ');
    const field = area();
    field.value = field.value.replace(', Alumni, contact and address lists;', ';').replace('fine to share — ', 'fine to share — Alumni, contact and address lists, ');
    field.dispatchEvent(new host.win.Event('input') as unknown as Event);
    expect(radio(host, 'family:contacts:share').checked).toBe(true);
  });

  test('a choice marks the draft changed: Cancel asks before discarding it', async () => {
    const { host } = await openPrivacy({ description: OWNER });
    const share = radio(host, 'family:conversations:share');
    share.checked = true;
    share.dispatchEvent(new host.win.Event('change') as unknown as Event);
    host.button(W.cancel).click();
    expect(host.text()).toContain(W.discardPrompt);
  });
});

describe('the dashboard Privacy row', () => {
  test('configured: one row after Sources and before Progress and Models, with an outlined Edit', async () => {
    const dashboard = model({ configured: true, pendingCount: 4, ruleCount: 3 }, {
      progress: { unit: 'files', phase: 'refresh', percent: 40, itemsLeft: 10, stalled: false, details: [] },
    });
    const host = mount({ olympus_dashboard: () => ({ structuredContent: dashboard }), [P.get]: () => privacyResult(DESCRIPTION, SAVED_RULES) });
    host.push({ structuredContent: dashboard });
    const text = host.text();
    const order = ['Sources', W.section, 'Your description · 3 always-private rules', '4 items waiting to be checked', 'Progress', 'Models'];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    const edit = host.button(W.editLabel);
    expect(edit.textContent).toBe(W.edit);
    expect(edit.className).toBe('btn');
    expect(host.doc.querySelector('.privacy-row .muted')!.textContent).toBe('4 items waiting to be checked');
    edit.click();
    await host.settle();
    expect(host.text()).toContain(W.title);
    host.button(W.back).click();
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:edit');
  });

  test('no rules reads "no always-private rules", never a zero', () => {
    const dashboard = model({ configured: true, pendingCount: 0, ruleCount: 0 });
    const host = mount({ olympus_dashboard: () => ({ structuredContent: dashboard }) });
    host.push({ structuredContent: dashboard });
    expect(host.doc.querySelector('.privacy-row .row-text')!.textContent).toBe('Your description · no always-private rules');
    expect(host.text()).not.toContain('0 always-private');
  });

  test('not configured: the needs-you item carries the one call to action and the row is not repeated', () => {
    const host = mount({});
    host.push({ structuredContent: unconfigured() });
    expect(host.text()).toContain('Tell Olympus what\'s private for you');
    expect(host.doc.querySelector('.privacy-row')).toBeNull();
    expect(host.hasButton(W.edit)).toBe(false);
    expect(host.button('Set up').className).toContain('primary');
  });

  test('without a count from the dashboard the row names no number until a save tells it', async () => {
    const dashboard = model({ configured: true, pendingCount: 0 });
    const saves: any[] = [];
    const host = mount({
      olympus_dashboard: () => ({ structuredContent: dashboard }),
      [P.get]: () => privacyResult(DESCRIPTION, SAVED_RULES),
      [P.set]: (args) => {
        saves.push(args);
        return privacyResult(args.description, SAVED_RULES.slice(0, 1));
      },
    });
    host.push({ structuredContent: dashboard });
    expect(host.text()).toContain(W.rowNoCount);
    expect(host.text()).not.toContain('waiting to be checked');
    host.button(W.editLabel).click();
    await host.settle();
    host.button(W.save).click();
    await host.settle();
    expect(saves.length).toBe(1);
    expect(host.text()).toContain('Your description · 1 always-private rule');
    expect(host.text()).not.toContain('1 always-private rules');
    expectNamesOnlyInPrivacy(host);
  });

  test('inline, the needs-you item opens the Privacy screen fullscreen', async () => {
    const host = mount({ [P.get]: () => privacyResult('', []) }, { displayMode: 'inline' });
    host.push({ structuredContent: unconfigured() });
    host.button('Set up').click();
    expect(host.calls).toContainEqual(['requestDisplayMode', { mode: 'fullscreen' }]);
    await host.settle();
    expect(host.text()).toContain(W.title);
  });
});

describe('words', () => {
  test('"Public" is never shown or shipped', async () => {
    expect(chatgptDashboardPageHtml()).not.toMatch(/public/i);
    expect(JSON.stringify(W)).not.toMatch(/public/i);
    const { host } = await openPrivacy({ description: DESCRIPTION, rules: SAVED_RULES, pending: 2 });
    expect(host.text()).not.toMatch(/public/i);
    host.button(W.addFolder).click();
    await host.settle();
    expect(host.text()).not.toMatch(/public/i);
  });
});
