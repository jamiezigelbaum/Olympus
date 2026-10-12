/**
 * The ChatGPT plugin directory's listing as submitted to OpenAI, pinned.
 *
 * OpenAI reviews, and after approval rescans daily, what the directory
 * endpoint (`/openai/mcp`) lists: the tools with their descriptions,
 * annotations and UI metadata, and the UI resources those tools name. The
 * relay answers that endpoint itself whenever no engine does (no token yet,
 * or the Mac offline), so it serves this copy there instead of the files it
 * generates from the current engine source for `/mcp`. Relay releases then
 * cannot change the reviewed listing by accident.
 *
 * `approved/*.json` are the relay's generated files of the submitted commit,
 * byte for byte (`git show <commit>:connect-relay/server/generated/chatgpt-*.json`).
 * test/reviewer-path.test.ts pins their digests and requires the relay's
 * reviewer-path answers to equal the submitted relay's
 * (test/fixtures/reviewer-path/golden.json). Changing this listing is a new
 * submission: replace the files from the commit submitted, update `APPROVED`,
 * the digests and the golden recording together, and say so in
 * chatgpt-plugin/SUBMISSION.md.
 */
import dashboard from './approved/dashboard.json';
import privateAnswer from './approved/private-answer.json';
import privateQuestion from './approved/private-question.json';
import surface from './approved/tools.json';

export const APPROVED = Object.freeze({
  /** The commit whose plugin package, relay and demo engine were submitted. */
  commit: '6c990f65f52efb524c4ac949348f3c3767a9e512',
  plugin: 'plugin_asdk_app_6acbb7a8a3008191b6f6b3dbfd6f3301',
  submitted: '2026-10-11',
  status: 'in review',
});

export const APPROVED_TOOLS = surface.tools;
export const APPROVED_RESOURCES = surface.resources;
export const APPROVED_DASHBOARD_CONTENTS = dashboard.contents;
export const APPROVED_PRIVATE_ANSWER_CONTENTS = privateAnswer.contents;
export const APPROVED_PRIVATE_QUESTION_CONTENTS = privateQuestion.contents;
