import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request source fence, retained through catalog/readiness awaits. */
const documentDispatch = new AsyncLocalStorage<() => boolean>();
export function runWithDocumentDispatch<T>(current: () => boolean, work: () => T): T {
  return documentDispatch.run(current, work);
}
export function assertDocumentDispatchCurrent(): void {
  const current = documentDispatch.getStore();
  if (current && current() !== true) throw new Error('Document authorization changed; nothing further was sent.');
}
