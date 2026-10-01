/**
 * The relay serves a generated copy of the engine's ChatGPT surface
 * (scripts/build-chatgpt-relay-assets.ts). This holds that copy to the source:
 * stale files fail, and what the relay lists and serves equals what the
 * engine's MCP server lists and serves.
 */
import { describe, expect, test } from 'bun:test';
import { staleChatgptRelayAssets } from '../scripts/build-chatgpt-relay-assets.ts';
import { CHATGPT_RESOURCES, CHATGPT_TOOLS, DASHBOARD_RESOURCE_CONTENTS } from '../connect-relay/server/relay-mcp.ts';
import { DASHBOARD_RESOURCE } from '../src/workers/chatgpt/dashboard-resource.ts';
import { CHATGPT_TOOLS as ENGINE_TOOLS, readChatGptResource } from '../src/workers/chatgpt/mcp-surface.ts';

describe('relay ChatGPT assets', () => {
  test('the committed generated files match the source (run bun run build when this fails)', () => {
    expect(staleChatgptRelayAssets()).toEqual([]);
  });

  test('the relay lists exactly the engine tool definitions, each with its securitySchemes', () => {
    expect(CHATGPT_TOOLS).toEqual(JSON.parse(JSON.stringify(ENGINE_TOOLS)));
    expect(CHATGPT_TOOLS.map((tool) => [tool.name, tool.securitySchemes])).toEqual([
      ['olympus_dashboard', [{ type: 'noauth' }, { type: 'oauth2', scopes: [] }]],
      ...[
        'olympus_search',
        'source_index_status',
        'source_answer',
        'source_answer_result',
        'olympus_connect_source',
        'olympus_scope_list',
        'olympus_scope_set',
        'olympus_disconnect_source',
        'olympus_model_set',
        'olympus_privacy_get',
        'olympus_privacy_set',
      ].map((name) => [name, [{ type: 'oauth2', scopes: [] }]]),
    ]);
  });

  test('the relay serves the engine dashboard resource, bundle and metadata included', () => {
    expect(CHATGPT_RESOURCES).toEqual([{ ...DASHBOARD_RESOURCE }]);
    expect(DASHBOARD_RESOURCE_CONTENTS).toEqual(JSON.parse(JSON.stringify(readChatGptResource(DASHBOARD_RESOURCE.uri).contents)));
  });
});
