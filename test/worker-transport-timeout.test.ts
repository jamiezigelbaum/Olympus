import { describe, expect, test } from 'bun:test';
import { DirectHttpEmailTransport } from '../src/core/email.ts';

interface WorkerTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

describe('direct worker HTTP transport timeouts', () => {
  test('abort hung worker fetches with product-specific timeout errors', async () => {
    const timeoutMs = 10;
    const cases: Array<{
      name: string;
      transport: WorkerTransport;
      url: string;
      expectedMessage: string;
    }> = [
      {
        name: 'email',
        transport: new DirectHttpEmailTransport(hangingFetch('email'), 'worker-secret', timeoutMs),
        url: 'http://email.test/v1/answer',
        expectedMessage: `Private email lane timed out at http://email.test/v1/answer after ${timeoutMs}ms.`,
      },
    ];

    for (const item of cases) {
      await expect(item.transport.requestJson(item.url, {
        method: 'POST',
        body: '{}',
      }), item.name).rejects.toThrow(item.expectedMessage);
    }
  });
});

function hangingFetch(name: string): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    const guard = setTimeout(() => {
      reject(new Error(`${name} fetch did not receive an abort signal`));
    }, 250);

    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(guard);
      reject(abortError());
      return;
    }

    signal.addEventListener('abort', () => {
      clearTimeout(guard);
      reject(abortError());
    }, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
