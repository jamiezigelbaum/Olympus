/**
 * The Outside help card (src/workers/dashboard/outside-help.ts,
 * pages/outside-help.ts) and its worker side (email-source/dashboard-consult.ts,
 * the writer's one caller): the page states and copy, the Mac-only boundary
 * (control session in, Gateway bearer out, nothing native), and the adapter's
 * rules over a temp HOME. Design docs/design/frontier-consult-lane.md §A.9,
 * §A.10, §A.14 (stage C5). No process is started: readiness and the recovery
 * session are seams.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { Window } from 'happy-dom';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import { DEFAULT_CONSULT_DOMAIN_PACKS } from '../src/core/consult-gate.ts';
import { readConsultSettings } from '../src/core/consult-settings.ts';
import type { ZkapiConsultReadiness, ZkapiConsultResult } from '../src/core/consult-transport-zkapi.ts';
import { zkapiFenceScope } from '../src/core/consult-transport-zkapi.ts';
import { V0_4_PUBLIC_DASHBOARD_ROUTES } from '../src/core/public-surface.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS, ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION } from '../src/core/zkapi-consult-settings.ts';
import { renderDashboardHtmlRoute, dashboardHtmlRoutePage, renderDashboardControlUi } from '../src/workers/dashboard/index.ts';
import {
  DASHBOARD_OUTSIDE_HELP_PATHS,
  outsideHelpBlockerWords,
  renderOutsideHelpSection,
  summaryOf,
  type DashboardOutsideHelpStatus,
} from '../src/workers/dashboard/outside-help.ts';
import { renderDashboardOutsideHelpPage } from '../src/workers/dashboard/pages/outside-help.ts';
import { renderDashboardSetupPage } from '../src/workers/dashboard/pages/setup.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W } from '../src/workers/dashboard/vocabulary.ts';
import { createDashboardConsultAdapter, DASHBOARD_ZKAPI_PROFILE_ID, type DashboardConsultBackend } from '../src/workers/email-source/dashboard-consult.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { DASHBOARD_CONSULT_CONTROL_PATHS, DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';
import { __sovereigntyFileTestHooks } from '../src/core/sovereignty.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const NOW = DASHBOARD_PREVIEW_NOW;
const ORIGIN = 'http://127.0.0.1:17777';
const ALL_IDS = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => entry.id);
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'olympus-outside-help-'));
  cleanups.push(() => {
    try {
      chmodSync(join(home, '.olympus'), 0o700);
    } catch {
      // not always present
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

// ---------------------------------------------------------------------------
// Fixtures: a status in each state the card knows.

const LANGUAGES: DashboardOutsideHelpStatus['languages'] = [
  { language: 'en', pack: 'en-esdb', state: 'verified', installed: true },
  { language: 'nl', pack: 'nl-opentaal', state: 'verified', installed: true },
  { language: 'fr', pack: 'fr-grammalecte', state: 'verified', installed: true },
  { language: 'es', pack: 'es-hunspell', state: 'verified', installed: true },
  { language: 'pt-PT', pack: 'pt-pt-hunspell', state: 'verified', installed: true },
  { language: 'pt-BR', pack: 'pt-br-hunspell', state: 'verified', installed: true },
  { language: 'de', pack: 'de-hunspell', state: 'missing', installed: false },
  { language: 'it', pack: 'it-hunspell', state: 'missing', installed: false },
];

function readiness(overrides: Partial<ZkapiConsultReadiness> = {}): ZkapiConsultReadiness {
  return {
    daemonExecutable: '/opt/homebrew/bin/zkapi-clientd',
    daemonVersion: '0.1.6',
    torExecutable: '/opt/homebrew/bin/tor',
    tor: 'per_consult',
    confinement: { level: 'non_loopback_blocked', limit: 'loopback allowed' },
    daemonPort: 'free',
    torPort: 'free',
    apiKeyConfigured: true,
    money: { acknowledgements: { complete: true, accepted: 8, required: 8 }, expiryEstimate: { state: 'active', fundingDate: '2026-10-01', expiryDate: '2026-10-31', daysLeft: 24, notice: 'none' }, depositAboveSuggestedCeiling: false },
    requestsToday: { count: 2 },
    spendToday: { reservedUsd: 12 },
    unresolvedSession: false,
    fences: [],
    routeLabel: 'payment privacy; route not verified',
    blockers: [],
    ...overrides,
  };
}

function status(overrides: {
  settings?: Partial<DashboardOutsideHelpStatus['settings']>;
  route?: DashboardOutsideHelpStatus['route'];
  restartPending?: boolean;
} = {}): DashboardOutsideHelpStatus {
  return {
    settings: { state: 'off', revision: 0, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false, ...overrides.settings },
    route: overrides.route ?? configuredRoute(),
    languages: LANGUAGES,
    restartPending: overrides.restartPending ?? false,
  };
}

function configuredRoute(input: { complete?: boolean; ready?: ZkapiConsultReadiness; fences?: Array<{ scope: string; at: string; thisWallet: boolean }> } = {}): DashboardOutsideHelpStatus['route'] {
  const complete = input.complete ?? true;
  const ready = input.ready ?? readiness();
  return {
    state: 'configured',
    profileId: 'zkapi-consult',
    model: 'openai/gpt-5-mini',
    policyWritable: true,
    secretRef: 'env:OLYMPUS_ZKAPI_API_KEY',
    acknowledgements: { version: complete ? ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION : 0, accepted: complete ? ALL_IDS : [], complete },
    fundingDate: '2026-10-01',
    readiness: {
      ready: ready.blockers.length === 0,
      blockers: ready.blockers,
      daemonFound: ready.daemonExecutable !== undefined,
      ...(ready.daemonVersion ? { daemonVersion: ready.daemonVersion } : {}),
      torMode: ready.tor,
      torFound: ready.torExecutable !== undefined,
      apiKeyConfigured: ready.apiKeyConfigured,
      expiry: {
        state: ready.money.expiryEstimate.state,
        ...(ready.money.expiryEstimate.daysLeft !== undefined ? { daysLeft: ready.money.expiryEstimate.daysLeft } : {}),
        ...(ready.money.expiryEstimate.expiryDate !== undefined ? { expiryDate: ready.money.expiryEstimate.expiryDate } : {}),
      },
      requestsToday: ready.requestsToday,
      spendToday: ready.spendToday,
      fences: input.fences ?? [],
      routeLabel: ready.routeLabel,
    },
  };
}

function page(value: DashboardOutsideHelpStatus, extra: Record<string, unknown> = {}): string {
  return renderDashboardOutsideHelpPage(buildDashboardPreviewView('review'), { now: NOW, controlSessionCsrfToken: 'csrf', outsideHelpLocalSession: true, outsideHelp: value, ...extra });
}

/** Every word a reader sees: visible text plus accessible names, scripts and styles removed. */
function visibleText(html: string): string {
  const template = new Window().document.createElement('template');
  template.innerHTML = html.replaceAll('<', '\n<');
  for (const node of template.content.querySelectorAll('script,style')) node.remove();
  return template.content.textContent ?? '';
}

const JARGON = /\b(lanes?|guards?|supervisors?|chunks?|epochs?|reauth\w*|embed\w*|ingest\w*)\b/i;
const LEGACY = /\b(Full ingestion|Metadata only|metadata only|invisible|Public)\b/;

// ---------------------------------------------------------------------------

describe('the Outside help page: states and copy', () => {
  test('off, route ready, acknowledged: the disclosure, the steps, the languages and Turn on', () => {
    const html = page(status());
    expect(html).toContain('<title>Olympus / Anonymous answers</title>');
    expect(html).toContain(`data-outside-state="off">${W.state.off}<`);
    // What it is, then the plain privacy line; no "evidence pack" on the page.
    expect(html).toContain(W.intro.replace(/'/g, '&#39;'));
    expect(html).toContain(W.privacy);
    expect(visibleText(html)).not.toContain('evidence pack');
    // The honesty label keeps "network route not verified".
    expect(visibleText(html)).toContain('network route not verified');
    for (const line of W.disclosure) expect(html).toContain(line.replace(/'/g, '&#39;'));
    expect(html).toContain('data-outside-route="ready"');
    for (const step of W.steps) expect(visibleText(html)).toContain(step.replace('{secretRef}', 'env:OLYMPUS_ZKAPI_API_KEY').slice(0, 40));
    // The seven setup steps, in the order that worked live (§A.14): one send, activation, relay, require key, api key, key reuse 0.
    const text = visibleText(html);
    const order = ['--usd N', 'Private inference balance activated', '--relay-url socks5://127.0.0.1:19050', '--require-api-key', '--api-key <key>', '--key-reuse-window-seconds 0'];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('ONE transfer in total');
    expect(text).toContain('Gas prices move');
    // The eight acknowledgements as checkboxes, all ticked.
    expect(html.match(/name="acknowledged"/g)?.length).toBe(8);
    expect(html.match(/name="acknowledged" value="[a-z_0-9]+" checked/g)?.length).toBe(8);
    for (const entry of ZKAPI_RISK_ACKNOWLEDGEMENTS) expect(html).toContain(entry.statement.replace(/'/g, '&#39;').replace(/"/g, '&quot;'));
    // The domain packs beside the languages: the current defaults, on and off, in plain words.
    expect(html).toContain('data-outside-domains="units,countries,places,technical,medicines"');
    expect(text).toContain('a question may use: units of measure, country names, place names, technical terms, medicine names.');
    expect(text).toContain('Not admitted: medicine brand names.');
    // Languages: installed packs are choosable, uninstalled ones disabled with the reason.
    expect(html).toContain('name="languages" value="en" checked>');
    expect(html).toContain('name="languages" value="de" disabled aria-disabled="true"><span>German <span class="hint">pack not installed</span>');
    // The switch is the one filled button in the enable form.
    expect(html).toContain(`<button type="submit" class="btn primary" data-outside-enabled="true">${W.turnOn}</button>`);
    expect(html).not.toContain(W.turnOff);
    // Automatic, no approval prompt.
    expect(text).toContain('There is no approval step');
    // The revision rides on the card for compare-and-swap.
    expect(html).toContain('data-revision="0"');
    // The status block: route health in one line and today's usage, the $6 said as a hold.
    expect(html).toContain(`data-outside-route="ready">${W.routeReady}<`);
    // Never "spent": only the $6 hold per question is recorded.
    expect(text).toContain('2 questions today (counted as up to $12 against your limits) · balance expires about 31 Oct (24 days left)');
    expect(html.match(/data-outside-usage>([^<]*)</)?.[1]).not.toContain('spent');
    // Cost: the real cost first, then the hold, then how limits count it.
    expect(text).toContain(W.costLines.join(' '));
    expect(W.costLines[0]).toBe('Each question usually costs a few cents or less.');
    // The required disclosures stay on the page: automatic, $6 worst case, fee buffer, key-reuse 0, required key, expiry, route not verified.
    for (const needle of ['There is no approval step', 'Olympus counts the full $6', 'fee buffer', '--key-reuse-window-seconds 0', '--require-api-key', 'balance estimated to expire', 'network path is not verified on macOS']) expect(text).toContain(needle);
    // Three short lines first; the full statements one click away.
    expect(html.match(/<ul class="ohshort" data-outside-disclosure>(.*?)<\/ul>/)?.[1]?.match(/<li>/g)?.length).toBe(3);
    expect(html).toContain('<details class="howto" data-outside-disclosure-more>');
    // Accepted at the current wording: one line, the statements behind Review.
    expect(html).toContain(`data-outside-acknowledged="yes">You accepted the 8 cost and risk statements.<`);
    expect(html).toContain('data-outside-ack-review');
    // Nothing to fix: no problem list; secondary sections closed.
    expect(html).not.toContain('data-outside-blockers');
    for (const id of ['languages', 'limits', 'steps', 'details']) expect(html).toContain(`<details class="ohsect" data-outside-section="${id}"><summary>`);
    expect(text).toContain('No daily limit · paid in on 1 Oct');
    // Technical facts, inside Details only.
    expect(text).toContain('zkapi-clientd 0.1.6 found');
    expect(text).toContain('2 requests today ($12 counted at $6 each)');
    expect(text).toContain('balance estimated to expire 2026-10-31 (24 days left)');
    const details = html.slice(html.indexOf('data-outside-section="details"'));
    expect(details).toContain('Route: payment privacy; route not verified.');
    expect(html.slice(0, html.indexOf('data-outside-section="details"'))).not.toContain('Route: payment privacy');
  });

  test('on: Turn off; the chosen languages are checked; revision carried', () => {
    const html = page(status({ settings: { state: 'on', revision: 3, languages: ['en', 'pt-BR'] } }));
    expect(html).toContain(`data-outside-state="on">${W.state.on}<`);
    // On: "Before you turn this on" is gone from the first view; its content sits in a collapsed section.
    expect(visibleText(html)).not.toContain(W.disclosureTitle);
    expect(html).toContain('<details class="ohsect" data-outside-section="disclosure"><summary>');
    for (const line of [...W.disclosureShort, ...W.disclosure]) expect(html).toContain(line.replace(/'/g, '&#39;'));
    expect(html).toContain(`<button type="submit" class="btn" data-outside-enabled="false">${W.turnOff}</button>`);
    expect(html).toContain('name="languages" value="pt-BR" checked>');
    expect(html).toContain('name="languages" value="fr">');
    expect(html).toContain('data-revision="3"');
  });

  test('invalid file: the state says so and the one action is Replace the file, which keeps outside help off', () => {
    const html = page(status({ settings: { state: 'invalid', invalidReason: 'malformed_json' } }));
    expect(html).toContain(`data-outside-state="invalid">${W.state.invalid}<`);
    expect(html).toContain('data-outside-invalid="yes"');
    expect(html).toContain(`data-outside-replace>${W.replaceFile}</button>`);
    expect(html).not.toContain(W.turnOn);
    expect(html).not.toContain('malformed_json');
  });

  test('route not configured: Add the zkAPI route, the steps, and Turn on blocked with the reason', () => {
    const html = page(status({ route: { state: 'not_configured', policyWritable: true } }));
    expect(html).toContain(`data-outside-state="route_not_configured">${W.state.route_not_configured}<`);
    expect(html).toContain(`data-outside-form="add-route"`);
    expect(html).toContain(W.addRoute);
    expect(html).toContain(W.enableBlockedRoute);
    expect(html).toContain(`<button type="button" class="btn primary" disabled aria-disabled="true">${W.turnOn}</button>`);
    // The policy-not-a-file case offers no button and says why.
    const inline = page(status({ route: { state: 'not_configured', policyWritable: false } }));
    expect(inline).not.toContain('data-outside-form="add-route"');
    expect(inline).toContain(W.policyNotFile);
  });

  test('blockers read in plain words, one per line; acknowledgements incomplete blocks Turn on', () => {
    const { daemonExecutable: _d, daemonVersion: _v, torExecutable: _t, ...bare } = readiness();
    const blocked: ZkapiConsultReadiness = { ...bare, blockers: ['daemon_not_found', 'tor_not_found', 'daemon_api_key_missing', 'funding_date_missing', 'acknowledgements_incomplete'], apiKeyConfigured: false };
    const html = page(status({ route: configuredRoute({ complete: false, ready: blocked }) }));
    expect(html).toContain('data-outside-route="blocked"');
    const text = visibleText(html);
    // One list, a line each with its fix; the status line names the first and counts the rest.
    expect(html.match(/<ul class="ohfix" data-outside-blockers>(.*?)<\/ul>/)?.[1]?.match(/<li>/g)?.length).toBe(5);
    expect(text).toContain(W.blockers.daemon_not_found);
    expect(text).toContain(W.blockers.tor_not_found);
    expect(text).toContain(W.blockers.daemon_api_key_missing);
    expect(text).toContain('Enter the day you paid in under Balance and limits');
    expect(text).toContain(`Not ready: ${W.blockers.daemon_not_found} (+4 more below)`);
    // Setup steps and Balance and limits open because they hold the fixes; Details stays closed.
    expect(html).toContain('<details class="ohsect" data-outside-section="steps" open>');
    expect(html).toContain('<details class="ohsect" data-outside-section="limits" open>');
    expect(html).toContain('<details class="ohsect" data-outside-section="details"><summary>');
    expect(text).toContain('zkapi-clientd not installed');
    // Not accepted: the eight statements are shown expanded, not behind Review.
    expect(html).not.toContain('data-outside-ack-review');
    expect(html.match(/name="acknowledged"/g)?.length).toBe(8);
    expect(html).toContain('data-outside-acknowledged="no"');
    expect(html.match(/name="acknowledged" value="[a-z_0-9]+" checked/g)).toBeNull();
    expect(html).toContain(W.enableBlockedAcks);
    expect(html).not.toContain('data-outside-enabled="true"');
    // Every transport code the readiness can emit has words, or the honest fallback.
    for (const code of ['key_reuse_on', 'daemon_version_unsupported', 'unresolved_session', 'tor_port_busy', 'daemon_already_running', 'spend_cap_reached', 'daily_cap_reached', 'note_expired', 'stranded_processes', 'state_unavailable'] as const) {
      expect(outsideHelpBlockerWords(code)).not.toContain(code);
    }
    expect(outsideHelpBlockerWords('internal_error')).toBe('Not ready yet (internal_error).');
  });

  test('a held fence: the paused state, Recover (confirm, $6) and Abandon (its privacy consequence), each its own form', () => {
    const fences = [{ scope: 'a'.repeat(32), at: '2026-10-07T10:00:00.000Z', thisWallet: true }, { scope: 'b'.repeat(32), at: '2026-10-06T09:00:00.000Z', thisWallet: false }];
    const held = readiness({ blockers: ['unresolved_session', 'unresolved_session_other_wallet'], unresolvedSession: true });
    const value = status({ route: configuredRoute({ ready: held, fences }) });
    expect(summaryOf(value)).toEqual({ state: 'fence_held' });
    const html = page(value);
    expect(html).toContain(`data-outside-state="fence_held">${W.state.fence_held}<`);
    expect(html).toContain('data-outside-fence');
    expect(html).toContain(`data-outside-form="recover" data-outside-confirm="${W.recoverConfirm}"`);
    expect(html).toContain(`<button type="submit" class="btn primary">${W.recover}</button>`);
    expect(html).toContain('reserves up to $6');
    expect(html).toContain(`data-outside-form="abandon" data-outside-scope="${'a'.repeat(32)}" data-outside-confirm="${W.abandonConfirm.replace(/'/g, '&#39;')}"`);
    expect(html).toContain(`data-outside-form="abandon" data-outside-scope="${'b'.repeat(32)}"`);
    expect(visibleText(html)).toContain('may later link two sessions');
    expect(visibleText(html)).toContain('Held since 2026-10-07 10:00 (this wallet)');
    expect(visibleText(html)).toContain('Held since 2026-10-06 09:00 (another wallet folder)');
    // No fence for this wallet: Recover is disabled (recovery must run from the wallet that holds it).
    const other = page(status({ route: configuredRoute({ ready: held, fences: [fences[1]!] }) }));
    expect(other).toContain(`<button type="submit" class="btn primary" disabled aria-disabled="true">${W.recover}</button>`);
  });

  test('restart pending is said once, at the top', () => {
    const html = page(status({ restartPending: true }));
    expect(html).toContain(`data-outside-restart-pending>${W.restartPending}<`);
  });

  test('limits left on: Balance and limits names them, opens when one is reached, and offers No daily limit in one click', () => {
    const capped = readiness({ blockers: ['daily_cap_reached'], requestsToday: { count: 10, cap: 10 }, spendToday: { reservedUsd: 60, capUsd: 10 } });
    const route = { ...configuredRoute({ ready: capped }), dailyRequestCap: 10, dailySpendCapUsd: 10 } as DashboardOutsideHelpStatus['route'];
    const html = page(status({ route }));
    const text = visibleText(html);
    expect(html).toContain('<details class="ohsect" data-outside-section="limits" open>');
    expect(text).toContain('10 questions a day, $10 a day · paid in on 1 Oct');
    expect(text).toContain('Questions today: 10, counted as up to $60 against your limits.');
    expect(html).toContain(`data-outside-form="route" data-outside-nolimit><div class="pbuttons"><button type="submit" class="btn primary">${W.removeLimits}</button>`);
    expect(text).toContain(W.blockers.daily_cap_reached);
    // No limit set: no button, the plain statement instead, and the section stays closed.
    const free = page(status());
    expect(free).not.toContain('<form class="ohform ohinline" data-outside-form="route" data-outside-nolimit>');
    expect(visibleText(free)).toContain(W.noLimitIntro);
  });

  test('the card\'s script: No daily limit clears both caps with the recorded acknowledgements; turning on posts the language boxes and says on at once', async () => {
    const route = { ...configuredRoute(), dailyRequestCap: 10, dailySpendCapUsd: 10 } as DashboardOutsideHelpStatus['route'];
    const html = page(status({ settings: { state: 'off', revision: 4, languages: ['en', 'fr'] }, route }));
    const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?outside-help' });
    const document = window.document;
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-outside-help]'))!;
    const posts: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const fetchStub = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posts.push({ url, init });
      return { ok: true, json: async () => (url.endsWith('/dashboard/consult') ? { ok: true, status_message: 'on', revision: 5 } : { ok: true, status_message: 'saved', restarting: false }) };
    };
    const timers: Array<() => void> = [];
    // Run the card's own controller against the parsed card; reloads are recorded, never run.
    new Function('window', 'document', 'fetch', 'setTimeout', script)(
      { confirm: () => true, location: { href: 'http://127.0.0.1:8010/dashboard?outside-help', reload: () => timers.push(() => undefined) } },
      document,
      fetchStub,
      (run: () => void) => { timers.push(run); },
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const noLimit = document.querySelector('form[data-outside-nolimit]')!;
    noLimit.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(posts[0]!.url).toBe(DASHBOARD_OUTSIDE_HELP_PATHS.route);
    expect(posts[0]!.init.headers['X-Olympus-CSRF']).toBe('csrf');
    expect(JSON.parse(posts[0]!.init.body)).toEqual({ acknowledged: ALL_IDS, daily_request_cap: null, daily_spend_cap_usd: null });
    // Turn on: the switch sits in the status block; the language boxes sit in their section.
    const enable = document.querySelector('form[data-outside-form="enable"]')!;
    const event = new window.Event('submit', { cancelable: true }) as unknown as { submitter?: unknown };
    event.submitter = document.querySelector('[data-outside-enabled="true"]');
    enable.dispatchEvent(event as never);
    await settle();
    expect(posts[1]!.url).toBe(DASHBOARD_OUTSIDE_HELP_PATHS.enable);
    expect(JSON.parse(posts[1]!.init.body)).toEqual({ enabled: true, revision: 4, languages: ['en', 'fr'] });
    // The state line says on before the reload redraws the card.
    expect(document.querySelector('[data-outside-state-text]')!.textContent).toBe(W.state.on);
    expect(document.querySelector('[data-outside-state-text]')!.getAttribute('data-outside-state')).toBe('on');
    expect(document.querySelector('[data-outside-help]')!.getAttribute('data-revision')).toBe('5');
  });

  test('Tor off: the route is said to be direct with the network address visible, whether or not a tor binary exists', () => {
    const off = readiness({ tor: 'off', torPort: 'not_used' });
    const html = page(status({ route: configuredRoute({ ready: off }) }));
    const text = visibleText(html);
    expect(text).toContain('Tor off: the route is direct and your network address is visible to the provider');
    // The status block says it plainly; the Tor wording is in Details.
    expect(html).toContain(`<span class="attn">${W.addressVisible}</span>`);
    expect(text).not.toContain('Tor found');
    const { torExecutable: _t, ...noBinary } = readiness({ tor: 'off', torPort: 'not_used' });
    expect(visibleText(page(status({ route: configuredRoute({ ready: noBinary as ZkapiConsultReadiness }) })))).toContain('Tor off: the route is direct');
    // Tor on and missing: said as missing.
    const { torExecutable: _m, ...missing } = readiness({ blockers: ['tor_not_found'] });
    expect(visibleText(page(status({ route: configuredRoute({ ready: missing as ZkapiConsultReadiness }) })))).toContain('Tor not installed');
  });

  test('a bearer-grade session reads the card but gets the local unlock instead of controls', () => {
    const html = page(status(), { outsideHelpLocalSession: false });
    expect(html).toContain('data-outside-unlock');
    expect(html).toContain(W.unlock);
    expect(html).toContain(DASHBOARD_LOCAL_CONTROL_SESSION_PATH);
    // Every control is rendered disabled; only the unlock submits.
    expect(html).not.toContain('data-outside-enabled="true">');
    expect(html).toContain('data-outside-enabled="true" disabled aria-disabled="true">');
    expect(html).not.toContain(`<button type="submit" class="btn">${W.saveRoute}</button>`);
    expect(html).toContain(`<button type="submit" class="btn" disabled aria-disabled="true">${W.saveRoute}</button>`);
    // Still reads every fact and every statement, read-only.
    expect(html.match(/name="acknowledged"[^>]*disabled/g)?.length).toBe(8);
    // A local-grade session has no unlock to offer.
    expect(page(status())).not.toContain('data-outside-unlock');
  });

  test('locked and native readers get one sentence and no controls; the dash_ token reads as locked', () => {
    const view = buildDashboardPreviewView('review');
    const locked = renderDashboardOutsideHelpPage(view, { now: NOW });
    expect(locked).toContain('data-outside-locked');
    expect(locked).toContain(W.locked);
    expect(locked).not.toContain('data-outside-form');
    expect(locked).not.toContain('<script');
    const native = renderDashboardOutsideHelpPage(view, { now: NOW, format: 'fragment', controlMode: 'native', canWrite: true, outsideHelp: status() });
    expect(native).toContain('data-outside-native');
    expect(native).toContain(W.native.replace(/'/g, '&#39;'));
    expect(native).not.toContain('data-outside-form');
    expect(native).not.toContain('name="acknowledged"');
    // Through the route: the query flag, and the dash_ token reads read-only.
    const url = new URL('http://worker.test/dashboard?outside-help&token=dash_abc');
    expect(dashboardHtmlRoutePage(url)).toBe('outside_help');
    const routed = renderDashboardHtmlRoute({ url, view, options: { now: NOW, outsideHelp: status() } });
    expect(routed.status).toBe(200);
    expect(routed.html).toContain('data-outside-locked');
    // The native Control UI has no view that reaches this page at all.
    const ui = renderDashboardControlUi({ params: { view: 'setup' }, view, canWrite: true, options: { now: NOW, outsideHelp: status(), outsideHelpSummary: { state: 'off' } } });
    expect(ui.body).not.toContain('data-outside-help');
    expect(ui.body).not.toContain('data-outside-help-row');
  });

  test('the card speaks the owner\'s language: no implementation jargon, no legacy tier words, no content', () => {
    for (const value of [status(), status({ settings: { state: 'invalid' } }), status({ route: { state: 'not_configured', policyWritable: true } })]) {
      const text = visibleText(page(value));
      const lines = text.split('\n').map((line) => line.trim()).filter((line) => JARGON.test(line) || LEGACY.test(line));
      expect(lines).toEqual([]);
    }
  });

  test('the unlocked card carries its own script, posting the five routes with the CSRF token, and never the shared controller', () => {
    const html = page(status());
    expect(html).toContain('X-Olympus-CSRF');
    for (const path of Object.values(DASHBOARD_OUTSIDE_HELP_PATHS)) expect(html).toContain(path);
    // Not the shared standalone controller (its action router), nor the Control UI action set.
    expect(html).not.toContain('function route(params)');
    expect(html).not.toContain("'/dashboard/control/session'");
    expect(html).toContain('window.confirm(confirmText)');
    expect(html).toContain('replace_invalid');
  });
});

describe('Setup\'s Outside help row', () => {
  test('appears only on the standalone page with a summary, after Privacy, linking to the card', () => {
    const view = buildDashboardPreviewView('review');
    const html = renderDashboardSetupPage(view, { now: NOW, controlSessionCsrfToken: 'csrf', privacy: { configured: true, pendingCount: 0, ruleCount: 1 }, outsideHelpSummary: { state: 'off' } });
    expect(html).toContain('data-outside-help-row');
    expect(html).toContain(`<p class="sline strong">${W.row.off}</p>`);
    expect(html).toContain(`id="outside-help">${W.sectionTitle}</div>`);
    expect(html).toContain('href="/dashboard?outside-help">Edit</a>');
    expect(html.indexOf('id="privacy"')).toBeLessThan(html.indexOf('id="outside-help"'));
    expect(renderDashboardSetupPage(view, { now: NOW, controlSessionCsrfToken: 'csrf' })).not.toContain('data-outside-help-row');
    const native = renderDashboardSetupPage(view, { now: NOW, format: 'fragment', controlMode: 'native', canWrite: true, outsideHelpSummary: { state: 'on' } });
    expect(native).not.toContain('data-outside-help-row');
    expect(renderOutsideHelpSection({ state: 'route_not_configured' }, '/dashboard?token=dash_x')).toContain('href="/dashboard?token=dash_x&amp;outside-help">Set up</a>');
    expect(renderOutsideHelpSection(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The worker boundary: control session only.

function fakeBackend(calls: string[]): DashboardConsultBackend {
  return {
    summary: () => ({ state: 'off' }),
    status: async () => status(),
    setEnabled: async (update) => { calls.push(`enable:${JSON.stringify(update)}`); return { ok: true, status_message: 'on', revision: 1 }; },
    saveRoute: async () => { calls.push('route'); return { ok: true, status_message: 'saved', restarting: true }; },
    addRoute: async () => { calls.push('add'); return { ok: true, status_message: 'added', restarting: true }; },
    recover: async () => { calls.push('recover'); return { ok: true, status_message: 'recovered' }; },
    abandon: async () => { calls.push('abandon'); return { ok: false, httpStatus: 409, code: 'no_unresolved_session', message: 'none' }; },
  };
}

function worker(backend: DashboardConsultBackend | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-outside-help-worker-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const created = createEmailSourceWorker({
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
      registryAdoptionIntervalMs: 0,
      ...(backend ? { consult: backend } : {}),
    },
  });
  cleanups.push(() => created.close?.());
  return withWorkerBearerAuth((request: Request) => created.fetch(request), { authToken: 'worker-secret' });
}

/** A bearer-minted session: every ordinary control, never the consult routes. */
async function controlSession(fetcher: (request: Request) => Promise<Response>): Promise<{ cookie: string; csrf: string }> {
  const mint = await fetcher(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: 'Bearer worker-secret', Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  return { cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await mint.json()) as { csrf_token: string }).csrf_token };
}

/** The local-only mint: a loopback browser presenting no bearer. */
async function localSession(fetcher: (request: Request) => Promise<Response>): Promise<{ cookie: string; csrf: string }> {
  const request = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
  recordRequestPeer(request, '127.0.0.1');
  const mint = await fetcher(request);
  expect(mint.status).toBe(200);
  return { cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await mint.json()) as { csrf_token: string }).csrf_token };
}

function post(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('the worker serves the card only inside a local control session', () => {
  test('the five routes are the public route list\'s, the HTTP boundary\'s and the page\'s one set', () => {
    // The unlock is the session mint, not a consult route.
    const { unlock, ...consultPaths } = DASHBOARD_OUTSIDE_HELP_PATHS;
    expect(unlock).toBe(DASHBOARD_LOCAL_CONTROL_SESSION_PATH);
    const paths = Object.values(consultPaths).sort();
    expect([...DASHBOARD_CONSULT_CONTROL_PATHS].sort()).toEqual(paths);
    expect(V0_4_PUBLIC_DASHBOARD_ROUTES.filter((route) => route.path.startsWith('/dashboard/consult')).map((route) => `${route.method} ${route.path}`).sort())
      .toEqual(paths.map((path) => `POST ${path}`).sort());
  });

  test('the Gateway bearer, and every session the bearer can mint, are refused (403, mac_dashboard_only) and nothing is called; no session 401; wrong CSRF or origin 403', async () => {
    const calls: string[] = [];
    const fetcher = worker(fakeBackend(calls));
    const bearerMinted = await controlSession(fetcher);
    const { cookie, csrf } = await localSession(fetcher);
    for (const path of DASHBOARD_CONSULT_CONTROL_PATHS) {
      const bearer = await fetcher(post(path, { enabled: true, revision: 0, confirm: true }, { Authorization: 'Bearer worker-secret', Origin: ORIGIN }));
      expect(bearer.status).toBe(403);
      expect(((await bearer.json()) as { error: { code: string } }).error.code).toBe('mac_dashboard_only');
      // The full bearer → mint → drop Authorization → POST sequence (P1-1).
      const derived = await fetcher(post(path, { enabled: true, revision: 0, confirm: true }, { Cookie: bearerMinted.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': bearerMinted.csrf }));
      expect(derived.status).toBe(403);
      expect(((await derived.json()) as { error: { code: string } }).error.code).toBe('mac_dashboard_only');
      expect((await fetcher(post(path, { enabled: true, revision: 0 }, { Origin: ORIGIN }))).status).toBe(401);
      expect((await fetcher(post(path, { enabled: true, revision: 0 }, { Cookie: cookie, Origin: ORIGIN }))).status).toBe(403);
      expect((await fetcher(post(path, { enabled: true, revision: 0 }, { Cookie: cookie, Origin: 'http://attacker.test', 'X-Olympus-CSRF': csrf }))).status).toBe(403);
      expect((await fetcher(post(path, { enabled: true, revision: 0 }, { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': 'wrong' }))).status).toBe(403);
      // Forged context headers from outside are stripped at the boundary.
      expect((await fetcher(post(path, { enabled: true, revision: 0 }, { Authorization: 'Bearer worker-secret', Origin: ORIGIN, 'X-Olympus-Control-Session-CSRF': csrf, 'X-Olympus-Control-Session-Grade': 'local' }))).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test('a live local-grade session with CSRF reaches each route; outcomes map to status codes', async () => {
    const calls: string[] = [];
    const fetcher = worker(fakeBackend(calls));
    const { cookie, csrf } = await localSession(fetcher);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
    const on = await fetcher(post(DASHBOARD_OUTSIDE_HELP_PATHS.enable, { enabled: true, revision: 0, languages: ['en'] }, custody));
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, status_message: 'on', revision: 1 });
    expect((await (await fetcher(post(DASHBOARD_OUTSIDE_HELP_PATHS.route, { acknowledged: ALL_IDS }, custody))).json())).toEqual({ ok: true, status_message: 'saved', restarting: true });
    expect((await fetcher(post(DASHBOARD_OUTSIDE_HELP_PATHS.addRoute, { confirm: true }, custody))).status).toBe(200);
    expect((await fetcher(post(DASHBOARD_OUTSIDE_HELP_PATHS.recover, { confirm: true }, custody))).status).toBe(200);
    const abandon = await fetcher(post(DASHBOARD_OUTSIDE_HELP_PATHS.abandon, { confirm: true, scope: 'x' }, custody));
    expect(abandon.status).toBe(409);
    expect(await abandon.json()).toEqual({ ok: false, error: { code: 'no_unresolved_session', message: 'none' } });
    expect(calls).toEqual(['enable:{"enabled":true,"revision":0,"languages":["en"]}', 'route', 'add', 'recover', 'abandon']);
  });

  test('without a consult backend the routes answer 501 inside a session, and the page says unavailable', async () => {
    const fetcher = worker(undefined);
    const { cookie, csrf } = await localSession(fetcher);
    const response = await fetcher(post(DASHBOARD_OUTSIDE_HELP_PATHS.enable, { enabled: true, revision: 0 }, { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }));
    expect(response.status).toBe(501);
    const html = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(html).toContain('data-outside-unavailable');
  });

  test('the page reads the card\'s facts only for the control session, never for the bearer\'s plain GET or the dash_ reader', async () => {
    const calls: string[] = [];
    const backend = fakeBackend(calls);
    const counted: DashboardConsultBackend = { ...backend, status: async () => { calls.push('status'); return status(); }, summary: () => { calls.push('summary'); return { state: 'on' }; } };
    const fetcher = worker(counted);
    const { cookie } = await localSession(fetcher);
    const session = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(session).toContain('data-outside-help ');
    expect(session).toContain('name="acknowledged"');
    expect(session).toContain('data-outside-enabled="true"');
    expect(session).not.toContain('data-outside-unlock');
    expect(calls).toEqual(['status']);
    // A bearer-minted session reads the same facts but is offered the local unlock, no controls.
    const bearerMinted = await controlSession(fetcher);
    const offered = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: bearerMinted.cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(offered).toContain('data-outside-unlock');
    expect(offered).not.toContain('data-outside-enabled="true">');
    expect(calls).toEqual(['status', 'status']);
    calls.length = 0;
    calls.push('status');
    // Setup reads the one-word summary only.
    const setup = await (await fetcher(new Request(`${ORIGIN}/dashboard?setup`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(setup).toContain(`<p class="sline strong">${W.row.on}</p>`);
    expect(calls).toEqual(['status', 'summary']);
    // The bearer's own GET has write authority elsewhere, but this card needs the control session.
    const bearer = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Authorization: 'Bearer worker-secret' } }))).text();
    expect(bearer).toContain('data-outside-locked');
    expect(calls).toEqual(['status', 'summary']);
  });
});

// ---------------------------------------------------------------------------
// The adapter over a temp HOME: the writer's one caller.

function policyWith(zkapi: boolean, overrides: Record<string, unknown> = {}): SovereigntyConfig {
  const config = structuredClone(loadSovereigntyPreset('private-cloud-only')) as SovereigntyConfig;
  if (zkapi) {
    (config.modelProfiles as Record<string, unknown>)['zkapi-consult'] = {
      provider: 'zkapi',
      trust: 'standard_cloud',
      purpose: 'consult',
      baseUrl: 'http://127.0.0.1:8787/v1',
      model: 'openai/gpt-5-mini',
      secretRef: 'env:OLYMPUS_ZKAPI_API_KEY',
      zkapi: { fundingDate: '2026-10-01', acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ALL_IDS }, ...overrides },
    };
  }
  return config;
}

function adapter(input: {
  home: string;
  zkapi?: boolean;
  profileOverrides?: Record<string, unknown>;
  secret?: string;
  readiness?: Partial<ZkapiConsultReadiness>;
  recover?: ZkapiConsultResult;
  reload?: boolean;
  source?: string;
}) {
  const path = join(input.home, '.olympus', 'sovereignty.json');
  mkdirSync(join(input.home, '.olympus'), { recursive: true, mode: 0o700 });
  const config = policyWith(input.zkapi ?? true, input.profileOverrides);
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const reloads: number[] = [];
  const probes: unknown[] = [];
  const recoveries: unknown[] = [];
  const env = { HOME: input.home, ...(input.secret ? { OLYMPUS_ZKAPI_API_KEY: input.secret } : {}) };
  const backend = createDashboardConsultAdapter({
    sovereignty: { config, source: input.source ?? 'file', path },
    // Presence only; the key never reaches the adapter.
    secretPresent: (ref) => ref === 'env:OLYMPUS_ZKAPI_API_KEY' && env.OLYMPUS_ZKAPI_API_KEY !== undefined,
    requestReload: () => { reloads.push(1); return input.reload ?? true; },
    env,
    statePath: join(input.home, '.olympus', 'zkapi-consult-state.json'),
    now: () => new Date('2026-10-07T12:00:00.000Z'),
    readiness: async (options) => { probes.push(options); return readiness(input.readiness); },
    recoverSession: async (route, secretRef) => { recoveries.push({ route, secretRef }); return input.recover ?? { ok: false, error: { code: 'transport_failed', message: 'x', outcome: 'not_sent', networkIdentity: 'not_verified' } }; },
  });
  return { backend, reloads, probes, recoveries, path, env };
}

describe('the adapter: status', () => {
  test('summary and status reflect the file, the route and the fence; the probe never sees the key', async () => {
    const home = tempHome();
    const { backend, probes } = adapter({ home, secret: 'zk-local-key' });
    expect(backend.summary()).toEqual({ state: 'off' });
    const value = await backend.status();
    expect(value.settings).toMatchObject({ state: 'off', revision: 0, languages: ['en'] });
    expect(value.route.state).toBe('configured');
    if (value.route.state === 'configured') {
      expect(value.route).toMatchObject({ profileId: 'zkapi-consult', model: 'openai/gpt-5-mini', secretRef: 'env:OLYMPUS_ZKAPI_API_KEY', fundingDate: '2026-10-01', policyWritable: true });
      expect(value.route.acknowledgements.complete).toBe(true);
      expect(value.route.readiness?.ready).toBe(true);
    }
    expect(probes).toHaveLength(1);
    const probe = probes[0] as Record<string, unknown>;
    expect(probe.apiKey).toBeUndefined();
    expect(probe.apiKeyPresent).toBe(true);
    expect(JSON.stringify(value)).not.toContain('zk-local-key');
    // The probe gets the route and the process environment (for PATH), never a resolved key field.
    const { env: _env, ...probeWithoutEnv } = probe;
    expect(JSON.stringify(probeWithoutEnv)).not.toContain('zk-local-key');
    // Languages: the shipped packs are installed in this checkout; German and Italian are not.
    expect(value.languages.find((entry) => entry.language === 'en')?.installed).toBe(true);
    expect(value.languages.find((entry) => entry.language === 'de')?.installed).toBe(false);
    expect(value.restartPending).toBe(false);
  });

  test('no route, an invalid file and a held fence each give their summary word', async () => {
    const home = tempHome();
    expect(adapter({ home, zkapi: false }).backend.summary()).toEqual({ state: 'route_not_configured' });
    const second = adapter({ home: tempHome() });
    writeFileSync(join(second.env.HOME, '.olympus', 'consult.json'), '{bad', { mode: 0o600 });
    expect(second.backend.summary()).toEqual({ state: 'invalid' });
    const third = tempHome();
    const { backend, env } = adapter({ home: third });
    writeFileSync(join(third, '.olympus', 'zkapi-consult-state.json'), JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [zkapiFenceScope({ env })]: { at: '2026-10-07T10:00:00.000Z', configDir: '/w' } } }), { mode: 0o600 });
    expect(backend.summary()).toEqual({ state: 'fence_held' });
    const value = await backend.status();
    expect(value.route.state === 'configured' && value.route.readiness?.fences).toEqual([{ scope: zkapiFenceScope({ env }), at: '2026-10-07T10:00:00.000Z', thisWallet: true }]);
  });

  test('a failing probe reads as readiness unavailable, never as ready', async () => {
    const home = tempHome();
    mkdirSync(join(home, '.olympus'), { recursive: true, mode: 0o700 });
    const path = join(home, '.olympus', 'sovereignty.json');
    const config = policyWith(true);
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const backend = createDashboardConsultAdapter({
      sovereignty: { config, source: 'file', path },
      secretPresent: () => false,
      requestReload: () => true,
      env: { HOME: home },
      readiness: async () => { throw new Error('probe failed'); },
      recoverSession: async () => { throw new Error('never'); },
    });
    const value = await backend.status();
    expect(value.route).toMatchObject({ state: 'configured', readinessUnavailable: true });
    expect(value.route.state === 'configured' && value.route.readiness).toBeUndefined();
  });
});

describe('the adapter: turning outside help on and off', () => {
  test('on writes consult.json through the writer (enabled, languages, default domains, strict false, revision 1); off writes revision 2', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    const on = await backend.setEnabled({ enabled: true, revision: 0, languages: ['en', 'pt-BR'] });
    expect(on).toEqual({ ok: true, status_message: expect.stringContaining('Anonymous answers are on'), revision: 1 });
    const read = readConsultSettings({ env });
    expect(read).toMatchObject({ state: 'valid', settings: { v: 1, revision: 1, enabled: true, languages: ['en', 'pt-BR'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false } });
    expect(read.state === 'valid' && read.settings.domains).toMatchObject({ places: true, technical: true, countries: true, medicineBrands: false });
    expect(backend.summary()).toEqual({ state: 'on' });
    const off = await backend.setEnabled({ enabled: false, revision: 1 });
    expect(off).toEqual({ ok: true, status_message: expect.stringContaining('Anonymous answers are off'), revision: 2 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 2, enabled: false, languages: ['en', 'pt-BR'] } });
  });

  test('turning off with the real form payload (no language ticked) keeps the stored languages and is never refused', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    expect((await backend.setEnabled({ enabled: true, revision: 0, languages: ['en', 'pt-BR'] })).ok).toBe(true);
    // What the card's form posts when every language box is unticked: languages [] with enabled false.
    const off = await backend.setEnabled({ enabled: false, revision: 1, languages: [] });
    expect(off).toMatchObject({ ok: true, revision: 2 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { enabled: false, languages: ['en', 'pt-BR'] } });
    // Off with an unknown or uninstalled language in the payload: still off, languages kept.
    expect((await backend.setEnabled({ enabled: false, revision: 2, languages: ['de', 'xx'] })).ok).toBe(true);
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 3, enabled: false, languages: ['en', 'pt-BR'] } });
    // On with no language is still refused.
    expect(await backend.setEnabled({ enabled: true, revision: 3, languages: [] })).toMatchObject({ ok: false, code: 'languages_empty' });
  });

  test('turning on requires a configured route and complete acknowledgements; off never does', async () => {
    const home = tempHome();
    const noRoute = adapter({ home, zkapi: false }).backend;
    expect(await noRoute.setEnabled({ enabled: true, revision: 0 })).toMatchObject({ ok: false, httpStatus: 409, code: 'route_not_configured' });
    expect(existsSync(join(home, '.olympus', 'consult.json'))).toBe(false);
    const second = tempHome();
    const incomplete = adapter({ home: second, profileOverrides: { acknowledgements: { version: 2, accepted: ALL_IDS } } }).backend;
    expect(await incomplete.setEnabled({ enabled: true, revision: 0 })).toMatchObject({ ok: false, httpStatus: 409, code: 'acknowledgements_incomplete' });
    const partial = adapter({ home: tempHome(), profileOverrides: { acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ALL_IDS.slice(0, 7) } } }).backend;
    expect(await partial.setEnabled({ enabled: true, revision: 0 })).toMatchObject({ ok: false, code: 'acknowledgements_incomplete' });
    // Off is always allowed: it writes the file with enabled false.
    expect(await noRoute.setEnabled({ enabled: false, revision: 0 })).toMatchObject({ ok: true, revision: 1 });
  });

  test('a stale revision is a 409 conflict carrying the current revision; a damaged file is 409 settings_invalid until replace_invalid', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    expect((await backend.setEnabled({ enabled: true, revision: 0 })).ok).toBe(true);
    expect(await backend.setEnabled({ enabled: false, revision: 0 })).toEqual({ ok: false, httpStatus: 409, code: 'conflict', message: expect.stringContaining('changed somewhere else'), revision: 1 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 1, enabled: true } });
    writeFileSync(join(home, '.olympus', 'consult.json'), '{"v":1', { mode: 0o600 });
    expect(await backend.setEnabled({ enabled: false, revision: 0 })).toMatchObject({ ok: false, httpStatus: 409, code: 'settings_invalid' });
    expect(readFileSync(join(home, '.olympus', 'consult.json'), 'utf8')).toBe('{"v":1');
    expect(await backend.setEnabled({ enabled: false, revision: 0, replace_invalid: true })).toMatchObject({ ok: true, revision: 1 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { enabled: false } });
  });

  test('bad requests: no boolean, no revision, empty, unknown or uninstalled languages', async () => {
    const { backend } = adapter({ home: tempHome() });
    expect(await backend.setEnabled({ revision: 0 })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await backend.setEnabled({ enabled: true })).toMatchObject({ ok: false, httpStatus: 400, code: 'needs_revision' });
    expect(await backend.setEnabled({ enabled: true, revision: 0, languages: [] })).toMatchObject({ ok: false, code: 'languages_empty' });
    expect(await backend.setEnabled({ enabled: true, revision: 0, languages: ['xx'] })).toMatchObject({ ok: false, code: 'language_unknown' });
    expect(await backend.setEnabled({ enabled: true, revision: 0, languages: ['en', 'de'] })).toMatchObject({ ok: false, code: 'language_pack_missing' });
  });

  test('no HOME: refused, nothing written', async () => {
    const config = policyWith(true);
    const backend = createDashboardConsultAdapter({
      sovereignty: { config, source: 'inline_config' },
      secretPresent: () => false,
      requestReload: () => true,
      env: {},
      statePath: join(tempHome(), 'state.json'),
      readiness: async () => readiness(),
      recoverSession: async () => { throw new Error('never'); },
    });
    expect(await backend.setEnabled({ enabled: true, revision: 0 })).toMatchObject({ ok: false, httpStatus: 500, code: 'no_home' });
  });
});

describe('the adapter: the route, its acknowledgements and the fence', () => {
  test('saveRoute records the eight acknowledgements at version 3, the funding date and the caps in the policy file, validated, then asks for a restart', async () => {
    const home = tempHome();
    const { backend, reloads, path } = adapter({ home, profileOverrides: { acknowledgements: { version: 0, accepted: [] } } });
    expect((await backend.status()).route).toMatchObject({ acknowledgements: { complete: false } });
    const saved = await backend.saveRoute({ acknowledged: ALL_IDS, funding_date: '2026-10-05', daily_request_cap: 20, daily_spend_cap_usd: 120 });
    expect(saved).toEqual({ ok: true, status_message: expect.stringContaining('restarting'), restarting: true });
    expect(reloads).toEqual([1]);
    const written = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(written.modelProfiles['zkapi-consult']?.zkapi).toMatchObject({
      fundingDate: '2026-10-05',
      dailyRequestCap: 20,
      dailySpendCapUsd: 120,
      acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ALL_IDS },
    });
    // The file stays owner-only, and the adapter's own view follows it.
    expect((await backend.status()).route).toMatchObject({ acknowledgements: { complete: true }, fundingDate: '2026-10-05', dailyRequestCap: 20, dailySpendCapUsd: 120 });
    // Clearing a cap removes it; null and empty both clear.
    expect((await backend.saveRoute({ acknowledged: ALL_IDS, daily_request_cap: null, daily_spend_cap_usd: '' })).ok).toBe(true);
    const cleared = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(cleared.modelProfiles['zkapi-consult']?.zkapi?.dailyRequestCap).toBeUndefined();
    expect(cleared.modelProfiles['zkapi-consult']?.zkapi?.dailySpendCapUsd).toBeUndefined();
    expect(cleared.modelProfiles['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-10-05');
  });

  test('saveRoute refuses a partial tick, a bad date, a bad cap, no route, and a policy that is not a file; restart unavailable is said', async () => {
    const home = tempHome();
    const { backend, reloads, path } = adapter({ home, reload: false });
    const before = readFileSync(path, 'utf8');
    expect(await backend.saveRoute({ acknowledged: ALL_IDS.slice(1) })).toMatchObject({ ok: false, httpStatus: 400, code: 'acknowledgements_incomplete' });
    expect(await backend.saveRoute({ acknowledged: ALL_IDS, funding_date: '2026-13-01' })).toMatchObject({ ok: false, code: 'funding_date_invalid' });
    expect(await backend.saveRoute({ acknowledged: ALL_IDS, daily_request_cap: 2.5 })).toMatchObject({ ok: false, code: 'cap_invalid' });
    expect(await backend.saveRoute({ acknowledged: ALL_IDS, daily_spend_cap_usd: -1 })).toMatchObject({ ok: false, code: 'cap_invalid' });
    // The validator's own bounds refuse too (a cap over its limit), as a config_error.
    expect(await backend.saveRoute({ acknowledged: ALL_IDS, daily_request_cap: 10_000_000 })).toMatchObject({ ok: false, httpStatus: 400, code: 'config_error' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(reloads).toEqual([]);
    const ok = await backend.saveRoute({ acknowledged: ALL_IDS });
    expect(ok).toMatchObject({ ok: true, restarting: false, status_message: expect.stringContaining('restart the managed Olympus worker') });
    expect((await backend.status()).restartPending).toBe(true);
    expect(await adapter({ home: tempHome(), zkapi: false }).backend.saveRoute({ acknowledged: ALL_IDS })).toMatchObject({ ok: false, code: 'route_not_configured' });
    expect(await adapter({ home: tempHome(), source: 'inline_config' }).backend.saveRoute({ acknowledged: ALL_IDS })).toMatchObject({ ok: false, httpStatus: 409, code: 'policy_not_file' });
  });

  test('addRoute adds the one consult-only zkapi profile (confirmed), validated, and asks for a restart; a second is refused', async () => {
    const home = tempHome();
    const { backend, reloads, path } = adapter({ home, zkapi: false });
    expect(await backend.addRoute({})).toMatchObject({ ok: false, code: 'confirmation_required' });
    const added = await backend.addRoute({ confirm: true });
    expect(added).toMatchObject({ ok: true, restarting: true });
    expect(reloads).toEqual([1]);
    const written = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(written.modelProfiles[DASHBOARD_ZKAPI_PROFILE_ID]).toMatchObject({ provider: 'zkapi', trust: 'standard_cloud', purpose: 'consult', baseUrl: 'http://127.0.0.1:8787/v1', model: 'openai/gpt-5-mini', secretRef: 'env:OLYMPUS_ZKAPI_API_KEY' });
    expect(backend.summary()).toEqual({ state: 'off' });
    expect(await backend.addRoute({ confirm: true })).toMatchObject({ ok: false, httpStatus: 409, code: 'route_exists' });
    // The added route has no key yet and nothing acknowledged: the probe says so.
    const value = await backend.status();
    expect(value.route.state === 'configured' && value.route.acknowledgements.complete).toBe(false);
  });

  test('a policy file changed behind the card is a 409 policy_changed: nothing is written, and the view follows the file', async () => {
    const home = tempHome();
    const { backend, path, reloads } = adapter({ home, profileOverrides: { acknowledgements: { version: 0, accepted: [] } } });
    // Someone else edits the file (a new unrelated profile) after this adapter loaded its policy.
    const edited = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    (edited.modelProfiles as Record<string, unknown>)['local-extra'] = { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:28099/v1', model: 'extra', purpose: 'analyst' };
    writeFileSync(path, JSON.stringify(edited), { mode: 0o600 });
    const refused = await backend.saveRoute({ acknowledged: ALL_IDS });
    expect(refused).toMatchObject({ ok: false, httpStatus: 409, code: 'policy_changed' });
    expect(reloads).toEqual([]);
    const after = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(after.modelProfiles['zkapi-consult']?.zkapi?.acknowledgements).toMatchObject({ version: 0, accepted: [] });
    expect(after.modelProfiles['local-extra']).toBeDefined();
    // The adapter now holds the file's policy, so the retry writes only its block and keeps the other edit.
    expect((await backend.saveRoute({ acknowledged: ALL_IDS })).ok).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(written.modelProfiles['local-extra']).toBeDefined();
    expect(written.modelProfiles['zkapi-consult']?.zkapi?.acknowledgements).toMatchObject({ version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION });
  });

  test('a failure during the policy publish leaves the old policy file intact and asks for no restart', async () => {
    const home = tempHome();
    const { backend, path, reloads } = adapter({ home, profileOverrides: { acknowledgements: { version: 0, accepted: [] } } });
    const before = readFileSync(path, 'utf8');
    __sovereigntyFileTestHooks.beforePublish = () => { throw new Error('disk full'); };
    try {
      const failed = await backend.saveRoute({ acknowledged: ALL_IDS, funding_date: '2026-10-05' });
      expect(failed.ok).toBe(false);
    } finally {
      __sovereigntyFileTestHooks.beforePublish = undefined;
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(reloads).toEqual([]);
    expect(readdirSync(join(home, '.olympus')).filter((name) => name.includes('sovereignty') && name !== 'sovereignty.json')).toEqual([]);
    // Once the disk cooperates the same save goes through, atomically.
    expect((await backend.saveRoute({ acknowledged: ALL_IDS, funding_date: '2026-10-05' })).ok).toBe(true);
    expect((JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig).modelProfiles['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-10-05');
  });

  test('a failure after the policy publish is not a pre-publish failure: the published policy is applied (restart asked), or reported as uncertain', async () => {
    const home = tempHome();
    const { backend, path, reloads } = adapter({ home, profileOverrides: { acknowledgements: { version: 0, accepted: [] } } });
    // A directory-flush or mode failure right after the rename: the file is the new policy, so it is applied.
    __sovereigntyFileTestHooks.afterPublish = () => { throw new Error('directory flush failed'); };
    let saved;
    try {
      saved = await backend.saveRoute({ acknowledged: ALL_IDS, funding_date: '2026-10-05' });
    } finally {
      __sovereigntyFileTestHooks.afterPublish = undefined;
    }
    expect(saved).toMatchObject({ ok: true, restarting: true });
    expect(reloads).toEqual([1]);
    expect((JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig).modelProfiles['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-10-05');
    expect((await backend.status()).route).toMatchObject({ acknowledgements: { complete: true }, fundingDate: '2026-10-05' });
    // The file no longer reads as the new policy after the rename (clobbered in that instant): uncertain, no restart, the view follows the file.
    __sovereigntyFileTestHooks.afterPublish = (file) => {
      const clobbered = JSON.parse(readFileSync(file, 'utf8')) as SovereigntyConfig;
      (clobbered.modelProfiles['zkapi-consult'] as { zkapi?: { fundingDate?: string } }).zkapi!.fundingDate = '2026-10-06';
      writeFileSync(file, JSON.stringify(clobbered), { mode: 0o600 });
      throw new Error('directory flush failed');
    };
    let uncertain;
    try {
      uncertain = await backend.saveRoute({ acknowledged: ALL_IDS, funding_date: '2026-10-07' });
    } finally {
      __sovereigntyFileTestHooks.afterPublish = undefined;
    }
    expect(uncertain).toMatchObject({ ok: false, httpStatus: 500, code: 'policy_uncertain' });
    expect(reloads).toEqual([1]);
    expect((await backend.status()).route).toMatchObject({ fundingDate: '2026-10-06' });
  });

  test('recover runs the recovery session only for a held fence of this wallet, with confirmation, and reports settlement honestly', async () => {
    const home = tempHome();
    const { backend, recoveries, env } = adapter({ home, secret: 'k', recover: { ok: true, text: 'OK', routeLabel: 'r', networkIdentity: 'hidden', receipt: { fence: 'clear', settlement: 'confirmed' } as never, elapsedMs: 1 } });
    expect(await backend.recover({})).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(await backend.recover({ confirm: true })).toMatchObject({ ok: false, httpStatus: 409, code: 'no_unresolved_session' });
    const statePath = join(home, '.olympus', 'zkapi-consult-state.json');
    const other = 'b'.repeat(32);
    writeFileSync(statePath, JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [other]: { at: '2026-10-06T09:00:00.000Z', configDir: '/other' } } }), { mode: 0o600 });
    expect(await backend.recover({ confirm: true })).toMatchObject({ ok: false, httpStatus: 409, code: 'unresolved_session_other_wallet' });
    expect(recoveries).toEqual([]);
    const mine = zkapiFenceScope({ env });
    writeFileSync(statePath, JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [mine]: { at: '2026-10-07T10:00:00.000Z', configDir: '/mine' } } }), { mode: 0o600 });
    expect(await backend.recover({ confirm: true })).toEqual({ ok: true, status_message: expect.stringContaining('Recovered') });
    expect(recoveries).toHaveLength(1);
    // The adapter hands the route without a key and the key reference; the composition root resolves the key.
    expect((recoveries[0] as { route: { apiKey?: string }; secretRef?: string }).route.apiKey).toBeUndefined();
    expect((recoveries[0] as { secretRef?: string }).secretRef).toBe('env:OLYMPUS_ZKAPI_API_KEY');
    // Settlement not confirmed: the fence is still held, and the message says so.
    const pending = adapter({ home: tempHome(), secret: 'k', recover: { ok: true, text: 'OK', routeLabel: 'r', networkIdentity: 'hidden', receipt: { fence: 'held', settlement: 'pending' } as never, elapsedMs: 1 } });
    writeFileSync(join(pending.env.HOME, '.olympus', 'zkapi-consult-state.json'), JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [zkapiFenceScope({ env: pending.env })]: { at: '2026-10-07T10:00:00.000Z', configDir: '/mine' } } }), { mode: 0o600 });
    expect(await pending.backend.recover({ confirm: true })).toMatchObject({ ok: false, httpStatus: 502, code: 'recovery_incomplete' });
    const failed = adapter({ home: tempHome(), secret: 'k' });
    writeFileSync(join(failed.env.HOME, '.olympus', 'zkapi-consult-state.json'), JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [zkapiFenceScope({ env: failed.env })]: { at: '2026-10-07T10:00:00.000Z', configDir: '/mine' } } }), { mode: 0o600 });
    expect(await failed.backend.recover({ confirm: true })).toMatchObject({ ok: false, httpStatus: 502, code: 'transport_failed' });
  });

  test('abandon marks exactly the named fence abandoned, with confirmation, and keeps it as a record', async () => {
    const home = tempHome();
    const { backend } = adapter({ home });
    const statePath = join(home, '.olympus', 'zkapi-consult-state.json');
    const scope = 'c'.repeat(32);
    writeFileSync(statePath, JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [scope]: { at: '2026-10-06T09:00:00.000Z', configDir: '/other' } } }), { mode: 0o600 });
    expect(await backend.abandon({ scope })).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(await backend.abandon({ confirm: true })).toMatchObject({ ok: false, code: 'scope_invalid' });
    expect(await backend.abandon({ confirm: true, scope: 'd'.repeat(32) })).toMatchObject({ ok: false, httpStatus: 409, code: 'no_unresolved_session' });
    expect(backend.summary()).toEqual({ state: 'fence_held' });
    expect(await backend.abandon({ confirm: true, scope })).toEqual({ ok: true, status_message: expect.stringContaining('abandoned') });
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { fences?: unknown; abandonedFences?: Record<string, { abandonedAt: string }> };
    expect(state.fences).toBeUndefined();
    expect(state.abandonedFences?.[scope]?.abandonedAt).toBe('2026-10-07T12:00:00.000Z');
    expect(backend.summary()).toEqual({ state: 'off' });
  });
});
