import { expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { requestDashboardTool } from '../src/core/control-ui-gateway.ts';
import { fetchBoundedText, fetchWithBodyDeadline } from '../src/core/http-timeout.ts';
import { readBoundedRequestText } from '../src/workers/remote-request-body.ts';

// Observe the actual reader result as well as its bytes. Bounded text readers
// deliberately retain bytes for decoding, but no reader needs old result
// wrappers. A long-lived Promise.race retains both until its deadline settles.
function heldSecondRead() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pending!: () => void;
  const secondRead = new Promise<void>((resolve) => { pending = resolve; });
  let firstResult: WeakRef<object> | undefined;
  let firstChunk: WeakRef<Uint8Array> | undefined;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (++pulls === 1) {
        const chunk = new TextEncoder().encode('{"content":[]}');
        firstChunk = new WeakRef(chunk);
        controller.enqueue(chunk);
      } else {
        pending();
        await gate;
        controller.enqueue(new TextEncoder().encode(' '));
        controller.close();
      }
    },
  }, { highWaterMark: 0 });
  const getReader = body.getReader.bind(body);
  body.getReader = (() => {
    const reader = getReader();
    const read = reader.read.bind(reader);
    reader.read = (() => read().then((result) => {
      firstResult ??= new WeakRef(result);
      return result;
    })) as typeof reader.read;
    return reader;
  }) as typeof body.getReader;
  return { body, secondRead, release, result: () => firstResult?.deref(), chunk: () => firstChunk?.deref() };
}

for (const kind of ['body deadline', 'bounded response', 'dashboard', 'request body'] as const) {
  test(`${kind} releases the previous read result while the next read is pending`, async () => {
    const fixture = heldSecondRead();
    const config = defaultConfig();
    config.worker.authToken = 'synthetic-token';
    config.email.baseUrl = 'https://test/worker';
    const response = new Response(fixture.body);
    const done = (async () => {
      switch (kind) {
        case 'body deadline': {
          const relayed = await fetchWithBodyDeadline(async () => response, 'https://test/body', {}, 60_000);
          // Decode incrementally so the consumer itself does not retain chunks.
          let text = '';
          const reader = relayed.body!.getReader();
          while (await reader.read().then(({ done, value }) => {
            if (done) return false;
            text += new TextDecoder().decode(value);
            return true;
          })) { /* Only a boolean crosses the await, never a chunk. */ }
          reader.releaseLock();
          expect(text).toBe('{"content":[]} ');
          break;
        }
        case 'bounded response':
          expect((await fetchBoundedText(async () => response, 'https://test/body', {}, { timeoutMs: 60_000 })).text)
            .toBe('{"content":[]} ');
          break;
        case 'dashboard':
          expect(await requestDashboardTool({
            call: { name: 'olympus_dashboard', arguments: {} },
            config,
            timeoutMs: 60_000, fetchImpl: async () => response,
          })).toEqual({ content: [] });
          break;
        case 'request body':
          expect(await readBoundedRequestText(new Request('https://test/body', { method: 'POST', body: fixture.body }), 1024, { deadlineMs: 60_000 }))
            .toEqual({ ok: true, text: '{"content":[]} ' });
      }
    })();
    try {
      await fixture.secondRead;
      for (let round = 0; round < 3; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        Bun.gc(true);
      }
      expect(fixture.result()).toBeUndefined();
      if (kind === 'body deadline' || kind === 'dashboard') expect(fixture.chunk()).toBeUndefined();
    } finally {
      fixture.release();
      await done;
    }
  });
}
