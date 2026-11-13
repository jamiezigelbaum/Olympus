import { randomBytes } from 'node:crypto';
import type { SourceAnswerSelectedItemOption } from './email.ts';
import { sourceItemReadSelectedItem } from './source-index/selected-items.ts';

/** Only the remote MCP handler supplies these connection-bound capabilities. */
export interface RemoteReadHandleScope {
  issueReadHandle: (item: Readonly<Record<string, unknown>>) => string | undefined;
  resolveReadHandle: (handle: unknown) => SourceAnswerSelectedItemOption | undefined;
}

const TTL_MS = 30 * 60 * 1000;
interface Entry extends SourceAnswerSelectedItemOption {
  connectionId: string;
  expiresAt: number;
}

/** Process memory only; tokens contain no identity or privacy verdict. */
export class RemoteReadHandleStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 5_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new Error('Invalid read handle capacity.');
  }

  forConnection(connectionId: string): RemoteReadHandleScope {
    return {
      issueReadHandle: (item) => {
        if (item.trust_domain !== 'internal' && item.trust_domain !== 'public_safe') return undefined;
        // Copy only the identity needed by the existing read route. No text,
        // labels, source paths or cached tiers live in the map.
        let selected: SourceAnswerSelectedItemOption;
        try {
          selected = sourceItemReadSelectedItem({
            corpus_id: item.corpus_id, family: item.family, provider: item.provider,
            account_scope: item.account_scope, provider_item_id: item.provider_item_id,
            local_item_id: item.local_item_id,
            ...(item.provider_conversation_id ? { provider_conversation_id: item.provider_conversation_id } : {}),
          });
        } catch { return undefined; }
        const now = this.now();
        for (const [handle, entry] of this.entries) {
          if (entry.expiresAt <= now) this.entries.delete(handle);
        }
        while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
        const handle = `rh_${randomBytes(24).toString('base64url')}`;
        this.entries.set(handle, { ...selected, connectionId, expiresAt: now + TTL_MS });
        return handle;
      },
      resolveReadHandle: (handle) => {
        if (typeof handle !== 'string') return undefined;
        const entry = this.entries.get(handle);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) { this.entries.delete(handle); return undefined; }
        if (entry.connectionId !== connectionId) return undefined;
        const { connectionId: _connectionId, expiresAt: _expiresAt, ...selected } = entry;
        return selected;
      },
    };
  }
}
