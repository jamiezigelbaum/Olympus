import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readResult } from '../scripts/control-ui-preview.ts';
import {
  buildDashboardPreviewOptions,
  buildDashboardPreviewView,
  DASHBOARD_PREVIEW_NOW,
} from '../scripts/dashboard-preview.ts';
import type {
  OlympusDashboardControlParams,
  OlympusDashboardControlResult,
  OlympusDashboardReadResult,
} from '../src/control-ui-contract.ts';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { defaultConfig } from '../src/core/config.ts';
import { parseDashboardControlParams, requestDashboardControl } from '../src/core/control-ui-gateway.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import type { PrivacySettings } from '../src/workers/chatgpt/dashboard-contract.ts';
import { PRIVACY_GET_TOOL_NAME, PRIVACY_META_KEY, PRIVACY_SET_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import { renderDashboardHtmlRoute } from '../src/workers/dashboard/index.ts';
import { renderDashboardPrivacyPage } from '../src/workers/dashboard/pages/privacy.ts';
import { standaloneDashboardControllerScript } from '../src/workers/dashboard/components.ts';
import { createEmailSourceWorker, type DashboardPrivacyOutcome } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const NOW = DASHBOARD_PREVIEW_NOW;

function privacyPage(state = 'review', extra: Record<string, unknown> = {}): string {
  return renderDashboardPrivacyPage(buildDashboardPreviewView(state), {
    now: NOW,
    controlSessionCsrfToken: 'csrf',
    ...buildDashboardPreviewOptions(state),
    ...extra,
  });
}

describe('the Privacy editor page', () => {
  test('matches the ChatGPT privacy screen: description, always-private rules, pending count, Save', () => {
    const html = privacyPage();
    expect(html).toContain('<title>Olympus / Privacy</title>');
    expect(html).toContain('<h2 class="ptitle">What&#39;s private for you?</h2>');
    expect(html).toContain('Private items are answered only on this computer and never sent to a cloud model.');
    expect(html).toContain('>My health and therapy, money and taxes, anything about my kids</textarea>');
    expect(html).toContain('Always private (optional)');
    for (const [name, kind] of [['Medical Records', 'Folder in Dropbox'], ['Lawyer', 'Gmail label'], ['billing@clinic.example', 'Sender']]) {
      expect(html).toContain(`<p class="sline strong">${name}</p><p class="sline">${kind}</p>`);
    }
    expect(html).toContain('aria-label="Remove Medical Records"');
    expect(html).toContain('12 items are waiting to be checked on this computer.');
    // Save is the page's one filled button.
    const body = html.slice(html.indexOf('data-privacy-editor'), html.indexOf('<script'));
    expect(body.split('btn primary').length - 1).toBe(1);
    expect(body).toContain('<button type="submit" class="btn primary">Save</button>');
    expect(html).not.toContain('Public');
  });

  test('an unset profile starts empty, and a source that is not signed in says why its Add is unavailable', () => {
    const html = privacyPage('review-unconfigured');
    expect(html).toContain('placeholder="For example: my health and therapy, money and taxes, anything about my kids, my divorce"></textarea>');
    expect(html).toContain('<p class="foot pempty" data-privacy-empty>No folders, labels or senders yet.</p>');
    // Gmail is still signing in, so labels cannot be listed yet.
    expect(html).toContain('<span class="hint">Connect Gmail to add a label.</span>');
    expect(html).toContain('data-privacy-add="folder"');
    expect(html).toContain('data-privacy-add="sender"');
  });

  test('the read-only dash_ link never shows the owner\'s words or names', () => {
    const view = buildDashboardPreviewView('review');
    const { html } = renderDashboardHtmlRoute({
      url: new URL('http://olympus.test/dashboard?privacy&token=dash_reader'),
      view,
      options: { now: NOW, ...buildDashboardPreviewOptions('review') },
    });
    expect(html).toContain('data-privacy-locked');
    expect(html).toContain('Unlock dashboard controls in Setup to see and change what is private.');
    for (const secret of ['My health', 'Medical Records', 'Lawyer', 'billing@clinic.example']) expect(html).not.toContain(secret);
  });

  test('a native read-only connection reads the settings with every control disabled', () => {
    const page = readResult({ view: 'privacy' }, false, 'partial', 'review');
    expect(page.title).toBe('Olympus / Privacy');
    expect(page.body).toContain('Your OpenClaw connection is read-only');
    expect(page.body).toContain('<button type="submit" class="btn primary" disabled aria-disabled="true">Save</button>');
    expect(page.body).toContain(' readonly>');
  });

  test('without the worker\'s privacy settings the page says so instead of an empty editor', () => {
    const html = renderDashboardPrivacyPage(buildDashboardPreviewView('review'), { now: NOW, controlSessionCsrfToken: 'csrf' });
    expect(html).toContain('Privacy settings are not available from this worker.');
    expect(html.replace(/<script[\s\S]*?<\/script>/g, '')).not.toContain('data-privacy-form');
  });
});

describe('the save_privacy and retry_model control actions', () => {
  test('the Gateway accepts the editor\'s shape and nothing else', () => {
    const rules = [
      { kind: 'folder', source_id: 'dropbox.files', key: '/health', display: 'Health' },
      { kind: 'label', source_id: 'gmail.email', key: 'Label_12', value: 'Lawyer' },
      { kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' },
    ];
    expect(parseDashboardControlParams({ action: 'save_privacy', description: 'health', rules }))
      .toEqual({ action: 'save_privacy', description: 'health', rules } as OlympusDashboardControlParams);
    // The description may be cleared.
    expect(parseDashboardControlParams({ action: 'save_privacy', description: '' })).toEqual({ action: 'save_privacy', description: '' });
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules, api_key: 'x' })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules: [{ kind: 'public', source_id: 'gmail.email' }] })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules: [{ kind: 'sender', source_id: 'gmail.email', value: 'a@b.c', tier: 'x' }] })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules: Array.from({ length: 101 }, () => rules[2]) })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', description: 'x'.repeat(2_001) })).toThrow();
    expect(parseDashboardControlParams({ action: 'retry_model', model: 'answers' })).toEqual({ action: 'retry_model', model: 'answers' });
    expect(() => parseDashboardControlParams({ action: 'retry_model', model: 'gpt' })).toThrow();
  });

  test('the Gateway forwards them to the worker\'s own routes', async () => {
    const config = defaultConfig();
    config.worker.authToken = 'worker-secret';
    config.email.baseUrl = 'http://source-worker.test/v1';
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    await requestDashboardControl({ params: { action: 'save_privacy', description: 'health', rules: [] }, config, fetchImpl });
    await requestDashboardControl({ params: { action: 'retry_model', model: 'embedding' }, config, fetchImpl });
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual(['/dashboard/privacy', '/dashboard/models/retry']);
    expect(seen[0]!.body).toEqual({ description: 'health', rules: [] });
    expect(seen[1]!.body).toEqual({ model: 'embedding' });
  });

  test('the standalone page routes them to the same worker routes', () => {
    const script = standaloneDashboardControllerScript({ csrfToken: 'c', signature: 's', session: 'm', intervalMs: 0 });
    expect(script).toContain("if (action === 'save_privacy') return ['/dashboard/privacy', withoutAction(params)];");
    expect(script).toContain("if (action === 'retry_model') return ['/dashboard/models/retry', withoutAction(params)];");
  });

  test('the worker saves through the privacy hook, answers a refusal as 400, and needs the strong credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-privacy-route-'));
    const saved: Array<Record<string, unknown>> = [];
    const retried: string[] = [];
    const settings: PrivacySettings = { configured: true, description: 'health', rules: [], pendingCount: 2 };
    const worker = createEmailSourceWorker({ sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
      registryPath: join(dir, 'handles.json'),
      privacy: {
        read: async (): Promise<DashboardPrivacyOutcome> => ({ ok: true, settings }),
        save: async (update): Promise<DashboardPrivacyOutcome> => {
          saved.push(update);
          return update.description === 'bad'
            ? { ok: false, code: 'invalid_params', message: 'Those privacy settings are not valid.' }
            : { ok: true, settings: { ...settings, description: String(update.description ?? '') } };
        },
      },
      retryModel: (model) => { retried.push(model); return model === 'answers'; },
    } });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'test-control' });
    const post = (path: string, body: unknown, authenticated = true) => fetch(new Request(`http://worker.test${path}`, {
      method: 'POST',
      headers: { ...(authenticated ? { Authorization: 'Bearer test-control' } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    try {
      expect((await post('/dashboard/privacy', { description: 'x' }, false)).status).toBe(401);
      const ok = await post('/dashboard/privacy', { description: 'my kids', rules: [] });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, settings: { description: 'my kids' }, status_message: 'Privacy saved.' });
      expect(saved).toEqual([{ description: 'my kids', rules: [] }]);
      const refused = await post('/dashboard/privacy', { description: 'bad' });
      expect(refused.status).toBe(400);
      expect((await post('/dashboard/models/retry', { model: 'answers' })).status).toBe(200);
      expect((await post('/dashboard/models/retry', { model: 'embedding' })).status).toBe(409);
      expect((await post('/dashboard/models/retry', { model: 'other' })).status).toBe(400);
      expect(retried).toEqual(['answers', 'embedding']);
    } finally {
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the engine operation is ChatGPT\'s own: a save keeps Secrets-tier rules it never shows', async () => {
    // The worker's hook runs callSetupTool with the same backend ChatGPT uses;
    // this pins the behaviour the local editor relies on.
    let stored: PrivacySettings = {
      configured: true,
      description: 'old',
      pendingCount: 0,
      rules: [{ kind: 'sender', source_id: 'gmail.email', value: '@vault.example' }],
    };
    const backend = {
      privacySettings: () => stored,
      savePrivacy: (update: { description?: string; rules?: PrivacySettings['rules'] }) => {
        stored = { ...stored, configured: true, ...(update.description !== undefined ? { description: update.description } : {}), ...(update.rules ? { rules: update.rules } : {}) };
        return stored;
      },
      secretLocations: () => ({ folders: [], labels: [], senders: ['@vault.example'] }),
    } as unknown as Parameters<typeof callSetupTool>[2];
    const shown = await callSetupTool(PRIVACY_GET_TOOL_NAME, {}, backend);
    expect((shown._meta as Record<string, PrivacySettings>)[PRIVACY_META_KEY]!.rules).toEqual([]);
    await callSetupTool(PRIVACY_SET_TOOL_NAME, { description: 'new', rules: [{ kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' }] }, backend);
    expect(stored.rules.map((rule) => ('value' in rule ? rule.value : ''))).toEqual(['@clinic.example', '@vault.example']);
  });
});

const GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS',
] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let happy: Window;

describe('the Privacy editor in the browser', () => {
  beforeEach(() => {
    happy = new Window({ url: 'https://gateway.test/' });
    for (const name of GLOBALS) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      const value = name === 'window' ? happy : name === 'document' ? happy.document : name === 'navigator' ? happy.navigator
        : (happy as unknown as Record<string, unknown>)[name];
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
  });
  afterEach(() => {
    for (const name of GLOBALS) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    previous.clear();
    happy.close();
  });

  function mount(control: (params: OlympusDashboardControlParams) => Promise<OlympusDashboardControlResult>) {
    const page = readResult({ view: 'privacy' }, true, 'partial', 'review');
    const root = document.createElement('div');
    root.innerHTML = page.body;
    document.body.append(root);
    const reads: number[] = [];
    const abort = new AbortController();
    const controller = mountDashboardController({
      root,
      transport: { control },
      navigate: () => undefined,
      refresh: async (): Promise<OlympusDashboardReadResult> => { reads.push(1); return { ...page }; },
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: abort.signal,
      signature: page.signature,
      pollIntervalMs: 0,
    });
    const click = (selector: string) => (root.querySelector(selector) as HTMLElement).click();
    return { root, reads, controller, click, abort };
  }

  test('removes, adds a sender, holds the poll while edited, and saves the whole list', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const { root, reads, controller, click, abort } = mount(async (params) => {
      sent.push(params);
      return { status: 200, body: { ok: true, settings: {} } };
    });
    // Remove Lawyer, then add a sender (an invalid one first).
    const lawyer = [...root.querySelectorAll('[data-privacy-rule]')].find((row) => row.textContent?.includes('Lawyer'))!;
    (lawyer.querySelector('[data-privacy-remove]') as HTMLElement).click();
    expect(lawyer.hasAttribute('data-removed')).toBe(true);
    expect(lawyer.querySelector('[data-privacy-remove]')!.textContent).toBe('Undo');
    click('[data-privacy-add="sender"]');
    const field = root.querySelector('[data-privacy-sender]') as HTMLInputElement;
    field.value = 'not an address';
    click('[data-privacy-sender-add]');
    expect(root.querySelector('[data-privacy-panel="sender"] [data-privacy-panel-message]')!.textContent)
      .toBe('Enter an email address like name@example.com, or a domain like @example.com.');
    field.value = '@Doctor.Example';
    click('[data-privacy-sender-add]');
    expect(root.textContent).toContain('@doctor.example');
    // An edited list is the owner's: a poll does not replace it.
    await controller.refresh();
    expect(reads).toEqual([]);
    const textarea = root.querySelector('textarea[name="description"]') as HTMLTextAreaElement;
    textarea.value = 'health and money';
    (root.querySelector('form[data-privacy-form]') as HTMLFormElement).requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([{
      action: 'save_privacy',
      description: 'health and money',
      rules: [
        { kind: 'folder', source_id: 'dropbox.files', key: '/medical-records', display: 'Medical Records' },
        { kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' },
        { kind: 'sender', source_id: 'gmail.email', value: '@doctor.example' },
      ],
    } as OlympusDashboardControlParams]);
    // Saved: the page is read again from what the engine holds.
    expect(reads.length).toBe(1);
    abort.abort();
  });

  test('adds a folder from the picker\'s own list, by its key and name', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const { root, click, abort } = mount(async (params) => {
      sent.push(params);
      if (params.action === 'browse_folder_scope') {
        return { status: 200, body: { ok: true, scope_browser: {
          source_id: 'dropbox.files', account_generation: 'g', scope_revision: 'r', status: 'approved', selections: [], whole_account_selected: false,
          nodes: [{ key: '/Therapy', name: 'Therapy', kind: 'folder', has_children: false, selectable: true }],
        } } };
      }
      return { status: 200, body: { ok: true } };
    });
    click('[data-privacy-add="folder"]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent[0]).toEqual({ action: 'browse_folder_scope', source_id: 'dropbox.files' });
    const make = root.querySelector('[data-privacy-make-private]') as HTMLButtonElement;
    expect(make.textContent).toBe('Make private');
    make.click();
    expect(make.textContent).toBe('Already private');
    const added = [...root.querySelectorAll('[data-privacy-rule]')].map((row) => JSON.parse(row.getAttribute('data-privacy-rule')!));
    expect(added).toContainEqual({ kind: 'folder', source_id: 'dropbox.files', key: '/Therapy', display: 'Therapy' });
    expect(root.textContent).toContain('Therapy');
    abort.abort();
  });
});
