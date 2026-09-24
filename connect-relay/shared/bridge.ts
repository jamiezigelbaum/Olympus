import type { Duplex } from 'node:stream';

/** How long a half-closed bridge may take to drain before both sides are torn down. */
const DRAIN_GRACE_MS = 30_000;

/**
 * When one side of a bridge closes, the other side is *ended*, not destroyed:
 * bytes already queued for a slow reader are still delivered (destroying
 * would drop them). An error on either side tears both down immediately, and
 * a half-closed bridge that does not drain in time is torn down too.
 */
export function propagateClose(a: Duplex, b: Duplex): void {
  const destroyBoth = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', destroyBoth);
  b.on('error', destroyBoth);
  const onClose = (other: Duplex) => () => {
    if (other.destroyed) return;
    other.end();
    setTimeout(() => other.destroy(), DRAIN_GRACE_MS).unref();
  };
  a.once('close', onClose(b));
  b.once('close', onClose(a));
}
