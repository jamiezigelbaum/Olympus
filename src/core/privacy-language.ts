/** Display names only. Persisted schema-v1 keys and routing domains stay stable. */
export const SENSITIVITY_TIER_LABELS = {
  public: 'Public',
  private: 'Personal',
  secure: 'Private',
  secrets: 'Secrets',
} as const;

export const PRIVACY_PRESET_LABELS = {
  'local-first': 'Local models with Venice fallback',
  'local-only': 'Local models',
  'private-cloud-only': 'Venice',
  'no-sensitive': "Private answers only in Olympus",
} as const;

/** Shared first-run copy for both the dashboard and the ChatGPT setup panel. */
export const PRIVATE_ANSWER_OPTIONS = [
  { id: 'local-first', label: PRIVACY_PRESET_LABELS['local-first'], description: 'The built-in model answers on this computer. Venice can help only after you add a Venice key. Venice is a privacy-focused cloud provider whose policy says it does not retain conversations or train on them; it can read the content.', recommended: true },
  { id: 'local-only', label: PRIVACY_PRESET_LABELS['local-only'], description: 'The built-in model answers on this computer. You can connect your own local models; Private items stay on this computer.', recommended: false },
  { id: 'private-cloud-only', label: PRIVACY_PRESET_LABELS['private-cloud-only'], description: 'Use Venice for Private answers after you add its key. Venice is a privacy-focused cloud provider whose policy says it does not retain conversations or train on them; it can read the content.', recommended: false },
  { id: 'no-sensitive', label: PRIVACY_PRESET_LABELS['no-sensitive'], description: 'Search Private items and use Ask privately on this computer. Connected agents cannot use Private items to answer.', recommended: false },
] as const;

export type PrivateAnswerOptionId = typeof PRIVATE_ANSWER_OPTIONS[number]['id'];
export interface PrivateAnswerOption {
  id: PrivateAnswerOptionId;
  label: string;
  description: string;
  recommended: boolean;
  /** Why this one is recommended on this computer, when it is not the usual recommendation. */
  reason?: string;
}

/**
 * Below this much memory the local private model (about 3.5 GB on top of
 * Olympus, measured on test-mac 14 Nov 2026) does not fit beside the engine,
 * so first run recommends Venice instead. A recommendation only: the owner
 * may still pick a local mode, and nothing goes to Venice unless chosen.
 */
export const LOCAL_PRIVATE_MODEL_MIN_MEMORY_BYTES = 12 * 1024 ** 3;

/** The first-run choices for a computer with this much memory (os.totalmem() of the engine's machine). */
export function privateAnswerOptions(totalMemoryBytes: number): PrivateAnswerOption[] {
  const short = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 && totalMemoryBytes < LOCAL_PRIVATE_MODEL_MIN_MEMORY_BYTES;
  if (!short) return PRIVATE_ANSWER_OPTIONS.map((option) => ({ ...option }));
  const gb = Math.round(totalMemoryBytes / 1024 ** 3);
  return PRIVATE_ANSWER_OPTIONS.map((option) => option.id === 'private-cloud-only'
    ? { ...option, recommended: true, reason: `This computer has ${gb} GB of memory; the local private model needs about 3.5 GB on top of Olympus.` }
    : { ...option, recommended: false });
}
