/**
 * What each AI app received, for an agent on this computer (#1061): an
 * OpenClaw tool (`native`) or a local MCP client (`mcp`). Their source answer
 * leaves at the operation's own tool result (core/operations.ts), after a
 * handed-off job is collected and after stdio's release ticket is checked
 * again (revalidateStdioSourceAnswer), so it is recorded there and nowhere
 * earlier: a job nobody collects, or an answer the last check withholds, is
 * never listed as shared.
 *
 * Remote surfaces are recorded at their own exits (core/app-release-capture.ts),
 * and the owner's command line is not an AI app.
 *
 * The agent's process is not the worker: when no recorder is installed here,
 * the record is written to the same owner-only log file directly.
 */
import { recordAppRequest, releasedItemFromEvidence, sourceAnswerQuestion, type AppRequestRecord, type ReleasedItem } from './app-release-capture.ts';
import type { OperationCaller } from './operation-caller.ts';
import { isWithheldSourceAnswer } from './release-manifest.ts';
import { providerSourceLabel } from './remote-result.ts';

const FAMILY_SOURCE: Readonly<Record<string, string>> = { email: 'Mail', file: 'Files', chat: 'Messages', note: 'Notes' };

/** The items an answer carries, by name, at the tier each was released at. */
export function releasedItemsOfAnswer(result: Record<string, unknown>): ReleasedItem[] {
  return (Array.isArray(result.evidence) ? result.evidence : [])
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .slice(0, 48)
    .map((entry) => releasedItemFromEvidence(
      entry,
      (typeof entry.provider === 'string' ? providerSourceLabel(entry.provider) : undefined)
        ?? (typeof entry.family === 'string' ? FAMILY_SOURCE[entry.family] : undefined)
        ?? 'Other source',
      typeof entry.title === 'string' ? entry.title : undefined,
    ));
}

/**
 * Records a source answer as its tool result leaves for a local agent. A job
 * still working only remembers its question. Never throws.
 */
export async function recordLocalAgentAnswer(input: {
  caller: OperationCaller | undefined;
  operation: 'source_answer' | 'source_answer_result';
  args: Record<string, unknown>;
  result: unknown;
  /** Tests: where the record goes in place of the log file. */
  write?: (record: AppRequestRecord) => void;
}): Promise<void> {
  try {
    const { caller } = input;
    if (caller?.surface !== 'mcp' && caller?.surface !== 'native') return;
    if (!input.result || typeof input.result !== 'object') return;
    const result = input.result as Record<string, unknown>;
    const question = sourceAnswerQuestion(input.operation, input.args, result.status, result.job_id);
    if (typeof result.answer !== 'string') return;
    const withheld = isWithheldSourceAnswer(result);
    const records: AppRequestRecord[] = [];
    recordAppRequest({
      caller,
      question,
      capture: { items: withheld ? [] : releasedItemsOfAnswer(result), heldBack: 0, withheld },
      fallback: (record) => records.push(record),
    });
    if (records.length === 0) return;
    if (input.write) {
      for (const record of records) input.write(record);
      return;
    }
    const { openAppReleaseLog, appReleaseLogDbPath } = await import('./app-release-log.ts');
    const { resolveRemoteConnectionsDbPath } = await import('./remote-connections.ts');
    const log = openAppReleaseLog(appReleaseLogDbPath(resolveRemoteConnectionsDbPath(process.env)));
    try {
      for (const record of records) log.record(record);
    } finally {
      log.close();
    }
  } catch {
    // A log that cannot be written never changes what an agent gets.
  }
}
