import { countHeldItems } from './held-item-count.ts';
import type { HeldPass, HeldSample } from './held-item-status.ts';

declare const self: {
  onmessage: (event: { data: HeldPass }) => void;
  postMessage(value: HeldSample | 'scope_changed' | undefined): void;
};

self.onmessage = ({ data }) => {
  try {
    self.postMessage(countHeldItems(data, () => self.postMessage('scope_changed')));
  } catch {
    // A failed required group leaves the whole observation absent.
    self.postMessage(undefined);
  }
};
