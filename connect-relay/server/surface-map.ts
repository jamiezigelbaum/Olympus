/**
 * Which tool list each credential gets while its install is offline: the
 * mapping the install's engine confirms over its own authenticated session
 * (the `surfaces` feature, shared/protocol.ts). Keyed by install, endpoint
 * and the credential's surface fingerprint (shared/tokens.ts), with the
 * credential's expiry.
 *
 * - Only a session's own install is ever written: the relay stores a
 *   `surfaces` frame under the install that session authenticated as, so an
 *   install can shape nothing but its own credentials' offline answers, and a
 *   mapping no engine sent over its session is never trusted.
 * - Each frame replaces the install's whole set: a rotated token is added,
 *   and a revoked or expired one goes, as soon as the engine says so. An
 *   entry past its expiry is never served, whatever the engine last said.
 * - Content-free: fingerprints, a two-value surface, an endpoint and an
 *   expiry. No token, name, provider, connection or question.
 * - Bounded: MAX_SURFACE_ENTRIES per install, and `maxEntries` across the
 *   relay (the installs that synced longest ago are dropped first).
 * - Memory only. An access token lives an hour, so a mapping is useful for
 *   at most an hour after its install goes offline; after a relay restart an
 *   install that has not come back gets the remote list for its credentials
 *   until it reconnects and syncs again.
 *
 * Whether an install has synced at all is kept too, apart from its entries:
 * a relay serving an engine that predates the feature falls back to the
 * per-credential surface the engine marked on its responses (limits.ts
 * ConfirmedCredentials); one that syncs never does, so a revocation is not
 * undone by an older mark. That state outlives the eviction of the
 * install's entries and lasts as long as its registration (cleared on
 * revocation and registration expiry, `remove`); it is bounded by
 * `maxSyncedInstalls`, the registry's own bound by default.
 */
import { MAX_SURFACE_ENTRIES, type SurfaceEndpoint, type SurfaceEntry } from '../shared/protocol.ts';
import type { CredentialSurface } from '../shared/tokens.ts';

interface InstallMap {
  /** `<endpoint>\0<fingerprint>` → surface and expiry (ms). */
  readonly entries: Map<string, { surface: CredentialSurface; expiresAtMs: number }>;
}

/** Default bound across the relay; an install holds at most MAX_SURFACE_ENTRIES of it. */
export const DEFAULT_MAX_SURFACE_MAP_ENTRIES = 200_000;
/** Default bound on installs remembered as synced: the registry's own bound (registry.ts maxInstalls). */
export const DEFAULT_MAX_SYNCED_INSTALLS = 100_000;

export class SurfaceMap {
  /** Insertion order is sync order: the first install synced longest ago. */
  private readonly installs = new Map<string, InstallMap>();
  /** Installs whose engine has synced, oldest sync first; kept when their entries are evicted. */
  private readonly syncedInstalls = new Set<string>();
  private total = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_SURFACE_MAP_ENTRIES,
    private readonly now: () => number = Date.now,
    private readonly maxSyncedInstalls = DEFAULT_MAX_SYNCED_INSTALLS,
  ) {}

  /**
   * Replaces `installId`'s mapping with `entries` (already parsed by
   * parseSurfacesMessage). Entries already expired are dropped; beyond
   * MAX_SURFACE_ENTRIES the latest-expiring are kept.
   */
  replace(installId: string, entries: readonly SurfaceEntry[]): void {
    const at = this.now();
    const live = entries
      .map((entry) => ({ entry, expiresAtMs: entry.expiresAt * 1000 }))
      .filter(({ expiresAtMs }) => expiresAtMs > at)
      .sort((a, b) => b.expiresAtMs - a.expiresAtMs)
      .slice(0, MAX_SURFACE_ENTRIES);
    this.dropEntries(installId);
    this.syncedInstalls.delete(installId);
    this.syncedInstalls.add(installId);
    while (this.syncedInstalls.size > this.maxSyncedInstalls) {
      const oldest = this.syncedInstalls.values().next().value;
      if (oldest === undefined || oldest === installId) break;
      this.remove(oldest);
    }
    const map: InstallMap = { entries: new Map() };
    for (const { entry, expiresAtMs } of live) {
      map.entries.set(key(entry.endpoint, entry.fingerprint), { surface: entry.surface, expiresAtMs });
    }
    this.installs.set(installId, map);
    this.total += map.entries.size;
    while (this.total > this.maxEntries) {
      const oldest = this.installs.keys().next().value;
      if (oldest === undefined || oldest === installId) break;
      // Its entries go; that it synced stays.
      this.dropEntries(oldest);
    }
  }

  /** Whether this install's engine has synced a mapping (an empty one included). */
  synced(installId: string): boolean {
    return this.syncedInstalls.has(installId);
  }

  /** The surface the engine named for this credential, while it has not expired. */
  lookup(installId: string, endpoint: SurfaceEndpoint, fingerprint: string): CredentialSurface | undefined {
    const map = this.installs.get(installId);
    if (!map) return undefined;
    const k = key(endpoint, fingerprint);
    const entry = map.entries.get(k);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      map.entries.delete(k);
      this.total -= 1;
      return undefined;
    }
    return entry.surface;
  }

  /** Forgets an install, synced state included (revoked by the operator, or its registration expired). */
  remove(installId: string): void {
    this.dropEntries(installId);
    this.syncedInstalls.delete(installId);
  }

  private dropEntries(installId: string): void {
    const map = this.installs.get(installId);
    if (!map) return;
    this.total -= map.entries.size;
    this.installs.delete(installId);
  }

  /** Drops every expired entry. */
  sweep(): void {
    const at = this.now();
    for (const map of this.installs.values()) {
      for (const [k, entry] of map.entries) {
        if (entry.expiresAtMs > at) continue;
        map.entries.delete(k);
        this.total -= 1;
      }
    }
  }

  /** Counts only: names no install. */
  counts(): { installs: number; entries: number } {
    return { installs: this.installs.size, entries: this.total };
  }

  /**
   * Everything held, for tests that check what the relay keeps: per install,
   * the stored values exactly (there is nothing else).
   */
  snapshot(): Array<{ installId: string; entries: Array<{ endpoint: string; fingerprint: string; surface: CredentialSurface; expiresAtMs: number }> }> {
    return [...this.installs].map(([installId, map]) => ({
      installId,
      entries: [...map.entries].map(([k, entry]) => {
        const [endpoint, fingerprint] = k.split('\u0000') as [string, string];
        return { endpoint, fingerprint, surface: entry.surface, expiresAtMs: entry.expiresAtMs };
      }),
    }));
  }
}

function key(endpoint: SurfaceEndpoint, fingerprint: string): string {
  return `${endpoint}\u0000${fingerprint}`;
}
