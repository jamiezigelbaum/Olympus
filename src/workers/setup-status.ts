/**
 * The worker's side of the setup checklist (#1077): the facts it reads, from
 * the same places the dashboard reads them, handed to the one shared builder
 * (core/setup-checklist.ts). The CLI and the agent tool reach it through the
 * worker's `setup-status` CLI route; Home reads it in the dashboard result's
 * computer meta. Names and states only.
 */
import { buildSetupChecklist, type SetupChecklist, type SetupFacts, type SetupMessagingFact, type SetupSourceEntry } from '../core/setup-checklist.ts';
import { readFileSync } from 'node:fs';
import { privacyChoicePending, privateAnswerMode } from '../core/first-run-privacy.ts';
import { PRIVACY_PRESET_LABELS } from '../core/privacy-language.ts';
import type { RemoteConnectionStore } from '../core/remote-connections.ts';
import { validateSovereigntyConfig, type SovereigntyConfig } from '../core/sovereignty.ts';
import type { JudgeSpending } from './classification/judge-spending.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from './source-dashboard.ts';

/** What the worker knows beside the dashboard view. */
export interface SetupWorkerFacts {
  version: string;
  privateAnswers: { chosen: boolean; label?: string };
  judge?: { chosen: boolean; choice: 'local' | 'venice'; limitDollars: number | null };
  /** Active agent connections' names, plus the host agent Olympus runs inside. */
  aiApps?: readonly string[];
}

/** The same "connected" the dashboard's Sources page counts (pages/local.ts). */
const CONNECTED = new Set(['connected', 'waiting_for_first_sync', 'syncing', 'synced']);
const MESSAGING = new Set(['telegram.messages', 'whatsapp.personal.messages']);
/** Not sources the owner connects: a model key, and the imports row. */
const NOT_A_SOURCE = new Set(['venice.api', 'archive.imports']);

function sourceState(card: DashboardSourceCard): SetupSourceEntry['state'] {
  if (card.connection.state === 'reauth_required') return 'needs_you';
  if (!CONNECTED.has(card.connection.state)) return 'skipped';
  if (card.scope_selection?.status === 'scope_pending') return 'needs_you';
  return 'connected';
}

export function setupFactsFromView(view: SourceDashboardViewModel | undefined, worker: SetupWorkerFacts): SetupFacts {
  // An import-only source has no account to connect: its imports are its
  // connection, so it counts once an import has landed and is left out before.
  const cards = (view?.sources ?? []).filter((card) => !NOT_A_SOURCE.has(card.source_id)
    && (card.connection.action.kind !== 'archive_import' || CONNECTED.has(card.connection.state)));
  const sources: SetupSourceEntry[] = cards.map((card) => ({ id: card.source_id, name: card.label, state: sourceState(card) }));
  const messaging: SetupMessagingFact[] = cards.filter((card) => MESSAGING.has(card.source_id)).map((card) => ({
    name: card.label,
    paired: CONNECTED.has(card.connection.state) || card.connection.state === 'reauth_required',
    // Pairing alone starts nothing: capture runs once chats are approved. The
    // approval is what a worker-owned capture runtime reads back; a native
    // capture service (OpenClaw's own Telegram or WhatsApp) shows none here,
    // so a message it has captured is the evidence instead.
    chatsChosen: card.capture?.scope !== undefined || card.freshness?.capture?.age_seconds !== undefined,
  }));
  const findableItems = view
    ? view.sources.reduce((sum, card) => sum + (Number.isFinite(card.coverage?.indexed_items) ? Math.max(0, card.coverage.indexed_items) : 0), 0)
    : undefined;
  return {
    version: worker.version,
    running: true,
    privateAnswers: worker.privateAnswers,
    ...(worker.judge ? { judge: worker.judge } : {}),
    ...(view ? { sources, messaging } : {}),
    ...(worker.aiApps ? { aiApps: worker.aiApps } : {}),
    ...(findableItems !== undefined ? { findableItems } : {}),
  };
}

export function setupChecklistFromView(view: SourceDashboardViewModel | undefined, worker: SetupWorkerFacts): SetupChecklist {
  return buildSetupChecklist(setupFactsFromView(view, worker));
}

/** The saved policy, re-read from its file when there is one: a choice saved since boot counts. */
function currentPolicy(policy: { config: SovereigntyConfig; path?: string }): SovereigntyConfig {
  if (!policy.path) return policy.config;
  try { return validateSovereigntyConfig(JSON.parse(readFileSync(policy.path, 'utf8'))); } catch { return policy.config; }
}

/**
 * Read the worker's own setup facts: the first-run privacy policy, the judge's
 * spending record, and the agent connections registry. Each part that cannot
 * be read is left out, so its step says "not known" instead of guessing.
 */
export function readSetupWorkerFacts(input: {
  version: string;
  policy: { config: SovereigntyConfig; path?: string };
  judge?: Pick<JudgeSpending, 'hasRecord' | 'status'>;
  connections?: () => Pick<RemoteConnectionStore, 'list'> | undefined;
  /** The agent Olympus runs inside (OpenClaw), when it does. */
  hostAgent?: string;
}): SetupWorkerFacts {
  const pending = privacyChoicePending(input.policy);
  const mode = privateAnswerMode(currentPolicy(input.policy));
  let judge: SetupWorkerFacts['judge'];
  if (input.judge) {
    try {
      const status = input.judge.status();
      judge = { chosen: input.judge.hasRecord(), choice: status.choice, limitDollars: status.uncapped ? null : status.capDollars };
    } catch { judge = undefined; }
  }
  let aiApps: string[] | undefined;
  try {
    const store = input.connections?.();
    aiApps = [
      ...(input.hostAgent ? [input.hostAgent] : []),
      ...(store?.list() ?? []).filter((connection) => !connection.revokedAt).map((connection) => connection.displayName),
    ];
  } catch { aiApps = input.hostAgent ? [input.hostAgent] : undefined; }
  return {
    version: input.version,
    privateAnswers: pending ? { chosen: false } : { chosen: true, label: mode === 'custom' ? 'Custom Private-answer mode' : PRIVACY_PRESET_LABELS[mode] },
    ...(judge ? { judge } : {}),
    ...(aiApps ? { aiApps } : {}),
  };
}
