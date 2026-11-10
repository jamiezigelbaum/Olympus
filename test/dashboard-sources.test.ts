import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderDashboardConnectPage } from '../src/workers/dashboard/pages/local.ts';
import { sourceLogoTile } from '../src/workers/dashboard/source-logos.ts';

type View = Parameters<typeof renderDashboardConnectPage>[0];

function view(): View {
  return {
    generated_at: new Date().toISOString(),
    sources: [
      { source_id: 'gmail.email', label: 'Gmail', connection: { state: 'synced', action: { kind: 'none' }, disconnect: { confirmation: 'Olympus stops reading Gmail.' } }, coverage: { indexed_items: 12408 }, freshness: { label: 'updated 2 min ago' } },
      { source_id: 'dropbox.files', label: 'Dropbox', connection: { state: 'reauth_required', action: { kind: 'oauth', label: 'Connect' } }, coverage: { indexed_items: 50 }, freshness: {} },
      { source_id: 'readwise.library', label: 'Readwise', connection: { state: 'synced', action: { kind: 'oauth', label: 'Reauthenticate' } }, coverage: { indexed_items: 9 }, freshness: {} },
      { source_id: 'evernote.notes', label: 'Evernote', connection: { state: 'not_connected', action: { kind: 'oauth', label: 'Connect' } }, coverage: { indexed_items: 0 }, freshness: {} },
      { source_id: 'google_drive.docs', label: 'Google Drive', connection: { state: 'not_connected', action: { kind: 'oauth', label: 'Connect' } }, coverage: { indexed_items: 310 }, freshness: {} },
      { source_id: 'x.bookmarks', label: 'X bookmarks', connection: { state: 'not_connected', action: { kind: 'oauth', label: 'Connect' } }, coverage: { indexed_items: 0 }, freshness: {} },
    ],
  } as unknown as View;
}

const unlockedOptions = { controlSessionCsrfToken: 'csrf-test' } as Parameters<typeof renderDashboardConnectPage>[1];

describe('Sources page', () => {
  test('connected sources are rows with a real logo, facts and a ⋯ menu', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardConnectPage(view(), unlockedOptions);
    const rows = [...doc.querySelectorAll('[data-source-row]')].map((row) => row.getAttribute('data-source-row'));
    expect(rows).toEqual(['gmail.email', 'dropbox.files', 'readwise.library', 'google_drive.docs']);
    const gmail = doc.querySelector('[data-source-row="gmail.email"]')!;
    expect(gmail.querySelector('svg path')).not.toBeNull();
    expect(gmail.textContent).toContain('12,408 items · updated 2 min ago');
    const menu = [...gmail.querySelectorAll('.menuitem')].map((item) => item.textContent?.trim());
    // Details opens the row on Home (#1085): its See why, Import an archive and Details for support.
    expect(menu).toEqual(['Details', 'Sync now', 'Disconnect Gmail']);
    expect(gmail.querySelector('form[data-source-action="sync_now"] input[name="source"]')!.getAttribute('value')).toBe('gmail');
    // Olympus deletes data only once a source is disconnected, so a connected row never offers it.
    expect(doc.querySelector('dialog#delete-gmail-email')).toBeNull();
    expect(doc.querySelector('dialog#disconnect-gmail-email')!.textContent).toContain('Olympus stops reading Gmail.');
  });

  test('a disconnected source with kept data shows Reconnect and Delete indexed data', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardConnectPage(view(), unlockedOptions);
    const drive = doc.querySelector('[data-source-row="google_drive.docs"][data-source-kept]')!;
    expect(drive.textContent).toContain('Disconnected · indexed data kept · 310 items');
    expect(drive.querySelector('button[data-source-open="google_drive.docs"]')!.textContent).toBe('Reconnect');
    expect([...drive.querySelectorAll('.menuitem')].map((item) => item.textContent?.trim())).toEqual(['Delete indexed data…']);
    expect(doc.querySelector('dialog#delete-google_drive-docs form[data-source-action="delete_source_data"] input[name="source_id"]')!.getAttribute('value')).toBe('google_drive.docs');
  });

  test('a source that needs sign-in says so and its button opens its setup in Add a source', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardConnectPage(view(), unlockedOptions);
    const dropbox = doc.querySelector('[data-source-row="dropbox.files"]')!;
    expect(dropbox.textContent).toContain('needs sign-in');
    expect(dropbox.querySelector('.logodot.attention')).not.toBeNull();
    const signIn = dropbox.querySelector('button[data-dialog-open="add-source"]')!;
    expect(signIn.getAttribute('data-source-open')).toBe('dropbox.files');
    expect(doc.querySelector('[data-add-source] [data-source-setup="dropbox.files"]')).not.toBeNull();
  });

  test('a connected source the provider refuses keeps its setup, behind Reconnect', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardConnectPage(view(), unlockedOptions);
    const button = doc.querySelector('[data-source-row="readwise.library"] button[data-source-open="readwise.library"]')!;
    expect(button.textContent).toBe('Reconnect');
    expect(doc.querySelector('[data-add-source] [data-source-setup="readwise.library"]')).not.toBeNull();
    expect(doc.querySelector('[data-source-pick="readwise.library"]')).toBeNull();
  });

  test('Add a source lists only what is not connected, each with its own setup panel', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardConnectPage(view(), unlockedOptions);
    const sheet = doc.querySelector('dialog#add-source[data-closable]')!;
    expect([...sheet.querySelectorAll('[data-source-pick]')].map((tile) => tile.getAttribute('data-source-pick'))).toEqual(['evernote.notes', 'google_drive.docs', 'x.bookmarks']);
    expect(sheet.querySelectorAll('[data-source-setup][hidden]')).toHaveLength(5);
    expect(sheet.querySelector('[data-source-search]')).not.toBeNull();
    expect(doc.body.textContent).toContain('Build a connector');
  });

  test('locked, the actions are disabled', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardConnectPage(view(), {} as Parameters<typeof renderDashboardConnectPage>[1]);
    // Details is a link to Home, which works locked; every action is disabled.
    expect([...doc.querySelectorAll('button.menuitem')].every((item) => item.hasAttribute('disabled'))).toBe(true);
  });

  test('logos fall back to a glyph or a letter, never an empty tile', () => {
    expect(sourceLogoTile('local.files')).toContain('<svg');
    expect(sourceLogoTile('readwise.library')).toContain('>R<');
    expect(sourceLogoTile('someone.else')).toContain('>S<');
  });
});

describe('Sources in the browser', () => {
  test('tiles open setup, search filters, and the menu actions post the right controls', async () => {
    const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
    const browser = new Window({ url: 'http://localhost/dashboard?connect' });
    const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLDialogElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'] as const;
    const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
    let dispose = () => {};
    try {
      const html = renderDashboardConnectPage(view(), unlockedOptions);
      const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
      const calls: Record<string, unknown>[] = [];
      let refreshes = 0;
      const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1, returnUrl: 'http://localhost/dashboard?connect', navigate() {},
        refresh: async () => { refreshes += 1; return { status: 200, title: 'Sources', body: html, controller: 'dashboard', can_write: true, signature: 'same', poll_interval_ms: -1 }; },
        transport: { control: async params => { calls.push(params as Record<string, unknown>); return params.action === 'disconnect_source' ? { status: 409, body: { ok: false, error: { code: 'disconnect_busy', message: 'This source is finishing a read.' } } } : { status: 200, body: { ok: true, status_message: 'Done.' } }; } },
      }); dispose = () => controller.dispose();

      let sheet = root.querySelector<HTMLDialogElement>('dialog#add-source')!;
      root.querySelector<HTMLButtonElement>('.srcbar [data-dialog-open="add-source"]')!.click();
      expect(sheet.open).toBe(true);
      const search = sheet.querySelector<HTMLInputElement>('[data-source-search]')!;
      search.value = 'book'; search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(sheet.querySelector<HTMLElement>('[data-source-pick="evernote.notes"]')!.hidden).toBe(true);
      expect(sheet.querySelector<HTMLElement>('[data-source-pick="x.bookmarks"]')!.hidden).toBe(false);
      sheet.querySelector<HTMLButtonElement>('[data-source-pick="x.bookmarks"]')!.click();
      expect(sheet.querySelector<HTMLElement>('[data-source-setup="x.bookmarks"]')!.hidden).toBe(false);
      expect(sheet.querySelector<HTMLElement>('[data-source-catalog]')!.hidden).toBe(true);
      sheet.querySelector<HTMLElement>('[data-source-setup="x.bookmarks"] [data-source-back]')!.click();
      expect(sheet.querySelector<HTMLElement>('[data-source-catalog]')!.hidden).toBe(false);
      const before = refreshes;
      sheet.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click();
      expect(sheet.open).toBe(false);
      // Closing reads again, and the leftover search text does not hold the page back.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(refreshes).toBeGreaterThan(before);
      sheet = root.querySelector<HTMLDialogElement>('dialog#add-source')!;

      root.querySelector<HTMLButtonElement>('[data-source-row="dropbox.files"] [data-source-open]')!.click();
      expect(sheet.open).toBe(true);
      expect(sheet.querySelector<HTMLElement>('[data-source-setup="dropbox.files"]')!.hidden).toBe(false);
      sheet.close();

      root.querySelector<HTMLFormElement>('form[data-source-action="sync_now"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      root.querySelector<HTMLFormElement>('dialog#delete-google_drive-docs form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      root.querySelector<HTMLFormElement>('dialog#disconnect-gmail-email form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await browser.happyDOM.waitUntilComplete();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(calls).toEqual([
        { action: 'sync_now', source: 'gmail' },
        { action: 'delete_source_data', source_id: 'google_drive.docs', acknowledge: true },
        { action: 'disconnect_source', source_id: 'gmail.email', acknowledge: true },
      ]);
      // A refusal is said inside the confirmation, which stays open.
      expect(root.querySelector('dialog#disconnect-gmail-email [data-action-message]')!.textContent).not.toBe('');
    } finally {
      dispose(); browser.close();
      for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    }
  });
});
