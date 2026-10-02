import { SENSITIVITY_TIER_LABELS } from '../../../core/privacy-language.ts';
/**
 * Sensitivity: what is private for the owner, and the tier table that says
 * which models may read which tier.
 *
 * What is private is the owner's privacy profile, the one ChatGPT and the
 * local Privacy editor both edit (holistic review 2026-10-02, item 11): this
 * page shows its summary and links to the editor, so the two surfaces can no
 * longer describe different configurations. The older sensitivity map file
 * still feeds classification, so its categories stay visible, behind a
 * disclosure, as what they are: rules from that file.
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
import { dashboardPrivacySection } from '../source-rows.ts';
import { DASHBOARD_SOURCE_ROWS_CSS } from '../static-styles.ts';

/** The tier names the map can target, in the words the tier table uses. */
const TIER_NAMES: Readonly<Record<string, string>> = {
  secure: SENSITIVITY_TIER_LABELS.secure,
  secrets: SENSITIVITY_TIER_LABELS.secrets,
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
    body: renderDashboardSensitivityBody(view, options),
    styles: [DASHBOARD_POLICY_CSS, DASHBOARD_SOURCE_ROWS_CSS],
    controller: { ...(options?.controlSessionCsrfToken === undefined ? {} : { csrfToken: options.controlSessionCsrfToken }) },
    // Same poll as every other page, so the header's "checked Ns ago" keeps
    // moving; the body only swaps when a source actually changes.
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
    ...(options?.format === undefined ? {} : { format: options.format }),
  });
}

/** The body without the shell, so the page's composition can be read alone. */
export function renderDashboardSensitivityBody(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  return [dashboardPrivacySection(options), renderCategories(view), renderTiers(view)]
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
  // No map is the ordinary state now that privacy lives in the profile above:
  // nothing is said, rather than a "none configured" that reads as if nothing
  // were private.
  if (categories.length === 0) return '';
  const rows = categories.map((category) =>
    categoryRow({
      name: category.label,
      interpretation: category.interpretation,
      note: categoryNote(category),
    })
  );
  return `<details class="howto" data-poll-key="sensitivity-map"><summary>`
    + `${escapeHtml(`Also private: ${dashboardCount(categories.length)} ${categories.length === 1 ? 'category' : 'categories'} from your sensitivity map file`)}`
    + `</summary><div class="quiet">These come from the sensitivity map file on this computer and still keep matching items`
    + ` private. Change them in that file; what you set in Privacy above applies as well.</div>${rows.join('\n')}</details>`;
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
 * The tiers as the owner reads them: Secrets, Private and Personal. The
 * engine's freely shareable tier is permitted exactly what Personal is, so it
 * is shown inside Personal rather than under a word of its own (holistic
 * review 2026-10-02, item 21); the stored tiers are unchanged.
 */
function displayTiers(tiers: ReturnType<typeof dashboardSensitivityTiers>): ReturnType<typeof dashboardSensitivityTiers> {
  const shareable = tiers.find((tier) => tier.name === SENSITIVITY_TIER_LABELS.public);
  const personal = tiers.find((tier) => tier.name === SENSITIVITY_TIER_LABELS.private);
  if (!shareable || !personal || shareable.local !== personal.local || shareable.venice !== personal.venice
    || shareable.frontier !== personal.frontier) {
    return tiers;
  }
  const lowest = shareable.tier_label.split(/[–-]/)[0] ?? shareable.tier_label;
  const highest = personal.tier_label.split(/[–-]/).pop() ?? personal.tier_label;
  return tiers
    .filter((tier) => tier !== shareable)
    .map((tier) => tier === personal
      ? { ...tier, tier_label: `${lowest}–${highest}`, meaning: 'Everyday mail, files and notes, and freely shareable material' }
      : tier);
}

/**
 * The tier table: three rows of policy, no counts.
 *
 * Every cell is read off the enforcement code by the data leg, so the table
 * states what the system refuses rather than what the design intends. It says
 * nothing about whether a lane is reachable — that is the answer-lane card's
 * job, and the note under the table says so.
 */
function renderTiers(view: SourceDashboardViewModel): string {
  const tiers = displayTiers(dashboardSensitivityTiers(view));
  if (tiers.length === 0) return '';
  const rows = tiers.map((tier) => `
          <tr><td class="tname">${escapeHtml(tier.name)}</td><td>${escapeHtml(tier.tier_label)}</td><td>${escapeHtml(tier.meaning)}</td>`
    + `${permissionCell(tier.local)}${permissionCell(tier.venice)}${permissionCell(tier.frontier)}</tr>`).join('');
  return `<div class="sect gap">Tiers</div>
        <p class="tiersnote">Every item is tiered as it is indexed, and the tier decides which models may read it.`
    + ` What you mark private raises items into Private; detected secrets are refused before their content is stored.</p>
        <table>
          <tr><th>Tier</th><th></th><th>What it means</th><th>Local models</th><th>Venice</th><th>Frontier cloud</th></tr>${rows}
        </table>
        <div class="quiet after">These columns are what the policy permits, not what is connected:`
    + ` a model still has to be set up before it can answer.</div>`;
}
