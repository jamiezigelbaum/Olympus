import { appClientCopy, type McpAppClient } from '../../connect-relay/shared/mcp-app-client.ts';
import { openPageUrl } from '../core/open-targets.ts';
import type { SourceAnswerJobScope } from '../core/source-answer-jobs.ts';
import { DASHBOARD_CHATGPT_VOCABULARY } from './dashboard/vocabulary.ts';

export const ANSWER_MODEL_REQUIRED_TEXT = `No answer model is set up in Olympus. Set one up in the Olympus dashboard's Settings. [${DASHBOARD_CHATGPT_VOCABULARY.openOnMac}](${openPageUrl({ kind: 'fix', section: 'answers' })})`;

/** Stop before any operation or source read; anonymous asks have their own model. */
export function answerModelRequiredResult(
  name: string,
  args: Record<string, unknown>,
  available: (() => boolean) | undefined,
  jobs?: SourceAnswerJobScope,
  client?: McpAppClient,
): { content: Array<{ type: 'text'; text: string }> } | undefined {
  if (name !== 'source_answer' && name !== 'source_answer_result') return;
  if (!available || available()) return;
  if (name === 'source_answer_result' && jobs?.registry.isAnonymousAsk(jobs.owner, typeof args.job_id === 'string' ? args.job_id.trim() : args.job_id)) return;
  return { content: [{ type: 'text', text: appClientCopy(ANSWER_MODEL_REQUIRED_TEXT, client) }] };
}
