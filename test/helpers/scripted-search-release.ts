import { createHash } from 'node:crypto';
import type { LocalContentProvider, LocalContentProviderMap } from '../../src/core/evidence-pack.ts';
import { recordReleaseManifest, releasedTextDigest, type ChunkReleaseResult, type ReleaseCheck, type ReleaseInput } from '../../src/core/release-manifest.ts';

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
      chunkHashes: [`${String(item.provider_item_id)}-chunk`],
      ...(typeof item.excerpt === 'string' && item.excerpt ? { releasedTextDigest: releasedTextDigest(item.excerpt) } : {}),
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
  chunks: provedChunks,
  secureDerivativeDefault: () => 'allow',
};

/** Scripted fixtures read their passages whole: every hash an input names is proved read. */
export async function provedChunks(inputs: readonly ReleaseInput[]): Promise<ChunkReleaseResult> {
  return { allowed: inputs.map((input) => input.chunkHashes ?? []), withheldPassages: 0, withheldDocuments: 0 };
}

/** For fixtures with no tier ledger: every input is Personal and every passage it names was read. */
export const provedReleaseCheck: ReleaseCheck = {
  inputs: (inputs) => inputs.map(() => ({ tier: 'public_or_personal', gone: false })),
  chunks: provedChunks,
  secureDerivativeDefault: () => 'allow',
};

/**
 * Fixture content providers return passages with no stored chunk behind
 * them. This gives each passage a stable hash, as a store's provider does,
 * so a proved release check can clear it for the cloud leg.
 */
export function provedContent(providers: LocalContentProviderMap): LocalContentProviderMap {
  return Object.fromEntries(Object.entries(providers).map(([corpusId, provider]) => [corpusId, provider && {
    ...provider,
    fetchLocalContent: async (request: Parameters<LocalContentProvider['fetchLocalContent']>[0]) => {
      const block = await provider.fetchLocalContent(request);
      return block && !block.chunkHashes
        ? { ...block, chunkHashes: block.chunks.map((text) => [`fixture:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`]) }
        : block;
    },
  }]));
}
