/**
 * The owner's model choices on Privacy rules (owner, 2026-11-07): which local
 * model answers Private questions, which Venice model, and which zkAPI model,
 * each with "Always the strongest" where the provider has one.
 *
 * - Pinned models live where the runtime already reads them: the sovereignty
 *   profiles (`local-source-answer`, `venice-private`) and the consult
 *   settings' zkAPI model. This file holds only what those cannot say: that a
 *   model follows the provider's strongest, and the built-in model size.
 * - The state file sits beside the policy, like the computer-use choice
 *   (first-run-privacy.ts), and is written atomically and privately.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import type { VenicePrivacyCategory } from './venice-models.ts';

export const STRONGEST_MODEL = 'strongest';
export const BUILT_IN_SIZES = ['small', 'standard', 'large'] as const;
export type BuiltInSize = typeof BUILT_IN_SIZES[number];
export type ModelChoiceProvider = 'local' | 'venice' | 'zkapi';

export interface ModelChoicesState {
  schema: 'olympus.model-choices.v1';
  /** The built-in model's size; absent: chosen by memory. The worker env still wins. */
  builtIn?: BuiltInSize;
  /** Absent means pinned for an existing install; new choices write it explicitly. */
  venice?: 'strongest' | 'pinned';
  /** Same for the zkAPI profile; "strongest" follows the release's default zkAPI model. */
  zkapi?: 'strongest' | 'pinned';
}

export function modelChoicesPath(policyPath: string): string {
  return join(dirname(policyPath), 'model-choices.json');
}

export function readModelChoices(policyPath: string): ModelChoicesState {
  try {
    const value = JSON.parse(readFileSync(modelChoicesPath(policyPath), 'utf8')) as Record<string, unknown>;
    if (value?.schema !== 'olympus.model-choices.v1') return { schema: 'olympus.model-choices.v1' };
    return {
      schema: 'olympus.model-choices.v1',
      ...(BUILT_IN_SIZES.includes(value.builtIn as BuiltInSize) ? { builtIn: value.builtIn as BuiltInSize } : {}),
      ...(value.venice === 'strongest' || value.venice === 'pinned' ? { venice: value.venice } : {}),
      ...(value.zkapi === 'strongest' || value.zkapi === 'pinned' ? { zkapi: value.zkapi } : {}),
    };
  } catch {
    return { schema: 'olympus.model-choices.v1' };
  }
}

export function writeModelChoices(policyPath: string, patch: Partial<Omit<ModelChoicesState, 'schema'>>): ModelChoicesState {
  const next: ModelChoicesState = { ...readModelChoices(policyPath), ...patch, schema: 'olympus.model-choices.v1' };
  writePrivateFileAtomicSync(modelChoicesPath(policyPath), JSON.stringify(next) + '\n');
  return next;
}

/**
 * The built-in size the worker should run: the environment's own choice
 * first (an operator's pin), then the owner's saved choice, else memory.
 */
export function builtInModelEnvValue(env: Record<string, string | undefined>, state: ModelChoicesState): string | undefined {
  return env.OLYMPUS_BUILT_IN_ANALYST_MODEL?.trim() || state.builtIn;
}

/**
 * Venice's traits, in the order "strongest" prefers them. Venice publishes a
 * trait to model map at `/models/traits`; a trait whose model is not a
 * private or TEE model is skipped, so "strongest" never leaves Private
 * models.
 */
export const VENICE_STRONGEST_TRAITS = ['highest_quality', 'default_reasoning'] as const;
const PRIVATE_CATEGORIES: readonly VenicePrivacyCategory[] = ['private', 'tee'];

export async function resolveVeniceStrongest(input: {
  apiKey: string;
  baseUrl: string;
  category: (modelId: string) => Promise<VenicePrivacyCategory | undefined>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const fetchImpl = input.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  let traits: Record<string, unknown>;
  try {
    const response = await fetchImpl(`${input.baseUrl.replace(/\/+$/, '')}/models/traits?type=text`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: unknown };
    if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return undefined;
    traits = body.data as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const trait of VENICE_STRONGEST_TRAITS) {
    const id = traits[trait];
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(id)) continue;
    const category = await input.category(id).catch(() => undefined);
    if (category && PRIVATE_CATEGORIES.includes(category)) return id;
  }
  return undefined;
}

/** One radio in a picker. */
export interface ModelChoiceOption {
  /** What the form submits: a model id, `strongest`, or `builtin:<size>`. */
  value: string;
  label: string;
  note?: string;
}

/** A provider's picker, as Privacy rules shows it. */
export interface ModelChoiceList {
  provider: ModelChoiceProvider;
  /** The option in use. */
  current: string;
  /** The model "Always the strongest" runs now, when it is in use. */
  strongestNow?: string;
  options: ModelChoiceOption[];
}

export interface DashboardModelChoices {
  local?: ModelChoiceList;
  venice?: ModelChoiceList;
  zkapi?: ModelChoiceList;
}

/** Venice models a person can add: private and TEE text models only, sorted. */
export function addableVeniceModels(catalog: Readonly<Record<string, VenicePrivacyCategory>>): string[] {
  return Object.entries(catalog)
    .filter(([, category]) => PRIVATE_CATEGORIES.includes(category))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

/** A model id a form may submit: no spaces, no control characters, bounded. */
export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(value);
}
