/**
 * The `ui://olympus/private-question` MCP Apps resource (advertised
 * content-versioned, `?v=<hash>`): the private question panel, where the
 * user types a question ChatGPT never sees (private-question-contract.ts).
 * Like private-answer-resource.ts, this module is the single place the MCP
 * surface (and, through the generated relay assets, the relay) loads the
 * panel HTML from. The page is the dashboard lane's
 * (src/workers/dashboard/chatgpt/private-question.ts):
 *
 * - read `_meta["olympus/privateQuestion"]` from the `open_private_question`
 *   result (`ui/notifications/tool-result`, or `window.openai.toolResponseMetadata`);
 * - seal the typed question to the engine's job key with the job's own ECDH
 *   P-256 pair (kept in the frame's IndexedDB), POST it to
 *   `<relay origin>/private/<jobId>/ask`, then collect the sealed outcome
 *   with `POST /private/<jobId>` as the private answer panel does;
 * - never send the question, the answer, the key or the job id back to the
 *   host (no tools/call, no widget state, no follow-up message).
 */
import { DASHBOARD_UI_DOMAIN, MCP_APP_MIME_TYPE, versionedResourceUri } from './dashboard-resource.ts';
import { PRIVATE_ANSWER_RELAY_ORIGIN } from './private-answer-resource.ts';
import { PRIVATE_QUESTION_RESOURCE_URI } from './private-question-contract.ts';
import { chatgptPrivateQuestionPageHtml, type ChatGptPrivateQuestionPageOptions } from '../dashboard/chatgpt/private-question.ts';

/** The panel as served, rendered once: it takes no per-request input. */
const PRIVATE_QUESTION_HTML = chatgptPrivateQuestionPageHtml({ relayOrigin: PRIVATE_ANSWER_RELAY_ORIGIN });

/** `ui://olympus/private-question?v=<hash of the HTML>`: resources/list, resources/read and the tool's `_meta`. */
export const PRIVATE_QUESTION_RESOURCE_VERSIONED_URI = versionedResourceUri(PRIVATE_QUESTION_RESOURCE_URI, PRIVATE_QUESTION_HTML);

export const PRIVATE_QUESTION_RESOURCE = {
  uri: PRIVATE_QUESTION_RESOURCE_VERSIONED_URI,
  name: 'Olympus private question',
  mimeType: MCP_APP_MIME_TYPE,
} as const;

/** `_meta` on the resource contents: the relay is the one origin the panel may contact. */
export function privateQuestionResourceMeta(relayOrigin = PRIVATE_ANSWER_RELAY_ORIGIN): Record<string, unknown> {
  return {
    ui: { csp: { connectDomains: [relayOrigin], resourceDomains: [] }, domain: DASHBOARD_UI_DOMAIN, prefersBorder: false },
    'openai/widgetDescription': 'A question field whose question and answer stay between the user and their own computer; ChatGPT never receives either.',
  };
}

export function privateQuestionResourceHtml(relayOrigin = PRIVATE_ANSWER_RELAY_ORIGIN): string {
  return relayOrigin === PRIVATE_ANSWER_RELAY_ORIGIN ? PRIVATE_QUESTION_HTML : privateQuestionPageHtml({ relayOrigin });
}

/** The panel page. Self-contained: no external scripts, styles or fonts. */
export function privateQuestionPageHtml(options: ChatGptPrivateQuestionPageOptions): string {
  return chatgptPrivateQuestionPageHtml(options);
}
