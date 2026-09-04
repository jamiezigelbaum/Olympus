import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/operation-error.ts';
import {
  EMAIL_CONNECTOR_NOT_CONNECTED_DETAIL,
  GogcliEmailConnectorStub,
  createEmailSourceWorker,
  type EmailSourceConnector,
} from '../src/workers/email-source/index.ts';

function connector(): EmailSourceConnector {
  return {
    name: 'canonical-test-connector',
    async health() {
      return {
        reachable: true,
        configured: true,
        connector: 'canonical-test-connector',
        raw_email_exposed: false,
      };
    },
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://worker.test/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('canonical source worker', () => {
  test('serves deep connector health without exposing source content', async () => {
    const worker = createEmailSourceWorker({ connector: connector() });
    const response = await worker.fetch(
      new Request('http://worker.test/v1/health?deep=true'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      reachable: true,
      configured: true,
      connector: 'canonical-test-connector',
      raw_email_exposed: false,
    });
    expect(JSON.stringify(body)).not.toContain('message_body');
  });

  test('says no account is connected, not that an internal component is unwired', async () => {
    // worker status leaked "gogcli is not wired yet. Configure the Gateway-side
    // connector before enabling email answers." on a clean install: an internal
    // component and a Gateway the reader does not have (clean-install
    // rehearsal, 2026-09-05).
    const worker = createEmailSourceWorker({ connector: new GogcliEmailConnectorStub() });
    for (const url of ['http://worker.test/v1/health', 'http://worker.test/v1/health?deep=true']) {
      const body = await (await worker.fetch(new Request(url))).json() as Record<string, unknown>;
      expect(body.configured).toBe(false);
      expect(body.detail).toBe(EMAIL_CONNECTOR_NOT_CONNECTED_DETAIL);
      expect(JSON.stringify(body)).not.toContain('gogcli is not wired');
      expect(JSON.stringify(body)).not.toContain('Gateway-side');
    }
  });

  test('routes every answer through the source-neutral answer handler', async () => {
    const requests: unknown[] = [];
    const worker = createEmailSourceWorker({
      connector: connector(),
      sourceAnswer: {
        async answer(request) {
          requests.push(request);
          return {
            kind: 'source_index_answer',
            answer: 'Evidence-backed fixture.',
            citations: [],
            gaps: [],
            policy: { raw_source_exposed: false },
          } as never;
        },
      },
    });

    const response = await worker.fetch(post('/source/answer', {
      question: 'What is in the canonical corpus?',
      corpus_id: 'internal.gmail.email',
    }));

    expect(response.status).toBe(200);
    expect(requests).toEqual([{
      question: 'What is in the canonical corpus?',
      corpus_id: 'internal.gmail.email',
    }]);
    expect(await response.json()).toMatchObject({
      kind: 'source_index_answer',
      answer: 'Evidence-backed fixture.',
    });
  });

  test('returns a typed refusal when no canonical answer handler is mounted', async () => {
    const response = await createEmailSourceWorker({ connector: connector() })
      .fetch(post('/source/answer', { question: 'Unavailable fixture.' }));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: 'source_index_answer_not_supported' },
      policy: { raw_email_exposed: false },
    });
  });

  test('maps sovereignty policy violations without leaking evidence', async () => {
    const worker = createEmailSourceWorker({
      connector: connector(),
      sourceAnswer: {
        async answer() {
          throw new OperationError(
            'source_index_policy_violation',
            'The requested analyst is not eligible for secure-local evidence.',
          );
        },
      },
    });

    const response = await worker.fetch(post('/source/answer', {
      question: 'Policy refusal fixture.',
      corpus_id: 'secure_local.dropbox.files',
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'source_index_policy_violation',
        message: 'The requested analyst is not eligible for secure-local evidence.',
      },
      policy: { raw_email_exposed: false },
    });
  });

  test('does not revive the removed family-specific answer endpoint', async () => {
    const response = await createEmailSourceWorker({ connector: connector() })
      .fetch(post('/answer', { question: 'Legacy endpoint fixture.' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'not_found' },
    });
  });
});
