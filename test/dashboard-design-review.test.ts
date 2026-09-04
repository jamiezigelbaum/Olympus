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
    reviewed_states: Array<{ id: string; rendered_html_sha256: string }>;
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
      'scripts/dashboard-preview.ts',
      'src/workers/dashboard',
      'src/workers/source-dashboard.ts',
      'src/workers/source-dispositions.ts',
    ],
    reviewed_visual_files_sha256: '7e3b66e05ea628fa30a43f193dcf0df44e1929ae7378a9407fb0f7f5cda8664c',
    implementation_guard_paths: [
      'INSTALL_FOR_AGENTS.md',
      'README.md',
      'dist/cli.js',
      'dist/index.js',
      'docs/QUICKSTART.md',
      'docs/V0_4_RELEASE.md',
      'scripts/dashboard-preview.ts',
      'scripts/release-artifact.ts',
      'scripts/release-artifact-ci.ts',
      'src/cli.ts',
      'src/core/google-pilot-client.ts',
      'src/workers/dashboard',
      'src/workers/email-source/index.ts',
      'src/workers/http.ts',
      'src/workers/source-dashboard.ts',
      'src/workers/source-dispositions.ts',
      'src/workers/source-ingestion-ledger.ts',
    ],
    implementation_guard_sha256: '242de01a4b824cf2e79673e65519b91e424aec88454b1a732ed89ad2a8059116',
    pending_review: {
      requested_on: '2026-09-02',
      reason: 'The persistent In Olympus totals line and the current-pass bars with a real batch denominator (owner decision, 2026-09-02) changed the source page, and Unpair adds a paired-session custody control to the setup rows plus new not-connected unpaired, Unpair-incomplete and unpair-state-unreadable card states, so the reviewed states await owner acceptance. A source reconnected since the last nightly probe no longer renders as a reconnect demand, and the OAuth landing pages now point back at the dashboard tab the flow started in (owner-reported, 2026-09-04), which changes those states again.',
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
