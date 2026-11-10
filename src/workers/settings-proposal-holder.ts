/**
 * The worker's side of agent-proposed settings (core/settings-proposal.ts).
 *
 * `propose` comes from the CLI over the bearer-only `/v1/cli/` route: it checks
 * every value against what this computer offers now and keeps one proposal
 * (a newer one replaces it). `apply` and `discard` come only from the Settings
 * page in an unlocked dashboard on this computer (workers/http.ts grades the
 * session), so the owner's click is what changes anything.
 *
 * Kept in memory: a proposal is a moment's handoff between the agent and the
 * owner, and a restarted Olympus simply asks the agent to propose again.
 */
import { randomUUID } from 'node:crypto';
import type { DashboardModelChoices } from '../core/model-choices.ts';
import { PRIVACY_PRESET_LABELS } from '../core/privacy-language.ts';
import {
  SETTINGS_PROPOSAL_MODEL_PROVIDERS,
  SettingsProposalError,
  type SettingsProposal,
  type SettingsProposalInput,
  type SettingsProposalRow,
} from '../core/settings-proposal.ts';
import type { SovereigntyPresetName } from '../core/sovereignty.ts';
import type { DashboardJudgeSetup } from './dashboard/pages/local.ts';

type Saved = { ok: true; message?: string } | { ok: false; message: string };

/** What the dashboard already reads and writes, bound by the worker's composition root. */
export interface SettingsProposalTargets {
  answerMode: () => { id: string; label: string };
  saveAnswerMode?: (choice: SovereigntyPresetName) => Saved;
  /** Present only where the everyday/server question exists (the standalone Mac app). */
  computerSetup?: () => { computer_use_pending?: boolean | undefined; engine_server_mode?: { enabled: boolean; pending: boolean } | undefined };
  saveComputerUse?: (choice: 'everyday' | 'server') => Saved;
  judge?: () => DashboardJudgeSetup;
  saveJudge?: (choice: 'local' | 'venice', capDollars: number) => Promise<Saved>;
  modelChoices?: () => Promise<DashboardModelChoices>;
  saveModel?: (provider: 'local' | 'venice' | 'zkapi', value: string) => Promise<Saved>;
  /** Hold the restarts the writers ask for until every write is done, so a restart cannot cut the batch short. */
  deferReloads?: <T>(writes: () => Promise<T>) => Promise<T>;
}

export interface SettingsProposalApplyResult {
  ok: boolean;
  rows: Array<SettingsProposalRow & { applied: boolean; message?: string }>;
}

const MODEL_LABELS: Record<string, string> = { local: 'Local model', venice: 'Venice model', zkapi: 'zkAPI model' };

function modeLabel(id: string): string {
  return (PRIVACY_PRESET_LABELS as Record<string, string>)[id] ?? id;
}

function judgeLabel(choice: 'local' | 'venice', cap: number | null): string {
  if (choice === 'local') return 'Local (free)';
  return cap === null ? 'Venice, no spending limit' : `Venice, up to $${cap}`;
}

export function createSettingsProposalHolder(targets: SettingsProposalTargets, now: () => Date = () => new Date()) {
  let held: SettingsProposal | undefined;
  /** What the last Apply did, so the page can still say so after it redraws. */
  let lastApplied: { at: number; result: SettingsProposalApplyResult } | undefined;

  async function rowsFor(input: SettingsProposalInput): Promise<SettingsProposalRow[]> {
    const rows: SettingsProposalRow[] = [];
    if (input.private_answer_mode) {
      if (!targets.saveAnswerMode) throw new SettingsProposalError('This Olympus cannot change the Private-answer mode from the dashboard.');
      if (!input.computer_use && targets.computerSetup?.().computer_use_pending === true) {
        throw new SettingsProposalError('Choose how this computer runs first: add computer_use to the proposal.');
      }
      rows.push({ key: 'private_answer_mode', label: 'Private-answer mode', current: targets.answerMode().label, proposed: modeLabel(input.private_answer_mode) });
    }
    if (input.computer_use) {
      const setup = targets.computerSetup?.();
      if (!setup?.engine_server_mode || !targets.saveComputerUse) throw new SettingsProposalError('computer_use can be set only in the standalone Olympus app on a Mac.');
      if (setup.computer_use_pending !== true) {
        throw new SettingsProposalError('How this Mac runs was already chosen. Change it with the Engine switch on the dashboard Settings page.');
      }
      rows.push({ key: 'computer_use', label: 'How this computer runs', current: 'Not chosen yet', proposed: input.computer_use === 'server' ? 'Always-on server' : 'Everyday computer' });
    }
    if (input.privacy_judge && (input.models || input.private_answer_mode || input.computer_use)) {
      // The judge is approved for the exact model and lane the running Olympus
      // uses. Models, the Private-answer mode and how the computer runs change
      // only after the restart, so a judge saved in the same batch would be
      // approved for the old setup and then stay off.
      throw new SettingsProposalError('The privacy judge goes in two proposals: propose the other changes first, and once they are applied, propose privacy_judge on its own.');
    }
    if (input.privacy_judge) {
      const judge = targets.judge?.();
      if (!judge || !targets.saveJudge) throw new SettingsProposalError('This Olympus has no privacy judge setting.');
      if (input.privacy_judge.choice === 'venice' && !judge.cloudAvailable) {
        throw new SettingsProposalError('Venice judging needs a Venice key and an allowed Venice model first. Connect Venice, then propose again.');
      }
      rows.push({
        key: 'privacy_judge',
        label: 'Privacy judge',
        current: judgeLabel(judge.choice, judge.uncapped ? null : judge.capDollars),
        proposed: judgeLabel(input.privacy_judge.choice, input.privacy_judge.spending_limit_dollars),
      });
    }
    if (input.models) {
      const choices = targets.modelChoices ? await targets.modelChoices() : undefined;
      if (!choices || !targets.saveModel) throw new SettingsProposalError('This Olympus has no model pickers.');
      for (const provider of SETTINGS_PROPOSAL_MODEL_PROVIDERS) {
        const value = input.models[provider];
        if (value === undefined) continue;
        const list = choices[provider];
        if (!list) throw new SettingsProposalError(`There is no ${MODEL_LABELS[provider]} picker on this computer yet. Set it up first, then propose again.`);
        const option = list.options.find((candidate) => candidate.value === value);
        if (!option) throw new SettingsProposalError(`models.${provider} must be one of: ${list.options.map((candidate) => candidate.value).join(', ')}.`);
        const current = list.options.find((candidate) => candidate.value === list.current);
        rows.push({ key: `models.${provider}`, label: MODEL_LABELS[provider]!, current: current?.label ?? list.current, proposed: option.label });
      }
    }
    return rows;
  }

  return {
    /** Check and hold a proposal; a newer one replaces the last. */
    async propose(input: SettingsProposalInput, from?: string): Promise<SettingsProposal> {
      const proposal: SettingsProposal = {
        id: randomUUID(),
        created_at: now().toISOString(),
        ...(from ? { from } : {}),
        input,
        rows: await rowsFor(input),
      };
      held = proposal;
      lastApplied = undefined;
      return proposal;
    },

    current(): SettingsProposal | undefined {
      return held;
    },

    /** The last Apply's outcome, for 15 minutes after it. */
    lastApplied(): SettingsProposalApplyResult | undefined {
      if (!lastApplied || now().getTime() - lastApplied.at > 15 * 60_000) return undefined;
      return lastApplied.result;
    },

    discard(id: string): boolean {
      if (!held || held.id !== id) return false;
      held = undefined;
      return true;
    },

    /**
     * Apply the held proposal the owner is looking at. Models and the judge
     * go first; the Private-answer mode and how the computer runs go last,
     * because those restart parts of Olympus.
     */
    async apply(id: string): Promise<SettingsProposalApplyResult | undefined> {
      if (!held || held.id !== id) return undefined;
      const proposal = held;
      held = undefined;
      const input = proposal.input;
      const results: SettingsProposalApplyResult['rows'] = [];
      const record = async (key: string, run: () => Saved | Promise<Saved>) => {
        const row = proposal.rows.find((candidate) => candidate.key === key)!;
        try {
          const saved = await run();
          results.push({ ...row, applied: saved.ok, ...(saved.message ? { message: saved.message } : {}) });
        } catch (error) {
          results.push({ ...row, applied: false, message: error instanceof Error ? error.message : 'This setting could not be saved.' });
        }
      };
      const writes = async () => {
        for (const provider of SETTINGS_PROPOSAL_MODEL_PROVIDERS) {
          const value = input.models?.[provider];
          if (value !== undefined) await record(`models.${provider}`, () => targets.saveModel!(provider, value));
        }
        if (input.privacy_judge) {
          const judge = input.privacy_judge;
          await record('privacy_judge', () => targets.saveJudge!(judge.choice, judge.spending_limit_dollars));
        }
        if (input.computer_use) await record('computer_use', () => targets.saveComputerUse!(input.computer_use!));
        if (input.private_answer_mode) await record('private_answer_mode', () => targets.saveAnswerMode!(input.private_answer_mode!));
      };
      await (targets.deferReloads ? targets.deferReloads(writes) : writes());
      const result = { ok: results.every((row) => row.applied), rows: results };
      lastApplied = { at: now().getTime(), result };
      return result;
    },
  };
}

export type SettingsProposalHolder = ReturnType<typeof createSettingsProposalHolder>;
