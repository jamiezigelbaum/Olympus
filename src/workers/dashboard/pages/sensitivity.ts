/**
 * Sensitivity: the categories the owner named as secure, and the tier table
 * that says which models may read which tier.
 *
 * Read-only, all of it. The mockup's remove buttons, the "describe what should
 * stay secure" field and the tiering-guidance field are absent because no write
 * route exists for any of them — the sensitivity map is a file the owner edits,
 * and a control that cannot do what it says is worse than an honest list. The
 * per-category "added Aug 12", the "preset: local-first" header and the removal
 * confirmation sheet are absent because no timestamp, no preset and no
 * migration preview exist anywhere upstream.
 *
 * The categories carry a COUNT of match terms and never the terms: those are
 * the owner's real sender addresses and folder paths, and this page is
 * reachable with the weak dash_ query token. The tier table carries no item
 * counts at all, because no cheap aggregate over items.trust_tier exists.
 */
import type {
  DashboardSensitivityCategory,
  SourceDashboardViewModel,
} from '../../source-dashboard.ts';
import {
  DASHBOARD_POLICY_CSS,
  categoryRow,
  escapeHtml,
  pageShell,
  permissionCell,
} from '../components.ts';
import { dashboardSensitivityCategories, dashboardSensitivityTiers } from '../contract.ts';
import { dashboardCheckedLabel, dashboardCount } from '../vocabulary.ts';
import type { DashboardPageOptions } from './home.ts';

/** The tier names the map can target, in the words the tier table uses. */
const TIER_NAMES: Readonly<Record<string, string>> = {
  secure: 'Secure',
  secrets: 'Secrets',
};

export function renderDashboardSensitivityPage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const now = options?.now ?? new Date();
  // No status word: this page describes policy, and policy is not Fresh or
  // Working. The header states only when the page was built.
  const checked = dashboardCheckedLabel(view.generated_at, now);
  return pageShell({
    title: 'Olympus',
    crumb: 'Sensitivity',
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    meta: checked,
    body: renderDashboardSensitivityBody(view),
    styles: [DASHBOARD_POLICY_CSS],
    // Same poll as every other page, so the header's "checked Ns ago" keeps
    // moving; the body only swaps when a source actually changes.
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
  });
}

/** The body without the shell, so the page's composition can be read alone. */
export function renderDashboardSensitivityBody(view: SourceDashboardViewModel): string {
  return [renderCategories(view), renderTiers(view)]
    .filter((section) => section.length > 0)
    .join('\n');
}

/**
 * The categories block. With no map — the ordinary state on a machine that has
 * never written one — this is a heading and one plain sentence, never an
 * invented Financial/Health/Family list.
 */
function renderCategories(view: SourceDashboardViewModel): string {
  const categories = dashboardSensitivityCategories(view);
  const head = [
    '<div class="sect">Secure categories</div>',
    '<div class="quiet">What you name here never reaches a frontier cloud model —'
    + ' everything else is tiered automatically.</div>',
  ].join('\n');
  if (categories.length === 0) {
    return `${head}\n<div class="foot">No secure categories are configured.</div>`;
  }
  const rows = categories.map((category) =>
    categoryRow({
      name: category.label,
      interpretation: category.interpretation,
      note: categoryNote(category),
    })
  );
  return [head, ...rows].join('\n');
}

/**
 * The quiet right-hand fact: which tier this category raises into, and how many
 * terms it matches on. The terms themselves stay in the map file.
 */
function categoryNote(category: DashboardSensitivityCategory): string {
  const name = TIER_NAMES[category.target_tier_name] ?? category.target_tier_name;
  const tier = category.target_trust_tier;
  const head = [name, tier === '' ? '' : `(${tier})`].filter((part) => part !== '').join(' ');
  if (category.match_terms <= 0) return head;
  const terms = `${dashboardCount(category.match_terms)} match ${category.match_terms === 1 ? 'term' : 'terms'}`;
  return head === '' ? terms : `${head} · ${terms}`;
}

/**
 * The tier table: four rows of policy, no counts.
 *
 * Every cell is read off the enforcement code by the data leg, so the table
 * states what the system refuses rather than what the design intends. It says
 * nothing about whether a lane is reachable — that is the answer-lane card's
 * job, and the note under the table says so.
 */
function renderTiers(view: SourceDashboardViewModel): string {
  const tiers = dashboardSensitivityTiers(view);
  if (tiers.length === 0) return '';
  const rows = tiers.map((tier) => `
          <tr><td class="tname">${escapeHtml(tier.name)}</td><td>${escapeHtml(tier.tier_label)}</td><td>${escapeHtml(tier.meaning)}</td>`
    + `${permissionCell(tier.local)}${permissionCell(tier.venice)}${permissionCell(tier.frontier)}</tr>`).join('');
  return `<div class="sect gap">Tiers</div>
        <p class="tiersnote">Every item is tiered as it is indexed, and the tier decides which models may read it.`
    + ` Your secure categories raise items into Secure; detected secrets are refused before their content is stored.</p>
        <table>
          <tr><th>Tier</th><th></th><th>What it means</th><th>Local models</th><th>Venice</th><th>Frontier cloud</th></tr>${rows}
        </table>
        <div class="quiet after">These columns are what the policy permits, not what is connected:`
    + ` a lane still has to be configured before it can answer.</div>`;
}
