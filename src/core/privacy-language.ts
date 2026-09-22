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
  'no-sensitive': "Don't ingest Private data",
} as const;
