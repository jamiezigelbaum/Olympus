/**
 * Settings an agent proposes and the owner applies with one click (#1050).
 *
 * An agent helping the owner (Claude Code on the computer, say) writes the
 * settings it was asked to set into one file and runs
 * `olympus settings propose <file>`. The running worker checks every entry
 * against the same choices the dashboard offers and holds the proposal; the
 * Settings page then shows each change, current and proposed, with Apply all
 * and Discard. Nothing changes until the owner clicks Apply in an unlocked
 * dashboard on this computer, so every applied value is the owner's own
 * choice and never an agent-written default (#598).
 *
 * Deliberately small: only settings with a fixed set of choices. Outside
 * help, remote access, source scopes and privacy rules have their own flows
 * (terms, pickers, per-item rules) and stay on their dashboard pages.
 */
import { SOVEREIGNTY_PRESETS, type SovereigntyPresetName } from './sovereignty.ts';

export const SETTINGS_PROPOSAL_MODEL_PROVIDERS = ['local', 'venice', 'zkapi'] as const;
export type SettingsProposalModelProvider = (typeof SETTINGS_PROPOSAL_MODEL_PROVIDERS)[number];

/** What a proposal file holds. Every key is optional; at least one is set. */
export interface SettingsProposalInput {
  private_answer_mode?: SovereigntyPresetName;
  computer_use?: 'everyday' | 'server';
  privacy_judge?: { choice: 'local' | 'venice'; spending_limit_dollars: number };
  models?: Partial<Record<SettingsProposalModelProvider, string>>;
}

/** One change on the card: what it is now and what the agent proposes. */
export interface SettingsProposalRow {
  key: string;
  label: string;
  current: string;
  proposed: string;
}

export interface SettingsProposal {
  id: string;
  created_at: string;
  /** Set when the agent named itself (`--from`), shown on the card. */
  from?: string;
  input: SettingsProposalInput;
  rows: SettingsProposalRow[];
}

/** The proposal file's shape, for `olympus settings schema`. */
export const SETTINGS_PROPOSAL_SCHEMA = {
  description: 'Write a JSON object with any of these keys, then run olympus settings propose <file>. The owner applies it with one click on the dashboard Settings page. Run olympus settings show for the current values and the allowed model choices.',
  keys: {
    private_answer_mode: { type: 'string', allowed: [...SOVEREIGNTY_PRESETS] },
    computer_use: { type: 'string', allowed: ['everyday', 'server'], note: 'Mac standalone installs only, while the choice is still open. Propose it on its own.' },
    privacy_judge: {
      type: 'object',
      fields: {
        choice: { type: 'string', allowed: ['local', 'venice'] },
        spending_limit_dollars: { type: 'number', note: 'Zero or more. Required for both choices.' },
        note: { type: 'note', note: 'Propose privacy_judge on its own. Propose any models or private_answer_mode change first, separately.' },
      },
    },
    models: {
      type: 'object',
      fields: Object.fromEntries(SETTINGS_PROPOSAL_MODEL_PROVIDERS.map((provider) => [provider, {
        type: 'string', note: `One of models.${provider}.options from olympus settings show.`,
      }])),
    },
  },
  example: {
    private_answer_mode: 'local-first',
    models: { venice: 'strongest' },
  },
} as const;

export class SettingsProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsProposalError';
  }
}

const TOP_KEYS = ['private_answer_mode', 'computer_use', 'privacy_judge', 'models'] as const;

/** Check a proposal file's shape. The worker then checks each value against what this computer offers. */
export function parseSettingsProposalInput(value: unknown): SettingsProposalInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsProposalError('A settings proposal is a JSON object. Run olympus settings schema for its shape.');
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !(TOP_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) throw new SettingsProposalError(`Olympus cannot set ${unknownKeys.join(', ')} from a proposal. Settable: ${TOP_KEYS.join(', ')}.`);
  const input: SettingsProposalInput = {};
  if (record.private_answer_mode !== undefined) {
    if (typeof record.private_answer_mode !== 'string' || !(SOVEREIGNTY_PRESETS as readonly string[]).includes(record.private_answer_mode)) {
      throw new SettingsProposalError(`private_answer_mode must be one of ${SOVEREIGNTY_PRESETS.join(', ')}.`);
    }
    input.private_answer_mode = record.private_answer_mode as SovereigntyPresetName;
  }
  if (record.computer_use !== undefined) {
    if (record.computer_use !== 'everyday' && record.computer_use !== 'server') throw new SettingsProposalError('computer_use must be everyday or server.');
    input.computer_use = record.computer_use;
  }
  if (record.privacy_judge !== undefined) {
    const judge = record.privacy_judge as Record<string, unknown> | null;
    if (!judge || typeof judge !== 'object' || Array.isArray(judge)) throw new SettingsProposalError('privacy_judge must be an object with choice and spending_limit_dollars.');
    if (judge.choice !== 'local' && judge.choice !== 'venice') throw new SettingsProposalError('privacy_judge.choice must be local or venice.');
    const cap = judge.spending_limit_dollars;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) throw new SettingsProposalError('privacy_judge.spending_limit_dollars must be a number, zero or more.');
    const extra = Object.keys(judge).filter((key) => key !== 'choice' && key !== 'spending_limit_dollars');
    if (extra.length > 0) throw new SettingsProposalError(`privacy_judge has no ${extra.join(', ')}.`);
    input.privacy_judge = { choice: judge.choice, spending_limit_dollars: cap };
  }
  if (record.models !== undefined) {
    const models = record.models as Record<string, unknown> | null;
    if (!models || typeof models !== 'object' || Array.isArray(models)) throw new SettingsProposalError('models must be an object such as {"venice": "strongest"}.');
    const picked: Partial<Record<SettingsProposalModelProvider, string>> = {};
    for (const [provider, choice] of Object.entries(models)) {
      if (!(SETTINGS_PROPOSAL_MODEL_PROVIDERS as readonly string[]).includes(provider)) throw new SettingsProposalError(`models.${provider} is not a model picker. Pickers: ${SETTINGS_PROPOSAL_MODEL_PROVIDERS.join(', ')}.`);
      if (typeof choice !== 'string' || choice.trim() === '') throw new SettingsProposalError(`models.${provider} must name one of its options.`);
      picked[provider as SettingsProposalModelProvider] = choice.trim();
    }
    if (Object.keys(picked).length > 0) input.models = picked;
  }
  if (Object.keys(input).length === 0) throw new SettingsProposalError('This proposal changes nothing. Run olympus settings schema for what it can set.');
  return input;
}

/** A short name an agent gives itself for the card (`--from "Claude Code"`). */
export function parseProposalFrom(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[\p{L}\p{N} ._'()-]{1,40}$/u.test(value.trim())) {
    throw new SettingsProposalError('--from takes a short name of up to 40 letters, digits and spaces.');
  }
  return value.trim();
}
