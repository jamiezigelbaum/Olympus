import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { waitFor } from './helpers/test-clock.ts';

const GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'FormData', 'CSS',
] as const;

const previous = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window;

beforeEach(() => {
  happyWindow = new Window({ url: 'https://gateway.test/' });
  const values: Record<(typeof GLOBALS)[number], unknown> = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLFormElement: happyWindow.HTMLFormElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
    HTMLSelectElement: happyWindow.HTMLSelectElement,
    HTMLButtonElement: happyWindow.HTMLButtonElement,
    ShadowRoot: happyWindow.ShadowRoot,
    Event: happyWindow.Event,
    MouseEvent: happyWindow.MouseEvent,
    KeyboardEvent: happyWindow.KeyboardEvent,
    FormData: happyWindow.FormData,
    CSS: happyWindow.CSS,
  };
  for (const name of GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
});

afterEach(() => {
  for (const name of GLOBALS) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  previous.clear();
  happyWindow.close();
});


test('Tinfoil controls submit the chosen provider for both judging and Private answers', async () => {
  const root = document.createElement('div');
  root.innerHTML = '<form data-judge-choice><input type="radio" name="choice" value="tinfoil" checked><input name="cap_dollars" value="2"><button type="submit">Save judge</button></form>'
    + '<form data-model-choice><input name="provider" value="tinfoil"><input name="model" value="kimi-k3-1-pro"><button type="submit">Save model</button></form>';
  document.body.append(root);
  const submitted: unknown[] = [];
  const controller = mountDashboardController({ root, transport: { control: async params => { submitted.push(params); return { status: 200, body: { ok: true } }; } }, navigate() {}, async refresh() { return undefined; }, returnUrl: 'https://gateway.test/', canWrite: true, signal: new AbortController().signal, pollIntervalMs: 0 });
  try {
    root.querySelectorAll('form').forEach(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await waitFor(() => submitted.length === 2, { description: 'Tinfoil forms submitted' });
    expect(submitted).toContainEqual({ action: 'save_judge', choice: 'tinfoil', cap_dollars: 2 });
    expect(submitted).toContainEqual({ action: 'save_model_choice', provider: 'tinfoil', model: 'kimi-k3-1-pro' });
  } finally { controller.dispose(); }
});
