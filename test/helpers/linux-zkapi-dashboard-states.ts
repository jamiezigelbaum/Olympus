import { DEFAULT_CONSULT_DOMAIN_PACKS } from '../../src/core/consult-gate.ts';
import { type DashboardOutsideHelpStatus } from '../../src/workers/dashboard/outside-help.ts';
import { renderDashboardPrivateAnswersPage } from '../../src/workers/dashboard/pages/private-answers.ts';

/** Synthetic owner-review states; no host, wallet, or account is read. */
export function linuxZkapiDashboardStates(): Record<string, string> {
  const base: DashboardOutsideHelpStatus = {
    settings: { state: 'off', revision: 0, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false, level: 'unnamed' },
    route: { state: 'not_configured', policyWritable: true }, languages: [], restartPending: false,
  };
  const states: Record<string, DashboardOutsideHelpStatus> = {
    available: base,
    unavailable: { ...base, unavailable: 'confinement_unavailable' },
  };
  for (const source of ['missing', 'outdated', 'system', 'configured'] as const) states[source] = {
    ...base, unavailable: 'confinement_unavailable', confinementInstallRequired: true,
    tools: { tools: [{ tool: 'zkapi-clientd', label: 'zkAPI', source, offered: true, installedVersion: '0.1.6-olympus3', version: '0.1.6-olympus4' }], install: { state: 'idle' } },
  };
  return Object.fromEntries(Object.entries(states).map(([id, outsideHelp]) => [id, renderDashboardPrivateAnswersPage({ now: new Date('2026-10-13T12:00:00.000Z'), controlSessionCsrfToken: 'review-csrf', outsideHelpLocalSession: true, outsideHelp })]));
}
