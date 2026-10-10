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
import { CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT, CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT, CONSULT_LIGHT_CLEANUP_INSTRUCTION, consultChatgptModelUnavailableMessage, readConsultSettings } from '../src/core/consult-settings.ts';
import type { ZkapiConsultReadiness, ZkapiConsultResult } from '../src/core/consult-transport-zkapi.ts';
import { zkapiFenceScope } from '../src/core/consult-transport-zkapi.ts';
import { V0_4_PUBLIC_DASHBOARD_ROUTES } from '../src/core/public-surface.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS, ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION } from '../src/core/zkapi-consult-settings.ts';
import { dashboardHtmlRoutePage } from '../src/workers/dashboard/index.ts';
import {
  DASHBOARD_OUTSIDE_HELP_PATHS,
  outsideHelpBlockerWords,
  summaryOf,
  type DashboardOutsideHelpStatus,
} from '../src/workers/dashboard/outside-help.ts';
import { renderDashboardOutsideHelpPage } from '../src/workers/dashboard/pages/outside-help.ts';
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
    settings: { state: 'off', revision: 0, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false, level: 'unnamed', ...overrides.settings },
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
  return renderDashboardOutsideHelpPage({ now: NOW, controlSessionCsrfToken: 'csrf', outsideHelpLocalSession: true, outsideHelp: value, ...extra });
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

type CardAnswer = { status: number; body: unknown } | 'network';

/** Runs the card's own controller against the parsed card; reloads are recorded, never run. */
function runCardScript(html: string, answer: (url: string, body: unknown) => CardAnswer | Promise<CardAnswer>) {
  const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?outside-help' });
  const document = window.document;
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-outside-help]'))!;
  const posts: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
  const fetchStub = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    posts.push({ url, init });
    const reply = await answer(url, init.body === undefined ? undefined : JSON.parse(init.body));
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  new Function('window', 'document', 'fetch', 'setTimeout', script)(
    { confirm: () => true, location: { href: 'http://127.0.0.1:8010/dashboard?outside-help', reload: () => undefined } },
    document,
    fetchStub,
    () => undefined,
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { window, document, posts, settle };
}

describe('the Outside help page: states and copy', () => {
  test('off, route ready, acknowledged: one status line, no problems, everything else one collapsed line with its value', () => {
    const html = page(status());
    expect(html).toContain('<title>Olympus / Anonymous answers</title>');
    expect(html).toContain(`data-outside-state="off">${W.state.off}<`);
    // Above the sections: the title and the status line only (owner 2026-10-10: "way too complicated").
    const firstView = html.slice(html.indexOf('data-outside-help '), html.indexOf('<div class="ohmore">'));
    expect(firstView).toContain('data-outside-form="enable"');
    expect(firstView).not.toContain('data-outside-blockers');
    expect(firstView).not.toContain('data-statement=');
    expect(firstView).not.toContain('name="level"');
    expect(firstView).not.toContain(W.intro.replace(/'/g, '&#39;'));
    // Every section is one closed line; each that has a value shows it.
    const sections = [...html.matchAll(/<details class="ohsect" id="outside-([a-z]+)" data-outside-section="\1"( open)?>/g)];
    expect(sections.map((match) => match[1])).toEqual(['before', 'level', 'languages', 'limits', 'statements', 'steps', 'details']);
    expect(sections.every((match) => match[2] === undefined)).toBe(true);
    // What it is, then the plain privacy line; no "evidence pack" on the page.
    expect(html).toContain(W.intro.replace(/'/g, '&#39;'));
    expect(html).toContain(W.privacy);
    expect(visibleText(html)).not.toContain('evidence pack');
    // The honesty label keeps "network route not verified".
    expect(visibleText(html)).toContain('network route not verified');
    for (const line of W.disclosure) expect(html).toContain(line.replace(/'/g, '&#39;'));
    for (const step of W.steps) expect(visibleText(html)).toContain(step.replace('{secretRef}', 'env:OLYMPUS_ZKAPI_API_KEY').slice(0, 40));
    // The seven setup steps, in the order that worked live (§A.14): one send, activation, relay, require key, api key, key reuse 0.
    const text = visibleText(html);
    const order = ['--usd N', 'Private inference balance activated', '--relay-url socks5://127.0.0.1:19050', '--require-api-key', '--api-key <key>', '--key-reuse-window-seconds 0'];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('Send one transfer: the deposit plus the fee buffer');
    expect(text).toContain('Network fees move');
    // Accepted: the six statements are listed for review, with nothing to post.
    expect(html.match(/<li data-statement=/g)?.length).toBe(6);
    expect(html.match(/<input type="hidden" name="acknowledged"/g)).toBeNull();
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
    // Only when asked, said plainly (the automatic escalation was retired on 2026-10-10).
    expect(text).toContain('It asks only when you do');
    expect(text).not.toContain('It asks on its own');
    // The revision rides on the card for compare-and-swap.
    expect(html).toContain('data-revision="0"');
    // The status line: today's usage, the $6 said as a hold. Never "spent": only the hold per question is recorded.
    expect(text).toContain('2 questions today (counted as up to $12 against your limits) · balance expires about 31 Oct (24 days left)');
    expect(html.match(/data-outside-usage>([^<]*)</)?.[1]).not.toContain('spent');
    // Cost: the real cost first, then the hold, in one line (Before you turn this on, and Balance and limits).
    expect(text).toContain(W.costLine);
    expect(html.slice(html.indexOf('data-outside-section="limits"'))).toContain(W.costLine);
    expect(W.costLine).toBe('A question usually costs a few cents. Up to $6 is held while it runs, and the rest comes back.');
    // The required disclosures stay on the page. "Everything to know first" keeps the fuller detail:
    // automatic timing, the hold counted against limits, no default limit, no top-up, the estimated expiry,
    // the fee buffer, the API key, key reuse, the operator and proof setup, the route not verified.
    const more = html.slice(html.indexOf('data-outside-disclosure-more'));
    const fuller = visibleText(more.slice(0, more.indexOf('</ul>')));
    for (const needle of ['only when you ask your agent to use Olympus zkAPI', 'counts each question at the amount held for its model', 'no daily limit unless you set one', 'There is no top-up', 'estimates the 30-day date',
      'fee buffer', 'require an API key', 'key reuse is on', 'pause deposits and withdrawals', 'proof setup', 'confirm the Tor route for each completed session', 'only when every check passes', 'does not hide identifying details']) expect(fuller).toContain(needle);
    // And the setup steps name the exact commands.
    for (const needle of ['--key-reuse-window-seconds 0', '--require-api-key', 'balance estimated to expire']) expect(text).toContain(needle);
    // Before you turn this on: two short lines; the fuller detail ("Everything to know first") inside Details.
    expect(html.match(/<ul class="ohshort" data-outside-disclosure>(.*?)<\/ul>/)?.[1]?.match(/<li>/g)?.length).toBe(2);
    expect(html.indexOf('data-outside-disclosure-more')).toBeGreaterThan(html.indexOf('data-outside-section="details"'));
    // Accepted at the current wording: one line, the statements inside it.
    expect(html).toContain(`<span class="ohsect-title">${W.costTitle}</span><span class="ohsect-sum">You accepted all 6</span>`);
    expect(html).toContain('data-outside-acknowledged="yes"');
    // Nothing to fix: no problem list. Each line shows its current value.
    expect(html).not.toContain('data-outside-blockers');
    expect(text).toContain('No daily limit · paid in on 1 Oct');
    expect(html).toContain(`<span class="ohsect-title">${W.levelTitle}</span><span class="ohsect-sum">Standard</span>`);
    expect(html).toContain(`<span class="ohsect-title">${W.languagesTitle}</span><span class="ohsect-sum">English</span>`);
    // Technical facts, inside Details only.
    expect(text).toContain('zkapi-clientd 0.1.6 found');
    expect(text).toContain('2 requests today ($12 counted against your limits)');
    expect(text).toContain('balance estimated to expire 2026-10-31 (24 days left)');
    const details = html.slice(html.indexOf('data-outside-section="details"'));
    expect(details).toContain('Route: payment privacy; route not verified.');
    expect(html.slice(0, html.indexOf('data-outside-section="details"'))).not.toContain('Route: payment privacy');
  });

  test('on: Turn off; the chosen languages are checked; revision carried', () => {
    const html = page(status({ settings: { state: 'on', revision: 3, languages: ['en', 'pt-BR'] } }));
    expect(html).toContain(`data-outside-state="on">${W.state.on}<`);
    // On: "Before you turn this on" is gone; what it is and the fuller detail sit in Details.
    expect(visibleText(html)).not.toContain(W.disclosureTitle);
    expect(html).not.toContain('data-outside-section="before"');
    const details = html.slice(html.indexOf('data-outside-section="details"'));
    expect(details).toContain(W.intro.replace(/'/g, '&#39;'));
    for (const line of W.disclosure) expect(details).toContain(line.replace(/'/g, '&#39;'));
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
    // The policy-not-a-file case cannot add it here: it says why, with the steps as its one button.
    const inline = page(status({ route: { state: 'not_configured', policyWritable: false } }));
    expect(inline).not.toContain('data-outside-form="add-route"');
    expect(inline).toContain(W.policyNotFile);
    expect(inline).toContain(`data-outside-open="steps">${W.showSteps}</button>`);
  });

  test('blockers read in plain words, one line and one button each; acknowledgements incomplete blocks Turn on', () => {
    const { daemonExecutable: _d, daemonVersion: _v, torExecutable: _t, ...bare } = readiness();
    const blocked: ZkapiConsultReadiness = { ...bare, blockers: ['daemon_not_found', 'tor_not_found', 'daemon_api_key_missing', 'funding_date_missing', 'acknowledgements_incomplete'], apiKeyConfigured: false };
    const html = page(status({ route: configuredRoute({ complete: false, ready: blocked }) }));
    const text = visibleText(html);
    // Said once, in the list: the status line never repeats a problem.
    expect(html).not.toContain('data-outside-route=');
    expect(html.match(/data-outside-usage>[^<]*</)?.[0]).not.toContain('Not ready');
    const list = html.match(/<ul class="ohfix" data-outside-blockers[^>]*>(.*?)<\/ul>/)?.[1] ?? '';
    const lines = list.split('</li>').filter((line) => line.includes('<li'));
    expect(lines.length).toBe(4);
    // Every line has exactly one button (the owner rule: never a problem without a way to fix it).
    for (const line of lines) expect(line.match(/<button /g)?.length).toBe(1);
    expect(list).toContain(`data-outside-open="limits" data-outside-focus="funding_date">${W.enterFundingDate}</button>`);
    expect(list.match(/data-outside-open="steps"/g)?.length).toBe(3);
    // The missing statements are said once, beside the statements, never again in the list.
    expect(text).not.toContain(W.blockers.acknowledgements_incomplete);
    expect(text).toContain(W.blockers.daemon_not_found);
    expect(text).toContain(W.blockers.tor_not_found);
    expect(text).toContain(W.blockers.daemon_api_key_missing);
    expect(text).toContain(W.blockers.funding_date_missing);
    // The sections stay closed: each problem's button opens the one that holds its fix.
    expect(html).not.toMatch(/data-outside-section="[a-z]+" open>/);
    expect(text).toContain('zkapi-clientd not installed');
    // Not accepted: the six statements in full, under the problems, with one Accept; nowhere else.
    const accept = html.slice(html.indexOf('data-outside-accept'), html.indexOf('</form>', html.indexOf('data-outside-accept')));
    expect(accept.match(/<li data-statement=/g)?.length).toBe(6);
    expect(accept.match(/name="acknowledged"/g)?.length).toBe(6);
    expect(accept).toContain(`>${W.accept}</button>`);
    expect(html.match(/<li data-statement=/g)?.length).toBe(6);
    expect(html.indexOf('data-outside-accept')).toBeGreaterThan(html.indexOf('data-outside-blockers'));
    expect(html.indexOf('data-outside-accept')).toBeLessThan(html.indexOf('<div class="ohmore">'));
    expect(html).not.toContain('data-outside-section="statements"');
    expect(html).toContain('data-outside-acknowledged="no"');
    expect(html).toContain(W.enableBlockedAcks);
    expect(html).not.toContain('data-outside-enabled="true"');
    // Every transport code the readiness can emit has words, or the honest fallback.
    for (const code of ['key_reuse_on', 'daemon_version_unsupported', 'unresolved_session', 'tor_port_busy', 'daemon_already_running', 'spend_cap_reached', 'daily_cap_reached', 'note_expired', 'stranded_processes', 'state_unavailable'] as const) {
      expect(outsideHelpBlockerWords(code)).not.toContain(code);
    }
    expect(outsideHelpBlockerWords('internal_error')).toBe('Not ready yet (internal_error).');
  });

  test('a held fence: the paused state, one line with Recover (confirm, $6) and a quiet Abandon (its privacy consequence)', () => {
    const fences = [{ scope: 'a'.repeat(32), at: '2026-10-07T10:00:00.000Z', thisWallet: true }, { scope: 'b'.repeat(32), at: '2026-10-06T09:00:00.000Z', thisWallet: false }];
    const held = readiness({ blockers: ['unresolved_session', 'unresolved_session_other_wallet'], unresolvedSession: true });
    const value = status({ route: configuredRoute({ ready: held, fences }) });
    expect(summaryOf(value)).toEqual({ state: 'fence_held' });
    const html = page(value);
    expect(html).toContain(`data-outside-state="fence_held">${W.state.fence_held}<`);
    const fence = html.slice(html.indexOf('data-outside-fence'), html.indexOf('</li>', html.indexOf('data-outside-fence')));
    expect(visibleText(fence)).toContain('An earlier question has not finished paying (held since 7 Oct 10:00).');
    expect(fence).toContain(`data-outside-form="recover" data-outside-confirm="${W.recoverConfirm}"`);
    expect(fence).toContain(`<button type="submit" class="btn primary" title="${W.recoverHint}">${W.recover}</button>`);
    expect(html).toContain('reserves up to $6');
    expect(fence).toContain(`data-outside-form="abandon" data-outside-scope="${'a'.repeat(32)}" data-outside-confirm="${W.abandonConfirm.replace(/'/g, '&#39;')}"`);
    expect(fence).toContain(`class="btn quiet" title="${W.abandonHint}">${W.abandon}</button>`);
    // The other wallet's payment: its own line, Abandon its one button.
    const otherLine = html.slice(html.indexOf('data-outside-blocker="unresolved_session_other_wallet"'));
    expect(visibleText(otherLine.slice(0, otherLine.indexOf('</li>')))).toContain('(held since 6 Oct 09:00)');
    expect(otherLine.slice(0, otherLine.indexOf('</li>'))).toContain(`data-outside-form="abandon" data-outside-scope="${'b'.repeat(32)}"`);
    expect(html).not.toContain('data-outside-form="recover" data-outside-confirm="x"');
    // Both held payments are named in Details too.
    expect(visibleText(html)).toContain('Unfinished payment held since 7 Oct 10:00 (this wallet)');
    expect(visibleText(html)).toContain('Unfinished payment held since 6 Oct 09:00 (another wallet folder)');
    // No fence for this wallet: no Recover at all (recovery must run from the wallet that holds it).
    const other = page(status({ route: configuredRoute({ ready: readiness({ blockers: ['unresolved_session_other_wallet'] }), fences: [fences[1]!] }) }));
    expect(other).not.toContain('data-outside-form="recover"');
    expect(other).toContain(`data-outside-scope="${'b'.repeat(32)}"`);
  });

  test('restart pending is said once, at the top', () => {
    const html = page(status({ restartPending: true }));
    expect(html).toContain(`data-outside-restart-pending>${W.restartPending}<`);
  });

  test('limits left on: Balance and limits names them; a reached limit is one problem line whose button is No daily limit', () => {
    const capped = readiness({ blockers: ['daily_cap_reached'], requestsToday: { count: 10, cap: 10 }, spendToday: { reservedUsd: 60, capUsd: 10 } });
    const route = { ...configuredRoute({ ready: capped }), dailyRequestCap: 10, dailySpendCapUsd: 10 } as DashboardOutsideHelpStatus['route'];
    const html = page(status({ route }));
    const text = visibleText(html);
    expect(text).toContain('10 questions a day, $10 a day · paid in on 1 Oct');
    expect(text).toContain('Questions today: 10, counted as up to $60 against your limits.');
    const line = html.slice(html.indexOf('data-outside-blocker="daily_cap_reached"'), html.indexOf('</li>', html.indexOf('data-outside-blocker="daily_cap_reached"')));
    expect(visibleText(line)).toContain(W.blockers.daily_cap_reached);
    expect(line).toContain(`data-outside-form="route" data-outside-nolimit><button type="submit" class="btn primary">${W.removeLimits}</button>`);
    expect(html).toContain(`data-outside-form="route" data-outside-nolimit><div class="pbuttons"><button type="submit" class="btn">${W.removeLimits}</button>`);
    // Both limits reached: one line, one button.
    const both = page(status({ route: { ...configuredRoute({ ready: readiness({ blockers: ['daily_cap_reached', 'spend_cap_reached'] }) }), dailyRequestCap: 10, dailySpendCapUsd: 10 } as DashboardOutsideHelpStatus['route'] }));
    expect(both.match(/data-outside-blocker="(daily|spend)_cap_reached"/g)?.length).toBe(1);
    expect(visibleText(both)).toContain(W.capsReached.replace(/&#39;/g, "'"));
    // No limit set: no button, the plain statement instead.
    const free = page(status());
    expect(free).not.toContain('<form class="ohform ohinline" data-outside-form="route" data-outside-nolimit>');
    expect(visibleText(free)).toContain(W.noLimitIntro);
  });

  test('the card\'s script: No daily limit clears both caps and leaves the acceptance alone; turning on posts the language boxes and says on at once', async () => {
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
    expect(JSON.parse(posts[0]!.init.body)).toEqual({ daily_request_cap: null, daily_spend_cap_usd: null });
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
    // What may zkAPI send: the chosen level, posted to the same settings route, keeping the switch as it now reads.
    const level = document.querySelector('form[data-outside-form="level"]')!;
    (level.querySelector('input[name="level"][value="general"]') as unknown as { checked: boolean }).checked = true;
    level.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(posts[2]!.url).toBe(DASHBOARD_OUTSIDE_HELP_PATHS.enable);
    expect(posts[2]!.init.headers['X-Olympus-CSRF']).toBe('csrf');
    expect(JSON.parse(posts[2]!.init.body)).toEqual({ enabled: true, revision: 5, level: 'general' });
  });

  test('What may zkAPI send: one line showing the level; Standard and Strict with the owner\'s copy, both always selectable, a plain Save', () => {
    const html = page(status());
    const text = visibleText(html);
    expect(text).toContain('What may zkAPI send?');
    for (const line of ['Standard (recommended)', 'Your question goes out as you choose: exactly as written, lightly cleaned, or by your own instruction. The provider can read it but can\'t tell who sent it.',
      'Strict', 'Your model rewrites it into general questions first (Vitalik Buterin\'s approach).']) expect(text).toContain(line);
    expect(text).not.toContain('without names (recommended)');
    expect(html).toContain('<input type="radio" name="level" value="unnamed" checked>');
    expect(html).toContain(`data-outside-level-save>${W.levelSave}</button>`);
    // Strict saved, statements missing: Standard is still selectable (never a dead radio), and the
    // statements are never tied to the level: they sit once, above, with their own Accept.
    const strict = page(status({ settings: { level: 'general' }, route: configuredRoute({ complete: false }) }));
    expect(strict).toContain(`<span class="ohsect-title">${W.levelTitle}</span><span class="ohsect-sum">Strict</span>`);
    expect(strict).toContain('<input type="radio" name="level" value="general" checked>');
    expect(strict).toContain('<input type="radio" name="level" value="unnamed">');
    expect(strict).toContain(`data-outside-level-save>${W.levelSave}</button>`);
    const levelForm = strict.slice(strict.indexOf('data-outside-form="level"'), strict.indexOf('</form>', strict.indexOf('data-outside-form="level"')));
    expect(levelForm).not.toContain('data-statement=');
    expect(strict).toContain(`>${W.accept}</button>`);
    // At Strict the Standard preparation line says it is kept but not used.
    expect(page({ ...status({ settings: { level: 'general' } }), standard: { mode: 'as_written', preset: 'p', maxChars: 2000 } })).toContain('<span class="ohsect-sum">Exactly as written (used at Standard only)</span>');
    // On with stale statements: on, but paused until they are accepted, said in the status line.
    const paused = status({ settings: { state: 'on', level: 'unnamed' }, route: configuredRoute({ complete: false }) });
    expect(summaryOf(paused)).toEqual({ state: 'needs_acceptance' });
    const pausedHtml = page(paused);
    expect(pausedHtml).toContain(`data-outside-state="needs_acceptance">${W.state.needs_acceptance}<`);
    expect(pausedHtml).toContain(W.turnOff);
    // On with another problem: paused, the fix below.
    const blocked = status({ settings: { state: 'on' }, route: configuredRoute({ ready: readiness({ blockers: ['daily_cap_reached'] }) }) });
    expect(summaryOf(blocked)).toEqual({ state: 'blocked' });
    expect(page(blocked)).toContain(`data-outside-state="blocked">${W.state.blocked}<`);
  });

  test('the card\'s script: a level save keeps the switch on while paused; Accept posts the statements; a problem\'s button opens its section', async () => {
    const held = readiness({ blockers: ['unresolved_session', 'funding_date_missing'] });
    const value = status({ settings: { state: 'on', revision: 7, level: 'general' }, route: configuredRoute({ complete: false, ready: held, fences: [{ scope: 'a'.repeat(32), at: '2026-10-07T10:00:00.000Z', thisWallet: true }] }) });
    expect(summaryOf(value)).toEqual({ state: 'fence_held' });
    const { document, window, posts, settle } = runCardScript(page(value), (url) => (url.endsWith('/dashboard/consult')
      ? { status: 200, body: { ok: true, status_message: 'Saved.', revision: 8 } }
      : { status: 200, body: { ok: true, status_message: 'Saved. Olympus is restarting.', restarting: true } }));
    const level = document.querySelector('form[data-outside-form="level"]')!;
    (level.querySelector('input[name="level"][value="general"]') as unknown as { checked: boolean }).checked = false;
    (level.querySelector('input[name="level"][value="unnamed"]') as unknown as { checked: boolean }).checked = true;
    level.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    // Paused by a held payment is still on: saving a level never turns it off.
    expect(posts.map((post) => post.url)).toEqual([DASHBOARD_OUTSIDE_HELP_PATHS.enable]);
    expect(JSON.parse(posts[0]!.init.body)).toEqual({ enabled: true, revision: 7, level: 'unnamed' });
    const accept = document.querySelector('form[data-outside-accept]')!;
    accept.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(posts[1]!.url).toBe(DASHBOARD_OUTSIDE_HELP_PATHS.route);
    expect(JSON.parse(posts[1]!.init.body)).toEqual({ acknowledged: ALL_IDS });
    expect(accept.querySelector('[data-action-message]')!.textContent).toContain('Saved. Olympus is restarting.');
    // Enter the date: opens Balance and limits.
    const limits = document.querySelector('details[data-outside-section="limits"]') as unknown as { open: boolean };
    expect(limits.open).toBe(false);
    (document.querySelector('[data-outside-open="limits"]') as unknown as { click: () => void }).click();
    expect(limits.open).toBe(true);
  });

  test('the card\'s script: every refusal shows the server\'s own words; no words, the status; no answer, says so', async () => {
    const answers = [
      { status: 409, body: { ok: false, error: { code: 'acknowledgements_incomplete', message: 'Accept the statements on this page before turning anonymous answers on.' } } },
      { status: 500, body: {} },
      'network' as const,
    ];
    const { document, window, settle } = runCardScript(page(status({ settings: { level: 'general' } })), () => answers.shift()!);
    const level = document.querySelector('form[data-outside-form="level"]')!;
    const out = level.querySelector('[data-action-message]')!;
    level.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(out.textContent).toBe('Accept the statements on this page before turning anonymous answers on.');
    expect(out.getAttribute('data-state')).toBe('error');
    level.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(out.textContent).toBe(W.saveFailedStatus.replace('{status}', '500'));
    level.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(out.textContent).toBe(W.saveUnreachable);
  });

  test('Tor off: the route is said to be direct with the network address visible, whether or not a tor binary exists', () => {
    const off = readiness({ tor: 'off', torPort: 'not_used' });
    const html = page(status({ route: configuredRoute({ ready: off }) }));
    const text = visibleText(html);
    expect(text).toContain('Tor off: the route is direct and your network address is visible to the provider');
    // The status line says it plainly; the Tor wording is in Details.
    expect(html).toContain(`data-outside-address-visible>${W.addressVisible}</p>`);
    expect(text).not.toContain('Tor found');
    const { torExecutable: _t, ...noBinary } = readiness({ tor: 'off', torPort: 'not_used' });
    expect(visibleText(page(status({ route: configuredRoute({ ready: noBinary as ZkapiConsultReadiness }) })))).toContain('Tor off: the route is direct');
    // Tor on and missing: said as missing.
    const { torExecutable: _m, ...missing } = readiness({ blockers: ['tor_not_found'] });
    expect(visibleText(page(status({ route: configuredRoute({ ready: missing as ZkapiConsultReadiness }) })))).toContain('Tor not installed');
  });

  test('a bearer-grade session reads the card; the unlock is its only control, and every fix\'s first click unlocks', async () => {
    const held = readiness({ blockers: ['unresolved_session'] });
    const value = status({ settings: { state: 'on' }, route: configuredRoute({ complete: false, ready: held, fences: [{ scope: 'a'.repeat(32), at: '2026-10-07T10:00:00.000Z', thisWallet: true }] }) });
    const html = page(value, { outsideHelpLocalSession: false });
    expect(html).toContain('data-outside-unlock');
    expect(html).toContain(W.unlock);
    expect(html).toContain(DASHBOARD_LOCAL_CONTROL_SESSION_PATH);
    // No control posts: the switch, Recover and Accept are shown, but each first opens the session.
    expect(html).not.toContain('data-outside-enabled=');
    expect(html).not.toContain('data-outside-form="recover"');
    expect(html).toContain(`data-outside-needs-unlock>${W.turnOff}</button>`);
    expect(html).toContain(`data-outside-needs-unlock>${W.recover}</button>`);
    expect(html).toContain(`data-outside-needs-unlock>${W.accept}</button>`);
    expect(html).not.toContain(`data-outside-save-limits`);
    // Still reads every fact and every statement.
    expect(html.match(/<li data-statement=/g)?.length).toBe(6);
    expect(html).toContain('name="level" value="unnamed" checked disabled aria-disabled="true">');
    // Recover's first click submits the unlock (no credential), nothing else.
    const { document, posts, settle } = runCardScript(html, () => ({ status: 200, body: { ok: true } }));
    (document.querySelector('[data-outside-needs-unlock]') as unknown as { click: () => void }).click();
    await settle();
    expect(posts.map((post) => post.url)).toEqual([DASHBOARD_OUTSIDE_HELP_PATHS.unlock]);
    // A local-grade session has no unlock to offer.
    expect(page(status())).not.toContain('data-outside-unlock');
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

// ---------------------------------------------------------------------------
// The worker boundary: control session only.

function fakeBackend(calls: string[]): DashboardConsultBackend {
  return {
    status: async () => status(),
    setEnabled: async (update) => { calls.push(`enable:${JSON.stringify(update)}`); return { ok: true, status_message: 'on', revision: 1 }; },
    saveRoute: async () => { calls.push('route'); return { ok: true, status_message: 'saved', restarting: true }; },
    addRoute: async () => { calls.push('add'); return { ok: true, status_message: 'added', restarting: true }; },
    recover: async () => { calls.push('recover'); return { ok: true, status_message: 'recovered' }; },
    abandon: async () => { calls.push('abandon'); return { ok: false, httpStatus: 409, code: 'no_unresolved_session', message: 'none' }; },
    installTools: async () => { calls.push('install'); return { ok: true, status_message: 'installing' }; },
    saveWriter: async () => { calls.push('writer'); return { ok: true, status_message: 'saved', revision: 2 }; },
    testWriter: async () => { calls.push('writer-test'); return { ok: true, status_message: 'testing' }; },
    saveStandard: async () => { calls.push('standard'); return { ok: true, status_message: 'saved', revision: 2 }; },
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
    const counted: DashboardConsultBackend = { ...backend, status: async () => { calls.push('status'); return status(); } };
    const fetcher = worker(counted);
    const { cookie } = await localSession(fetcher);
    const session = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(session).toContain('data-outside-help ');
    expect(session).toContain('data-statement="only_when_asked"');
    expect(session).toContain('data-outside-enabled="true"');
    expect(session).not.toContain('data-outside-unlock');
    expect(calls).toEqual(['status']);
    // A bearer-minted session reads the same facts but is offered the local unlock, no controls.
    const bearerMinted = await controlSession(fetcher);
    const offered = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: bearerMinted.cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(offered).toContain('data-outside-unlock');
    expect(offered).not.toContain('data-outside-enabled="true">');
    expect(calls).toEqual(['status', 'status']);
    // The bearer's own GET has write authority elsewhere, but this card needs the control session.
    const bearer = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Authorization: 'Bearer worker-secret' } }))).text();
    expect(bearer).toContain('data-outside-locked');
    expect(calls).toEqual(['status', 'status']);
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
  writerCheck?: Parameters<typeof createDashboardConsultAdapter>[0]['writerCheck'];
  chatgptModelProblem?: Parameters<typeof createDashboardConsultAdapter>[0]['chatgptModelProblem'];
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
    ...(input.writerCheck ? { writerCheck: input.writerCheck } : {}),
    ...(input.chatgptModelProblem ? { chatgptModelProblem: input.chatgptModelProblem } : {}),
  });
  return { backend, reloads, probes, recoveries, path, env };
}

describe('the adapter: status', () => {
  test('the summary word and status reflect the file, the route and the fence; the probe never sees the key', async () => {
    const home = tempHome();
    const { backend, probes } = adapter({ home, secret: 'zk-local-key' });
    const value = await backend.status();
    expect(summaryOf(value)).toEqual({ state: 'off' });
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
    expect(summaryOf(await adapter({ home, zkapi: false }).backend.status())).toEqual({ state: 'route_not_configured' });
    const second = adapter({ home: tempHome() });
    writeFileSync(join(second.env.HOME, '.olympus', 'consult.json'), '{bad', { mode: 0o600 });
    expect(summaryOf(await second.backend.status())).toEqual({ state: 'invalid' });
    const third = tempHome();
    const { backend, env } = adapter({ home: third });
    writeFileSync(join(third, '.olympus', 'zkapi-consult-state.json'), JSON.stringify({ version: 1, day: '2026-10-07', count: 0, reservedMicroUsd: 0, fences: { [zkapiFenceScope({ env })]: { at: '2026-10-07T10:00:00.000Z', configDir: '/w' } } }), { mode: 0o600 });
    expect(summaryOf(await backend.status())).toEqual({ state: 'fence_held' });
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
    expect(summaryOf(await backend.status())).toEqual({ state: 'on' });
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
    const partial = adapter({ home: tempHome(), profileOverrides: { acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ALL_IDS.slice(0, 5) } } }).backend;
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

  test('level: Standard ("unnamed") is the default everywhere, including a file without the key; a damaged file replaced without a choice is Strict', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    expect((await backend.setEnabled({ enabled: true, revision: 0 })).ok).toBe(true);
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 1, level: 'unnamed' } });
    expect((await backend.status()).settings.level).toBe('unnamed');

    const older = tempHome();
    const { backend: olderBackend, env: olderEnv } = adapter({ home: older });
    // A file written before the level existed reads as Standard; sending still needs the current statements.
    writeFileSync(join(older, '.olympus', 'consult.json'), JSON.stringify({ v: 1, revision: 4, enabled: true, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false }), { mode: 0o600 });
    expect((await olderBackend.status()).settings.level).toBe('unnamed');
    expect((await olderBackend.setEnabled({ enabled: false, revision: 4 })).ok).toBe(true);
    expect((await olderBackend.setEnabled({ enabled: true, revision: 5 })).ok).toBe(true);
    expect(readConsultSettings({ env: olderEnv })).toMatchObject({ state: 'valid', settings: { revision: 6, enabled: true, level: 'unnamed' } });
    // A damaged file replaced without a choice is written Strict, and off: a repair never widens the scope.
    writeFileSync(join(older, '.olympus', 'consult.json'), '{"v":1', { mode: 0o600 });
    expect((await olderBackend.setEnabled({ enabled: false, revision: 0, replace_invalid: true })).ok).toBe(true);
    expect(readConsultSettings({ env: olderEnv })).toMatchObject({ state: 'valid', settings: { enabled: false, level: 'general' } });
  });

  test('level: choosing a level is never refused for the statements; on with stale statements stays on and reads paused', async () => {
    // The owner's state: outside help on, no level key, statements accepted at an older version.
    const stale = adapter({ home: tempHome(), profileOverrides: { acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION - 2, accepted: ['per_consult_cost', 'deposit_fee'] } } });
    writeFileSync(join(stale.env.HOME, '.olympus', 'consult.json'), JSON.stringify({ v: 1, revision: 3, enabled: true, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false }), { mode: 0o600 });
    expect(summaryOf(await stale.backend.status())).toEqual({ state: 'needs_acceptance' });
    for (const [revision, level] of [[3, 'general'], [4, 'unnamed'], [5, 'general']] as const) {
      expect(await stale.backend.setEnabled({ enabled: true, revision, level })).toEqual({ ok: true, status_message: 'Saved. Anonymous answers stay paused until you accept the statements on this page.', revision: revision + 1 });
    }
    expect(readConsultSettings({ env: stale.env })).toMatchObject({ settings: { revision: 6, enabled: true, level: 'general' } });
    // Off, a level change is just saved.
    expect(await stale.backend.setEnabled({ enabled: false, revision: 6, level: 'unnamed' })).toEqual({ ok: true, status_message: 'Saved.', revision: 7 });
    // Turning ON (from off) still needs the statements, with the server's own words.
    expect(await stale.backend.setEnabled({ enabled: true, revision: 7 })).toMatchObject({ ok: false, httpStatus: 409, code: 'acknowledgements_incomplete', message: expect.stringContaining('Accept the statements') });
    // Accepting them clears the pause.
    expect((await stale.backend.saveRoute({ acknowledged: ALL_IDS })).ok).toBe(true);
    expect((await stale.backend.setEnabled({ enabled: true, revision: 7 })).ok).toBe(true);
    expect(summaryOf(await stale.backend.status())).toEqual({ state: 'on' });
    expect(await stale.backend.setEnabled({ enabled: true, revision: 8, level: 'everything' })).toMatchObject({ ok: false, httpStatus: 400, code: 'level_unknown' });
  });

  test('the owner\'s Save, end to end: the real card script against the real worker and adapter saves the level and says it is paused', async () => {
    const home = tempHome();
    const stale = adapter({ home, profileOverrides: { acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION - 2, accepted: [] } } });
    writeFileSync(join(home, '.olympus', 'consult.json'), JSON.stringify({ v: 1, revision: 3, enabled: true, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false }), { mode: 0o600 });
    const fetcher = worker(stale.backend);
    const { cookie, csrf } = await localSession(fetcher);
    const html = await (await fetcher(new Request(`${ORIGIN}/dashboard?outside-help`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/dashboard` } }))).text();
    expect(html).toContain(`data-outside-state="needs_acceptance"`);
    const { document, window, posts, settle } = runCardScript(html, async (url, body) => {
      const response = await fetcher(post(url, body, { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }));
      return { status: response.status, body: await response.json() };
    });
    const level = document.querySelector('form[data-outside-form="level"]')!;
    (level.querySelector('input[name="level"][value="general"]') as unknown as { checked: boolean; dispatchEvent: (event: unknown) => void }).checked = true;
    level.querySelector('input[name="level"][value="general"]')!.dispatchEvent(new window.Event('change'));
    level.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(posts.map((entry) => entry.url)).toEqual([DASHBOARD_OUTSIDE_HELP_PATHS.enable]);
    expect(level.querySelector('[data-action-message]')!.textContent).toBe('Saved. Anonymous answers stay paused until you accept the statements on this page.');
    expect(readConsultSettings({ env: stale.env })).toMatchObject({ settings: { revision: 4, enabled: true, level: 'general' } });
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
  test('saveRoute records the six acknowledgements at version 5, the funding date and the caps in the policy file, validated, then asks for a restart', async () => {
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

  test('saveRoute without the statements (the funding date, the limits) leaves the recorded acceptance exactly as it is', async () => {
    const stale = { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION - 1, accepted: ['per_consult_cost'] };
    const { backend, path } = adapter({ home: tempHome(), profileOverrides: { acknowledgements: stale } });
    expect((await backend.saveRoute({ funding_date: '2026-10-06', daily_request_cap: null, daily_spend_cap_usd: null })).ok).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(written.modelProfiles['zkapi-consult']?.zkapi).toMatchObject({ fundingDate: '2026-10-06', acknowledgements: stale });
    expect((await backend.status()).route).toMatchObject({ acknowledgements: { complete: false } });
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
    expect(summaryOf(await backend.status())).toEqual({ state: 'off' });
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
    expect(summaryOf(await backend.status())).toEqual({ state: 'fence_held' });
    expect(await backend.abandon({ confirm: true, scope })).toEqual({ ok: true, status_message: expect.stringContaining('abandoned') });
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { fences?: unknown; abandonedFences?: Record<string, { abandonedAt: string }> };
    expect(state.fences).toBeUndefined();
    expect(state.abandonedFences?.[scope]?.abandonedAt).toBe('2026-10-07T12:00:00.000Z');
    expect(summaryOf(await backend.status())).toEqual({ state: 'off' });
  });
});

describe('who writes the question (owner decision 2026-10-10)', () => {
  const REPORT = {
    level: 'unnamed' as const, cases: 1, written: 1, declined: 0, failed: 0, gatePassed: 1, gateRefused: 0, canaryLeaks: [], documentQuestions: [],
    results: [{ id: 'loi-notary-present', outcome: 'questions' as const, questions: ['Does a non binding letter of intent for a shop lease in Spain need a notary?'], gate: 'pass' as const, gateReasons: [], canaryLeak: false, asksAboutDocuments: false }],
  };

  test('saving a model of the owner\'s own (a LAN address is accepted) and the ChatGPT model; the switch and the level keep them; clearing goes back to the built-in model', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    const saved = await backend.saveWriter({ revision: 0, writer: { base_url: 'http://192.168.1.20:8080/v1', model: 'qwen3-32b', secret_ref: 'env:HOME_MODEL_KEY' }, chatgpt_frontier_model: 'anthropic/some-model' });
    expect(saved).toMatchObject({ ok: true, revision: 1 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { writer: { baseUrl: 'http://192.168.1.20:8080/v1', model: 'qwen3-32b', secretRef: 'env:HOME_MODEL_KEY' }, chatgptFrontierModel: 'anthropic/some-model' } });
    // Turning on and choosing a level carry the choices through.
    expect(await backend.setEnabled({ enabled: true, revision: 1, languages: ['en'] })).toMatchObject({ ok: true, revision: 2 });
    expect(await backend.setEnabled({ enabled: true, revision: 2, level: 'general' })).toMatchObject({ ok: true, revision: 3 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { enabled: true, level: 'general', writer: { model: 'qwen3-32b' }, chatgptFrontierModel: 'anthropic/some-model' } });
    const status = await backend.status();
    expect(status.writer).toMatchObject({ choice: { model: 'qwen3-32b', secretRef: 'env:HOME_MODEL_KEY', keyPresent: false }, chatgptFrontierModel: 'anthropic/some-model', effectiveChatgptModel: 'anthropic/some-model', effectiveClaudeModel: CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT });
    expect(await backend.saveWriter({ revision: 3, writer: null })).toMatchObject({ ok: true, revision: 4 });
    const cleared = readConsultSettings({ env });
    expect(cleared.state === 'valid' && cleared.settings.writer).toBeUndefined();
    expect(cleared.state === 'valid' && cleared.settings.chatgptFrontierModel).toBe('anthropic/some-model');
    // Not a URL, a stale revision: refused, nothing written.
    expect(await backend.saveWriter({ revision: 4, writer: { base_url: 'ftp://x', model: 'm' } })).toMatchObject({ ok: false, code: 'writer_invalid' });
    expect(await backend.saveWriter({ revision: 1, writer: { base_url: 'http://127.0.0.1:11434/v1', model: 'm' } })).toMatchObject({ ok: false, code: 'conflict' });
  });

  test('the test runs only on the click, needs a chosen model, reports progress and its result, and is never started by status', async () => {
    const home = tempHome();
    let runs = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const { backend } = adapter({ home, writerCheck: async ({ onCase }) => { runs += 1; onCase(REPORT.results[0]!, 0, 1); await gate; return REPORT; } });
    await backend.status();
    expect(runs).toBe(0);
    expect(await backend.testWriter({ confirm: true })).toMatchObject({ ok: false, code: 'writer_not_chosen' });
    await backend.saveWriter({ revision: 0, writer: { base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.3:70b' } });
    expect(await backend.testWriter({})).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(await backend.testWriter({ confirm: true })).toMatchObject({ ok: true });
    expect(await backend.testWriter({ confirm: true })).toMatchObject({ ok: false, code: 'writer_test_running' });
    expect((await backend.status()).writer?.check).toEqual({ state: 'running', done: 1, total: 1 });
    finish();
    await Bun.sleep(5);
    const done = (await backend.status()).writer?.check;
    expect(done).toMatchObject({ state: 'done', report: REPORT });
    expect(runs).toBe(1);
  });

  test('the card: the choice, no gate on the model, the OpenAI note, the test button and its result', () => {
    const html = page({
      ...status(),
      writer: { effectiveChatgptModel: 'openai/gpt-5-mini', effectiveClaudeModel: CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT, testAvailable: true, check: { state: 'done', at: '2026-10-10T12:00:00.000Z', report: REPORT } },
    });
    const text = visibleText(html);
    expect(text).toContain('For people running a strong local model at home: ask frontier models anonymously when your model needs help.');
    expect(text).toContain('paid and sent anonymously.');
    expect(text).not.toContain('identifiers removed');
    expect(text).not.toMatch(/unlinkable/i);
    expect(text).toContain('Who writes the question');
    expect(text).toContain('works best with a substantial model');
    expect(text).toContain('Now: the model built into Olympus.');
    expect(text).toContain('Questions from ChatGPT now go to openai/gpt-5-mini, an OpenAI model.');
    expect(text).toContain('Does a non binding letter of intent for a shop lease in Spain need a notary?');
    expect(text).toContain('No invented name, place or figure got past the privacy check.');
    expect(html).toContain('data-outside-form="writer"');
    expect(html).toContain('data-outside-form="writer-test"');
    expect(html).toContain('/dashboard/consult/writer/test');
    // Not an OpenAI model: no note.
    const other = page({ ...status(), writer: { chatgptFrontierModel: 'anthropic/some-model', effectiveChatgptModel: 'anthropic/some-model', testAvailable: true, check: { state: 'idle' } } });
    expect(other).not.toContain('data-outside-writer-openai');
  });

  test('the card: the zkAPI model for questions from Claude sits next to the ChatGPT one, with the mirror warning for an Anthropic model', () => {
    const html = page({ ...status(), writer: { effectiveChatgptModel: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT, effectiveClaudeModel: CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT, testAvailable: true, check: { state: 'idle' } } });
    const text = visibleText(html);
    expect(text).toContain('zkAPI model for questions from ChatGPT');
    expect(text).toContain('zkAPI model for questions from Claude (Claude Code, Claude Desktop)');
    expect(text).toContain(W.writer.claudeFrontierHint);
    expect(html).toContain('name="claude_frontier_model"');
    expect(html).toContain(`placeholder="${CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT}"`);
    // The default (an OpenAI model) gets no Anthropic warning.
    expect(html).not.toContain('data-outside-writer-anthropic');
    const anthropic = page({ ...status(), writer: { claudeFrontierModel: 'Anthropic/claude-opus-5.5', effectiveClaudeModel: 'Anthropic/claude-opus-5.5', testAvailable: true, check: { state: 'idle' } } });
    expect(anthropic).toContain('data-outside-writer-anthropic');
    expect(anthropic).toContain('value="Anthropic/claude-opus-5.5"');
    expect(visibleText(anthropic)).toContain('Questions from Claude now go to Anthropic/claude-opus-5.5, an Anthropic model.');
  });

  test('saving only the zkAPI models keeps the built-in writer; both are validated; empty clears', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    expect(await backend.saveWriter({ revision: 0, chatgpt_frontier_model: 'google/gemini-3-pro', claude_frontier_model: 'x-ai/grok-5' })).toMatchObject({ ok: true, revision: 1, status_message: 'Saved the zkAPI models.' });
    const saved = readConsultSettings({ env });
    expect(saved).toMatchObject({ state: 'valid', settings: { chatgptFrontierModel: 'google/gemini-3-pro', claudeFrontierModel: 'x-ai/grok-5' } });
    expect(saved.state === 'valid' && saved.settings.writer).toBeUndefined();
    expect((await backend.status()).writer).toMatchObject({ effectiveChatgptModel: 'google/gemini-3-pro', effectiveClaudeModel: 'x-ai/grok-5' });
    expect(await backend.saveWriter({ revision: 1, claude_frontier_model: 'not a model' })).toMatchObject({ ok: false, code: 'frontier_model_invalid' });
    expect(await backend.saveWriter({ revision: 1, chatgpt_frontier_model: null, claude_frontier_model: '' })).toMatchObject({ ok: true, revision: 2 });
    const cleared = readConsultSettings({ env });
    expect(cleared.state === 'valid' && cleared.settings.chatgptFrontierModel).toBeUndefined();
    expect(cleared.state === 'valid' && cleared.settings.claudeFrontierModel).toBeUndefined();
    expect((await backend.status()).writer).toMatchObject({ effectiveChatgptModel: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT, effectiveClaudeModel: CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT });
  });

  test('the card\'s script: with no model server named, Save posts only the two zkAPI models; a named server is posted with them', async () => {
    const html = page({ ...status(), writer: { effectiveChatgptModel: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT, effectiveClaudeModel: CONSULT_CLAUDE_FRONTIER_MODEL_DEFAULT, testAvailable: true, check: { state: 'idle' } } });
    const window = new Window({ url: 'http://127.0.0.1:8010/dashboard?outside-help' });
    const document = window.document;
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-outside-help]'))!;
    const posts: Array<{ url: string; init: { body: string } }> = [];
    const fetchStub = async (url: string, init: { body: string }) => {
      posts.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, status_message: 'saved', revision: 1 }) };
    };
    new Function('window', 'document', 'fetch', 'setTimeout', script)(
      { confirm: () => true, location: { href: 'http://127.0.0.1:8010/dashboard?outside-help', reload: () => undefined } },
      document,
      fetchStub,
      () => undefined,
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const form = document.querySelector('form[data-outside-form="writer"]')!;
    const set = (name: string, value: string) => { (form.querySelector(`input[name="${name}"]`) as unknown as { value: string }).value = value; };
    set('chatgpt_frontier_model', ' google/gemini-3-pro ');
    set('claude_frontier_model', 'x-ai/grok-5');
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    expect(posts[0]!.url).toBe(DASHBOARD_OUTSIDE_HELP_PATHS.writer);
    expect(JSON.parse(posts[0]!.init.body)).toEqual({ revision: 0, chatgpt_frontier_model: 'google/gemini-3-pro', claude_frontier_model: 'x-ai/grok-5' });
    set('writer_base_url', 'http://127.0.0.1:11434/v1');
    set('writer_model', 'llama3.3:70b');
    set('claude_frontier_model', '');
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
    // The card took the saved revision from the first answer.
    expect(JSON.parse(posts[1]!.init.body)).toEqual({
      revision: 1,
      chatgpt_frontier_model: 'google/gemini-3-pro',
      claude_frontier_model: null,
      writer: { base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.3:70b', secret_ref: '' },
    });
  });
});

describe('Standard is open (owner decision 2026-10-10)', () => {
  test('saving the mode: light cleanup by default, custom keeps its instruction verbatim, a preset drops it; the other forms carry it', async () => {
    const home = tempHome();
    const { backend, env } = adapter({ home });
    expect((await backend.status()).standard).toMatchObject({ mode: 'light_cleanup', preset: CONSULT_LIGHT_CLEANUP_INSTRUCTION });
    expect(await backend.saveStandard({ revision: 0, standard_mode: 'custom' })).toMatchObject({ ok: false, code: 'standard_invalid' });
    expect(await backend.saveStandard({ revision: 0, standard_mode: 'loud' })).toMatchObject({ ok: false, code: 'standard_invalid' });
    expect(await backend.saveStandard({ revision: 0, standard_mode: 'custom', standard_instruction: 'Ask it in French.\r\nKeep my name out.' })).toMatchObject({ ok: true, revision: 1 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { standardMode: 'custom', standardInstruction: 'Ask it in French.\nKeep my name out.' } });
    // Turning on and saving the writer keep the choice.
    expect(await backend.setEnabled({ enabled: true, revision: 1, languages: ['en'] })).toMatchObject({ ok: true, revision: 2 });
    expect(await backend.saveWriter({ revision: 2, chatgpt_frontier_model: 'anthropic/other' })).toMatchObject({ ok: true, revision: 3 });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { enabled: true, standardMode: 'custom', standardInstruction: 'Ask it in French.\nKeep my name out.' } });
    expect(await backend.saveStandard({ revision: 3, standard_mode: 'as_written' })).toMatchObject({ ok: true, revision: 4 });
    const plain = readConsultSettings({ env });
    expect(plain).toMatchObject({ state: 'valid', settings: { standardMode: 'as_written', chatgptFrontierModel: 'anthropic/other' } });
    expect(plain.state === 'valid' && plain.settings.standardInstruction).toBeUndefined();
    expect(await backend.saveStandard({ revision: 1, standard_mode: 'light_cleanup' })).toMatchObject({ ok: false, code: 'conflict' });
  });

  test('the card has no question box (retired 2026-10-10): the Standard form stays, the ask route is gone everywhere', async () => {
    const { backend } = adapter({ home: tempHome() });
    const value = await backend.status();
    expect(value).not.toHaveProperty('ask');
    expect('ask' in backend).toBe(false);
    const html = page({ ...status(), standard: value.standard! });
    expect(html).toContain('data-outside-form="standard"');
    expect(visibleText(html)).toContain(W.standard.title);
    expect(html).not.toContain('data-outside-form="ask"');
    expect(html).not.toContain('/dashboard/consult/ask');
    expect(Object.values(DASHBOARD_OUTSIDE_HELP_PATHS)).not.toContain('/dashboard/consult/ask');
    expect(DASHBOARD_CONSULT_CONTROL_PATHS).not.toContain('/dashboard/consult/ask');
    expect(V0_4_PUBLIC_DASHBOARD_ROUTES.map((route) => route.path)).not.toContain('/dashboard/consult/ask');
  });

  test('the card names the ChatGPT model problem in plain words, and the effective model defaults to Claude Sonnet', async () => {
    const { backend } = adapter({ home: tempHome(), chatgptModelProblem: () => ({ at: '2026-10-10T12:00:00.000Z', message: consultChatgptModelUnavailableMessage(CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT) }) });
    const value = await backend.status();
    expect(value.writer).toMatchObject({ effectiveChatgptModel: 'anthropic/claude-sonnet-5.5' });
    const text = visibleText(page(value));
    expect(text).toContain('Claude Sonnet isn\'t available through zkAPI right now; choose another model.');
  });
});
