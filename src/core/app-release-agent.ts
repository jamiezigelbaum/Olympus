/**
 * What each AI app received, for an agent on this computer (#1061): an
 * OpenClaw tool (`native`) or a local MCP client (`mcp`).
 *
 * The worker keeps what an answer would show the owner (question, caller,
 * item names) with the answer's release ticket, and records nothing yet. The
 * operation's own tool result (core/operations.ts) tells the worker once the
 * answer actually leaves: after a handed-off job is collected and after
 * stdio's release ticket is checked again (revalidateStdioSourceAnswer). So a
 * job nobody collects is never listed, and an answer the last check withholds
 * is listed as withheld, with no items.
 *
 * Only the worker writes the log. The agent's side holds no store: the native
 * plugin runs in Node, where the log's SQLite does not exist.
 *
 * Remote surfaces are recorded at their own exits (core/app-release-capture.ts),
 * and the owner's command line is not an AI app.
 */
import { recordAppRequest, releasedItemFromEvidence, type ReleasedItem } from './app-release-capture.ts';
import type { OperationCaller, OperationCallerWire } from './operation-caller.ts';
import { isWithheldSourceAnswer } from './release-manifest.ts';
import { providerSourceLabel } from './remote-result.ts';

const FAMILY_SOURCE: Readonly<Record<string, string>> = { email: 'Mail', file: 'Files', chat: 'Messages', note: 'Notes' };

/** What the worker keeps with a release ticket until the answer is received. */
export interface AgentAnswerReceipt {
  caller: OperationCaller;
  question: string;
  items: ReleasedItem[];
}

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

function isLocalAgent(surface: unknown): surface is 'mcp' | 'native' {
  return surface === 'mcp' || surface === 'native';
}

/** The worker's side: what to keep with a local agent's release ticket, if anything. */
export function agentAnswerReceipt(question: string, callerWire: OperationCallerWire | undefined, result: unknown): AgentAnswerReceipt | undefined {
  if (!callerWire || !isLocalAgent(callerWire.surface) || !result || typeof result !== 'object') return undefined;
  return {
    caller: {
      surface: callerWire.surface,
      ...(callerWire.connection_id ? { connectionId: callerWire.connection_id } : {}),
      ...(callerWire.display_name ? { displayName: callerWire.display_name } : {}),
      ...(callerWire.provider ? { provider: callerWire.provider } : {}),
    },
    question,
    items: releasedItemsOfAnswer(result as Record<string, unknown>),
  };
}

/** The worker's side: records a kept receipt once its answer was received. */
export function recordAgentAnswerReceipt(receipt: AgentAnswerReceipt, withheld: boolean): void {
  recordAppRequest({
    caller: receipt.caller,
    question: receipt.question,
    capture: { items: withheld ? [] : receipt.items, heldBack: 0, withheld },
  });
}

/**
 * The tool result's side: tells the worker a source answer left for a local
 * agent, as `released` (withheld or not). `original` is the answer as the
 * worker returned it, which names its release ticket. Never throws.
 */
export async function noteLocalAgentAnswer(input: {
  caller: OperationCaller | undefined;
  email: { noteSourceAnswerReceived?: (original: unknown, withheld: boolean) => Promise<void> };
  original: unknown;
  released: unknown;
}): Promise<void> {
  try {
    if (!isLocalAgent(input.caller?.surface)) return;
    const released = input.released;
    if (!released || typeof released !== 'object' || typeof (released as { answer?: unknown }).answer !== 'string') return;
    if (typeof input.email.noteSourceAnswerReceived !== 'function') return;
    await input.email.noteSourceAnswerReceived(input.original, isWithheldSourceAnswer(released));
  } catch {
    // A log that cannot be written never changes what an agent gets.
  }
}
