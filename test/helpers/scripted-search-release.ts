import { recordReleaseManifest, type ReleaseCheck } from '../../src/core/release-manifest.ts';

/** Scripted search fixtures still carry the identities of the Personal items they read. */
export function recordScriptedSearch<T extends Record<string, unknown>>(raw: T): T {
  const evidence = Array.isArray(raw.evidence) ? raw.evidence as Array<Record<string, unknown>> : [];
  recordReleaseManifest({
    inputs: evidence.filter((item) => item.trust_domain === 'internal' || item.trust_domain === 'public_safe').map((item) => ({
      corpusId: typeof item.corpus_id === 'string' ? item.corpus_id : '',
      provider: typeof item.provider === 'string' ? item.provider : '',
      accountScope: 'scripted-account',
      providerItemId: typeof item.provider_item_id === 'string' ? item.provider_item_id : '',
      privateAtAnswer: false,
    })),
    constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false },
  });
  return raw;
}

export const scriptedSearchReleaseCheck: ReleaseCheck = {
  inputs: (inputs) => inputs.map((item) => ({
    tier: item.accountScope === 'scripted-account' && item.corpusId && item.provider && item.providerItemId ? 'public_or_personal' : 'unknown',
    gone: false,
  })),
  secureDerivativeDefault: () => 'allow',
};
