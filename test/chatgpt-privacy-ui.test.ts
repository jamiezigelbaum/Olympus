import { PRIVATE_ANSWER_OPTIONS } from '../src/core/privacy-language.ts';
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
  serve[P.questions] ??= () => ({ _meta: { [CHATGPT_PRIVACY_META_KEY]: { fallback: true, questions: [] } } });
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
const DESCRIPTION = 'my divorce and my lawyer letters';
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
  await sleep(475);
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
  const allowed = [P.get, P.set, P.questions, P.check, S.scopeList];
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
  return Array.from(host.doc.querySelectorAll('.rule')).map((row) => (row.textContent ?? '').replace(/Remove|Undo|×/g, '').trim());
}

/** Removal already opens the same confirmation that Save opens for other edits. */
async function saveDraft(host: Host): Promise<void> {
  await sleep(475);
  await host.settle();
  if (host.hasButton(W.confirm)) {
    expect(host.doc.querySelector('[data-key="privacy:confirm:yes"]')).not.toBeNull();
    return;
  }
  if (host.hasButton(W.save)) host.button(W.save).click();
  else host.button(W.applyAgain).click();
}

describe('privacy main-view essentials', () => {
  test('full words, intro, questions and disclosure notes stay outside Details in order', async () => {
    const description = 'My family is private. ' + 'Personal diary entries stay private. '.repeat(12).trim();
    const { host } = await openPrivacy({ description, rules: SAVED_RULES });
    const summary = host.doc.querySelector('[data-key="privacy:summary"]')!;
    expect(summary.textContent).toBe(description);
    expect(host.doc.activeElement?.getAttribute('data-key')).toBe('privacy:title');
    expect(summary.closest('details')).toBeNull();
    expect(host.doc.querySelector('textarea')).toBeNull();
    expect(host.button('Edit')).toBeDefined();
    const details = host.doc.querySelector('details')!;
    expect(details.open).toBe(false);
    for (const text of [W.intro, W.descriptionShared, W.namesShared]) {
      expect(host.text()).toContain(text);
      expect(details.textContent).not.toContain(text);
    }
    const questions = host.doc.querySelector('.questions')!;
    expect(questions.closest('details')).toBeNull();
    expect(host.text().indexOf(W.descriptionLabel)).toBeLessThan(host.text().indexOf(W.questions.title));
    expect(host.text().indexOf(W.questions.title)).toBeLessThan(host.text().indexOf(W.rulesTitle));
    expect(host.doc.querySelector('.rule-chips')!.parentElement!.textContent).toContain(W.namesShared);
    expect(details.querySelector('textarea, input, button')).toBeNull();
  });
  test('empty state opens the same inline editor; Cancel restores words without saving', async () => {
    const { host, saves } = await openPrivacy();
    // Empty reads as empty: a plain line, the example greyed, and one main button; never the example as saved text.
    expect(host.doc.querySelector('[data-key="privacy:summary"]')!.textContent).toBe(W.descriptionEmpty);
    expect(host.doc.querySelector('.privacy-example.muted')!.textContent).toBe(W.descriptionPlaceholder);
    expect(host.doc.querySelector('button[data-key="privacy:description:edit"]')!.textContent).toBe(W.descriptionStart);
    host.button(W.descriptionStart).click();
    const area = host.doc.querySelector('textarea')!;
    expect(area.closest('details')).toBeNull();
    expect(area.placeholder).toBe(W.descriptionPlaceholder);
    const save = host.button(W.save);
    expect(save.parentElement).toBe(host.button(W.cancel).parentElement);
    expect(save.parentElement!.firstElementChild).toBe(save);
    area.value = 'my diary';
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.cancel).click();
    expect(host.doc.querySelector('textarea')).toBeNull();
    expect(host.text()).toContain(W.descriptionEmpty);
    expect(host.text()).toContain(W.title);
    expect(saves).toHaveLength(0);
  });
});

function editDescription(host: Host): HTMLTextAreaElement {
  if (!host.doc.querySelector('textarea')) (host.doc.querySelector('button[data-key="privacy:description:edit"]') as unknown as HTMLButtonElement).click();
  return host.doc.querySelector('textarea') as HTMLTextAreaElement;
}

describe('the Privacy screen', () => {
  test('the needs-you item opens it and it renders the description, rules and waiting count from _meta', async () => {
    const { host } = await openPrivacy({ description: DESCRIPTION, rules: SAVED_RULES, pending: 12 });
    expect(host.toolCalls(P.get)).toEqual([{}]);
    const text = host.text();
    expect(text).toContain(W.title);
    expect(text).toContain(W.intro);
    expect(text).toContain(W.back);
    const area = editDescription(host) as unknown as HTMLTextAreaElement;
    expect(area.value).toBe(DESCRIPTION);
    expect(area.placeholder).toBe(W.descriptionPlaceholder);
    expect(area.getAttribute('aria-label')).toBe(W.descriptionLabel);
    expect(text).toContain(W.rulesTitle);
    expect(ruleRows(host)).toEqual(['Medical RecordsFolder in Dropbox', 'Lawyer LettersGmail label', 'doctor@clinic.exampleSender']);
    expect(host.button(W.addRule).disabled).toBe(false);
    expect(text).not.toContain('waiting to be checked');
    expect(host.button(W.save).disabled).toBe(true);
    expect(host.hasButton(W.cancel)).toBe(true);
    expect(host.doc.querySelector('.privacy-description .picker-footer')).not.toBeNull();
    area.value = `${DESCRIPTION} and more`;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    expect(host.button(W.save).disabled).toBe(true);
    await sleep(475); await host.settle();
    expect(host.button(W.save).disabled).toBe(false);
    expect(host.doc.getElementById('privacy-save-reason')).toBeNull();
    expect(host.button(W.save).hasAttribute('aria-describedby')).toBe(false);
    const primary = Array.from(host.doc.querySelectorAll('.btn.primary'));
    expect(primary.map((node) => node.textContent)).toEqual([W.save]);
    expect(host.button(W.cancel).className).not.toContain('primary');
    expectNoJargon(host);
    expectNamesOnlyInPrivacy(host);
  });

  test('says plainly what ChatGPT sees: under the description box, and under the always-private rules', async () => {
    const { host } = await openPrivacy({ description: DESCRIPTION, rules: SAVED_RULES });
    expect(W.descriptionShared).toBe('ChatGPT sees what you type here so it can save it; keep it to topics, like "my health", not details.');
    editDescription(host);
    const field = host.doc.querySelector('label.field')!;
    const note = field.nextElementSibling!;
    expect(note.textContent).toBe(W.descriptionShared);
    expect(editDescription(host)!.getAttribute('aria-describedby')).toBe(note.id);
    expect(host.doc.querySelector('.rule-chips')!.parentElement!.textContent).toContain(W.namesShared);
    expect(W.namesShared).toContain('shown to ChatGPT');
  });

  test('no waiting line when nothing is waiting; one item reads in the singular', async () => {
    const none = await openPrivacy();
    expect(none.host.text()).not.toContain('waiting to be checked');
    expect(none.host.text()).toContain(W.rulesEmpty);
    const one = await openPrivacy({ pending: 1 });
    expect(one.host.text()).not.toContain('waiting to be checked');
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
    expect((editDescription(host) as unknown as HTMLTextAreaElement).value).toBe(DESCRIPTION);
  });
});

describe('adding rules', () => {
  test('Add a folder browses one level per screen and Make private adds the folder and returns', async () => {
    const { host, saves } = await openPrivacy({ rules: [SAVED_RULES[0]], pending: 12 });
    expect(host.text()).not.toContain('12 items are waiting to be checked');
    host.button(W.addRule).click();
    host.button(W.addFolder).click();
    host.button(W.next).click();
    await host.settle();
    expect(host.toolCalls(S.scopeList)).toEqual([{ source_id: 'dropbox.files' }]);
    expect(host.text()).toContain(W.folderTitle);
    expect(host.text()).toContain(W.sheetBack);
    // No choices sheet, no Save in pick mode; an already-private folder says so.
    expect(host.doc.querySelector('.fstatus')).toBeNull();
    expect(host.doc.querySelector('.privacy-sheet-actions')).not.toBeNull();
    expect(rowButton(host, 'Medical Records').textContent).toBe(W.alreadyPrivate);
    expect(rowButton(host, 'Medical Records').disabled).toBe(true);
    // Tapping a name drills in.
    host.button('Tax Returns 2024›').click();
    await host.settle();
    expect(host.toolCalls(S.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files', parent_key: 'k-a' });
    expect(host.text()).toContain('Therapy Notes');
    host.button('Choose Therapy Notes').click();
    host.button(W.next).click();
    host.button(W.makePrivate).click();
    await host.settle();
    expect(host.text()).toContain(W.title);
    expect(ruleRows(host)).toEqual(['Medical RecordsFolder in Dropbox', 'Therapy NotesFolder in Dropbox']);
    expect(saves).toHaveLength(1);
    expect(saves[0].rules).toContainEqual({ kind: 'folder', source_id: 'dropbox.files', key: 'k-a1', display: 'Therapy Notes' });
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:add');
    expectNamesOnlyInPrivacy(host);
  });

  test('with two folder sources the account comes first; Back from the picker returns without a rule', async () => {
    const { host } = await openPrivacy({ sources: [DROPBOX, DRIVE, GMAIL] });
    host.button(W.addRule).click();
    host.button(W.addFolder).click();
    host.button(W.next).click();
    expect(host.text()).toContain(W.folderSourceIntro);
    host.button('Google Drive›').click();
    await host.settle();
    expect(host.toolCalls(S.scopeList)).toEqual([{ source_id: 'google_drive.docs' }]);
    host.button(W.sheetBack).click();
    host.button(W.sheetBack).click();
    expect(host.text()).toContain(W.title);
    expect(ruleRows(host)).toEqual([]);
  });

  test('Add a folder is unavailable, with a reason, when no folder source is connected', async () => {
    const { host } = await openPrivacy({ sources: [GMAIL, { ...DROPBOX, status: 'Off' }] });
    host.button(W.addRule).click();
    expect(host.button(W.addFolder).disabled).toBe(true);
    expect(host.text()).toContain(W.needFolderSource);
  });

  test('Add a Gmail label lists the labels with Make private on each', async () => {
    const { host } = await openPrivacy({ rules: [SAVED_RULES[1]] });
    host.button(W.addRule).click();
    host.button(W.addLabel).click();
    host.button(W.next).click();
    await host.settle();
    expect(host.toolCalls(S.scopeList)).toEqual([{ source_id: 'gmail.email' }]);
    expect(host.text()).toContain(W.labelTitle);
    expect(host.text()).toContain('Sent');
    expect(rowButton(host, 'Lawyer Letters').textContent).toBe(W.alreadyPrivate);
    expect(rowButton(host, 'Lawyer Letters').disabled).toBe(true);
    host.button('Choose Kids School').click();
    host.button(W.next).click();
    host.button(W.makePrivate).click();
    await host.settle();
    expect(ruleRows(host)).toEqual(['Lawyer LettersGmail label', 'Kids SchoolGmail label']);
    expectNamesOnlyInPrivacy(host);
  });

  test('Add a sender checks for an address or @domain inline', async () => {
    const { host } = await openPrivacy({ rules: [SAVED_RULES[2]] });
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = () => host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    expect(input().closest('label')!.textContent).toContain(W.senderLabel);
    for (const bad of ['', 'clinic', 'name@', '@', '@nodot', 'two words@x.com']) {
      input().value = bad;
      input().dispatchEvent(new host.win.Event('input') as unknown as Event);
      host.button(W.next).click();
      if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
      expect(host.text()).toContain(W.senderInvalid);
      expect(input().getAttribute('aria-invalid')).toBe('true');
    }
    input().value = 'Doctor@Clinic.example';
    input().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    expect(host.text()).toContain(W.senderDuplicate);
    input().value = '@Example.com';
    input().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    expect(host.text()).toContain(W.title);
    expect(ruleRows(host)).toEqual(['doctor@clinic.exampleSender', '@example.comSender']);
  });

  test('Remove offers immediate confirmation and an inline Undo', async () => {
    const { host } = await openPrivacy({ rules: SAVED_RULES });
    host.button('Remove Medical Records').click();
    expect(host.text()).toContain('Removed: Medical Records');
    expect(host.doc.activeElement!.getAttribute('data-key')).toBe('privacy:confirm:yes');
    host.button('Undo removing Medical Records').click();
    expect(host.text()).not.toContain('Removed:');
    expect(ruleRows(host)[0]).toBe('Medical RecordsFolder in Dropbox');
  });
});

describe('saving', () => {
  test('Save sends exactly the description and the kept rules, then returns to the dashboard', async () => {
    const { host, saves } = await openPrivacy({ description: 'old words', rules: SAVED_RULES });
    const area = editDescription(host) as unknown as HTMLTextAreaElement;
    area.value = `  ${DESCRIPTION}\n`;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button('Remove Lawyer Letters').click();
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    await saveDraft(host);
    // Removing a rule and new words lower protection: an inline step names what goes, before anything is sent.
    const box = host.doc.querySelector('.confirm-box')!;
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain('This removes protection from Lawyer Letters.');
    expect(box.textContent).toContain(W.confirmDescription);
    expect(host.toolCalls(P.set)).toHaveLength(1);
    host.button(W.confirm).click();
    await host.settle();
    expect(saves).toHaveLength(2);
    expect(saves[0].description).toBe('old words');
    expect(saves[0].rules).toContainEqual(SAVED_RULES[1]);
    expect(saves[0].confirmation).toBeUndefined();
    expect(saves[1]).toEqual({
      description: DESCRIPTION,
      // Loaded rules go back exactly as the engine sent them.
      rules: [
        { kind: 'folder', source_id: 'dropbox.files', key: 'k-b', display: 'Medical Records' },
        { kind: 'sender', source_id: 'gmail.email', value: 'doctor@clinic.example' },
        { kind: 'sender', source_id: 'gmail.email', value: '@example.com' },
      ],
      revision: 'rev1',
      confirmation: 'conf1',
    });
    expect(host.text()).toContain(W.saved);
    expect(host.text()).not.toContain(W.title);
    expect(host.toolCalls('olympus_dashboard').length).toBe(1);
    expectNamesOnlyInPrivacy(host);
  });

  test('a failed save keeps the changes and says so inline', async () => {
    const { host } = await openPrivacy({ setResult: () => ({ isError: true, structuredContent: {} }) });
    const area = editDescription(host) as unknown as HTMLTextAreaElement;
    area.value = DESCRIPTION;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    await saveDraft(host);
    host.button(W.confirm).click();
    await host.settle();
    expect(host.text()).toContain(W.saveFailed);
    expect((editDescription(host) as unknown as HTMLTextAreaElement).value).toBe(DESCRIPTION);
  });

  test('adding protection saves at once, with the revision and no confirmation', async () => {
    const { host, saves } = await openPrivacy({ description: 'old words', rules: SAVED_RULES });
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].revision).toBe('rev1');
    expect(saves[0].confirmation).toBeUndefined();
    expect(host.text()).toContain('@example.com');
    expect(host.hasButton(W.save)).toBe(false);
  });

  test('Cancel in the confirmation step sends nothing and keeps the changes', async () => {
    const { host } = await openPrivacy({ rules: SAVED_RULES });
    host.button('Remove Medical Records').click();
    await saveDraft(host);
    expect(host.text()).toContain('This removes protection from Medical Records.');
    host.button(W.cancel).click();
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    expect(host.text()).toContain('Removed: Medical Records');
    expect(host.toolCalls(P.set)).toEqual([]);
    // Undoing the removal leaves nothing to confirm.
    host.button('Undo removing Medical Records').click();
    expect(host.hasButton(W.save)).toBe(false);
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
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    // Nothing saved, and it says so plainly; the draft is still here, the saved settings beside it.
    const box = host.doc.querySelector('.confirm-box')!;
    expect(box.textContent).toContain("Your changes weren't saved because the privacy settings changed elsewhere.");
    expect(box.textContent).toContain('Your description: their words');
    expect(box.textContent).toContain('lawyer@firm.example');
    expect((editDescription(host) as unknown as HTMLTextAreaElement).value).toBe('old words');
    expect(ruleRows(host)).toContain('@example.comSender');
    expect(host.hasButton(W.save)).toBe(false);
    expect(host.button(W.addRule).disabled).toBe(true);
    expect(host.text()).toContain('Resolve the conflict before adding another rule.');
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

  for (const kind of ['folder', 'label', 'sender'] as const) {
    for (const edit of ['add', 're-add', 'remove'] as const) {
      for (const conflicts of [1, 2, 3]) {
        test(`${edit} ${kind} survives ${conflicts} consecutive conflicts`, async () => {
          const rule = SAVED_RULES.find((item) => item.kind === kind)!;
          const other = { kind: 'sender', source_id: 'gmail.email', value: 'other@example.com' };
          const sent: any[] = [];
          let persisted: unknown[] = [];
          const { host } = await openPrivacy({
            rules: edit === 'add' ? [] : [rule],
            setResult: (args) => {
              sent.push(args);
              if (sent.length <= conflicts) {
                // First agrees with our intent, then the other editor reverses it.
                const present = edit === 'remove' ? sent.length % 2 === 0 : sent.length % 2 === 1;
                const lastServer = present ? [other, rule] : [other];
                return privacyResult('', lastServer, 0, { revision: `rev${sent.length + 1}`, status: 'conflict' });
              }
              persisted = args.rules;
              return privacyResult(args.description, persisted, 0, { status: 'saved' });
            },
          });
          const name = kind === 'folder' ? 'Medical Records' : kind === 'label' ? 'Lawyer Letters' : 'doctor@clinic.example';
          if (edit !== 'add') host.button(`Remove ${name}`).click();
          if (edit === 'remove') {
            await saveDraft(host);
            host.button(W.confirm).click();
          } else if (kind === 'sender') {
            host.button(W.addRule).click();
            host.button(W.addSender).click();
            host.button(W.next).click();
            const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
            input.value = name;
            input.dispatchEvent(new host.win.Event('input') as unknown as Event);
            host.button(W.next).click();
            if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
          } else {
            host.button(W.addRule).click();
            host.button(kind === 'folder' ? W.addFolder : W.addLabel).click();
            host.button(W.next).click();
            await host.settle();
            host.button(`Choose ${name}`).click();
            host.button(W.next).click();
            host.button(W.makePrivate).click();
          }
          await host.settle();
          for (let i = 0; i < conflicts; i++) {
            expect(host.text()).toContain(W.conflict);
            expect(host.text()).not.toContain(W.saved);
            host.button(W.applyAgain).click();
            if (host.hasButton(W.confirm)) host.button(W.confirm).click();
            await host.settle();
            expect(sent.at(-1).rules).toEqual(edit === 'remove' ? [other] : [other, rule]);
          }
          expect(sent).toHaveLength(conflicts + 1);
          expect(sent.at(-1).revision).toBe(`rev${conflicts + 1}`);
          expect(persisted).toEqual(edit === 'remove' ? [other] : [other, rule]);
          expect(host.text()).toContain(W.saved);
        });
      }
    }
  }

  for (const edit of ['add', 'remove'] as const) {
    test(`a saved response that contradicts an intended ${edit} never reports success`, async () => {
      const rule = SAVED_RULES[2]!;
      let accept = false;
      const { host } = await openPrivacy({
        rules: [rule],
        setResult: (args) => privacyResult('', accept ? args.rules : edit === 'add' ? [] : [rule], 0, { status: 'saved' }),
      });
      host.button('Remove doctor@clinic.example').click();
      if (edit === 'add') host.button('Undo removing doctor@clinic.example').click();
      await saveDraft(host);
      if (host.hasButton(W.confirm)) host.button(W.confirm).click();
      await host.settle();
      expect(host.text()).not.toContain(W.saved);
      expect(host.text()).toContain(W.conflict);
      accept = true;
      host.button(W.applyAgain).click();
      if (host.hasButton(W.confirm)) host.button(W.confirm).click();
      await host.settle();
      expect(host.toolCalls(P.set).at(-1).rules).toEqual(edit === 'add' ? [rule] : []);
      expect(host.text()).toContain(W.saved);
    });
  }

  test('an immediate save clears only its confirmed addition, retaining other edits across later conflicts', async () => {
    const sender = SAVED_RULES[2]!;
    const base = SAVED_RULES.slice(0, 2);
    let calls = 0;
    const { host } = await openPrivacy({
      rules: base,
      setResult: (args) => {
        calls++;
        if (calls === 2 || calls === 3) {
          // Another editor removes the successfully saved sender. That old
          // addition is finished; the pending label removal still belongs to us.
          return privacyResult('', calls === 2 ? [base[0]] : base, 0, { status: 'conflict', revision: `rev${calls}` });
        }
        return privacyResult(args.description, args.rules, 0, { status: 'saved' });
      },
    });
    host.button('Remove Lawyer Letters').click();
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = sender.value!;
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    expect(host.toolCalls(P.set)[0].rules).toEqual([...base, sender]);
    expect(host.text()).toContain('Removed: Lawyer Letters');
    await saveDraft(host);
    host.button(W.confirm).click();
    await host.settle();
    for (let i = 0; i < 2; i++) {
      host.button(W.applyAgain).click();
      if (host.hasButton(W.confirm)) host.button(W.confirm).click();
      await host.settle();
    }
    expect(host.toolCalls(P.set).at(-1).rules).toEqual([base[0]]);
    expect(host.text()).toContain(W.saved);
  });

  for (const failure of ['transport', 'contradictory', 'not-saved'] as const) {
    test(`an immediate addition retains intent after a ${failure} response`, async () => {
      let calls = 0;
      const { host } = await openPrivacy({
        setResult: (args) => {
          if (++calls === 1) return failure === 'transport' ? 'fail'
            : privacyResult('', [], 0, { status: failure === 'contradictory' ? 'saved' : 'current' });
          return privacyResult(args.description, args.rules, 0, { status: 'saved' });
        },
      });
      host.button(W.addRule).click();
      host.button(W.addSender).click();
      host.button(W.next).click();
      const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
      input.value = 'doctor@clinic.example';
      input.dispatchEvent(new host.win.Event('input') as unknown as Event);
      host.button(W.next).click();
      if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
      await host.settle();
      expect(host.text()).not.toContain(W.saved);
      host.button(W.applyAgain).click();
      await host.settle();
      expect(host.toolCalls(P.set).at(-1).rules).toEqual([SAVED_RULES[2]]);
      expect(host.text()).toContain(W.saved);
    });
  }

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
    await saveDraft(host);
    host.button(W.confirm).click();
    await host.settle();
    expect(host.text()).toContain(W.conflict);
    host.button(W.applyAgain).click();
    expect(host.doc.querySelector('.confirm-box')!.textContent).toContain('This removes protection from Medical Records.');
    host.button(W.cancel).click();
    expect(host.text()).toContain('Removed: Medical Records');
    await saveDraft(host);
    host.button(W.confirm).click();
    await host.settle();
    expect(sent.at(-1).revision).toBe('rev2');
    expect(sent.at(-1).description).toBe('their words');
    expect(sent.at(-1).rules).toEqual(SAVED_RULES.slice(1));
    expect(typeof sent.at(-1).confirmation).toBe('string');
    expect(host.text()).toContain(W.saved);
  });

  test('Remove and Undo stay visible during an unresolved conflict and Apply sends only visible changes', async () => {
    const sent: any[] = [];
    const { host } = await openPrivacy({
      rules: SAVED_RULES,
      setResult: (args) => {
        sent.push(args);
        if (sent.length === 1) return privacyResult('their words', SAVED_RULES, 0, { revision: 'rev2', status: 'conflict' });
        return privacyResult(args.description, args.rules, 0, { status: 'saved' });
      },
    });
    host.button('Remove Medical Records').click();
    host.button(W.confirm).click();
    await host.settle();
    expect(host.text()).toContain(W.conflict);

    host.button('Remove Lawyer Letters').click();
    expect(host.text()).toContain('Removed: Lawyer Letters');
    host.button('Undo removing Lawyer Letters').click();
    expect(host.text()).not.toContain('Removed: Lawyer Letters');
    expect(host.button('Remove Lawyer Letters').disabled).toBe(false);
    host.button('Remove doctor@clinic.example').click();
    expect(host.text()).toContain('Removed: doctor@clinic.example');
    expect(host.button('Undo removing doctor@clinic.example').disabled).toBe(false);
    expect(host.text()).toContain('Removed: Medical Records');
    expect(host.text()).toContain(W.conflict);
    expect(sent).toHaveLength(1);

    host.button(W.applyAgain).click();
    expect(sent).toHaveLength(1);
    host.button(W.confirm).click();
    await host.settle();
    expect(sent).toHaveLength(2);
    expect(sent[1].revision).toBe('rev2');
    expect(sent[1].description).toBe('their words');
    expect(sent[1].rules).toEqual([SAVED_RULES[1]]);
    expect(typeof sent[1].confirmation).toBe('string');
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
    await saveDraft(host);
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
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = 'Doctor@Clinic.example';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    expect(host.text()).toContain(W.senderDuplicate);
  });

  test('Discard my changes replaces the draft with the saved settings', async () => {
    const { host } = await openPrivacy({
      description: 'old words',
      rules: SAVED_RULES,
      setResult: () => privacyResult('their words', [], 0, { revision: 'rev2', status: 'conflict' }),
    });
    host.button('Remove Medical Records').click();
    await saveDraft(host);
    host.button(W.confirm).click();
    await host.settle();
    host.button(W.discardMine).click();
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    expect(host.button(W.addRule).disabled).toBe(false);
    expect((editDescription(host) as unknown as HTMLTextAreaElement).value).toBe('their words');
    expect(ruleRows(host)).toEqual([]);
    // Opening Edit retains a disabled Save until something changes.
    expect(host.button(W.save).disabled).toBe(true);
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
    const area = editDescription(host) as unknown as HTMLTextAreaElement;
    area.value = 'new words';
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    await saveDraft(host);
    // Asked only because the description changed: nothing is named as losing protection.
    const box = host.doc.querySelector('.confirm-box')!;
    expect(box.textContent).toContain(W.confirmDescription);
    expect(box.textContent).not.toContain('removes protection');
    host.button(W.confirm).click();
    await host.settle();
    expect(saves).toEqual([{ description: 'new words', rules: serialized, revision: 'rev1', confirmation: 'conf1' }]);
  });

  test('reverting description edits after an immediate addition closes confirmation without another save', async () => {
    const { host, saves } = await openPrivacy({ description: 'old words', rules: SAVED_RULES });
    host.button(W.addRule).click();
    host.button(W.addSender).click();
    host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as unknown as HTMLInputElement;
    input.value = '@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click();
    if (host.hasButton(W.makePrivate)) host.button(W.makePrivate).click();
    await host.settle();
    const area = () => editDescription(host) as unknown as HTMLTextAreaElement;
    area().value = 'new words';
    area().dispatchEvent(new host.win.Event('input') as unknown as Event);
    await saveDraft(host);
    expect(host.doc.querySelector('.confirm-box')).not.toBeNull();
    area().value = 'old words';
    area().dispatchEvent(new host.win.Event('input') as unknown as Event);
    // The change closed the step; what it named is no longer true.
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
    expect(host.button(W.save).disabled).toBe(true);
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
        return privacyResult('', args.rules ?? [], 0, { status: 'saved' });
      },
    });
    host.button('Remove Medical Records').click();
    await saveDraft(host);
    host.button(W.confirm).click();
    await host.settle();
    expect(host.toolCalls(P.get)).toHaveLength(2);
    expect(sent.map((args) => args.confirmation)).toEqual(['conf1', 'conf2']);
    expect(host.text()).toContain(W.saved);
  });

  test('Cancel with changes asks inline first; without changes it just goes back', async () => {
    const { host } = await openPrivacy({ rules: SAVED_RULES });
    host.button(W.back).click();
    expect(host.text()).not.toContain(W.title);
    host.button('Set up').click();
    await host.settle();
    host.button('Remove Medical Records').click();
    host.button(W.back).click();
    expect(host.text()).toContain(W.discardPrompt);
    host.button(W.keep).click();
    expect(host.text()).toContain('Removed: Medical Records');
    host.button(W.back).click();
    host.button(W.discard).click();
    expect(host.text()).not.toContain(W.title);
    expect(host.toolCalls(P.set)).toEqual([]);
  });
});

describe('follow-up questions', () => {
  const Q = W.questions;
  const OWNER = 'I want my family stuff to stay private';
  const choice = (host: Host, id: string, side: string) => host.doc.querySelector(`[data-key="privacy:q:${id}:${side}"]`) as HTMLButtonElement;

  test('fallback pairs start unanswered, stay side by side and disclose the general questions', async () => {
    const { host } = await openPrivacy({ description: OWNER });
    expect(host.text()).toContain(Q.fallback);
    const pairs = host.doc.querySelectorAll('.qchoices');
    expect(pairs).toHaveLength(6);
    for (const pair of pairs) {
      expect(Array.from(pair.querySelectorAll('button')).map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    }
    expect(host.doc.querySelector('style')!.textContent).toContain('.qchoices{display:flex;flex-wrap:nowrap;');
    expect(host.text()).not.toContain(Q.checkTitle);
    expectNoJargon(host);
  });

  test('only explicit sharing is allowed; skipped questions save Private after confirmation', async () => {
    const { host, saves } = await openPrivacy({ description: OWNER });
    editDescription(host);
    choice(host, 'family:medical', 'share').click();
    const draft = (editDescription(host) as HTMLTextAreaElement).value;
    expect(draft.split('\n')[0]).toBe(OWNER);
    expect(draft.split('\n')[1]).toBe('Fine to share: ' + Q.topics.family.options.medical + '.');
    expect(choice(host, 'family:history', 'share').getAttribute('aria-pressed')).toBe('false');
    choice(host, 'family:medical', 'private').click();
    const answered = (editDescription(host) as HTMLTextAreaElement).value;
    expect(answered).toBe(OWNER + '\nPrivate: ' + Q.topics.family.options.medical + '.');
    await saveDraft(host);
    expect(host.doc.querySelector('.confirm-box')).not.toBeNull();
    expect(saves).toHaveLength(0);
    const complete = (editDescription(host) as HTMLTextAreaElement).value;
    // Every skipped choice joins the one Private line; nothing is fine to share.
    expect(complete.split('\n')).toHaveLength(2);
    expect(complete.split('\n')[1]!.startsWith('Private: ')).toBe(true);
    expect(complete).not.toContain('Fine to share');
    host.button(W.confirm).click(); await host.settle();
    expect(saves[0].description).toBe(complete);
    expectNamesOnlyInPrivacy(host);
  });

  test('a saved answer shows as chosen when reopened, and flipping it replaces it instead of contradicting it', async () => {
    const photos = Q.topics.family.options.history;
    const { host, saves } = await openPrivacy({ description: OWNER + '\nFine to share: ' + photos + '.' });
    editDescription(host);
    expect(choice(host, 'family:history', 'share').getAttribute('aria-pressed')).toBe('true');
    choice(host, 'family:history', 'private').click();
    const flipped = (editDescription(host) as HTMLTextAreaElement).value;
    expect(flipped).toBe(OWNER + '\nPrivate: ' + photos + '.');
    await saveDraft(host);
    host.button(W.confirm).click(); await host.settle();
    expect(saves[0].description).not.toContain('Fine to share');
    expect(saves[0].description.split(photos)).toHaveLength(2);
  });

  test('answers saved by the earlier editor are kept, shown, and replaced rather than contradicted', async () => {
    const photos = Q.topics.family.options.history;
    const medical = Q.topics.family.options.medical;
    const legacy = OWNER + '\nAbout family: private — ' + medical + '; fine to share — ' + photos + '.';
    const { host, saves } = await openPrivacy({ description: legacy });
    editDescription(host);
    expect(choice(host, 'family:history', 'share').getAttribute('aria-pressed')).toBe('true');
    expect(choice(host, 'family:medical', 'private').getAttribute('aria-pressed')).toBe('true');
    choice(host, 'family:history', 'private').click();
    const migrated = (editDescription(host) as HTMLTextAreaElement).value;
    expect(migrated).not.toContain('About family');
    expect(migrated).not.toContain('Fine to share');
    expect(migrated.split(photos)).toHaveLength(2);
    expect(migrated.split(medical)).toHaveLength(2);
    await saveDraft(host);
    host.button(W.confirm).click(); await host.settle();
    expect(saves[0].description).not.toContain('Fine to share');
    expect(saves[0].description.split(photos)).toHaveLength(2);
  });

  test('saving an earlier editor\'s answers untouched keeps their sharing choice', async () => {
    const photos = Q.topics.family.options.history;
    const legacy = OWNER + '\nAbout family: fine to share — ' + photos + '.';
    const { host, saves } = await openPrivacy({ description: legacy });
    const area = editDescription(host) as HTMLTextAreaElement;
    area.value = legacy + ' '; area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    await sleep(475); await host.settle();
    await saveDraft(host);
    if (host.doc.querySelector('.confirm-box')) { host.button(W.confirm).click(); }
    await host.settle();
    expect(saves[0].description).toContain('Fine to share: ' + photos + '.');
    expect(saves[0].description.split(photos)).toHaveLength(2);
  });

  test('a failed refresh cannot restore a sharing answer deleted from the description', async () => {
    const { host, saves } = await openPrivacy({ description: OWNER });
    editDescription(host);
    choice(host, 'family:medical', 'share').click();
    host.serve[P.questions] = () => 'fail';
    const area = editDescription(host) as HTMLTextAreaElement;
    area.value = OWNER + ' and my diary';
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    await sleep(475); await host.settle();
    expect(choice(host, 'family:medical', 'share').getAttribute('aria-pressed')).toBe('false');
    await saveDraft(host);
    host.button(W.confirm).click(); await host.settle();
    expect(saves[0].description).not.toContain('Fine to share');
  });

  test('a choice over the limit is refused without selecting either side', async () => {
    const own = 'my family ' + 'x'.repeat(1980);
    const { host, saves } = await openPrivacy({ description: own });
    editDescription(host);
    choice(host, 'family:medical', 'share').click();
    expect((editDescription(host) as HTMLTextAreaElement).value).toBe(own);
    expect(choice(host, 'family:medical', 'share').getAttribute('aria-pressed')).toBe('false');
    expect(host.text()).toContain(Q.tooLong);
    await saveDraft(host);
    expect(saves).toHaveLength(0);
    expect(host.doc.querySelector('.confirm-box')).toBeNull();
  });

  test('debounces edits, reads back before Save, corrects the same sample, and never persists samples to widget state', async () => {
    const { host, saves } = await openPrivacy({ description: 'My client invoices and poems' });
    host.serve[P.questions] = () => ({ _meta: { [CHATGPT_PRIVACY_META_KEY]: { fallback: false,
      questions: [{ id: 'invoices', question: 'Should client invoices stay Private?', topic: 'client invoices', quote: 'client invoices' }] } } });
    host.serve[P.check] = args => ({ _meta: { [CHATGPT_PRIVACY_META_KEY]: {
      private: ['Client invoices'], share: ['Poems'], samples: [{ name: 'Synthetic client invoice', side: args.sample ? 'share' : 'private' }],
    } } });
    const area = editDescription(host) as HTMLTextAreaElement;
    for (const value of ['My client invoices and poems.', 'My client invoices and poems. More words.']) {
      area.value = value; area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    }
    const previous = host.toolCalls(P.questions).length;
    expect(host.text()).toContain(Q.loading);
    expect(host.toolCalls(P.questions)).toHaveLength(previous);
    await sleep(475); await host.settle();
    expect(host.toolCalls(P.questions)).toHaveLength(previous + 1);
    expect(host.text()).toContain('Should client invoices stay Private?');
    await saveDraft(host); await host.settle();
    expect(saves).toHaveLength(0);
    expect(host.text()).toContain(Q.checkTitle);
    expect(host.text()).toContain('Synthetic client invoice');
    expect(host.toolCalls(P.check)[0].description).toContain('Private: client invoices.');
    host.button(Q.wrong).click(); await host.settle();
    expect(host.toolCalls(P.check).at(-1).sample).toBe('Synthetic client invoice');
    expect(host.toolCalls(P.check).at(-1).description).toContain('Fine to share: Synthetic client invoice');
    expect(saves).toHaveLength(0);
    await saveDraft(host);
    host.button(W.confirm).click(); await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].description).toContain('Fine to share: Synthetic client invoice');
    expect(host.calls.some(([name]) => name === 'setWidgetState')).toBe(false);
    expect(host.sent.some(message => String(message.method).includes('update-model-context'))).toBe(false);
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
    const order = ['Sources', W.section, 'Uses your description and 3 always-private rules.', '4 items waiting to be checked', 'Progress', 'Models'];
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
    expect(host.doc.querySelector('.privacy-row .row-text')!.textContent).toBe('Uses your description. No always-private rules.');
    expect(host.text()).not.toContain('0 always-private');
  });

  test('not configured: the needs-you item carries the one call to action and the row is not repeated', () => {
    const host = mount({});
    host.push({ structuredContent: unconfigured() });
    expect(host.text()).toContain('Tell Olympus what\'s private for you');
    expect(host.doc.querySelector('.privacy-row')).toBeNull();
    expect(host.hasButton(W.edit)).toBe(false);
    expect(host.button('Set up').className).toContain('warnfill');
  });

  test('without a count from the dashboard the row names no number until a save tells it', async () => {
    const dashboard = model({ configured: true, pendingCount: 0 });
    const saves: any[] = [];
    const host = mount({
      olympus_dashboard: () => ({ structuredContent: dashboard }),
      [P.get]: () => privacyResult(DESCRIPTION, SAVED_RULES, 0, { confirmation: 'conf1' }),
      [P.set]: (args) => {
        saves.push(args);
        return privacyResult(args.description, SAVED_RULES.slice(0, 1), 0, { status: 'saved' });
      },
    });
    host.push({ structuredContent: dashboard });
    expect(host.text()).toContain(W.rowNoCount);
    expect(host.text()).not.toContain('waiting to be checked');
    host.button(W.editLabel).click();
    await host.settle();
    const area = editDescription(host) as unknown as HTMLTextAreaElement;
    area.value = `${DESCRIPTION} and more`;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    await saveDraft(host);
    expect(host.doc.querySelector('.confirm-box')).not.toBeNull();
    host.button(W.confirm).click();
    await host.settle();
    expect(saves.length).toBe(1);
    expect(host.text()).toContain('Uses your description and 1 always-private rule.');
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
    host.button(W.addRule).click();
    host.button(W.addFolder).click();
    host.button(W.next).click();
    await host.settle();
    expect(host.text()).not.toMatch(/public/i);
  });
});


test('Escape leaves the pending first-run chooser without opening a profile sheet', async () => {
  const pending = { pending: true as const, options: PRIVATE_ANSWER_OPTIONS };
  const { host, saves } = await openPrivacy({
    getResult: () => privacyToolResult({ configured: false, description: '', rules: [], pendingCount: 0, revision: 'rev1', privateAnswerChoice: pending }, 'current', 'owner-token'),
  });
  expect(host.text()).toContain('How should Olympus answer with Private items?');
  host.doc.dispatchEvent(new host.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
  await host.settle();
  expect(host.doc.querySelectorAll('.privacy')).toHaveLength(0);
  expect(host.doc.querySelectorAll('.privacy-sheet')).toHaveLength(0);
  expect(host.doc.querySelector('textarea')).toBeNull();
  expect(saves).toHaveLength(0);
  host.button('Set up').click();
  await host.settle();
  expect(host.text()).toContain('How should Olympus answer with Private items?');
});

test('pending first-run opens the shared mode choice before any profile edit', async () => {
  const saves: any[] = [];
  const pending = { pending: true as const, options: PRIVATE_ANSWER_OPTIONS };
  const { host } = await openPrivacy({
    getResult: () => privacyToolResult({ configured: false, description: '', rules: [], pendingCount: 0, revision: 'rev1', privateAnswerChoice: pending }, 'current', 'owner-token'),
    setResult: args => {
      saves.push(args);
      return privacyToolResult({ configured: true, description: args.description ?? 'Health', rules: [], pendingCount: 0, revision: 'rev2', ...(!args.private_answer_mode ? { privateAnswerChoice: pending } : {}) }, 'saved', 'choice-token');
    },
  });
  expect(host.doc.querySelector('textarea')).toBeNull();
  expect(saves).toHaveLength(0);
  expect(host.text()).toContain('How should Olympus answer with Private items?');
  expect(host.text()).toContain('Recommended');
  for (const option of PRIVATE_ANSWER_OPTIONS) expect(host.text()).toContain(option.label);
  expect((host.doc.querySelector('input[value="local-first"]') as unknown as HTMLInputElement).checked).toBe(true);
  host.button('Save Private-answer mode').click();
  await host.settle();
  expect(saves[0]).toEqual({ private_answer_mode: 'local-first', revision: 'rev1', confirmation: 'owner-token' });
  expect(host.text()).not.toContain('How should Olympus answer with Private items?');
});

describe('privacy step sheet', () => {
  test('starts with full description, compact removable chips and collapsed Details', async () => {
    const { host } = await openPrivacy({ description: DESCRIPTION, rules: SAVED_RULES });
    expect(host.doc.querySelector('[data-key="privacy:summary"]')?.textContent).toContain(DESCRIPTION);
    const details = host.doc.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.textContent).toContain(W.judgingDetails);
    expect(host.doc.querySelectorAll('.rule-chip')).toHaveLength(3);
    expect(host.button('Remove Medical Records').textContent).toBe('×');
    expect(host.button('Add a rule')).toBeDefined();
  });
  test('sender has three steps, Back retains input, and double confirm saves once', async () => {
    const { host, saves } = await openPrivacy();
    host.button('Add a rule').click();
    expect(host.text()).toContain('Step 1 of 3');
    host.button(W.addSender).click();
    host.button(W.next).click();
    expect(host.text()).toContain('Step 2 of 3');
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as HTMLInputElement;
    input.value = 'person@example.com';
    input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button('Next').click();
    expect(host.text()).toContain('Step 3 of 3');
    expect(saves).toHaveLength(0);
    host.button('Back').click();
    expect((host.doc.querySelector('input[data-key="privacy:sender"]') as HTMLInputElement).value).toBe('person@example.com');
    host.button('Next').click();
    const confirm = host.button('Make private');
    confirm.click(); confirm.click();
    await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].rules).toEqual([{ kind: 'sender', source_id: 'gmail.email', value: 'person@example.com' }]);
    expect(host.text()).toContain(W.title);
    expectNamesOnlyInPrivacy(host);
  });
});

describe('privacy sheet persistence boundaries', () => {
  for (const kind of ['folder', 'label'] as const) {
    test(`${kind} selection waits for review, Back keeps the choice, confirm saves once`, async () => {
      const { host, saves } = await openPrivacy();
      host.button(W.addRule).click();
      expect(host.button(W.next).disabled).toBe(true);
      host.button(kind === 'folder' ? W.addFolder : W.addLabel).click();
      host.button(W.next).click();
      await host.settle();
      expect(host.text()).toContain('Step 2 of 3');
      expect(host.doc.querySelectorAll('.privacy-sheet-actions')).toHaveLength(1);
      const name = kind === 'folder' ? 'Medical Records' : 'Lawyer Letters';
      host.button(`Choose ${name}`).click();
      expect(saves).toHaveLength(0);
      host.button(W.next).click();
      expect(host.text()).toContain('Step 3 of 3');
      expect(saves).toHaveLength(0);
      host.button(W.sheetBack).click();
      await host.settle();
      expect(host.text()).toContain('Step 2 of 3');
      // The folder browser starts afresh; labels retain the in-session selection.
      if (kind === 'folder') host.button(`Choose ${name}`).click();
      host.button(W.next).click();
      const confirm = host.button(W.makePrivate);
      confirm.click(); confirm.click();
      await host.settle();
      expect(saves).toHaveLength(1);
      expect(saves[0].rules).toEqual([SAVED_RULES[kind === 'folder' ? 0 : 1]]);
      expectNamesOnlyInPrivacy(host);
    });
  }

  test('changing kind clears the prior candidate and cannot save it as a different kind', async () => {
    const { host, saves } = await openPrivacy();
    host.button(W.addRule).click(); host.button(W.addSender).click(); host.button(W.next).click();
    const input = host.doc.querySelector('input[data-key="privacy:sender"]') as HTMLInputElement;
    input.value = 'person@example.com'; input.dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.next).click(); host.button(W.sheetBack).click(); host.button(W.sheetBack).click();
    host.button(W.addLabel).click(); host.button(W.next).click();
    await host.settle();
    expect(host.button(W.next).disabled).toBe(true);
    expect(saves).toHaveLength(0);
  });

  test('removing a chip confirms and applies without a separate Save click', async () => {
    const { host, saves } = await openPrivacy({ rules: SAVED_RULES });
    host.button('Remove Medical Records').click();
    expect(saves).toHaveLength(0);
    expect(host.text()).toContain('This removes protection from Medical Records.');
    host.button(W.confirm).click();
    await host.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0].rules).toEqual(SAVED_RULES.slice(1));
    expect(saves[0].confirmation).toBe('conf1');
  });

  test('Details stays open during editing; all quick questions remain outside it without a cap', async () => {
    const { host } = await openPrivacy({ description: 'family health money work relationships home' });
    let details = host.doc.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatchEvent(new host.win.Event('toggle') as unknown as Event);
    expect(details.querySelectorAll('.qtopic')).toHaveLength(0);
    expect(host.doc.querySelectorAll('.qchoices')).toHaveLength(32);
    const area = editDescription(host);
    area.value += ' and other topics';
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    details = host.doc.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(details.textContent).not.toContain(W.descriptionShared);
    expect(details.textContent).not.toContain(W.namesShared);
  });
});

test('inline editor retains every keystroke and caret when topics and save availability stay the same', async () => {
  const { host, saves } = await openPrivacy({ description: 'my diary' });
  const details = () => host.doc.querySelector('details') as HTMLDetailsElement;
  details().open = true;
  details().dispatchEvent(new host.win.Event('toggle') as unknown as Event);
  const type = (value: string) => {
    const area = editDescription(host)!;
    area.value = value;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
  };
  type('my diary and a');
  const area = editDescription(host)!;
  type('my diary and letters');
  // This edit must retain the textarea and its current value without redrawing it.
  expect(editDescription(host)).toBe(area);
  expect(editDescription(host).value).toBe('my diary and letters');
  details().open = false;
  details().dispatchEvent(new host.win.Event('toggle') as unknown as Event);
  expect(editDescription(host).value).toBe('my diary and letters');
  await saveDraft(host);
  host.button(W.confirm).click();
  await host.settle();
  expect(saves).toHaveLength(1);
  expect(saves[0].description).toBe('my diary and letters');
});

test('the save bar follows pending covered edits, including reverting to the saved description', async () => {
  const { host } = await openPrivacy({ description: 'my family' });
  expect(host.doc.querySelector('.picker-footer')).toBeNull();
  for (const value of ['my family and diary', 'my family']) {
    const area = editDescription(host)!;
    area.value = value;
    area.dispatchEvent(new host.win.Event('input') as unknown as Event);
    expect(host.hasButton(W.save)).toBe(true);
  }
  await sleep(475); await host.settle();
  const choice = host.doc.querySelector('[data-key="privacy:q:family:medical:share"]') as HTMLButtonElement;
  choice.click();
  expect(host.button(W.save).textContent).toBe('Save description and answers');
});
