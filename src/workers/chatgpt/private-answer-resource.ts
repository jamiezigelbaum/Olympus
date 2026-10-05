/**
 * The `ui://olympus/private-answer` MCP Apps resource (advertised
 * content-versioned, `?v=<hash>`): the private answer
 * panel. LANE HANDOFF POINT: this module is the single place the MCP surface
 * (and, through the generated relay assets, the relay) loads the panel HTML
 * from, like dashboard-resource.ts for the dashboard. The page itself is the
 * dashboard lane's panel (src/workers/dashboard/chatgpt/private-answer.ts),
 * built against the contract in private-answer-contract.ts:
 *
 * - read `_meta["olympus/privateAnswer"]` from the tool result
 *   (`ui/notifications/tool-result`, or `window.openai.toolResponseMetadata`);
 * - as soon as a ready result renders: reuse the job's ECDH P-256 pair from
 *   the frame's IndexedDB or generate one (private key non-extractable), POST
 *   `{"v":1,"publicKey"}` to `<relay origin>/private/<jobId>`, poll on 202
 *   with the same key, decrypt a `ready` body (private-answer-crypto.ts),
 *   render it as text only;
 * - never send the answer, the key or the job id back to the host
 *   (no tools/call, no widget state, no follow-up message).
 */
import { DASHBOARD_UI_DOMAIN, MCP_APP_MIME_TYPE, versionedResourceUri } from './dashboard-resource.ts';
import { PRIVATE_ANSWER_RESOURCE_URI } from './private-answer-contract.ts';
import { chatgptPrivateAnswerPageHtml, type ChatGptPrivateAnswerPageOptions } from '../dashboard/chatgpt/private-answer.ts';

/** Where the panel collects answers: the relay's one public origin. */
export const PRIVATE_ANSWER_RELAY_ORIGIN = 'https://mcp.olympusplugin.ai';

/** The panel as served, rendered once: it takes no per-request input. */
const PRIVATE_ANSWER_HTML = chatgptPrivateAnswerPageHtml({ relayOrigin: PRIVATE_ANSWER_RELAY_ORIGIN });

/**
 * The panel's advertised URI, `ui://olympus/private-answer?v=<hash of the
 * HTML>` (dashboard-resource.ts, versionedResourceUri): resources/list,
 * resources/read and the answer tools' `_meta`.
 */
export const PRIVATE_ANSWER_RESOURCE_VERSIONED_URI = versionedResourceUri(PRIVATE_ANSWER_RESOURCE_URI, PRIVATE_ANSWER_HTML);

export const PRIVATE_ANSWER_RESOURCE = {
  uri: PRIVATE_ANSWER_RESOURCE_VERSIONED_URI,
  name: 'Olympus private answer',
  mimeType: MCP_APP_MIME_TYPE,
} as const;

/** `_meta` on the resource contents: the relay is the one origin the panel may contact. */
export function privateAnswerResourceMeta(relayOrigin = PRIVATE_ANSWER_RELAY_ORIGIN): Record<string, unknown> {
  return {
    ui: { csp: { connectDomains: [relayOrigin], resourceDomains: [] }, domain: DASHBOARD_UI_DOMAIN, prefersBorder: false },
    'openai/widgetDescription': 'Shows how many private items match and, when the user asks, a private answer that ChatGPT never receives.',
  };
}

export function privateAnswerResourceHtml(relayOrigin = PRIVATE_ANSWER_RELAY_ORIGIN): string {
  return relayOrigin === PRIVATE_ANSWER_RELAY_ORIGIN ? PRIVATE_ANSWER_HTML : privateAnswerPageHtml({ relayOrigin });
}

/**
 * The panel page (src/workers/dashboard/chatgpt/private-answer.ts).
 * Self-contained: no external scripts, styles or fonts.
 */
export function privateAnswerPageHtml(options: ChatGptPrivateAnswerPageOptions): string {
  return chatgptPrivateAnswerPageHtml(options);
}
