// The bounded reader's cleanup contract.
//
// `fetchBoundedText` races the body read against a deadline. When the deadline
// wins, the read is still in flight and still holds the body's lock — and an
// `AbortSignal` only ends it if the peer honours the signal, which an
// in-process stream (a test double, a buffering proxy library) need not do.
// Without an explicit cancel the process is left with a pending read against a
// permanently locked stream: the leak Codex round 2 on 98d4a946 named.

import { describe, expect, test } from 'bun:test';
import {
  BoundedResponseTooLargeError,
  fetchBoundedText,
} from '../src/core/http-timeout.ts';

const URL_UNDER_TEST = 'https://token-endpoint.test/token';

/** A body that hands over one chunk and then never ends, ignoring the signal. */
function stalledBody(): { response: Response; cancels: () => number } {
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"access_token":"'));
      // ...and never closes, and never watches the abort signal.
    },
    cancel() {
      cancels += 1;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    cancels: () => cancels,
  };
}

describe('fetchBoundedText leaves no reader holding a body it abandoned', () => {
  test('a stalled body is cancelled and unlocked when the deadline wins', async () => {
    const { response, cancels } = stalledBody();
    await expect(fetchBoundedText(async () => response, URL_UNDER_TEST, {}, { timeoutMs: 50 }))
      .rejects.toThrow(/deadline/);

    // Cancelled explicitly, not merely signalled: this stream ignores the signal.
    expect(cancels()).toBe(1);
    // And the lock is gone, so the body is not stranded mid-read.
    expect(response.body?.locked).toBe(false);
  });

  test('an oversized body from a still-open stream is cancelled and unlocked too', async () => {
    // Deliberately left OPEN, the way a live peer mid-flood would be:
    // cancelling an already-closed stream is a spec no-op that never reaches
    // the source, so a closed one could not show that the cancel happened.
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('A'.repeat(80 * 1024)));
      },
      cancel() {
        cancels += 1;
      },
    });
    const response = new Response(stream, { status: 200 });

    await expect(fetchBoundedText(async () => response, URL_UNDER_TEST, {}, {
      timeoutMs: 5_000,
      limitBytes: 64 * 1024,
    })).rejects.toBeInstanceOf(BoundedResponseTooLargeError);

    expect(cancels).toBe(1);
    expect(response.body?.locked).toBe(false);
  });

  test('an ordinary read still returns its body and unlocks it', async () => {
    const payload = JSON.stringify({ access_token: 'tok', expires_in: 3599 });
    const response = new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });

    const result = await fetchBoundedText(async () => response, URL_UNDER_TEST, {}, { timeoutMs: 5_000 });

    expect(result.text).toBe(payload);
    expect(result.response.status).toBe(200);
    expect(response.body?.locked).toBe(false);
  });

  test('the deadlineless lane still caps, cancels, and unlocks', async () => {
    // No `timeoutMs` — the direct-provider refresh lane's shape. It has no
    // deadline to abandon a read, but the cap and the cleanup still apply.
    const { response, cancels } = stalledBody();

    await expect(fetchBoundedText(async () => response, URL_UNDER_TEST, {}, { limitBytes: 8 }))
      .rejects.toBeInstanceOf(BoundedResponseTooLargeError);

    expect(cancels()).toBe(1);
    expect(response.body?.locked).toBe(false);
  });
});
