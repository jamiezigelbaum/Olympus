// The second thread's half of secret-scan-off-thread.ts: scans one text for
// secret finding kinds and answers with the kinds only, never the text.
// Bundled on its own as dist/secret-scan-worker.js and started as a Bun Worker.

import { scanSecretFindingKinds } from './engine.ts';

declare const self: {
  onmessage: ((event: { data: { id: number; text: string } }) => void) | null;
  postMessage(message: unknown): void;
};

self.onmessage = (event) => {
  const { id, text } = event.data;
  try {
    self.postMessage({ id, ok: true, kinds: scanSecretFindingKinds(text) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
