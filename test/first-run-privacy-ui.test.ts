import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { createPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { ModelSetupService, type ModelSetupView } from '../src/core/model-setup.ts';
import { loadSovereigntyPreset, type SovereigntyPresetName } from '../src/core/sovereignty.ts';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';
import { renderDashboardKeysPage } from '../src/workers/dashboard/pages/local.ts';
import { buildDashboardPreviewView, setupPreviewScript } from '../scripts/dashboard-preview.ts';

const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let browser: Window;
const cleanup: Array<() => void> = [];
beforeEach(() => {
  browser = new Window({ url: 'http://localhost/dashboard?keys' });
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
  }
});
afterEach(() => {
  cleanup.splice(0).reverse().forEach(fn => fn());
  browser.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function fixture(upgrade = false) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-sheet-ui-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sovereignty.json');
  writeFileSync(path, JSON.stringify(upgrade ? loadSovereigntyPreset('local-only') : createPendingPrivacyPolicy()));
  const policy = () => JSON.parse(readFileSync(path, 'utf8'));
  let override: ModelSetupView | undefined;
  const view = () => override ?? new ModelSetupService({ config: policy(), credentialState: () => 'ready', autoCheck: false }).getStatus();
  const html = () => renderModelSetup(view());
  const root = document.createElement('div');
  root.innerHTML = html(); document.body.append(root);
  const calls: string[] = [];
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1,
    navigate() {}, returnUrl: 'http://localhost/dashboard?keys',
    async refresh() { return { status: 200, title: 'Keys', body: html(), controller: 'dashboard', can_write: true, signature: html(), poll_interval_ms: -1 }; },
    transport: { async control(params) {
      calls.push(params.action);
      if (params.action === 'save_first_run_privacy') {
        const saved = saveFirstRunPrivacyChoice(path, params.choice as SovereigntyPresetName);
        if (!saved.ok || !saved.changed) return { status: 409, body: { ok: false, error: { message: 'This choice was already made. Refresh to see the current setting.' } } };
      }
      if (params.action === 'check_model_setup' && !override) {
        const service = new ModelSetupService({ config: policy(), credentialState: () => 'ready', autoCheck: false, builtInAnswers: () => true,
          fetch: Object.assign(async () => { throw new Error('No external model in this fixture'); }, { preconnect: () => {} }) });
        override = await service.checkLocalModels();
      }
      return { status: 200, body: { ok: true } };
    } },
  });
  cleanup.push(() => controller.dispose());
  const submit = async (selector: string) => {
    const form = root.querySelector<HTMLFormElement>(selector);
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await browser.happyDOM.waitUntilComplete();
  };
  const click = (selector: string) => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull(); button!.click();
  };
  return { root, policy, path, calls, controller, submit, click, setView: (value: ModelSetupView) => { override = value; } };
}

function visiblePanel(root: HTMLElement) { return root.querySelector<HTMLElement>('[data-first-run-sheet] [data-setup-panel]:not([hidden])'); }

test('new-install fixture renders the shared sheet and upgrade fixture never asks', () => {
  const fresh = fixture();
  expect(fresh.root.querySelector('[data-first-run-sheet] [data-setup-steps]')).not.toBeNull();
  expect(fresh.root.querySelector<HTMLInputElement>('input[value="local-first"]')?.checked).toBe(true);
  expect(visiblePanel(fresh.root)?.textContent).toContain('Local models with Venice fallback — Recommended');
  expect(fixture(true).root.querySelector('[data-first-run-sheet]')).toBeNull();
});

test('Keys shows one privacy explanation and describes the fourth option without routing jargon', () => {
  const page = document.createElement('div');
  page.innerHTML = renderDashboardKeysPage(buildDashboardPreviewView('first-run'));
  expect(page.textContent).not.toContain('Privacy settings for Private answers');
  expect(page.textContent).not.toContain('The default keeps them on this computer');
  const option = page.querySelector('input[value="no-sensitive"]')!.closest('label')!;
  expect(option.textContent).toContain('Private answers only in Olympus');
  expect(option.textContent).toContain('Connected agents cannot use Private items to answer.');
  expect(option.textContent).not.toContain('agent answer lane');
  // Existing links from Private answers still land on the model setup area.
  expect(page.querySelector('#private-routing [data-first-run-sheet]')).not.toBeNull();
});

test('the full Keys page supplies the existing Venice key target and the local-model connector', () => {
  const view = buildDashboardPreviewView('new');
  view.model_setup = new ModelSetupService({ config: createPendingPrivacyPolicy(), credentialState: () => 'missing', autoCheck: false }).getStatus();
  const page = document.createElement('div');
  page.innerHTML = renderDashboardKeysPage(view, { controlSessionCsrfToken: 'fixture' });
  const target = page.querySelector<HTMLElement>('[data-first-run-venice] [data-focus-target]')!.dataset.focusTarget!;
  expect(page.querySelector(target)?.getAttribute('type')).toBe('password');
  expect(page.querySelectorAll('[data-first-run-sheet] [data-local-models-discover]')).toHaveLength(1);
  expect(page.querySelector('[data-first-run-sheet] [name="embedding_model"]')).toBeNull();
  view.model_setup = new ModelSetupService({ config: loadSovereigntyPreset('local-only'), credentialState: () => 'ready', autoCheck: false }).getStatus();
  page.innerHTML = renderDashboardKeysPage(view);
  expect(page.querySelector('[data-first-run-sheet]')).toBeNull();
});

for (const [choice, step] of [
  ['local-first', 'Add a Venice key'], ['private-cloud-only', 'Add a Venice key'],
  ['local-only', 'Connect my local models'], ['no-sensitive', undefined],
] as const) test(`${choice} saves its preset, shows only its conditional step and finishes with verified Working`, async () => {
  const f = fixture();
  f.root.querySelector<HTMLInputElement>(`input[value="${choice}"]`)!.checked = true;
  await f.submit('[data-first-run-privacy]');
  expect(f.policy()).toEqual(loadSovereigntyPreset(choice));
  expect(visiblePanel(f.root)?.textContent).toContain(step ?? 'Verify it works');
  if (step) {
    const other = choice === 'local-only' ? '[data-first-run-venice]' : '[data-first-run-local]';
    expect(f.root.querySelector<HTMLElement>(other)?.hidden).toBe(true);
    f.click('[data-first-run-sheet] [data-setup-next]');
  }
  expect(visiblePanel(f.root)?.textContent).toContain('Verify it works');
  expect(f.root.querySelector('[data-setup-counter]')?.textContent).toBe(choice === 'no-sensitive' ? 'Step 2 of 2' : 'Step 3 of 3');
  expect(visiblePanel(f.root)?.textContent).not.toContain('Working');
  await f.submit('[data-first-run-sheet] [data-model-check]');
  expect(f.calls).toEqual(['save_first_run_privacy', 'check_model_setup']);
  expect(visiblePanel(f.root)?.textContent).toContain('Working');
  expect(f.root.querySelector<HTMLElement>('[data-first-run-done]')?.hidden).toBe(false);
  f.click('[data-first-run-done]');
  await browser.happyDOM.waitUntilComplete();
  expect(f.root.querySelector('[data-first-run-sheet]')).toBeNull();
  expect(f.policy()).toEqual(loadSovereigntyPreset(choice));
});

test.each(['local-first', 'local-only'] as const)('%s failed readiness names the step to redo; polling preserves it', async choice => {
  const f = fixture();
  f.root.querySelector<HTMLInputElement>(`input[value="${choice}"]`)!.checked = true;
  await f.submit('[data-first-run-privacy]');
  f.click('[data-first-run-sheet] [data-setup-next]');
  const local = choice === 'local-only';
  const detail = local ? 'The answer model is not responding.' : 'The key was rejected.';
  const step = local ? 'Connect my local models' : 'Add a Venice key';
  f.setView({ ready: false, checked_at: '', cards: [{ id: local ? 'local' : 'venice', label: local ? 'Local' : 'Venice', state: 'needs_attention', required: true, detail }] });
  await f.submit('[data-first-run-sheet] [data-model-check]');
  expect(visiblePanel(f.root)?.textContent).toContain(detail);
  expect(f.root.querySelector<HTMLElement>('[data-first-run-done]')?.hidden).toBe(true);
  f.click('[data-first-run-redo]');
  expect(visiblePanel(f.root)?.textContent).toContain(step);
  await f.controller.refresh();
  expect(visiblePanel(f.root)?.textContent).toContain(step);
});

test('pending worker activation never reports Working and a later read can complete verification', async () => {
  const f = fixture();
  await f.submit('[data-first-run-privacy]'); f.click('[data-first-run-sheet] [data-setup-next]');
  f.setView({ ready: false, privacy_choice_pending: true, checked_at: '', cards: [] });
  await f.submit('[data-first-run-sheet] [data-model-check]');
  expect(visiblePanel(f.root)?.textContent).toContain('applying');
  expect(f.root.querySelector<HTMLElement>('[data-first-run-done]')?.hidden).toBe(true);
  f.setView({ ready: true, checked_at: '', cards: [] });
  await f.controller.refresh();
  expect(visiblePanel(f.root)?.textContent).toContain('Working');
});

test('a save conflict uses the separate error state and returns to the choice', async () => {
  const f = fixture();
  saveFirstRunPrivacyChoice(f.path, 'local-only');
  await f.submit('[data-first-run-privacy]');
  expect(visiblePanel(f.root)).toBeNull();
  expect(f.root.querySelector('[data-setup-error]')?.textContent).toContain('This choice was already made');
  f.click('[data-setup-retry]');
  expect(visiblePanel(f.root)?.textContent).toContain('How should Olympus answer');
  expect(f.root.querySelector('[data-setup-error]')).toBeNull();
  expect(f.policy()).toEqual(loadSovereigntyPreset('local-only'));
});

test('first-run primary actions share the bottom row with Back', async () => {
  const f = fixture();
  const actions = f.root.querySelector('[data-setup-actions]')!;
  const primary = actions.querySelector<HTMLButtonElement>('[data-setup-submit]')!;
  expect(primary.hidden).toBe(false);
  expect(primary.textContent).toBe('Continue');
  expect(primary.form).toBe(f.root.querySelector('[data-first-run-privacy]'));
  expect(actions.querySelector<HTMLButtonElement>('[data-setup-back]')!.disabled).toBe(true);
  expect(visiblePanel(f.root)?.querySelector('button[type="submit"]')).toBeNull();
  await f.submit('[data-first-run-privacy]');
  expect(primary.hidden).toBe(true);
  f.click('[data-setup-next]');
  expect(primary.hidden).toBe(false);
  expect(primary.textContent).toBe('Check readiness');
  expect(primary.form).toBe(f.root.querySelector('[data-model-check]'));
  expect(actions.querySelector<HTMLButtonElement>('[data-setup-back]')!.disabled).toBe(false);
  await f.submit('[data-model-check]');
  expect(primary.hidden).toBe(true);
  expect(actions.querySelector('[data-first-run-done]')).not.toBeNull();
  f.click('[data-setup-back]');
  await f.controller.refresh();
  expect(actions.querySelector<HTMLButtonElement>('[data-first-run-done]')!.hidden).toBe(true);
  expect(primary.hidden).toBe(true);
});

test('preview exposes the pending first-run sheet', () => {
  const view = buildDashboardPreviewView('first-run');
  expect(view.model_setup?.privacy_choice_pending).toBe(true);
  expect(renderDashboardKeysPage(view)).toContain('data-first-run-sheet');
});

for (const [sheet, step, text] of [
  ['first-run', '1', 'How should Olympus answer'],
  ['first-run', '2', 'Add a Venice key'],
  ['first-run-local', '2', 'Connect my local models'],
  ['first-run', '3', 'Verify it works'],
  ['first-run-no-sensitive', '2', 'Verify it works'],
] as const) test(`preview link ${sheet} step ${step} opens the intended panel`, async () => {
  const f = fixture();
  new Function('setTimeout', setupPreviewScript(sheet, step).replace(/^<script>|<\/script>$/g, ''))(browser.setTimeout.bind(browser));
  browser.dispatchEvent(new browser.Event('DOMContentLoaded'));
  await browser.happyDOM.waitUntilComplete();
  expect(visiblePanel(f.root)?.textContent).toContain(text);
});
