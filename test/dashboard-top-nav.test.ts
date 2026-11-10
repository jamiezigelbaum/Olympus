import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { dashboardHtmlRoutePage, renderComputerHostPage, renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';

const ORIGIN = 'http://127.0.0.1:8010';

function nav(html: string) {
  const doc = new Window().document; doc.write(html);
  const bar = doc.querySelector('header.topnav')!;
  return {
    tabs: [...bar.querySelectorAll('.navtab')].map(tab => [tab.textContent, tab.getAttribute('href')]),
    active: bar.querySelector('.navtab.on')?.textContent,
    lock: bar.querySelector('.navlock')!,
  };
}

describe('the top bar', () => {
  test('every page shows Home, Sources, Privacy and Settings, with its own tab marked', () => {
    const url = new URL(`${ORIGIN}/dashboard?settings`);
    const settings = nav(renderDashboardLocalPage('settings', { url, options: { controlSessionCsrfToken: 'c' } }));
    expect(settings.tabs).toEqual([['Home', '/dashboard'], ['Sources', '/dashboard?connect'], ['Privacy', '/dashboard?private-answers'], ['Settings', '/dashboard?settings']]);
    expect(settings.active).toBe('Settings');
    expect(nav(renderDashboardLocalPage('private_answers', { url })).active).toBe('Privacy');
    expect(nav(renderDashboardLocalPage('agents', { url })).active).toBe('Settings');
    expect(nav(renderComputerHostPage({ panelHtml: '<p></p>', origin: ORIGIN })).active).toBe('Home');
  });

  test('a read-only reader keeps their token on every tab', () => {
    const url = new URL(`${ORIGIN}/dashboard?settings&token=dash_abc`);
    expect(nav(renderDashboardLocalPage('settings', { url })).tabs.map(([, href]) => href)).toEqual(['/dashboard?token=dash_abc', '/dashboard?connect&token=dash_abc', '/dashboard?private-answers&token=dash_abc', '/dashboard?settings&token=dash_abc']);
  });

  test('unlocked shows Unlocked · Lock in the bar instead of the unlock card; locked keeps the card', () => {
    const url = new URL(`${ORIGIN}/dashboard?settings`);
    const open = renderDashboardLocalPage('settings', { url, options: { controlSessionCsrfToken: 'c' } });
    const bar = nav(open);
    expect(bar.lock.textContent).toContain('Unlocked');
    expect(bar.lock.querySelector('form[data-control-session-kind="lock"] button')!.textContent).toBe('Lock');
    expect(open).not.toContain('data-state="locked"');
    const shut = renderDashboardLocalPage('settings', { url });
    expect(nav(shut).lock.textContent).toContain('Locked');
    expect(shut).toContain('Open dashboard controls');
    expect(nav(renderComputerHostPage({ panelHtml: '<p></p>', origin: ORIGIN, csrfToken: 'c' })).lock.querySelector('form')).toBeNull();
  });
});

describe('Settings', () => {
  test('a side list that shows one section at a time: agents and access, models on this computer, zkAPI, updates and help', () => {
    expect(dashboardHtmlRoutePage(new URL(`${ORIGIN}/dashboard?settings`))).toBe('settings');
    const html = renderDashboardLocalPage('settings', { url: new URL(`${ORIGIN}/dashboard?settings`), options: {
      controlSessionCsrfToken: 'c',
      settings: { models: [{ name: 'Search model', state: 'Ready', detail: 'Finds matching passages', downloadBytes: 600_000_000 }], update: { version: '1.4.1', command: 'curl -fsSL https://olympusplugin.ai/install | sh' } },
    } });
    const doc = new Window().document; doc.write(html);
    expect([...doc.querySelectorAll('.setside a')].map(link => link.textContent)).toEqual(['Agents and access', 'Models on this computer', 'zkAPI', 'Updates', 'Help']);
    // Each side link opens its own section; the rest stay hidden (owner, 2026-11-10).
    expect([...doc.querySelectorAll('.setside a')].map(link => link.getAttribute('href'))).toEqual(['#agents', '#models', '#zkapi', '#updates', '#help']);
    expect([...doc.querySelectorAll('.setmain > section.setpane')].map(pane => pane.id)).toEqual(['agents', 'models', 'zkapi', 'updates', 'help']);
    expect(html).toContain('.setmain > .setpane { display: none;');
    expect(html).toContain('.setmain > .setpane:target, .setmain:not(:has(> .setpane:target)) > .setpane:first-child { display: block; }');
    expect(doc.getElementById('models')!.textContent).toContain('Search model');
    expect(doc.getElementById('updates')!.textContent).toContain('Olympus 1.4.1 is available');
    const quiet = renderDashboardLocalPage('settings', { url: new URL(`${ORIGIN}/dashboard?settings`) });
    expect(quiet).toContain('Olympus is up to date.');
  });
});
