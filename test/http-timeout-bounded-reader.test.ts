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
  fetchWithBodyDeadline,
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

describe('fetchWithBodyDeadline', () => {
  test('a body that stalls and ignores the signal fails at the deadline and is cancelled', async () => {
    const { response, cancels } = stalledBody();
    const relayed = await fetchWithBodyDeadline(async () => response, URL_UNDER_TEST, {}, 30);
    const started = Date.now();
    const failure = await relayed.text().then(() => undefined, (error: unknown) => error);
    expect((failure as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancels()).toBe(1);
  });

  test('headers that never arrive fail at the deadline', async () => {
    const failure = await fetchWithBodyDeadline(() => new Promise<Response>(() => undefined), URL_UNDER_TEST, {}, 30)
      .then(() => undefined, (error: unknown) => error);
    expect((failure as Error).name).toBe('AbortError');
  });

  test('a body that finishes in time arrives whole, with its status and headers', async () => {
    const relayed = await fetchWithBodyDeadline(
      async () => new Response('{"entries":[]}', { status: 409, headers: { 'content-type': 'application/json' } }),
      URL_UNDER_TEST,
      {},
      1_000,
    );
    expect(relayed.status).toBe(409);
    expect(relayed.headers.get('content-type')).toBe('application/json');
    expect(await relayed.text()).toBe('{"entries":[]}');
  });
});

describe('a stalled body whose cancel never settles still fails at the deadline (PR #267 review, Astra round 2)', () => {
  function hungCancelBody(): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"')); },
      cancel() { return new Promise<void>(() => undefined); },
    }), { status: 200 });
  }

  test('fetchWithBodyDeadline', async () => {
    const relayed = await fetchWithBodyDeadline(async () => hungCancelBody(), URL_UNDER_TEST, {}, 30);
    const failure = await relayed.text().then(() => undefined, (error: unknown) => error);
    expect((failure as Error).name).toBe('AbortError');
  });

  test('fetchBoundedText', async () => {
    await expect(fetchBoundedText(async () => hungCancelBody(), URL_UNDER_TEST, {}, { timeoutMs: 30 }))
      .rejects.toThrow(/deadline/);
  });
});
