// Recomputes the dashboard design-review pins from the current source, so a
// change that moves them is re-pinned by a script, never by hand-typed digests.
//
//   bun scripts/dashboard-design-repin.ts           # report which pins moved
//   bun scripts/dashboard-design-repin.ts --write   # rewrite them in place
//
// It rewrites the pins in config/dashboard-design-review.json and
// test/dashboard-design-review.test.ts: the implementation guard digest, each
// pending reviewed state's candidate rendering, and the Linux anonymous-answers
// states. It never touches the owner's sign-off (`design_review`), so a re-pin
// records that the code changed, not that the owner approved a new look.
//
// Re-pin freely for a change that leaves the rendered page the same (a script
// or wording-free fix). A change to what the dashboard shows still needs the
// owner's design approval first.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CONFIG = 'config/dashboard-design-review.json';
const TEST = 'test/dashboard-design-review.test.ts';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function allFiles(path: string): string[] {
  return statSync(path).isFile() ? [path] : readdirSync(path).flatMap((entry) => allFiles(join(path, entry)));
}

/** The same digest the guard test takes: every file under the paths, sorted, as name and content hash. */
function filesDigest(paths: readonly string[]): string {
  const files = paths.flatMap((path) => allFiles(join(ROOT, path))).map((path) => path.slice(ROOT.length + 1)).sort();
  const digest = createHash('sha256');
  for (const file of files) digest.update(file).update('\0').update(sha256(readFileSync(join(ROOT, file)))).update('\n');
  return digest.digest('hex');
}

const receipt = JSON.parse(readFileSync(join(ROOT, CONFIG), 'utf8')) as {
  implementation_guard_paths: string[];
  implementation_guard_sha256: string;
  reviewed_states: Array<{ id: string; pending_review?: { candidate_rendered_html_sha256: string } }>;
  linux_anonymous_review: { rendered_states_sha256: Record<string, string> };
};

const pairs: Array<[pinned: string, current: string]> = [[receipt.implementation_guard_sha256, filesDigest(receipt.implementation_guard_paths)]];

const { dashboardResourceHtml } = await import('../src/workers/chatgpt/dashboard-resource.ts');
const { renderComputerHostPage } = await import('../src/workers/dashboard/host-page.ts');
const { renderDashboardAgentsSection } = await import('../src/workers/dashboard/agents.ts');
const { previewAgentsView, DASHBOARD_PREVIEW_NOW } = await import('./dashboard-preview.ts');
const { linuxZkapiDashboardStates } = await import('../test/helpers/linux-zkapi-dashboard-states.ts');

const panel = dashboardResourceHtml();
const origin = 'http://127.0.0.1:8787';
const rendered: Record<string, string> = {
  panel,
  computer_host: renderComputerHostPage({ panelHtml: panel, origin, csrfToken: 'design-review-csrf' }),
  computer_host_locked: renderComputerHostPage({ panelHtml: panel, origin }),
  setup_agents: renderDashboardAgentsSection({ view: previewAgentsView(null), now: DASHBOARD_PREVIEW_NOW, platform: 'darwin' }),
};
for (const state of receipt.reviewed_states) {
  const html = rendered[state.id];
  if (state.pending_review && html !== undefined) pairs.push([state.pending_review.candidate_rendered_html_sha256, sha256(html)]);
}
for (const [id, html] of Object.entries(linuxZkapiDashboardStates())) {
  const pinned = receipt.linux_anonymous_review.rendered_states_sha256[id];
  if (pinned !== undefined) pairs.push([pinned, sha256(html as string)]);
}

const moved = pairs.filter(([pinned, current]) => pinned !== current);
const write = process.argv.includes('--write');
for (const file of [CONFIG, TEST]) {
  let text = readFileSync(join(ROOT, file), 'utf8');
  let replaced = 0;
  for (const [pinned, current] of moved) {
    replaced += text.split(pinned).length - 1;
    text = text.split(pinned).join(current);
  }
  if (write) writeFileSync(join(ROOT, file), text);
  console.log(`${file}: ${replaced} pin${replaced === 1 ? '' : 's'} ${write ? 'rewritten' : 'would change'}`);
}
console.log(`${moved.length} of ${pairs.length} pins moved${moved.length > 0 && !write ? '; run with --write to rewrite them' : ''}`);
