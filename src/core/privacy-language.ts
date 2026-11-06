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
