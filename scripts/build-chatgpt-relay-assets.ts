/**
 * Generates the relay's copy of the ChatGPT surface from the engine's source,
 * so the relay's no-token answers list the same tools and serve the same
 * dashboard as the engine:
 *
 *   connect-relay/server/generated/chatgpt-tools.json      tools/list + resources/list
 *   connect-relay/server/generated/chatgpt-dashboard.json  resources/read of ui://olympus/dashboard
 *
 * The relay builds and deploys separately from the engine and imports only
 * these files. `bun run build` writes them; `--check` (and
 * test/chatgpt-relay-assets.test.ts) fails when they are stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_RESOURCE } from '../src/workers/chatgpt/dashboard-resource.ts';
import { CHATGPT_TOOLS, readChatGptResource } from '../src/workers/chatgpt/mcp-surface.ts';

const ROOT = join(import.meta.dir, '..');
export const GENERATED_DIR = 'connect-relay/server/generated';

export function chatgptRelayAssets(): Record<string, string> {
  const render = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    [`${GENERATED_DIR}/chatgpt-tools.json`]: render({ tools: CHATGPT_TOOLS, resources: [{ ...DASHBOARD_RESOURCE }] }),
    [`${GENERATED_DIR}/chatgpt-dashboard.json`]: render(readChatGptResource(DASHBOARD_RESOURCE.uri)),
  };
}

/** Paths whose committed content differs from what the source generates. */
export function staleChatgptRelayAssets(): string[] {
  return Object.entries(chatgptRelayAssets()).filter(([path, content]) => {
    try {
      return readFileSync(join(ROOT, path), 'utf8') !== content;
    } catch {
      return true;
    }
  }).map(([path]) => path);
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const stale = staleChatgptRelayAssets();
    if (stale.length > 0) {
      console.error(`Stale relay ChatGPT assets (run bun run build): ${stale.join(', ')}`);
      process.exit(1);
    }
  } else {
    for (const [path, content] of Object.entries(chatgptRelayAssets())) writeFileSync(join(ROOT, path), content);
  }
}
