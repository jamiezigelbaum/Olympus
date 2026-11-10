/**
 * The engine split's front never writes a background-owned store
 * (docs/design/engine-split.md, part 3). The front's `main()` calls
 * forbidWritableStoreOpens() before anything mounts; from then on every
 * writable open of a connector store, tier ledger, sniffer store or
 * secret-locations index in that process throws instead of opening. With
 * the switch off nothing calls it and every open behaves as before.
 *
 * This is an assertion, not the mechanism: the front opens its stores
 * read-only on purpose, and this makes a missed path fail loudly at the open
 * rather than race the background's writer.
 */

export class FrontStoreWriteError extends Error {
  readonly code = 'front_store_write';
  constructor(kind: string) {
    super(`The engine front opened a ${kind} for writing; only the background process writes it.`);
    this.name = 'FrontStoreWriteError';
  }
}

let forbidden = false;

/** Called once by the front process, before any store opens. */
export function forbidWritableStoreOpens(): void {
  forbidden = true;
}

/** Whether this process is a front that must open stores read-only. */
export function writableStoreOpensForbidden(): boolean {
  return forbidden;
}

/** Each writable open of a background-owned store calls this first. `:memory:` stores are private to their caller. */
export function assertWritableStoreOpenAllowed(kind: string, dbPath: string): void {
  if (forbidden && dbPath !== ':memory:') throw new FrontStoreWriteError(kind);
}

/** Test seam: the guard is process-wide. */
export function resetStoreWriteGuardForTests(): void {
  forbidden = false;
}
