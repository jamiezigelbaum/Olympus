import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import { readModelChoices, resolveVeniceStrongest, builtInModelEnvValue } from '../src/core/model-choices.ts';
import { createModelChoicesBackend, VENICE_PROFILE_ID } from '../src/workers/engine/runtime/model-choices-backend.ts';
import { renderAnswerModelPickers, renderZkapiModelPicker } from '../src/workers/dashboard/model-pickers.ts';

const GIB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function policy(preset: 'local-first' | 'private-cloud-only' = 'local-first') {
  const dir = mkdtempSync(join(tmpdir(), 'model-choices-')); dirs.push(dir);
  const path = join(dir, 'sovereignty.json');
  writeFileSync(path, JSON.stringify(loadSovereigntyPreset(preset)));
  const config = (): SovereigntyConfig => JSON.parse(readFileSync(path, 'utf8'));
  return { path, config };
}

let zkapiSaved: string | undefined;
afterEach(() => { zkapiSaved = undefined; });

function backend(input: { path: string; config: () => SovereigntyConfig }, over: Partial<Parameters<typeof createModelChoicesBackend>[0]> = {}) {
  let reloads = 0;
  const made = createModelChoicesBackend({
    policyPath: input.path,
    config: input.config,
    builtInAnswers: () => true,
    builtInSize: () => 'standard',
    totalMemoryBytes: 16 * GIB,
    zkapi: { available: () => true, strongest: 'anthropic/claude-sonnet-5.5', read: () => zkapiSaved, write: async model => { zkapiSaved = model; return { ok: true }; } },
    venice: { strongest: async () => 'kimi-k4', catalog: async () => ({ 'kimi-k3': 'private', 'kimi-k4': 'private', 'glm-5': 'tee', 'grok-x': 'anonymized' }) },
    requestReload: () => { reloads += 1; return true; },
    ...over,
  });
  return { made, reloads: () => reloads };
}

describe('Venice: Always the strongest', () => {
  const traits = (data: Record<string, string>) => async () => new Response(JSON.stringify({ data }), { status: 200 });
  test('picks the highest-quality model when it is private, never an anonymized one', async () => {
    const category = async (id: string) => ({ 'big-anon': 'anonymized', 'kimi-k4': 'private', 'glm-5': 'tee' } as const)[id as 'kimi-k4'];
    expect(await resolveVeniceStrongest({ apiKey: 'k', baseUrl: 'https://v.test/api/v1', category, fetchImpl: traits({ highest_quality: 'kimi-k4', default_reasoning: 'glm-5' }) })).toBe('kimi-k4');
    expect(await resolveVeniceStrongest({ apiKey: 'k', baseUrl: 'https://v.test/api/v1', category, fetchImpl: traits({ highest_quality: 'big-anon', default_reasoning: 'glm-5' }) })).toBe('glm-5');
    expect(await resolveVeniceStrongest({ apiKey: 'k', baseUrl: 'https://v.test/api/v1', category, fetchImpl: traits({ highest_quality: 'big-anon' }) })).toBeUndefined();
    expect(await resolveVeniceStrongest({ apiKey: 'k', baseUrl: 'https://v.test/api/v1', category, fetchImpl: async () => new Response('nope', { status: 503 }) })).toBeUndefined();
  });

  test('choosing it pins the strongest now and remembers to follow it', async () => {
    const p = policy();
    const { made, reloads } = backend(p);
    const saved = await made.save('venice', 'strongest');
    expect(saved).toMatchObject({ ok: true });
    expect(p.config().modelProfiles[VENICE_PROFILE_ID]).toMatchObject({ model: 'kimi-k4' });
    expect(readModelChoices(p.path).venice).toBe('strongest');
    expect(reloads()).toBe(1);
    const status = await made.status();
    expect(status.venice).toMatchObject({ current: 'strongest', strongestNow: 'kimi-k4' });
    expect(status.venice!.options[0]!.value).toBe('strongest');
  });

  test('a pinned model must be a private Venice model', async () => {
    const p = policy();
    const { made } = backend(p);
    expect(await made.save('venice', 'grok-x')).toMatchObject({ ok: false });
    expect(await made.save('venice', 'glm-5')).toMatchObject({ ok: true });
    expect(p.config().modelProfiles[VENICE_PROFILE_ID]).toMatchObject({ model: 'glm-5' });
    expect(readModelChoices(p.path).venice).toBe('pinned');
    expect(await made.addable('venice')).toEqual(['glm-5', 'kimi-k3', 'kimi-k4']);
  });

  test('a later check follows a new strongest model; a pinned one stays', async () => {
    const p = policy();
    let strongest = 'kimi-k4';
    const { made } = backend(p, { venice: { strongest: async () => strongest, catalog: async () => ({}) } });
    await made.save('venice', 'strongest');
    strongest = 'kimi-k5';
    expect(await made.refreshStrongest()).toBe(true);
    expect(p.config().modelProfiles[VENICE_PROFILE_ID]).toMatchObject({ model: 'kimi-k5' });
    await made.save('venice', 'kimi-k5');
    strongest = 'kimi-k6';
    expect(await made.refreshStrongest()).toBe(false);
    expect(p.config().modelProfiles[VENICE_PROFILE_ID]).toMatchObject({ model: 'kimi-k5' });
  });
});

test('a pin made while the strongest lookup runs is kept', async () => {
  const p = policy();
  let release = (_: string) => {};
  let slow = false;
  const { made } = backend(p, { venice: { strongest: async () => slow ? new Promise<string>(resolve => { release = resolve; }) : 'kimi-k4', catalog: async () => ({ 'kimi-k3': 'private', 'kimi-k4': 'private' }) } });
  await made.save('venice', 'strongest');
  slow = true;
  const pending = made.refreshStrongest();
  await made.save('venice', 'kimi-k3');
  release('kimi-k5');
  expect(await pending).toBe(false);
  expect(p.config().modelProfiles[VENICE_PROFILE_ID]).toMatchObject({ model: 'kimi-k3' });
});

describe('local models', () => {
  test('lists the built-in sizes this computer can run and saves the size', async () => {
    const p = policy();
    const { made } = backend(p, { totalMemoryBytes: 8 * GIB, builtInSize: () => 'small' });
    const status = await made.status();
    expect(status.local!.options.map(option => option.value)).toEqual(['builtin:small']);
    const roomy = backend(p).made;
    expect((await roomy.status()).local!.options.map(option => option.value)).toEqual(['builtin:small', 'builtin:standard', 'builtin:large']);
    expect(await roomy.save('local', 'builtin:large')).toMatchObject({ ok: true });
    expect(readModelChoices(p.path).builtIn).toBe('large');
    expect(builtInModelEnvValue({}, readModelChoices(p.path))).toBe('large');
    expect(builtInModelEnvValue({ OLYMPUS_BUILT_IN_ANALYST_MODEL: 'small' }, readModelChoices(p.path))).toBe('small');
    expect(await backend(p, { totalMemoryBytes: 8 * GIB }).made.save('local', 'builtin:large')).toMatchObject({ ok: false });
  });

  test('a model server the owner runs is the one option, changed through Add a model', async () => {
    const p = policy();
    const { made } = backend(p, { builtInAnswers: () => false });
    const status = await made.status();
    expect(status.local).toMatchObject({ current: 'delphi/source-answer' });
    expect(await made.save('local', 'builtin:small')).toMatchObject({ ok: false });
  });
});

describe('zkAPI', () => {
  test('saves to the consult settings questions use; Always the strongest clears the pin', async () => {
    const { made } = backend(policy());
    expect((await made.status()).zkapi).toMatchObject({ current: 'strongest', strongestNow: 'anthropic/claude-sonnet-5.5' });
    expect(await made.save('zkapi', 'openai/gpt-5.5')).toMatchObject({ ok: true });
    expect(zkapiSaved).toBe('openai/gpt-5.5');
    expect((await made.status()).zkapi!.current).toBe('openai/gpt-5.5');
    expect(await made.save('zkapi', 'not a model')).toMatchObject({ ok: false });
    expect(await made.save('zkapi', 'strongest')).toMatchObject({ ok: true });
    expect(zkapiSaved).toBeUndefined();
    expect(await backend(policy(), { zkapi: { available: () => false, strongest: 'x/y', read: () => undefined, write: async () => ({ ok: true }) } }).made.status()).not.toHaveProperty('zkapi');
  });
});

describe('the pickers on Privacy rules', () => {
  test('list only usable models, strongest first, with Add a model in a closable dialog', async () => {
    const p = policy();
    const { made } = backend(p);
    await made.save('venice', 'strongest');
    const html = renderAnswerModelPickers(await made.status(), true);
    const doc = new Window().document; doc.body.innerHTML = html;
    const venice = doc.querySelector('[data-model-pick="venice"]')!;
    expect(venice.querySelector('.pickhead')!.textContent).toContain('Always the strongest (kimi-k4)');
    expect([...venice.querySelectorAll('input[name="model"]')].map(input => (input as unknown as HTMLInputElement).value)).toEqual(['strongest', 'kimi-k4']);
    expect((venice.querySelector('input[value="strongest"]') as unknown as HTMLInputElement).checked).toBe(true);
    expect(venice.querySelector('[data-add-model-open="venice"]')!.textContent).toBe('+ Add a Venice model');
    expect(venice.querySelector('dialog[data-add-model="venice"] [data-dialog-close]')!.textContent).toBe('✕');
    const local = doc.querySelector('[data-model-pick="local"]')!;
    expect(local.querySelector('dialog[data-add-model="local"]')!.textContent).toContain('Look on this computer');
    expect(local.querySelector('dialog[data-add-model="local"]')!.textContent).toContain('Copy request');
    expect(renderAnswerModelPickers(await made.status(), false)).toContain('disabled');
    expect(renderZkapiModelPicker(await made.status(), true)).toContain('Always the strongest');
  });

  test('the browser submits the pick, and Add a Venice model loads the private list', async () => {
    const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
    const browser = new Window({ url: 'http://localhost/dashboard?keys' });
    const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLDialogElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'] as const;
    const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
    let dispose = () => {};
    try {
      const p = policy();
      const { made } = backend(p);
      const html = renderAnswerModelPickers(await made.status(), true);
      const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
      const calls: Record<string, unknown>[] = [];
      const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1, returnUrl: 'http://localhost/dashboard?keys', navigate() {},
        refresh: async () => ({ status: 200, title: 'Keys', body: html, controller: 'dashboard', can_write: true, signature: 'same', poll_interval_ms: -1 }),
        transport: { control: async params => { calls.push(params as Record<string, unknown>); return params.action === 'list_addable_models' ? { status: 200, body: { ok: true, models: ['glm-5', 'kimi-k4'] } } : { status: 200, body: { ok: true, status_message: 'Saved.' } }; } },
      }); dispose = () => controller.dispose();
      root.querySelector<HTMLInputElement>('[data-model-pick="venice"] input[value="strongest"]')!.click();
      root.querySelector<HTMLFormElement>('[data-model-pick="venice"] .pickpanel form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await browser.happyDOM.waitUntilComplete();
      expect(calls[0]).toEqual({ action: 'save_model_choice', provider: 'venice', model: 'strongest' });
      root.querySelector<HTMLButtonElement>('[data-add-model-open="venice"]')!.click();
      await browser.happyDOM.waitUntilComplete();
      await new Promise(resolve => setTimeout(resolve, 20));
      const dialog = root.querySelector<HTMLDialogElement>('dialog[data-add-model="venice"]')!;
      expect(dialog.open).toBe(true);
      expect(calls.at(-1)).toEqual({ action: 'list_addable_models', provider: 'venice' });
      expect([...dialog.querySelectorAll<HTMLInputElement>('input[name="model"]')].map(input => input.value)).toEqual(['glm-5', 'kimi-k4']);
      dialog.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click();
      expect(dialog.open).toBe(false);
    } finally {
      dispose(); browser.close();
      for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    }
  });
});
