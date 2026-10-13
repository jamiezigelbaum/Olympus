import { AsyncLocalStorage } from 'node:async_hooks';

export interface DocumentDispatchProgress {
  state: 'reading' | 'summarizing' | 'writing' | 'answering';
  documentsRead: number;
  documentsTotal: number;
}

export interface DocumentDispatchObserver {
  /** Synchronous observation immediately before the actual model fetch. */
  onRequest(url: string, init: RequestInit): void;
  /** The complete live guard for this nesting level, without an execution signal. */
  onGuard(current: () => boolean): void;
  /** Counts only; never document text, identifiers, or request bodies. */
  onProgress?(progress: DocumentDispatchProgress): void;
}

interface DocumentDispatchContext {
  guards: readonly (() => boolean)[];
  observer?: DocumentDispatchObserver;
}

/** Per-request source fence and private observer, retained through every await. */
const documentDispatch = new AsyncLocalStorage<DocumentDispatchContext>();

export function runWithDocumentDispatch<T>(
  current: () => boolean,
  work: () => T,
  observer?: DocumentDispatchObserver,
): T {
  const parent = documentDispatch.getStore();
  const guards = [...(parent?.guards ?? []), current];
  const inheritedObserver = composeDocumentDispatchObservers(parent?.observer, observer);
  const combinedCurrent = () => guardsEveryCurrent(guards);
  inheritedObserver?.onGuard(combinedCurrent);
  return documentDispatch.run({ guards, ...(inheritedObserver ? { observer: inheritedObserver } : {}) }, work);
}

export function assertDocumentDispatchCurrent(): void {
  const context = documentDispatch.getStore();
  if (context && !guardsEveryCurrent(context.guards)) {
    throw new Error('Document authorization changed; nothing further was sent.');
  }
}

/** Called by model-transport after the final guard and immediately before fetch. */
export function observeDocumentDispatchRequest(url: string, init: RequestInit): void {
  documentDispatch.getStore()?.observer?.onRequest(url, init);
}

export function reportDocumentDigestProgress(progress: DocumentDispatchProgress): void {
  documentDispatch.getStore()?.observer?.onProgress?.(progress);
}

function guardsEveryCurrent(guards: readonly (() => boolean)[]): boolean {
  try { return guards.every((guard) => guard() === true); } catch { return false; }
}

function composeDocumentDispatchObservers(
  outer: DocumentDispatchObserver | undefined,
  inner: DocumentDispatchObserver | undefined,
): DocumentDispatchObserver | undefined {
  if (!outer) return inner;
  if (!inner || inner === outer) return outer;
  return {
    onRequest(url, init) {
      outer.onRequest(url, init);
      inner.onRequest(url, init);
    },
    onGuard(current) {
      outer.onGuard(current);
      inner.onGuard(current);
    },
    onProgress(progress) {
      outer.onProgress?.(progress);
      inner.onProgress?.(progress);
    },
  };
}
