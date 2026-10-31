import { expect, test } from 'bun:test';
import { setupStepsSheet } from '../src/workers/dashboard/components.ts';

test('setup sheet renders one provider-neutral step at a time with a fallback link', () => {
  const html = setupStepsSheet({ id: 'sample', provider: 'Example', steps: [
    { text: 'Create an app', link: { label: 'Example', url: 'https://example.com/apps' } },
    { text: 'Paste the key' },
  ], finalForm: (id) => `<form id="${id}">KEY</form>` });
  expect(html).toContain('Step 1 of 2');
  expect(html).toContain('Open this page in Example');
  expect(html).toContain('https://example.com/apps');
  expect(html).toContain("I've done this, next");
  expect(html).toContain('data-setup-next');
  expect(html).toContain('data-setup-open');
});

import { Window, type HTMLButtonElement, type HTMLInputElement } from 'happy-dom';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';

function preview(state: string) {
  const window = new Window();
  window.document.body.innerHTML = renderDashboardLocalPage('keys', {
    url: new URL('http://localhost/dashboard?keys'), view: buildDashboardPreviewView(state),
    options: { controlSessionCsrfToken: 'fixture' },
  });
  return window.document;
}

test('Dropbox final input has its own row and Back precedes Connect in one shared footer', () => {
  const doc = preview('connect-dropbox');
  const sheet = doc.querySelector('#connect-dropbox-files')!;
  const footer = sheet.querySelector('[data-setup-actions]');
  expect(footer).not.toBeNull();
  const buttons = footer!.querySelectorAll('button');
  expect(buttons[0]?.textContent).toBe('Back');
  const submit = footer!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.textContent).toBe('Connect');
  const field = sheet.querySelector<HTMLInputElement>('[name="client_id"]')!;
  expect(field.closest('[data-setup-actions]')).toBeNull();
  expect(submit.getAttribute('form')).toBe(field.form!.id);
  expect(sheet.querySelector('[data-setup-back]')!.hasAttribute('disabled')).toBe(true);
});

test('refused Dropbox shows only error state with collapsed details and no Cancel', () => {
  const doc = preview('connect-dropbox-refused');
  const sheet = doc.querySelector('#connect-dropbox-files')!;
  expect(sheet.querySelector('[data-connect-error]')).not.toBeNull();
  expect(sheet.querySelector('[data-connect-content]')!.hasAttribute('hidden')).toBe(true);
  expect(sheet.querySelector('details.howto')!.hasAttribute('open')).toBe(false);
  expect(sheet.textContent).not.toContain('Cancel connection attempt');
});

test('normal Dropbox has no error banner or Cancel; connecting alone offers Cancel', () => {
  const normal = preview('connect-dropbox').querySelector('#connect-dropbox-files')!;
  expect(normal.querySelector('[data-connect-error]')).toBeNull();
  expect(normal.textContent).not.toContain('Cancel connection attempt');
  const connecting = preview('connect-dropbox-connecting').querySelector('#connect-dropbox-files')!;
  expect(connecting.textContent).toContain('Cancel connection attempt');
  expect(connecting.querySelector('[data-connect-error]')).toBeNull();
});

test('Google and X use the same single-footer walkthrough with the approved steps', () => {
  const google = preview('connect-google-loopback');
  const sheet = google.querySelector('#connect-gmail-email')!;
  expect(sheet.querySelector('[data-setup-steps]')).not.toBeNull();
  expect(sheet.textContent).toContain('Make the project and turn on Gmail and Drive');
  expect(sheet.textContent).toContain('Set up the sign-in screen and publish it');
  expect(sheet.textContent).toContain('Make a Desktop app key and download it');
  expect(sheet.textContent).toContain('Drop the downloaded file here');
  expect(sheet.querySelector('[type="file"]')).not.toBeNull();
  expect(sheet.querySelectorAll('[data-setup-actions]').length).toBe(1);
  const x = preview('connect-x').querySelector('#connect-x-bookmarks')!;
  expect(x.querySelectorAll('[data-setup-panel]').length).toBe(5);
  expect(x.textContent).toContain('paid X API access');
  expect(x.textContent).toContain('bookmark.read');
  expect(x.querySelector('[data-copy-target]')).not.toBeNull();
});

test('Google full signal uses owner copy; otherwise shared Connect stays first', () => {
  const full = preview('connect-google-full').querySelector('#connect-gmail-email')!;
  expect(full.textContent).toContain("Olympus's Google sign-in is full");
  expect(full.textContent).toContain('it lets 100 people');
  expect(full.querySelector('[data-setup-begin]')!.textContent).toBe('Set up my own Google app');
  expect(full.querySelector('[data-setup-walkthrough]')!.hasAttribute('hidden')).toBe(true);
  expect(full.querySelector('[data-oauth-autostart]')).toBeNull();
  const ordinary = preview('connect-google-publisher').querySelector('#connect-gmail-email')!;
  expect(ordinary.querySelector('button[type="submit"]')!.textContent).toBe('Connect');
  expect(ordinary.querySelector('[data-setup-begin]')!.textContent).toBe('Use my own Google app');
  expect(ordinary.querySelector('[data-setup-walkthrough]')!.hasAttribute('hidden')).toBe(true);
});
