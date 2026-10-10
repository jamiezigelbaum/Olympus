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
    design_review: { id: string; approved_by: string; approved_on: string; approval: string; covers: string[]; decisions: string[] };
    reviewed_states: Array<{
      id: string;
      rendered_html_sha256: string;
      approved_by?: string;
      approved_on?: string;
      approval?: string;
      screenshot_commit?: string;
      rendered_from_commit?: string;
      prior_approval?: { rendered_html_sha256: string; approved_on: string; approval: string; screenshot_commit: string; rendered_from_commit: string };
      pending_review?: { requested_on: string; reason: string; candidate_rendered_html_sha256: string };
    }>;
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
      'src/control-ui',
      'src/control-ui.ts',
      'src/workers/dashboard',
      'src/workers/source-dashboard.ts',
      'src/workers/source-dispositions.ts',
    ],
    reviewed_visual_files_sha256: '7e3b66e05ea628fa30a43f193dcf0df44e1929ae7378a9407fb0f7f5cda8664c',
    implementation_guard_paths: [
      'dist/control-ui',
      'scripts/dashboard-preview.ts',
      'src/control-ui',
      'src/control-ui-contract.ts',
      'src/control-ui.ts',
      'src/core/control-ui-gateway.ts',
      'src/workers/dashboard',
      'src/workers/email-source/dashboard-panel-tools.ts',
      'src/workers/source-dashboard.ts',
      'src/workers/source-dispositions.ts',
    ],
    implementation_guard_sha256: '1486296f60c349d74c4e02fa0cb18023d8700f665f78dc4ee86155c69109585f',
    pending_review: {
      requested_on: '2026-09-02',
      reason: 'The persistent In Olympus totals line and the current-pass bars with a real batch denominator (owner decision, 2026-09-02) changed the source page, and Unpair adds a paired-session custody control to the setup rows plus new not-connected unpaired, Unpair-incomplete and unpair-state-unreadable card states, so the reviewed states await owner acceptance. A source reconnected since the last nightly probe no longer renders as a reconnect demand, and the OAuth landing pages now point back at the dashboard tab the flow started in (owner-reported, 2026-09-04), which changes those states again. The second clean-install rehearsal (2026-09-05) then changed the unconnected-source states again: every not-connected card reads one readiness, a never-run source says it is waiting for the first sync, a publisher setup sheet leads from the one-click sentence the action itself carries, and the worker-token gate names the plugin bin path. The native OpenClaw pages, their shared browser controls, and the retained standalone interface now await owner acceptance for the integrated layout. The 2026-09-10 consent repair reuses the Finder-style tree and three-state inspector, adds explicit folder browsing before indexing, starts with no folders selected, and requires a separate whole-account confirmation. Source cards expose Choose folders before the first sync; pending scopes and bounded metadata passes no longer imply active extraction or a complete traversal. These changed states await owner acceptance. The picker navigation repair restores dashboard and source return links, opens the requested provider, and shows both file providers in Locations without stacking two visible pickers. Setup cards link through to their source pages. The September 13 Dropbox repair shows scoped file counts and policy deferrals, marks completed metadata with its next check, sorts folder siblings alphabetically, and removes disconnected providers from Locations. The standalone opening-link handoff replaces the normal worker-token prompt and moves manual entry into an advanced disclosure; these changed states await owner acceptance. Opening Choose folders now loads the visible connected source automatically, shows loading beside Folders and Update, and fills folder pages across mixed provider results; these states await owner acceptance. Tier labels now read Public, Personal, Private, and Secrets, with updated setup option names; these wording changes await owner acceptance. Setup now places model key entry and existing-local-model readiness above gated source connections, and accepted connections update their controls immediately; these states await owner acceptance. Gmail now waits for a connect-time mail scope: the Choose mail picker (full-content window, categories, labels, sender rules and an estimate) and the waiting-for-mail-selection card, Setup and source states await owner acceptance. The Sensitivity section of a source page now also shows Secrets as a location count, items pending classification, superseded chunks kept hidden, and the tier migration state with its approval ledger entry; these states await owner acceptance. The Models cards now share one compact layout on the native Control UI page and the standalone Setup page (owner-reported, 2026-09-24): name and state on one line, the key field, Connect and the Get-a-key link on one wrapping row, and Connect existing local models beside Check readiness; this Models row layout awaits owner acceptance. Setup sheets now open one at a time on both surfaces (owner-reported, 2026-09-24): opening a Connect or Set up sheet closes any other open sheet and moves focus into it; this sheet behaviour awaits owner acceptance. The native OpenClaw Setup page now offers the same publisher one-click Connect for Gmail, Google Drive and Dropbox as the standalone dashboard, with bring-your-own kept in its disclosure, including on a loopback Gateway with no gateway.publicOrigin; these native states await owner acceptance. Source attention now reads one way on home, the page header and the source page (owner-reported, 2026-09-24): a sync task that failed once is a booked retry and stays Working with no banner, the background syncs line says retrying rather than failing, and only a sync that keeps failing (three failures in a row, or one credential failure other than refresh or session contention) puts the source under Needs you together with a new sync-failing banner that names the last condition and offers Sync now, and the background page lists it as needing you. A keyword-only source\'s In Olympus line now reads Embedded not needed beside its Embedding row, its missing chunks no longer count as an embedding backlog, and the Added to Olympus counts use the source\'s own noun instead of files, with Readwise counted in items; these states await owner acceptance. Readwise now answers with hybrid search in both tiers (owner decision, 2026-09-24), so its source page shows a measured Embedding row and embedding backlog instead of Not needed, and its embedding task appears beside the pull and reconcile in the background syncs; these Readwise states await owner acceptance. While an embedding provider does not answer, a source\'s syncs and its embedding sweep now read degraded (embedding provider unavailable) on the Background page and the source page; these states await owner acceptance. A hybrid-served source page now states how many chunks wait for embedding with an estimated token count and cost, and a source whose embedding skipped failing items reads degraded (embedding items failed); these states await owner acceptance. Setup\'s Agents section, with Turn on and Turn off remote access, the Let\'s Encrypt agreement panel, and the relay-unavailable, awaiting-agreement and worker.env states, was approved by Jamie on 2026-09-30, and its when-to-ask instructions that tell an agent to collect a slow answer with source_answer_result on 2026-10-01; the Agents section no longer awaits owner acceptance. Release 1 of the 2026-10-01 dashboard UX review (Clarity) rewords every owner-facing status in plain words (signed out with Reconnect, paused with its reason, Indexing with percent done and an estimate only from a measured rate), gives every problem row one fix button, puts one blocker banner at the top of Setup while models are not ready with every blocked connect control disabled and its reason beside it, translates provider refusals into one sentence with How to fix, moves the Background page\'s lanes, tiles and notes behind Details, and checks local models automatically (Checking…); these Home, Background and Setup states await owner acceptance. Release 3 of the 2026-10-01 dashboard UX review (the local dashboard\'s visual pass) raises every text and control colour to WCAG AA, uses one five-size type scale with sentence-case section headings, tints warnings and errors with an icon instead of a faint border, keeps one filled button per row with Disconnect, Unpair, Provider access, Cancel and Replace key behind a ⋯ menu, removes the card around the page, labels progress bars with their percent, opens panels directly under their row, puts setup instructions behind How to set this up with the key caveat first, and shows Mixed, Names only and a consequence footer in the folder picker; these states await owner acceptance. The 2026-10-02 port of the ChatGPT dashboard\'s rules to the local pages (Home, Setup, Background, Sensitivity and a new Privacy editor) shows each source once, as a row with its one outlined fix and the ones that need the owner first; paints in progress yellow and needs you orange, in a new light theme beside the dark one; holds every status word to the progress bar through the derivation the ChatGPT dashboard uses; says Finish signing in with Open sign-in again; collapses Models to one line with its install bars; adds the Privacy row and editor; and replaces the older scope and tier words; these states await owner acceptance. The 2026-10-07 Outside help card (stage C5 of the frontier consult design; owner-approved as C5 scope on 2026-10-07) adds a Setup row and a Mac-only page with the cost and risk disclosure, the zkAPI route readiness and setup steps, the eight acknowledgements, language choice, the on/off switch, and Recover and Abandon for a held request; these states await owner acceptance. The 2026-10-07 Outside help redesign (owner-requested) leads with one status block (the switch, route health in one line, and the usage for the day with the $6 said as a hold), lists each problem once with its fix, shows three short lines before turning on with the full statements behind a disclosure, collapses accepted acknowledgements to one line with Review, and puts languages, balance and limits (with a one-click No daily limit), setup steps and technical details in sections that stay collapsed unless they need attention; these states await owner acceptance. The owner\'s follow-up the same day rewords the card in plain language (what outside help is and a plain privacy line first, real cost before the $6 hold, questions counted against limits rather than spent), hides Before you turn this on once outside help is on, and keeps the technical names in Details, Everything to know first and Set up zkAPI; these states await owner acceptance. The owner then named the feature (2026-10-07): Setup\'s section reads Private answers with the row Anonymous answers (zkAPI), the card is Anonymous answers · zkAPI with the approved opening explanation, and the ChatGPT panel\'s appended block is labelled Anonymous answer · zkAPI with its question under What Olympus asked; these states await owner acceptance. The owner approved the zkAPI send levels (2026-10-07, mockup): the card adds What may zkAPI send? with Your situation, without names (recommended) and General questions only (strict), and a ninth acknowledgement stating what the first sends; the panel shows the exact question sent above the reply, under Sent without names or What Olympus asked; these states await owner acceptance. The Models row now also shows the built-in transcription model (owner-requested, 2026-10-08): Transcription with Not needed: no audio in your chosen folders, Not downloaded, or Download stopped before it finished, each with a Download now button, Getting ready with its download line and bar only while the engine is downloading, Needs you with Download now when its download failed, Couldn\'t start the transcription model with Try again, or Ready; these states await owner acceptance. The owner\'s 2026-10-08 feedback names the send levels Standard (recommended) and Strict, makes Standard the default and always selectable with its statements shown inline and one Accept and save while they are not accepted, shows the server\'s own words on every failed save, says Paused until the updated statements are accepted, and replaces the cost and risk statements with six calmer ones (version 5); these states await owner acceptance. The 2026-10-08 honest-status pass (owner-approved Phase 1 of the dashboard parity proposal) adds the can\'t-be-read clause to a healthy source\'s row (synced 41m ago · 2 files can\'t be read), says paused only of a lane Olympus parked, finishes the Extraction and Embedding rows when every in-scope file is read or can\'t be read (Done · 252 read · 2 can\'t be read) with one plain reason sentence under the bars, re-alarms as many files can\'t be read past five percent, and gives Sync now a Checking Dropbox… wait and a kept result line (Checked just now — no new files); these states await owner acceptance. The 2026-10-09 unified-dashboard Phase 1 (design signed off by Jamie on 2026-10-09) moves the transcription row into the shared view model the local Models row now reads, and rewords every owner-facing Mac as computer, with the help page moved to /help/on-your-computer/ (the old address redirects); these states await owner acceptance. The 2026-10-09 unified-dashboard Phase 4 (design signed off by Jamie on 2026-10-09 on the unified dashboard review page) makes the ChatGPT panel the only dashboard: the computer\'s /dashboard frames the exact panel ChatGPT loads and answers its calls, the OpenClaw Control UI tab frames the same panel, and the old Home, Setup, source, Background, Sensitivity, Privacy and embedding-ledger pages redirect to /dashboard. On the computer the panel adds Connect that opens the local setup sheet for X bookmarks, Readwise, Telegram and WhatsApp, an enabled Change models, Index faster under Progress details while indexing runs, and an On this computer section (Keys, Agents, Outside help, Build a connector); while locked, the host page shows the Open dashboard controls banner. The rendered panel, computer host and locked computer host states await owner acceptance. The 2026-10-10 Anonymous answers card (owner decision of that day) opens with the sentence for people running a strong local model at home, adds a collapsed Who writes the question section (the built-in model or the owner\'s own model server, the zkAPI model for questions from ChatGPT with a note when it is an OpenAI model, and Test your model with its per-case results), and these states await owner acceptance. The 2026-10-10 cap accounting change rewords the Anonymous answers card\'s usage and limit lines: each question now counts against the daily limits at the amount zkAPI holds for its model ($1 to $6) instead of a flat $6, so Details reads counted against your limits, the limits field says so, and the fuller statement names the per-model amount; these wording states await owner acceptance.',
    },
    // Owner sign-off of the unified dashboard (2026-10-09): one panel on
    // ChatGPT, the computer and OpenClaw. The states it covers are rendered
    // below from this commit and await owner acceptance of those pixels.
    design_review: {
      id: 'unified_dashboard_2026_10_09',
      approved_by: 'jamie',
      approved_on: '2026-10-09',
      approval: 'Owner sign-off of the unified dashboard review page: one panel on ChatGPT, the computer and OpenClaw',
      covers: ['panel', 'computer_host', 'computer_host_locked'],
      decisions: ['one_panel_on_every_host'],
    },
    reviewed_states: [
      {
        // The panel ChatGPT loads (ui://olympus/dashboard), which the
        // computer's /dashboard and the OpenClaw tab frame unchanged.
        id: 'panel',
        rendered_html_sha256: 'e6c9d6ef3bfbf8187399fb2a8e641b864fbf6dfdc23f93d38eb548422db739b7',
      },
      {
        // The computer's /dashboard with the controls open.
        id: 'computer_host',
        rendered_html_sha256: 'eae287b3ea7524a8fab7956b6ac7d0b9b3f1b023b34ec950a70154f5901c79c9',
      },
      {
        // The same page while locked: the Open dashboard controls banner.
        id: 'computer_host_locked',
        rendered_html_sha256: 'c24bf396fdf091536c795aaaf94b34f4701879f7d0c641da6ebc41198b77c6e8',
      },
      {
        // Owner visual approval of Setup's Agents section (the remote-access
        // row with Turn on and Turn off, the agreement panel, Connect an agent
        // with its when-to-ask instructions, and the connected-agents list).
        // The digest is renderDashboardAgentsSection over the preview fixture
        // (previewAgentsView(null), DASHBOARD_PREVIEW_NOW), rendered from
        // rendered_from_commit; the screenshots Jamie viewed are on
        // codex/v05-remote-toggle-screenshots at screenshot_commit.
        id: 'setup_agents',
        rendered_html_sha256: '7453298473da4e153c9cb13936f535b728133b363619d2edf2725b40373f5e4d',
        approved_by: 'jamie',
        approved_on: '2026-10-03',
        approval: 'In chat: Approved (Agents section after the gap and outlined-button fixes)',
        screenshot_commit: 'ff46632da9fcd227270824fe4d45cbd5e2d4c6a1',
        rendered_from_commit: 'ff46632da9fcd227270824fe4d45cbd5e2d4c6a1',
        // The earlier approval (release 3 look), superseded by this one.
        prior_approval: {
          rendered_html_sha256: 'da90e0a8a1d5ba5a83de517c4d00cf224098121a5677fdd424830acc2b34244f',
          approved_on: '2026-10-01',
          approval: 'In chat: yes, re-approve the Agents section with the release 3 look',
          screenshot_commit: 'e6b8ae6461d08f845a40d367eed2b5394ba95bf5',
          rendered_from_commit: 'e6b8ae6461d08f845a40d367eed2b5394ba95bf5',
        },
      },
    ],
    decisions: [
      'ready_source_count_without_denominator',
      'agent_wording_without_ai_qualifier',
      'shared_google_client_normal_path',
      'incremental_updates_preserve_existing_readiness',
      'selection_counts_only_metadata_and_full_ingestion',
      'finder_style_scope_picker',
      'full_ingestion_default_with_nearest_ancestor_inheritance',
      'embedding_measured_in_items_never_ahead_of_extraction',
      'per_row_done_working_stalled_waiting',
      'persistent_unlock_fixed_thirty_days_with_lock',
      'inline_reauthentication_and_setup_on_home',
      'one_panel_on_every_host',
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

test('the Agents section renders what Jamie approved, or says honestly that it awaits his re-approval', async () => {
  const receipt = JSON.parse(readFileSync(join(ROOT, 'config/dashboard-design-review.json'), 'utf8')) as {
    reviewed_states: Array<{
      id: string;
      rendered_html_sha256: string;
      approved_by?: string;
      rendered_from_commit?: string;
      pending_review?: { reason: string; candidate_rendered_html_sha256: string };
    }>;
  };
  const approved = receipt.reviewed_states.find((state) => state.id === 'setup_agents')!;
  const { renderDashboardAgentsSection } = await import('../src/workers/dashboard/agents.ts');
  const { previewAgentsView, DASHBOARD_PREVIEW_NOW } = await import('../scripts/dashboard-preview.ts');
  const html = renderDashboardAgentsSection({ view: previewAgentsView(null), now: DASHBOARD_PREVIEW_NOW });
  const rendered = createHash('sha256').update(html).digest('hex');
  expect(approved.approved_by).toBe('jamie');
  if (approved.pending_review) {
    // A changed render is a new visual state: the approval on record does not
    // cover it. The candidate pins exactly what awaits Jamie's re-approval.
    expect(rendered).not.toBe(approved.rendered_html_sha256);
    expect(rendered).toBe(approved.pending_review.candidate_rendered_html_sha256);
    expect(approved.pending_review.reason).toContain('awaits Jamie\'s re-approval');
  } else {
    // A change here is a new visual state: it needs the owner's approval again.
    expect(rendered).toBe(approved.rendered_html_sha256);
    // Which source the approved screenshots were rendered from.
    expect(approved.rendered_from_commit).toMatch(/^[0-9a-f]{40}$/);
  }
});

test('the panel and the computer host render what the unified-dashboard review covers', async () => {
  const receipt = JSON.parse(readFileSync(join(ROOT, 'config/dashboard-design-review.json'), 'utf8')) as {
    design_review: { covers: string[] };
    reviewed_states: Array<{ id: string; rendered_html_sha256: string }>;
  };
  const { dashboardResourceHtml } = await import('../src/workers/chatgpt/dashboard-resource.ts');
  const { renderComputerHostPage } = await import('../src/workers/dashboard/host-page.ts');
  const panel = dashboardResourceHtml();
  const origin = 'http://127.0.0.1:8787';
  const rendered: Record<string, string> = {
    panel,
    computer_host: renderComputerHostPage({ panelHtml: panel, origin, csrfToken: 'design-review-csrf' }),
    computer_host_locked: renderComputerHostPage({ panelHtml: panel, origin }),
  };
  for (const id of receipt.design_review.covers) {
    const state = receipt.reviewed_states.find((candidate) => candidate.id === id)!;
    // A change here is a new visual state: update the digest only together
    // with fresh renders for the owner.
    expect(`${id}: ${createHash('sha256').update(rendered[id]!).digest('hex')}`).toBe(`${id}: ${state.rendered_html_sha256}`);
  }
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
