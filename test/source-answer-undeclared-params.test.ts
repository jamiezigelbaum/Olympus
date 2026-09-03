import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

describe('source_answer undeclared parameters', () => {
  test('a narrowing parameter source_answer does not declare is refused, not dropped', async () => {
    const calls: unknown[] = [];
    const sourceAnswer = operations.find((operation) => operation.name === 'source_answer')!;

    // `after`/`folder_name` are spellings source_index_search teaches. Dropping
    // them silently answers over the whole corpus while the caller believes the
    // question was scoped.
    await expect(sourceAnswer.handler(contextRecording(calls), {
      question: 'What did we decide in July?',
      corpus_id: 'internal.telegram.messages',
      after: '2026-07-01',
      folder_name: 'reading',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Source answer request contains undeclared properties: "after", "folder_name". Remove them and retry.',
    });
    expect(calls).toEqual([]);
  });

  test('the declared parameter set still reaches the private source lane', async () => {
    const calls: unknown[] = [];
    const sourceAnswer = operations.find((operation) => operation.name === 'source_answer')!;

    await sourceAnswer.handler(contextRecording(calls), {
      question: 'What did we decide in July?',
      corpus_id: 'internal.telegram.messages',
      authored_after: '2026-07-01T00:00:00.000Z',
    });

    expect(calls[0]).toMatchObject({
      question: 'What did we decide in July?',
      corpusId: 'internal.telegram.messages',
      authoredAfter: '2026-07-01T00:00:00.000Z',
    });
  });
});

function contextRecording(calls: unknown[]): OperationContext {
  return {
    config: defaultConfig(),
    delphi: {} as OperationContext['delphi'],
    email: {
      sourceAnswer: async (options: unknown) => {
        calls.push(options);
        return {
          answer: 'I found 1 safe source result with provenance.',
          evidence: [],
          audit: {
            searched_corpora: ['internal.telegram.messages'],
            skipped_corpora: [],
            lane_audits: [],
            latency_ms: 1,
            raw_source_exposed: false,
          },
          policy: {
            raw_source_exposed: false,
            source_packets_exposed: false,
            internal_content_exposed: true,
            secure_local_content_exposed: false,
            castor_safe_bridge: true,
          },
        };
      },
    } as unknown as OperationContext['email'],
  };
}
