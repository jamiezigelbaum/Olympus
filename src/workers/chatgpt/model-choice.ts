/**
 * The model choices ChatGPT's dashboard can make (`olympus_model_set`), as a
 * pure change to the owner's sovereignty policy.
 *
 * - Embeddings: the built-in model only. A policy already on it is unchanged;
 *   moving one that embeds with anything else is a re-embed, which needs the
 *   owner's approval and an embedding-ledger entry, so it is refused here.
 * - Answers: `venice` or `local`, when already set up on the Mac, becomes
 *   the analyst for Public and Personal answers, and for Private answers on
 *   the Mac when that route is on. A disabled Private route stays disabled.
 *   Retrieval policy is never touched, and no credential is ever added.
 *
 * The result is validated by the same validator `olympus sovereignty init`
 * uses before anything is written.
 */
import {
  validateSovereigntyConfig,
  type SovereigntyConfig,
  type SovereigntyModelProfile,
} from '../../core/sovereignty.ts';

export type ChatGptAnswerChoice = 'local' | 'venice';

export interface ChatGptModelChoice {
  embedding?: 'built_in';
  answers?: ChatGptAnswerChoice;
}

export class ModelChoiceRefusal extends Error {
  constructor(readonly code: 'embedding_change_needs_approval' | 'model_not_configured') {
    super(code);
    this.name = 'ModelChoiceRefusal';
  }
}

const DOMAINS = ['public_safe', 'internal', 'secure_local'] as const;

/** Profile ids and definitions, as the shipped presets name them. */
const ANSWER_PROFILES: Record<ChatGptAnswerChoice, { id: string; profile: SovereigntyModelProfile }> = {
  venice: {
    id: 'venice-private',
    profile: {
      provider: 'venice',
      trust: 'encrypted_cloud',
      baseUrl: 'https://api.venice.ai/api/v1',
      model: 'kimi-k3',
      secretRef: 'store:venice.api_key',
      purpose: 'analyst',
    },
  },
  local: {
    id: 'local-source-answer',
    profile: {
      provider: 'local-openai-compatible',
      trust: 'local',
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'delphi/source-answer',
      purpose: 'analyst',
    },
  },
};

export const ANSWER_PROFILE_IDS: Readonly<Record<ChatGptAnswerChoice, string>> = {
  venice: ANSWER_PROFILES.venice.id,
  local: ANSWER_PROFILES.local.id,
};

/** The profile a choice installs when the policy has none under its id. */
export function answerProfile(choice: ChatGptAnswerChoice): SovereigntyModelProfile {
  return structuredClone(ANSWER_PROFILES[choice].profile);
}

/** Whether every trust domain that embeds does so with the built-in model. */
export function embeddingIsBuiltIn(config: SovereigntyConfig): boolean {
  let any = false;
  for (const domain of DOMAINS) {
    const id = config.retrieval.trustDomains[domain]?.embeddingProfile;
    if (!id) continue;
    if (config.modelProfiles[id]?.provider !== 'built-in') return false;
    any = true;
  }
  return any;
}

/** The answer choice the policy already makes, when it is exactly one of ours. */
export function currentAnswerChoice(config: SovereigntyConfig): ChatGptAnswerChoice | undefined {
  for (const choice of ['venice', 'local'] as const) {
    const { id } = ANSWER_PROFILES[choice];
    const routes = (['public_safe', 'internal'] as const).map((domain) => config.routes[domain]?.pool?.members ?? config.routes[domain]?.analyst ?? []);
    if (routes.every((members) => members.length === 1 && members[0] === id)) return choice;
  }
  return undefined;
}

/**
 * Switches between answer models already set up on the Mac: `configured`
 * says which are (Venice: its key is on the Mac; local: a local answer
 * profile exists). Never adds a credential.
 */
export function applyModelChoice(
  config: SovereigntyConfig,
  choice: ChatGptModelChoice,
  configured: Readonly<Record<ChatGptAnswerChoice, boolean>>,
): { config: SovereigntyConfig; changed: boolean } {
  if (choice.embedding === 'built_in' && !embeddingIsBuiltIn(config)) {
    throw new ModelChoiceRefusal('embedding_change_needs_approval');
  }
  if (!choice.answers || currentAnswerChoice(config) === choice.answers) return { config, changed: false };
  if (!configured[choice.answers]) throw new ModelChoiceRefusal('model_not_configured');
  const { id, profile } = ANSWER_PROFILES[choice.answers];
  const next = structuredClone(config);
  next.modelProfiles[id] = next.modelProfiles[id] ?? profile;
  for (const domain of DOMAINS) {
    const route = next.routes[domain];
    if (domain === 'secure_local' && route?.mode === 'disabled') continue;
    next.routes[domain] = { pool: { members: [id], order: [id] } };
  }
  return { config: validateSovereigntyConfig(next), changed: true };
}

