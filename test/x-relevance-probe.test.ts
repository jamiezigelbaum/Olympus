import { describe, expect, test } from 'bun:test';
import { parseXRelevanceProbeArgs } from '../scripts/x-relevance-probe.ts';

describe('X relevance calibration probe', () => {
  test('refuses to run without an explicit connector-store database', () => {
    expect(() => parseXRelevanceProbeArgs([
      '--account',
      'personal',
      '--query',
      'calibration input',
    ])).toThrow('--db is required; the probe never selects a default store.');
  });

  test('accepts repeatable queries and an optional model override', () => {
    expect(parseXRelevanceProbeArgs([
      '--db=/tmp/x.sqlite',
      '--account',
      'personal',
      '--model-id',
      'gemini-embedding-2',
      '--query',
      'first calibration input',
      '--query=second calibration input',
    ])).toEqual({
      dbPath: '/tmp/x.sqlite',
      account: 'personal',
      modelId: 'gemini-embedding-2',
      queries: ['first calibration input', 'second calibration input'],
    });
  });
});
