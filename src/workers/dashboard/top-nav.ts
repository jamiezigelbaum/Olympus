/**
 * The dashboard's top bar (owner, 2026-11-07; mockups final-6 to final-8):
 * "Olympus", four tabs (Home, Sources, Privacy, Settings) and the lock state
 * on the right. Every page on the computer shows it, so each piece of the
 * dashboard is one click from any other. AI apps show the panel only, with
 * "Open on your computer" leading here.
 */
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml } from './components.ts';
import { dashboardHomeHref, dashboardLocalPageHref } from './host-page.ts';

export type DashboardTab = 'home' | 'sources' | 'privacy' | 'settings';

export const DASHBOARD_TABS: readonly { id: DashboardTab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'sources', label: 'Sources' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'settings', label: 'Settings' },
];

export function dashboardTabHref(tab: DashboardTab, token?: string): string {
  switch (tab) {
    case 'home': return dashboardHomeHref(token);
    case 'sources': return dashboardLocalPageHref('connect', token);
    case 'privacy': return dashboardLocalPageHref('privateAnswers', token);
    case 'settings': return dashboardLocalPageHref('settings', token);
  }
}

/**
 * The bar. Unlocked, the right side is "Unlocked · Lock", and Lock is the same
 * control-session form the page controller already handles; `lockable: false`
 * (the Home page, whose script does not post controls) shows the state only.
 */
export function dashboardTopNav(input: { active: DashboardTab; token?: string; unlocked: boolean; lockable?: boolean }): string {
  const tabs = DASHBOARD_TABS.map(tab => {
    const href = escapeHtml(dashboardTabHref(tab.id, input.token));
    return tab.id === input.active
      ? `<a class="navtab on" aria-current="page" href="${href}">${escapeHtml(tab.label)}</a>`
      : `<a class="navtab" href="${href}">${escapeHtml(tab.label)}</a>`;
  }).join('');
  const lock = !input.unlocked
    ? '<span class="navlock" data-state="locked"><span aria-hidden="true">🔒</span> Locked</span>'
    : input.lockable === false
      ? '<span class="navlock" data-state="connected"><span aria-hidden="true">🔓</span> Unlocked</span>'
      : `<div class="navlock" id="${DASHBOARD_CONTROL_GATE_ID}" data-dashboard-control-gate data-state="connected"><span aria-hidden="true">🔓</span> Unlocked<span class="navsep" aria-hidden="true">·</span>`
        + '<form class="navlockform" data-control-session-kind="lock" method="post" action="/dashboard/control/session/lock">'
        + '<button class="navlockbtn" type="submit">Lock</button><span class="actmsg" data-action-message role="status"></span></form></div>';
  return `<header class="topnav"><span class="navbrand">Olympus</span><nav class="navtabs" aria-label="Olympus">${tabs}</nav><span class="navgrow"></span>${lock}</header>`;
}

/** Works on the local pages' theme (--t1, --t2, --link) and the Home page's (--text, --muted, --accent). */
export const TOP_NAV_CSS = `
.topnav { display: flex; align-items: center; gap: 8px 20px; flex-wrap: wrap; padding: 0 0 14px; margin: 0 0 20px; border-bottom: 1px solid var(--line); }
.navbrand { font-weight: 700; font-size: 1.35em; color: var(--t1, var(--text)); }
.navtabs { display: flex; gap: 4px; flex-wrap: wrap; }
.navtab { padding: 6px 12px; border-radius: 8px; color: var(--t2, var(--muted)); text-decoration: none; }
.navtab:hover { color: var(--t1, var(--text)); }
.navtab.on { color: var(--t1, var(--text)); background: color-mix(in srgb, var(--link, var(--accent)) 22%, transparent); font-weight: 600; }
.navtab:focus-visible, .navlockbtn:focus-visible { outline: 2px solid var(--link, var(--focus)); outline-offset: 2px; }
.navgrow { flex: 1; }
.navlock { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--t2, var(--muted)); font-size: 0.92em; }
.navsep { opacity: .7; }
.navlockform { display: inline-flex; align-items: center; gap: 6px; margin: 0; }
.navlockbtn { font: inherit; background: none; border: 0; padding: 0; color: var(--t2, var(--muted)); cursor: pointer; }
.navlockbtn:hover { color: var(--t1, var(--text)); text-decoration: underline; }
.navlockform .actmsg:empty { display: none; }

.top.subtop { margin: -10px 0 16px; font-size: .9em; }
@media (max-width: 640px) { .navgrow { display: none; } .topnav { gap: 8px 12px; } }
`;
