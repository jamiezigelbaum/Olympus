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
import { callSetupTool, type ChatGptSetupBackend } from '../src/workers/chatgpt/setup-tools.ts';
import type { PrivacySettings } from '../src/workers/chatgpt/dashboard-contract.ts';
import { PRIVACY_GET_TOOL_NAME, PRIVACY_META_KEY, PRIVACY_SET_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import { renderDashboardHtmlRoute } from '../src/workers/dashboard/index.ts';
import { renderDashboardPrivacyPage } from '../src/workers/dashboard/pages/privacy.ts';
import { standaloneDashboardControllerScript } from '../src/workers/dashboard/components.ts';
import { createEmailSourceWorker, type DashboardPrivacyOutcome } from '../src/workers/email-source/index.ts';
import { createDashboardPrivacyAdapter } from '../src/workers/email-source/dashboard-privacy.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { lowersPrivacy, privacyLogic, privacyRuleIdentity } from '../src/workers/dashboard/shared-privacy.ts';
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

  test('broad words in the saved description bring the follow-up questions, pre-filled from its sentences', () => {
    const html = privacyPage();
    // "health" and "money" in the preview's description: their questions, every choice at its default.
    expect(html).toContain('<div class="pquestions" data-privacy-questions="health,money"><div class="sect">A few quick questions</div>');
    expect(html).toContain('<h3 class="pqtitle">Which money things are private?</h3>');
    expect(html).toContain('<div class="pqopt" role="radiogroup" aria-labelledby="privacy-q-money-tax"><span class="pqlabel" id="privacy-q-money-tax">Tax and payroll papers</span>');
    expect(html).toContain('<label class="pqchoice"><input type="radio" name="privacy-q-money-tax" value="private" data-privacy-topic="money" data-privacy-option="tax" checked><span>Private</span></label>');
    const saved = renderDashboardPrivacyPage(buildDashboardPreviewView('review'), {
      now: NOW, format: 'fragment', controlMode: 'native', canWrite: true,
      privacySettings: { configured: true, description: 'my family\nAbout family: private — Alumni, contact and address lists.', pendingCount: 0, revision: 'r', rules: [] },
    });
    expect(saved).toContain('name="privacy-q-family-contacts" value="private" data-privacy-topic="family" data-privacy-option="contacts" checked>');
    expect(saved).toContain('name="privacy-q-family-history" value="share" data-privacy-topic="family" data-privacy-option="history" checked>');
    const none = privacyPage('review-unconfigured');
    expect(none).toContain('<div class="pquestions" data-privacy-questions="" hidden></div>');
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

  test('a native read-only connection gets counts and why, never the description or names', () => {
    const page = readResult({ view: 'privacy' }, false, 'partial', 'review');
    expect(page.title).toBe('Olympus / Privacy');
    expect(page.can_write).toBe(false);
    expect(page.body).toContain('data-privacy-locked');
    expect(page.body).toContain('Your description and 3 always-private rules are set.');
    expect(page.body).toContain('Your OpenClaw connection is read-only.');
    for (const secret of ['My health', 'Medical Records', 'Lawyer', 'billing@clinic.example']) expect(page.body).not.toContain(secret);
    expect(page.body).not.toContain('data-privacy-form');
  });

  test('a standalone page without the control session gets the same: counts, never content', () => {
    const html = renderDashboardPrivacyPage(buildDashboardPreviewView('review'), {
      now: NOW, ...buildDashboardPreviewOptions('review'),
    });
    expect(html).toContain('data-privacy-locked');
    for (const secret of ['My health', 'Medical Records', 'Lawyer', 'billing@clinic.example']) expect(html).not.toContain(secret);
  });

  test('without the worker\'s privacy settings the page says so instead of an empty editor', () => {
    const html = renderDashboardPrivacyPage(buildDashboardPreviewView('review'), { now: NOW, controlSessionCsrfToken: 'csrf' });
    expect(html).toContain('Privacy settings are not available from this worker.');
    expect(html.replace(/<script[\s\S]*?<\/script>/g, '')).not.toContain('data-privacy-form');
  });
});

describe('the privacy rules both editors share', () => {
  test('one identity per rule: folders and labels by key, senders by trimmed lowercase value', () => {
    expect(privacyRuleIdentity({ kind: 'sender', source_id: 'gmail.email', value: ' Billing@Clinic.Example ' }))
      .toBe(privacyRuleIdentity({ kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' }));
    expect(privacyRuleIdentity({ kind: 'folder', source_id: 'dropbox.files', key: '/a', display: 'A' }))
      .toBe(privacyRuleIdentity({ kind: 'folder', source_id: 'dropbox.files', key: '/a' }));
    expect(privacyRuleIdentity({ kind: 'label', source_id: 'gmail.email', key: 'L1', value: 'x' }))
      .not.toBe(privacyRuleIdentity({ kind: 'label', source_id: 'gmail.email', key: 'L2', value: 'x' }));
  });

  test('lowering is a removed rule or changed words; adding never lowers', () => {
    const current = { description: 'health', rules: [{ kind: 'label', source_id: 'gmail.email', key: 'L1', value: 'Lawyer' }] };
    expect(lowersPrivacy({ description: 'health', rules: [...current.rules, { kind: 'sender', source_id: 'gmail.email', value: 'a@b.example' }] }, current as never)).toBe(false);
    expect(lowersPrivacy({ rules: [] }, current as never)).toBe(true);
    expect(lowersPrivacy({ description: 'health and money' }, current as never)).toBe(true);
  });

  test('the Gateway refuses a rule without its kind\'s shape, by the editors\' own rule', () => {
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', rules: [{ kind: 'label', source_id: 'gmail.email', key: 'L1' }] }))
      .toThrow('shape of its kind');
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', rules: [{ kind: 'folder', source_id: 'gmail.email', key: '/x' }] }))
      .toThrow('shape of its kind');
    // A folder saved without its name is a valid rule.
    expect(parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/x' }] }))
      .toEqual({ action: 'save_privacy', revision: 'r1', rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/x' }] });
  });
});

describe('the save_privacy and retry_model control actions', () => {
  test('the Gateway accepts the editor\'s shape and nothing else', () => {
    const rules = [
      { kind: 'folder', source_id: 'dropbox.files', key: '/health', display: 'Health' },
      { kind: 'label', source_id: 'gmail.email', key: 'Label_12', value: 'Lawyer' },
      { kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' },
    ];
    expect(parseDashboardControlParams({ action: 'save_privacy', description: 'health', rules, revision: 'r1' }))
      .toEqual({ action: 'save_privacy', description: 'health', rules, revision: 'r1' } as OlympusDashboardControlParams);
    // The description may be cleared.
    expect(parseDashboardControlParams({ action: 'save_privacy', description: '', revision: 'r1' }))
      .toEqual({ action: 'save_privacy', description: '', revision: 'r1' });
    // No revision, no save: an omitted or empty one would skip the compare-and-swap.
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules })).toThrow('revision');
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules, revision: '' })).toThrow('revision');
    expect(() => parseDashboardControlParams({ action: 'save_privacy', rules, revision: 'r1', api_key: 'x' })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', rules: [{ kind: 'public', source_id: 'gmail.email' }] })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', rules: [{ kind: 'sender', source_id: 'gmail.email', value: 'a@b.c', tier: 'x' }] })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', rules: Array.from({ length: 101 }, () => rules[2]) })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', description: 'x'.repeat(2_001) })).toThrow();
    expect(parseDashboardControlParams({ action: 'retry_model', model: 'answers' })).toEqual({ action: 'retry_model', model: 'answers' });
    expect(parseDashboardControlParams({ action: 'save_privacy', rules: [], revision: 'r1', confirm: true }))
      .toEqual({ action: 'save_privacy', rules: [], revision: 'r1', confirm: true });
    expect(() => parseDashboardControlParams({ action: 'save_privacy', revision: 'r1', confirm: 'yes' })).toThrow();
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
    await requestDashboardControl({ params: { action: 'save_privacy', description: 'health', rules: [], revision: 'r1', confirm: true }, config, fetchImpl });
    await requestDashboardControl({ params: { action: 'retry_model', model: 'embedding' }, config, fetchImpl });
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual(['/dashboard/privacy', '/dashboard/models/retry']);
    expect(seen[0]!.body).toEqual({ description: 'health', rules: [], revision: 'r1', confirm: true });
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
        summary: async () => ({ ok: true, summary: { configured: true, pendingCount: 2, ruleCount: 0 } }),
        read: async (): Promise<DashboardPrivacyOutcome> => ({ ok: true, status: 'current', settings }),
        save: async (update): Promise<DashboardPrivacyOutcome> => {
          saved.push(update);
          if (update.description === 'bad') return { ok: false, code: 'invalid_params', message: 'Those privacy settings are not valid.' };
          if (update.description === 'lower') return { ok: false, code: 'privacy_owner_only', message: 'Confirm first.' };
          if (update.description === 'stale') return { ok: true, status: 'conflict', settings: { ...settings, revision: 'r9' } };
          return { ok: true, status: 'saved', settings: { ...settings, description: String(update.description ?? '') } };
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
      expect(saved[0]).toEqual({ description: 'my kids', rules: [] });
      const refused = await post('/dashboard/privacy', { description: 'bad' });
      expect(refused.status).toBe(400);
      const lower = await post('/dashboard/privacy', { description: 'lower' });
      expect(lower.status).toBe(409);
      expect(await lower.json()).toMatchObject({ ok: false, error: { code: 'privacy_owner_only' } });
      const stale = await post('/dashboard/privacy', { description: 'stale', revision: 'r1' });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'conflict' }, settings: { revision: 'r9' } });
      expect((await post('/dashboard/models/retry', { model: 'answers' })).status).toBe(200);
      expect((await post('/dashboard/models/retry', { model: 'embedding' })).status).toBe(409);
      expect((await post('/dashboard/models/retry', { model: 'other' })).status).toBe(400);
      expect(retried).toEqual(['answers', 'embedding']);
    } finally {
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the engine operation is ChatGPT\'s own: removals need the confirmation, Secrets-tier rules are kept, a stale revision is a conflict', async () => {
    // The worker's hook runs callSetupTool with the same backend ChatGPT uses;
    // this pins the behaviour the local editor relies on.
    let stored: PrivacySettings = {
      configured: true,
      description: 'old',
      pendingCount: 0,
      revision: 'r1',
      rules: [
        { kind: 'sender', source_id: 'gmail.email', value: 'boss@vault.example' },
        { kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' },
      ],
    };
    const backend = {
      privacySettings: () => stored,
      savePrivacy: (update: { description?: string; rules?: PrivacySettings['rules'] }) => {
        stored = {
          ...stored,
          revision: `${stored.revision}+`,
          ...(update.description !== undefined ? { description: update.description } : {}),
          ...(update.rules ? { rules: update.rules } : {}),
        };
        return stored;
      },
      secretLocations: () => ({ folderKeys: new Set(), pathPrefixes: [], labelIds: new Set(), senders: ['@vault.example'] }),
    } as unknown as Parameters<typeof callSetupTool>[2];
    const shown = await callSetupTool(PRIVACY_GET_TOOL_NAME, {}, backend);
    const visible = (shown._meta as Record<string, PrivacySettings>)[PRIVACY_META_KEY]!;
    expect(visible.rules).toEqual([{ kind: 'sender', source_id: 'gmail.email', value: '@clinic.example' }]);
    // Removing the visible rule without the confirmation is refused.
    await expect(callSetupTool(PRIVACY_SET_TOOL_NAME, { rules: [], revision: 'r1' }, backend)).rejects.toThrow('privacy_owner_only');
    // A stale revision is a conflict, and nothing is saved.
    const stale = await callSetupTool(PRIVACY_SET_TOOL_NAME, { rules: visible.rules, revision: 'r0' }, backend);
    expect((stale.structuredContent as { status: string }).status).toBe('conflict');
    // With the confirmation the removal saves, and the hidden Secrets rule stays.
    await callSetupTool(PRIVACY_SET_TOOL_NAME, { rules: [], revision: 'r1', confirmation: visible.confirmation }, backend);
    expect(stored.rules.map((rule) => ('value' in rule ? rule.value : ''))).toEqual(['boss@vault.example']);
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

  const BASE_SETTINGS: PrivacySettings = {
    configured: true,
    description: 'My health',
    pendingCount: 3,
    revision: 'rev-1',
    rules: [
      { kind: 'folder', source_id: 'dropbox.files', key: '/medical-records', display: 'Medical Records' },
      { kind: 'label', source_id: 'gmail.email', key: 'Label_12', value: 'Lawyer' },
      { kind: 'sender', source_id: 'gmail.email', value: 'billing@clinic.example' },
      // A folder saved without its name: kept exactly as saved.
      { kind: 'folder', source_id: 'dropbox.files', key: '/Taxes/2025' },
    ],
  };

  function mount(
    control: (params: OlympusDashboardControlParams) => Promise<OlympusDashboardControlResult>,
    settings: PrivacySettings = BASE_SETTINGS,
  ) {
    const view = buildDashboardPreviewView('review');
    const body = renderDashboardPrivacyPage(view, {
      now: NOW, format: 'fragment', controlMode: 'native', canWrite: true, privacySettings: settings,
    });
    const root = document.createElement('div');
    root.innerHTML = body;
    document.body.append(root);
    const reads: number[] = [];
    const abort = new AbortController();
    const controller = mountDashboardController({
      root,
      transport: { control },
      navigate: () => undefined,
      refresh: async (): Promise<OlympusDashboardReadResult> => {
        reads.push(1);
        return { status: 200, title: 'Olympus / Privacy', body, controller: 'dashboard', can_write: true, signature: 'x', poll_interval_ms: 0 };
      },
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: abort.signal,
      signature: 'x',
      pollIntervalMs: 0,
      privacyLogic,
    });
    const click = (selector: string) => (root.querySelector(selector) as HTMLElement).click();
    const submit = async () => {
      (root.querySelector('form[data-privacy-form]') as HTMLFormElement).requestSubmit();
      await settle();
    };
    const row = (text: string) => [...root.querySelectorAll('[data-privacy-rule]')].find((node) => node.textContent?.includes(text))!;
    return { root, reads, controller, click, submit, row, abort };
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 4; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const ok = async (): Promise<OlympusDashboardControlResult> => ({ status: 200, body: { ok: true, settings: {} } });

  test('an additive save goes straight out with the revision and no confirmation, every saved rule kept byte for byte', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const { root, reads, controller, click, submit, abort } = mount(async (params) => { sent.push(params); return ok(); });
    // A rule saved without its name shows its account, as the ChatGPT panel does, and stays nameless.
    expect(root.textContent).toContain('A folder in Dropbox');
    click('[data-privacy-add="sender"]');
    const field = root.querySelector('[data-privacy-sender]') as HTMLInputElement;
    field.value = 'not an address';
    click('[data-privacy-sender-add]');
    expect(root.querySelector('[data-privacy-panel="sender"] [data-privacy-panel-message]')!.textContent)
      .toBe('Enter an email address like name@example.com, or a domain like @example.com.');
    field.value = '@Doctor.Example';
    click('[data-privacy-sender-add]');
    // An edited list is the owner's: a poll does not replace it.
    await controller.refresh();
    expect(reads).toEqual([]);
    await submit();
    expect(root.querySelector('[data-privacy-confirm]')).toBeNull();
    expect(sent).toEqual([{
      action: 'save_privacy',
      description: 'My health',
      rules: [...BASE_SETTINGS.rules, { kind: 'sender', source_id: 'gmail.email', value: '@doctor.example' }],
      revision: 'rev-1',
    } as OlympusDashboardControlParams]);
    expect(reads.length).toBe(1);
    abort.abort();
  });

  test('a removal asks first, in place, and only the confirmed save carries the confirmation', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const { root, click, submit, row, abort } = mount(async (params) => { sent.push(params); return ok(); });
    (row('Lawyer').querySelector('[data-privacy-remove]') as HTMLElement).click();
    expect(row('Lawyer').hasAttribute('data-removed')).toBe(true);
    await submit();
    expect(sent).toEqual([]);
    expect(root.querySelector('[data-privacy-confirm]')!.textContent).toContain('This removes protection from Lawyer.');
    // Cancel: nothing is sent, and undoing the removal needs no confirmation.
    click('[data-privacy-confirm-no]');
    expect(root.querySelector('[data-privacy-confirm]')).toBeNull();
    (row('Lawyer').querySelector('[data-privacy-remove]') as HTMLElement).click();
    (row('Lawyer').querySelector('[data-privacy-remove]') as HTMLElement).click();
    await submit();
    click('[data-privacy-confirm-yes]');
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'save_privacy', revision: 'rev-1', confirm: true });
    expect((sent[0] as { rules: unknown[] }).rules).toHaveLength(3);
    abort.abort();
  });

  test('a description-only change asks to confirm', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const { root, click, submit, abort } = mount(async (params) => { sent.push(params); return ok(); });
    (root.querySelector('textarea[name="description"]') as HTMLTextAreaElement).value = 'My health and money';
    await submit();
    expect(sent).toEqual([]);
    expect(root.querySelector('[data-privacy-confirm]')!.textContent)
      .toContain('This changes your description, which decides what Olympus keeps private.');
    click('[data-privacy-confirm-yes]');
    await settle();
    expect(sent[0]).toMatchObject({ description: 'My health and money', confirm: true, revision: 'rev-1' });
    abort.abort();
  });

  test('follow-up questions: "family" asks them, a choice rewrites the description, and Save sends the refined words', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const owner = 'I want my family stuff to stay private';
    const { root, click, submit, controller, reads, abort } = mount(async (params) => { sent.push(params); return ok(); }, { ...BASE_SETTINGS, description: owner });
    const holder = root.querySelector('[data-privacy-questions]') as HTMLElement;
    expect(holder.hidden).toBe(false);
    expect(holder.textContent).toContain('A few quick questions');
    expect(holder.querySelector('h3')!.textContent).toBe('Which family things are private?');
    const rows = [...holder.querySelectorAll('[role="radiogroup"]')];
    expect(rows.map((row) => root.querySelector(`#${row.getAttribute('aria-labelledby')}`)!.textContent)).toEqual([
      'Family members\' medical records', 'Family legal and money papers (divorce, custody, trusts)', 'Private family conversations and journals',
      'School plans and family logistics', 'Alumni, contact and address lists', 'Family history and photos']);
    const choice = (option: string, side: string) => holder.ownerDocument.querySelector(
      `input[data-privacy-topic="family"][data-privacy-option="${option}"][value="${side}"]`) as HTMLInputElement;
    expect(choice('contacts', 'share').checked).toBe(true);
    expect(choice('contacts', 'share').closest('label')!.textContent).toBe('Fine to share');
    // A choice writes its sentence under the owner's words and holds the poll off like typing.
    const contacts = choice('contacts', 'private');
    contacts.checked = true;
    contacts.dispatchEvent(new Event('change', { bubbles: true }));
    const field = root.querySelector('textarea[name="description"]') as HTMLTextAreaElement;
    expect(field.value.split('\n')[0]).toBe(owner);
    expect(field.value.split('\n')[1]).toContain('Alumni, contact and address lists; fine to share — School plans and family logistics');
    expect(choice('contacts', 'private').checked).toBe(true);
    expect(document.activeElement).toBe(choice('contacts', 'private'));
    await controller.refresh();
    expect(reads).toEqual([]);
    // Typing a new broad word asks about it too.
    field.value = `${field.value}\nand my health`;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...root.querySelectorAll('[data-privacy-questions] h3')].map((node) => node.textContent))
      .toEqual(['Which family things are private?', 'Which health things are private?']);
    expect(choice('contacts', 'private').checked).toBe(true);
    // A changed description lowers protection: confirmed first, then sent as shown.
    await submit();
    expect(sent).toEqual([]);
    expect(root.querySelector('[data-privacy-confirm]')!.textContent)
      .toContain('This changes your description, which decides what Olympus keeps private.');
    click('[data-privacy-confirm-yes]');
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'save_privacy', description: field.value.trim(), confirm: true, revision: 'rev-1' });
    expect((sent[0] as { description: string }).description).toContain('About family: private —');
    abort.abort();
  });

  test('a conflict keeps the draft and shows what is saved now; applying again replays the draft onto it', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    const elsewhere = { kind: 'sender', source_id: 'gmail.email', value: 'new@elsewhere.example' };
    let answer: OlympusDashboardControlResult = {
      status: 409,
      body: {
        ok: false,
        error: { code: 'conflict', message: 'changed' },
        settings: { ...BASE_SETTINGS, revision: 'rev-2', rules: [...BASE_SETTINGS.rules, elsewhere] },
      },
    };
    const { root, reads, click, submit, abort } = mount(async (params) => { sent.push(params); return answer; });
    click('[data-privacy-add="sender"]');
    (root.querySelector('[data-privacy-sender]') as HTMLInputElement).value = 'me@here.example';
    click('[data-privacy-sender-add]');
    await submit();
    expect(sent).toHaveLength(1);
    const conflict = root.querySelector('[data-privacy-conflict]')!;
    expect(conflict.textContent).toContain('Your changes weren\'t saved because the privacy settings changed elsewhere.');
    expect(conflict.textContent).toContain('What is saved now:');
    expect(conflict.textContent).toContain('new@elsewhere.example · Sender');
    // The draft is untouched and the poll holds off.
    expect(root.textContent).toContain('me@here.example');
    expect(reads).toEqual([]);
    // Replayed onto what is saved now: the rule added elsewhere stays, mine is
    // added again, nothing is removed, so it saves at once with the new revision.
    answer = { status: 200, body: { ok: true, settings: {} } };
    click('[data-privacy-apply-again]');
    await settle();
    expect(root.querySelector('[data-privacy-confirm]')).toBeNull();
    expect(sent[1]).toEqual({
      action: 'save_privacy',
      description: 'My health',
      rules: [...BASE_SETTINGS.rules, elsewhere, { kind: 'sender', source_id: 'gmail.email', value: 'me@here.example' }],
      revision: 'rev-2',
    } as OlympusDashboardControlParams);
    abort.abort();
  });

  test('after a conflict, a replayed removal still asks first, then saves against the new revision', async () => {
    const sent: OlympusDashboardControlParams[] = [];
    let answer: OlympusDashboardControlResult = {
      status: 409,
      body: { ok: false, error: { code: 'conflict', message: 'changed' }, settings: { ...BASE_SETTINGS, revision: 'rev-2' } },
    };
    const { root, click, submit, row, abort } = mount(async (params) => { sent.push(params); return answer; });
    (row('Lawyer').querySelector('[data-privacy-remove]') as HTMLElement).click();
    await submit();
    click('[data-privacy-confirm-yes]');
    await settle();
    expect(sent).toHaveLength(1);
    answer = { status: 200, body: { ok: true, settings: {} } };
    click('[data-privacy-apply-again]');
    await settle();
    expect(sent).toHaveLength(1);
    expect(root.querySelector('[data-privacy-confirm]')!.textContent).toContain('This removes protection from Lawyer.');
    click('[data-privacy-confirm-yes]');
    await settle();
    expect(sent[1]).toMatchObject({ revision: 'rev-2', confirm: true });
    expect((sent[1] as { rules: unknown[] }).rules).toHaveLength(3);
    abort.abort();
  });

  test('Discard my changes drops the draft and reads the page again', async () => {
    const { root, reads, click, submit, abort } = mount(async () => ({
      status: 409,
      body: { ok: false, error: { code: 'conflict', message: 'changed' }, settings: { ...BASE_SETTINGS, revision: 'rev-2' } },
    }));
    click('[data-privacy-add="sender"]');
    (root.querySelector('[data-privacy-sender]') as HTMLInputElement).value = 'me@here.example';
    click('[data-privacy-sender-add]');
    await submit();
    click('[data-privacy-discard-mine]');
    await settle();
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
    await settle();
    expect(sent[0]).toEqual({ action: 'browse_folder_scope', source_id: 'dropbox.files' });
    const make = root.querySelector('[data-privacy-make-private]') as HTMLButtonElement;
    expect(make.textContent).toBe('Make private');
    make.click();
    expect(make.textContent).toBe('Already private');
    const added = [...root.querySelectorAll('[data-privacy-rule]')].map((row) => JSON.parse(row.getAttribute('data-privacy-rule')!));
    expect(added).toContainEqual({ kind: 'folder', source_id: 'dropbox.files', key: '/Therapy', display: 'Therapy' });
    abort.abort();
  });
});

describe('the worker\'s privacy adapter (production code)', () => {
  function memoryBackend(initial: PrivacySettings) {
    let stored = initial;
    const backend = {
      privacySettings: () => stored,
      savePrivacy: (update: { description?: string; rules?: PrivacySettings['rules'] }) => {
        stored = {
          ...stored,
          configured: true,
          revision: `${stored.revision}+`,
          ...(update.description !== undefined ? { description: update.description } : {}),
          ...(update.rules ? { rules: update.rules } : {}),
        };
        return stored;
      },
      secretLocations: () => ({ folderKeys: new Set(), pathPrefixes: [], labelIds: new Set(), senders: [] }),
    } as unknown as ChatGptSetupBackend;
    let pendingCalls = 0;
    let pendingValue = 7;
    let clock = 0;
    const adapter = createDashboardPrivacyAdapter({
      backend,
      readSettings: (pending) => ({ ...stored, pendingCount: pending }),
      pendingCount: () => { pendingCalls++; return pendingValue; },
      now: () => clock,
    });
    return { adapter, stored: () => stored, pendingCalls: () => pendingCalls, setPending: (n: number) => { pendingValue = n; }, tick: (ms: number) => { clock += ms; } };
  }
  const RULE = { kind: 'sender' as const, source_id: 'gmail.email' as const, value: 'billing@clinic.example' };

  test('a save without a revision is refused and changes nothing, even with the owner\'s confirmation', async () => {
    const { adapter, stored } = memoryBackend({ configured: true, description: 'health', pendingCount: 0, revision: 'r2', rules: [RULE] });
    for (const update of [{ rules: [], confirm: true }, { rules: [], revision: '', confirm: true }, { description: 'x', revision: '  ' }]) {
      const outcome = await adapter.save(update);
      expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' });
    }
    expect(stored().rules).toEqual([RULE]);
    expect(stored().revision).toBe('r2');
  });

  test('a first save carries the empty profile\'s revision; a stale one is a conflict; a lowering one needs the confirmation', async () => {
    const empty = memoryBackend({ configured: false, description: '', pendingCount: 0, revision: 'prv1.unset', rules: [] });
    expect(await empty.adapter.save({ revision: 'prv1.unset', description: '', rules: [RULE] })).toMatchObject({ ok: true, status: 'saved' });
    const saved = memoryBackend({ configured: true, description: 'health', pendingCount: 0, revision: 'r2', rules: [RULE] });
    expect(await saved.adapter.save({ revision: 'r1', description: 'health', rules: [RULE] })).toMatchObject({ ok: true, status: 'conflict' });
    expect(await saved.adapter.save({ revision: 'r2', description: 'health', rules: [] })).toMatchObject({ ok: false, code: 'privacy_owner_only' });
    expect(await saved.adapter.save({ revision: 'r2', description: 'health', rules: [], confirm: true })).toMatchObject({ ok: true, status: 'saved' });
    expect(saved.stored().rules).toEqual([]);
  });

  test('the summary is counts only, and the backlog count is reused for a minute', async () => {
    const { adapter, pendingCalls, tick } = memoryBackend({ configured: true, description: 'health', pendingCount: 0, revision: 'r1', rules: [RULE] });
    expect(await adapter.summary()).toEqual({ ok: true, summary: { configured: true, pendingCount: 7, ruleCount: 1 } });
    await adapter.summary();
    await adapter.read();
    expect(pendingCalls()).toBe(1);
    tick(60_000);
    await adapter.summary();
    expect(pendingCalls()).toBe(2);
  });
  test('a successful save drops the cached backlog, so the next read counts again; a conflict keeps it', async () => {
    const { adapter, pendingCalls, setPending } = memoryBackend({ configured: true, description: 'health', pendingCount: 0, revision: 'r1', rules: [RULE] });
    expect(await adapter.summary()).toMatchObject({ summary: { pendingCount: 7 } });
    setPending(3);
    expect(await adapter.summary()).toMatchObject({ summary: { pendingCount: 7 } });
    expect(await adapter.save({ revision: 'r0', description: 'health', rules: [RULE] })).toMatchObject({ ok: true, status: 'conflict' });
    expect(await adapter.summary()).toMatchObject({ summary: { pendingCount: 7 } });
    expect(await adapter.save({ revision: 'r1', description: 'health', rules: [RULE, { ...RULE, value: 'lab@clinic.example' }] })).toMatchObject({ ok: true, status: 'saved' });
    expect(await adapter.summary()).toMatchObject({ summary: { pendingCount: 3 } });
    const read = await adapter.read();
    expect(read.ok && read.settings.pendingCount).toBe(3);
    expect(pendingCalls()).toBe(2);
  });
});

describe('only the pages that name privacy read it', () => {
  function memorySecretStore(): SecretStore {
    const values = new Map<string, string>();
    return {
      label: 'memory',
      get: async (key: string) => values.get(key),
      getSync: (key: string) => values.get(key),
      set: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); },
    } as SecretStore;
  }

  test('Background and source polls never call the privacy hook; Setup reads counts; the editor needs write authority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-privacy-poll-'));
    const calls: string[] = [];
    const settings: PrivacySettings = { configured: true, description: 'secret words', rules: [], pendingCount: 0, revision: 'r1' };
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return {
            kind: 'source_index_status',
            generated_at: NOW.toISOString(),
            corpora: [],
            policy: {
              read_only: true, raw_source_exposed: false, source_packets_exposed: false,
              source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true,
            },
          } as unknown as SourceIndexStatusResult;
        },
      },
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore(),
        registryAdoptionIntervalMs: 0,
        privacy: {
          summary: async () => { calls.push('summary'); return { ok: true, summary: { configured: true, pendingCount: 0, ruleCount: 0 } }; },
          read: async () => { calls.push('read'); return { ok: true, status: 'current', settings }; },
          save: async () => ({ ok: false, code: 'unavailable', message: 'no' }),
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'test-control' });
    const get = async (query: string) => {
      const response = await fetch(new Request(`http://worker.test/dashboard${query}`, { headers: { Authorization: 'Bearer test-control' } }));
      return { status: response.status, html: await response.text() };
    };
    const native = async (view: string, canWrite: boolean) => {
      const response = await fetch(new Request(`http://worker.test/dashboard/ui?native=1&view=${view}&can_write=${canWrite ? 1 : 0}`, {
        headers: { Authorization: 'Bearer test-control' },
      }));
      return await response.json() as { body: string };
    };
    try {
      await get('?background');
      await get('?source=gmail.email');
      await native('background', true);
      // The renderer's precedence decides the page: these render Background
      // and the source page, so they read no privacy either.
      expect((await get('?background&privacy')).html).toContain('<title>Olympus / Background</title>');
      expect((await get('?source=gmail.email&privacy')).html).not.toContain('<title>Olympus / Privacy</title>');
      await get('?privacy&background');
      expect(calls).toEqual([]);
      await get('?setup');
      expect(calls).toEqual(['summary']);
      calls.length = 0;
      // The bearer page without a control session, and a read-only native
      // connection: counts only, the full settings never read.
      expect((await get('?privacy')).html).not.toContain('secret words');
      expect((await native('privacy', false)).body).not.toContain('secret words');
      expect(calls).toEqual(['summary', 'summary']);
      calls.length = 0;
      expect((await native('privacy', true)).body).toContain('secret words');
      expect(calls).toEqual(['summary', 'read']);
    } finally {
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

