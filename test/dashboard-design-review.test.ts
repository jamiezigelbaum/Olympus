import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');

test('dashboard implementation is guarded and visual approval cannot survive changed pixels', () => {
  const receipt = JSON.parse(readFileSync(join(ROOT, 'config/dashboard-design-review.json'), 'utf8')) as {
    kind: string;
    schema_version: number;
    status: string;
    approved_on: string;
    review_method: string;
    reviewed_commit: string;
    reviewed_visual_paths: string[];
    reviewed_visual_files_sha256: string;
    implementation_guard_paths: string[];
    implementation_guard_sha256: string;
    pending_review?: { requested_on: string; reason: string };
    reviewed_states: Array<{ id: string; rendered_html_sha256: string; approved_by?: string; approved_on?: string; approval?: string; screenshot_commit?: string }>;
    decisions: string[];
    content_free: boolean;
  };
  expect(receipt).toEqual({
    kind: 'olympus_dashboard_design_review',
    schema_version: 1,
    status: 'pending_owner_acceptance',
    approved_on: '2026-09-02',
    review_method: 'dialogic_owner_review_in_app_browser',
    reviewed_commit: 'b0211134136365582bfdec946f8683f5cad7903b',
    reviewed_visual_paths: [
      'scripts/control-ui-preview.ts',
      'scripts/dashboard-preview.ts',
      'src/control-ui',
      'src/control-ui.ts',
      'src/workers/dashboard',
      'src/workers/source-dashboard.ts',
      'src/workers/source-dispositions.ts',
    ],
    reviewed_visual_files_sha256: '7e3b66e05ea628fa30a43f193dcf0df44e1929ae7378a9407fb0f7f5cda8664c',
    implementation_guard_paths: [
      'INSTALL_FOR_AGENTS.md',
      'README.md',
      'dist/cli.js',
      'dist/control-ui',
      'dist/index.js',
      'docs/QUICKSTART.md',
      'docs/V0_4_RELEASE.md',
      'openclaw.plugin.json',
      'package.json',
      'scripts/control-ui-preview.ts',
      'scripts/dashboard-preview.ts',
      'scripts/release-artifact-ci.ts',
      'scripts/release-artifact.ts',
      'src/cli.ts',
      'src/control-ui',
      'src/control-ui-contract.ts',
      'src/control-ui.ts',
      'src/core/control-ui-gateway.ts',
      'src/core/google-pilot-client.ts',
      'src/core/setup.ts',
      'src/native-plugin.ts',
      'src/workers/dashboard',
      'src/workers/email-source/index.ts',
      'src/workers/http.ts',
      'src/workers/source-dashboard.ts',
      'src/workers/source-dispositions.ts',
      'src/workers/source-ingestion-ledger.ts',
    ],
    implementation_guard_sha256: '8be347ba55a24ef998cdb9e3f0c7aef28249a88d920fb75f5f956d7de4db5ef8',
    pending_review: {
      requested_on: '2026-09-02',
      reason: 'The persistent In Olympus totals line and the current-pass bars with a real batch denominator (owner decision, 2026-09-02) changed the source page, and Unpair adds a paired-session custody control to the setup rows plus new not-connected unpaired, Unpair-incomplete and unpair-state-unreadable card states, so the reviewed states await owner acceptance. A source reconnected since the last nightly probe no longer renders as a reconnect demand, and the OAuth landing pages now point back at the dashboard tab the flow started in (owner-reported, 2026-09-04), which changes those states again. The second clean-install rehearsal (2026-09-05) then changed the unconnected-source states again: every not-connected card reads one readiness, a never-run source says it is waiting for the first sync, a publisher setup sheet leads from the one-click sentence the action itself carries, and the worker-token gate names the plugin bin path. The native OpenClaw pages, their shared browser controls, and the retained standalone interface now await owner acceptance for the integrated layout. The 2026-09-10 consent repair reuses the Finder-style tree and three-state inspector, adds explicit folder browsing before indexing, starts with no folders selected, and requires a separate whole-account confirmation. Source cards expose Choose folders before the first sync; pending scopes and bounded metadata passes no longer imply active extraction or a complete traversal. These changed states await owner acceptance. The picker navigation repair restores dashboard and source return links, opens the requested provider, and shows both file providers in Locations without stacking two visible pickers. Setup cards link through to their source pages. The September 13 Dropbox repair shows scoped file counts and policy deferrals, marks completed metadata with its next check, sorts folder siblings alphabetically, and removes disconnected providers from Locations. The standalone opening-link handoff replaces the normal worker-token prompt and moves manual entry into an advanced disclosure; these changed states await owner acceptance. Opening Choose folders now loads the visible connected source automatically, shows loading beside Folders and Update, and fills folder pages across mixed provider results; these states await owner acceptance. Tier labels now read Public, Personal, Private, and Secrets, with updated setup option names; these wording changes await owner acceptance. Setup now places model key entry and existing-local-model readiness above gated source connections, and accepted connections update their controls immediately; these states await owner acceptance. Gmail now waits for a connect-time mail scope: the Choose mail picker (full-content window, categories, labels, sender rules and an estimate) and the waiting-for-mail-selection card, Setup and source states await owner acceptance. The Sensitivity section of a source page now also shows Secrets as a location count, items pending classification, superseded chunks kept hidden, and the tier migration state with its approval ledger entry; these states await owner acceptance. The Models cards now share one compact layout on the native Control UI page and the standalone Setup page (owner-reported, 2026-09-24): name and state on one line, the key field, Connect and the Get-a-key link on one wrapping row, and Connect existing local models beside Check readiness; this Models row layout awaits owner acceptance. Setup sheets now open one at a time on both surfaces (owner-reported, 2026-09-24): opening a Connect or Set up sheet closes any other open sheet and moves focus into it; this sheet behaviour awaits owner acceptance. The native OpenClaw Setup page now offers the same publisher one-click Connect for Gmail, Google Drive and Dropbox as the standalone dashboard, with bring-your-own kept in its disclosure, including on a loopback Gateway with no gateway.publicOrigin; these native states await owner acceptance. Source attention now reads one way on home, the page header and the source page (owner-reported, 2026-09-24): a sync task that failed once is a booked retry and stays Working with no banner, the background syncs line says retrying rather than failing, and only a sync that keeps failing (three failures in a row, or one credential failure other than refresh or session contention) puts the source under Needs you together with a new sync-failing banner that names the last condition and offers Sync now, and the background page lists it as needing you. A keyword-only source\'s In Olympus line now reads Embedded not needed beside its Embedding row, its missing chunks no longer count as an embedding backlog, and the Added to Olympus counts use the source\'s own noun instead of files, with Readwise counted in items; these states await owner acceptance. Readwise now answers with hybrid search in both tiers (owner decision, 2026-09-24), so its source page shows a measured Embedding row and embedding backlog instead of Not needed, and its embedding task appears beside the pull and reconcile in the background syncs; these Readwise states await owner acceptance.',
    },
    reviewed_states: [
      {
        id: 'home',
        rendered_html_sha256: '5d077aa91d7988db152c24fc94fa0d9ce9e4615568583d39e38a8404cbd8092d',
      },
      {
        id: 'setup',
        rendered_html_sha256: 'ffe46deb252cacdf4cf0e46260d87002492768aef39a85dde1451ccc02672653',
      },
      {
        id: 'gmail_detail',
        rendered_html_sha256: '9477a7535e9e12555afaa73df6a2ee417dab8b1179536b6f14ab7557ca3f36ef',
      },
      {
        id: 'google_drive_stalled',
        rendered_html_sha256: '1a3bad510c2226d252538c8e6e7bb6b7698dfa3d452000d21fe6645fee703c89',
      },
      {
        id: 'dropbox_initial_ingestion',
        rendered_html_sha256: '160a5278f84cfd4241327a2f84781ab8de2ab34a5e9c996aa2898d44bb4e0ce8',
      },
      {
        id: 'dropbox_incremental_update',
        rendered_html_sha256: '108a302ae2fd78eac3094f81e1b25084542cc55dfee375041547cd4454809878',
      },
      {
        id: 'background',
        rendered_html_sha256: '8f6bf5a1acae2c0efe00defe193cf07b6c9b024348806590f573414514b4c7d3',
      },
      {
        // Owner visual approval of Setup's Agents section only (the remote-access
        // row, Connect an agent and the connected-agents list), from the
        // screenshots on codex/hosted-onboarding-screenshots at d87036a6. The
        // digest is renderDashboardAgentsSection over the preview fixture
        // (previewAgentsView(null), DASHBOARD_PREVIEW_NOW) that produced them.
        id: 'setup_agents',
        rendered_html_sha256: '1e60215994ad182b6d186a8677b7630b5acfc8fef3cd8353f10a1d64d6c04c0f',
        approved_by: 'jamie',
        approved_on: '2026-09-24',
        approval: 'In chat: I saw one agent section screenshot, and it looked great. Approved.',
        screenshot_commit: 'd87036a66980b177f5cdd971848bfbaa940e0af1',
      },
    ],
    decisions: [
      'persistent_dashboard_navigation',
      'ready_source_count_without_denominator',
      'agent_wording_without_ai_qualifier',
      'shared_google_client_normal_path',
      'sequential_ingestion_phase_motion',
      'incremental_updates_preserve_existing_readiness',
      'selection_counts_only_metadata_and_full_ingestion',
      'finder_style_scope_picker',
      'full_ingestion_default_with_nearest_ancestor_inheritance',
      'three_uniform_bars_in_correct_units',
      'embedding_measured_in_items_never_ahead_of_extraction',
      'per_row_done_working_stalled_waiting',
      'token_gate_on_setup_only',
      'persistent_unlock_fixed_thirty_days_with_lock',
      'inline_reauthentication_and_setup_on_home',
      'setup_page_crumb',
    ],
    content_free: true,
  });
  expect(receipt.implementation_guard_sha256).toBe(filesDigest(receipt.implementation_guard_paths));
  const currentVisualDigest = filesDigest(receipt.reviewed_visual_paths);
  if (receipt.status === 'approved') {
    expect(receipt.reviewed_visual_files_sha256).toBe(currentVisualDigest);
  } else {
    expect(receipt.status).toBe('pending_owner_acceptance');
    expect(receipt.reviewed_visual_files_sha256).not.toBe(currentVisualDigest);
    expect(receipt.pending_review?.reason).toContain('await owner acceptance');
  }
}, 30_000);

test('the owner-approved Agents section still renders exactly what was approved', async () => {
  const receipt = JSON.parse(readFileSync(join(ROOT, 'config/dashboard-design-review.json'), 'utf8')) as {
    reviewed_states: Array<{ id: string; rendered_html_sha256: string }>;
  };
  const approved = receipt.reviewed_states.find((state) => state.id === 'setup_agents')!;
  const { renderDashboardAgentsSection } = await import('../src/workers/dashboard/agents.ts');
  const { previewAgentsView, DASHBOARD_PREVIEW_NOW } = await import('../scripts/dashboard-preview.ts');
  const html = renderDashboardAgentsSection({ view: previewAgentsView(null), now: DASHBOARD_PREVIEW_NOW });
  // A change here is a new visual state: it needs the owner's approval again.
  expect(createHash('sha256').update(html).digest('hex')).toBe(approved.rendered_html_sha256);
});

function filesDigest(paths: string[]): string {
  const files = paths.flatMap((path) => allFiles(join(ROOT, path)))
    .map((path) => path.slice(ROOT.length + 1))
    .sort();
  const digest = createHash('sha256');
  for (const path of files) {
    const fileDigest = createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
    digest.update(path).update('\0').update(fileDigest).update('\n');
  }
  return digest.digest('hex');
}

function allFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => allFiles(join(path, entry)));
}
