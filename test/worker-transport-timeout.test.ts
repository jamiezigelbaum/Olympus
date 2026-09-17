import { describe, expect, test } from 'bun:test';
import { DirectHttpCastorWorkspaceTransport } from '../src/core/castor-workspace.ts';
import { DirectHttpEmailTransport, effectiveEmailRequestTimeoutMs } from '../src/core/email.ts';
import { DirectHttpFileDeliveryTransport } from '../src/core/file-delivery.ts';

interface WorkerTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

describe('direct worker HTTP transport timeouts', () => {
  test('a caller-declared budget raises the email lane timeout but never lowers it', async () => {
    expect(effectiveEmailRequestTimeoutMs(180_000, 600_000)).toBe(600_000);
    expect(effectiveEmailRequestTimeoutMs(180_000, 30_000)).toBe(180_000);
    expect(effectiveEmailRequestTimeoutMs(180_000, undefined)).toBe(180_000);
    expect(effectiveEmailRequestTimeoutMs(0, 600_000)).toBe(0);
    expect(effectiveEmailRequestTimeoutMs(180_000, Number.NaN)).toBe(180_000);

    const transport = new DirectHttpEmailTransport(hangingFetch('email'), 'worker-secret', 10);
    await expect(transport.requestJson('http://email.test/v1/source/answer', {
      method: 'POST',
      body: '{}',
    }, { timeoutMs: 40 })).rejects.toThrow('Private email lane timed out at http://email.test/v1/source/answer after 40ms.');
  });

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
      {
        name: 'file delivery',
        transport: new DirectHttpFileDeliveryTransport(hangingFetch('file delivery'), 'worker-secret', timeoutMs),
        url: 'http://file.test/v1/file/deliver',
        expectedMessage: `Bounded file-delivery worker timed out at http://file.test/v1/file/deliver after ${timeoutMs}ms.`,
      },
      {
        name: 'Castor workspace',
        transport: new DirectHttpCastorWorkspaceTransport(hangingFetch('Castor workspace'), 'worker-secret', timeoutMs),
        url: 'http://workspace.test/v1/workspace',
        expectedMessage: `Delegated workspace worker timed out at http://workspace.test/v1/workspace after ${timeoutMs}ms.`,
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
