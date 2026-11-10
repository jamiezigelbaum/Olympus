import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { OlympusDashboardControlResult } from '../src/control-ui-contract.ts';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { renderMessagingCard } from '../src/workers/dashboard/messaging.ts';
import { flushMicrotasks, waitFor } from './helpers/test-clock.ts';

// #1075 and #1086: the chat chooser by kind, and the source dialog's one primary action and busy buttons.
const GLOBALS = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLDetailsElement', 'Event', 'MouseEvent', 'FormData'] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window;
beforeEach(() => {
  happyWindow = new Window({ url: 'https://gateway.test/' });
  for (const name of GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? happyWindow : name === 'document' ? happyWindow.document : name === 'navigator' ? happyWindow.navigator : (happyWindow as unknown as Record<string, unknown>)[name] });
  }
});
afterEach(async () => {
  await happyWindow.happyDOM.abort();
  for (const name of GLOBALS) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

type Messaging = (operation: string, params: Record<string, unknown>) => Promise<OlympusDashboardControlResult>;
const noControl = async (): Promise<OlympusDashboardControlResult> => ({ status: 200, body: {} });
function mount(html: string, messaging: Messaging) {
  const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, transport: { control: noControl, messaging: messaging as never }, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys' });
  return { root, controller };
}
const submit = (form: Element) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const visible = (element: Element) => !element.closest('[hidden]') && !element.closest('.sheet:not(.on)');

/** 300 chats: 212 one-to-one, 46 groups, 31 channels, 11 bots, newest first by id. */
function manyChats() {
  const chats: { chatScope: string; title: string; kind: string; lastMessageAt: string }[] = [];
  const kinds: [string, number, string][] = [['dm', 212, 'Person'], ['group', 46, 'Group'], ['channel', 31, 'Channel'], ['bot', 11, 'Bot']];
  let id = 1;
  for (const [kind, count, name] of kinds) {
    for (let i = 0; i < count; i++, id++) {
      chats.push({ chatScope: `telegram.personal:chat:${id}`, title: kind === 'channel' && i === 7 ? 'Lobster Daily' : `${name} ${i}`, kind, lastMessageAt: new Date(Date.UTC(2026, 9, 1) + id * 60_000).toISOString() });
    }
  }
  return chats;
}

test('with 300 chats, two switches read every one-to-one chat and group, and one channel is found by typing', async () => {
  const chats = manyChats();
  const sent: Record<string, unknown>[] = [];
  const { root, controller } = mount(renderMessagingCard('telegram', true, { paired: true }), async (operation, params) => {
    if (operation === 'chats') return { status: 200, body: { ok: true, state: 'paired', chats, wholeAccount: false, chatKinds: [], chatScopes: [] } };
    if (operation === 'scope') { sent.push(structuredClone(params)); return { status: 200, body: { ok: true, state: 'paired' } }; }
    return { status: 200, body: { ok: true, state: 'paired' } };
  });
  try {
    await flushMicrotasks();
    submit(root.querySelector('form[data-messaging-kind="chats"]')!);
    const picker = await waitFor(() => root.querySelector<HTMLFormElement>('[data-kind-picker]'));
    expect([...picker.querySelectorAll('.kindgroup')].map(group => group.querySelector('b')!.textContent)).toEqual(['One-to-one 212', 'Groups 46', 'Channels 31', 'Bots 11']);
    // The chooser is the content: Choose chats steps aside and Save is the one primary action.
    expect(root.querySelector<HTMLElement>('form[data-messaging-kind="chats"]')!.hidden).toBe(true);
    expect([...root.querySelectorAll('.btn.primary')].filter(visible).map(button => button.textContent)).toEqual(['Save']);
    // Two clicks: One-to-one and Groups.
    for (const kind of ['dm', 'group']) picker.querySelector<HTMLInputElement>(`[name="chatKind"][value="${kind}"]`)!.click();
    const note = (kind: string) => picker.querySelector(`[data-kind-group="${kind}"] .kindnote`)!;
    expect(note('dm').textContent).toBe('All one-to-one chats, including new ones');
    expect(note('group').textContent).toBe('All groups, including new ones');
    // Find one channel by typing.
    const channels = picker.querySelector<HTMLElement>('[data-kind-group="channel"]')!;
    channels.querySelector<HTMLButtonElement>('[data-kind-open]')!.click();
    expect(channels.querySelector<HTMLElement>('.kindlist')!.hidden).toBe(false);
    expect(channels.querySelector('.kindcap')!.textContent).toBe('Most recent first');
    // Most recent first.
    expect(channels.querySelector('.chatline .chatname')!.textContent).toBe('Channel 30');
    const search = channels.querySelector<HTMLInputElement>('[data-kind-search]')!;
    search.value = 'lobster';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const shown = [...channels.querySelectorAll<HTMLElement>('.chatline')].filter(line => !line.hidden);
    expect(shown.map(line => line.querySelector('.chatname')!.textContent)).toEqual(['Lobster Daily']);
    shown[0]!.querySelector<HTMLInputElement>('input')!.click();
    // A kind with only some chats chosen says so, and that new ones of that kind are not read.
    expect(note('channel').textContent).toBe('1 of 31 chosen · new channels are not read');
    expect(note('channel').classList.contains('partial')).toBe(true);
    expect(note('bot').textContent).toBe('Off · new bots are not read');
    expect(picker.textContent).toContain('Choosing chats never decides privacy. Every message is still judged on its own.');
    submit(picker);
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toEqual({ source: 'telegram', wholeAccount: false, chatKinds: ['dm', 'group'], chatScopes: ['telegram.personal:chat:266'] });
  } finally { controller.dispose(); }
});

test('after Save, the chooser closes and Choose chats is back, so the choice can be changed again', async () => {
  let chatsCalls = 0;
  const { root, controller } = mount(renderMessagingCard('telegram', true, { paired: true }), async (operation) => {
    if (operation === 'chats') { chatsCalls += 1; return { status: 200, body: { ok: true, state: 'paired', chats: [{ chatScope: 'telegram.personal:chat:1', title: 'Ana', kind: 'dm' }], wholeAccount: false, chatKinds: [], chatScopes: [] } }; }
    return { status: 200, body: { ok: true, state: 'paired' } };
  });
  try {
    await flushMicrotasks();
    submit(root.querySelector('form[data-messaging-kind="chats"]')!);
    const picker = await waitFor(() => root.querySelector<HTMLFormElement>('[data-kind-picker]'));
    picker.querySelector<HTMLInputElement>('[name="chatKind"][value="dm"]')!.click();
    submit(picker);
    await waitFor(() => !root.querySelector('[data-kind-picker]'));
    const chooseChats = root.querySelector<HTMLFormElement>('form[data-messaging-kind="chats"]')!;
    expect(chooseChats.hidden).toBe(false);
    expect(root.querySelector('[data-messaging-status]')!.textContent).toBe('Chat choices saved. Capture will use this selection.');
    submit(chooseChats);
    await waitFor(() => root.querySelector('[data-kind-picker]'));
    expect(chatsCalls).toBe(2);
  } finally { controller.dispose(); }
});

test('Read all chats switches every kind on, and turning a kind off leaves it', async () => {
  const { root, controller } = mount(renderMessagingCard('whatsapp', true, { paired: true }), async (operation) => operation === 'chats'
    ? { status: 200, body: { ok: true, state: 'paired', chats: [{ chatScope: 'whatsapp.personal:chat:1@s.whatsapp.net', title: 'Ana', kind: 'dm' }, { chatScope: 'whatsapp.personal:chat:2@g.us', title: 'Street', kind: 'community' }], wholeAccount: false, chatKinds: ['group'], chatScopes: [] } }
    : { status: 200, body: { ok: true, state: 'paired' } });
  try {
    await flushMicrotasks();
    submit(root.querySelector('form[data-messaging-kind="chats"]')!);
    const picker = await waitFor(() => root.querySelector<HTMLFormElement>('[data-kind-picker]'));
    // WhatsApp's kinds: One-to-one, Groups, Communities; the saved kind is on.
    expect([...picker.querySelectorAll<HTMLInputElement>('[name="chatKind"]')].map(input => [input.value, input.checked])).toEqual([['dm', false], ['group', true], ['community', false]]);
    const all = picker.querySelector<HTMLInputElement>('[name="wholeAccount"]')!;
    all.click();
    expect([...picker.querySelectorAll<HTMLInputElement>('[name="chatKind"]')].every(input => input.checked)).toBe(true);
    picker.querySelector<HTMLInputElement>('[name="chatKind"][value="community"]')!.click();
    expect(all.checked).toBe(false);
  } finally { controller.dispose(); }
});

test('at first pairing the suggested start is One-to-one and Groups on, and nothing is sent until Save', async () => {
  const sent: Record<string, unknown>[] = [];
  const { root, controller } = mount(renderMessagingCard('telegram', true), async (operation, params) => {
    if (operation === 'scope') { sent.push(structuredClone(params)); return { status: 200, body: { ok: true, state: 'starting' } }; }
    return { status: 200, body: { ok: true, state: 'scope_selection_required', chats: [{ chatScope: 'telegram.personal:chat:1', title: 'Ana', kind: 'dm' }], wholeAccount: false, chatScopes: [], chatKinds: [] } };
  });
  try {
    const picker = await waitFor(() => root.querySelector<HTMLFormElement>('[data-kind-picker]'));
    expect([...picker.querySelectorAll<HTMLInputElement>('[name="chatKind"]:checked')].map(input => input.value)).toEqual(['dm', 'group']);
    expect(picker.querySelector<HTMLInputElement>('[name="wholeAccount"]')!.checked).toBe(false);
    expect(sent).toEqual([]);
    expect(picker.textContent).toContain('Nothing is read until you press Save');
    submit(picker);
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toEqual({ source: 'telegram', wholeAccount: false, chatKinds: ['dm', 'group'], chatScopes: [] });
  } finally { controller.dispose(); }
});

test('a pressed button is busy and disabled in place, with no separate indicator, and a second press does nothing', async () => {
  let release!: () => void;
  const calls: string[] = [];
  const { root, controller } = mount(renderMessagingCard('telegram', true, { paired: true }), async (operation) => {
    calls.push(operation);
    if (operation === 'chats') await new Promise<void>((resolve) => { release = resolve; });
    return { status: 200, body: { ok: true, state: 'paired' } };
  });
  try {
    await flushMicrotasks();
    const form = root.querySelector<HTMLFormElement>('form[data-messaging-kind="chats"]')!;
    const button = form.querySelector('button')!;
    submit(form);
    expect(button.textContent).toBe('Loading chats…');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('[data-messaging-status]')!.textContent).toBe('');
    submit(form);
    await flushMicrotasks();
    expect(calls).toEqual(['status', 'chats']);
    release();
    await waitFor(() => !button.disabled);
    expect(button.textContent).toBe('Choose chats');
  } finally { controller.dispose(); }
});

test('Check connection from the ⋯ menu shows Checking… on its own button and closes the menu', async () => {
  let statusCalls = 0;
  let release: (() => void) | undefined;
  const { root, controller } = mount(renderMessagingCard('whatsapp', true, { paired: true }), async (operation) => {
    if (operation === 'status' && ++statusCalls > 1) await new Promise<void>((resolve) => { release = resolve; });
    return { status: 200, body: { ok: true, state: 'paired' } };
  });
  try {
    await waitFor(() => statusCalls === 1);
    await flushMicrotasks();
    const menu = root.querySelector<HTMLDetailsElement>('details.msgmenu')!;
    expect(menu.hidden).toBe(false);
    menu.open = true;
    const check = menu.querySelector<HTMLFormElement>('form[data-messaging-kind="status"]')!;
    submit(check);
    expect(check.querySelector('button')!.textContent).toBe('Checking…');
    expect(menu.open).toBe(false);
    await waitFor(() => release !== undefined);
    release!();
    await waitFor(() => check.querySelector('button')!.textContent === 'Check connection');
  } finally { controller.dispose(); }
});
