import { describe, expect, test } from 'bun:test';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import { createAnalystQueryPlanner } from '../src/core/query-planner.ts';
import {
  createSourceAnswerTrace,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';

function modelReturning(text: string, requests?: AnalystModelRequest[]): AnalystModel {
  return {
    async complete(request) {
      requests?.push(request);
      return { text, modelId: 'fake-planner' };
    },
  };
}

describe('createAnalystQueryPlanner', () => {
  test('parses a JSON array of query strings', async () => {
    const plan = createAnalystQueryPlanner(
      modelReturning('["2024 lab results", "2025 lab results", "lab comparison"]'),
    );
    expect(await plan('How do the labs compare?')).toEqual([
      '2024 lab results',
      '2025 lab results',
      'lab comparison',
    ]);
  });

  test('strips code fences and surrounding prose before parsing', async () => {
    const plan = createAnalystQueryPlanner(
      modelReturning('Here you go:\n```json\n["alpha", "beta"]\n```\nHope that helps!'),
    );
    expect(await plan('q')).toEqual(['alpha', 'beta']);
  });

  test('drops blanks, non-strings, and duplicates, and caps at 3 queries', async () => {
    const plan = createAnalystQueryPlanner(
      modelReturning('["a", "a", "  ", 7, null, "b", "c", "d"]'),
    );
    expect(await plan('q')).toEqual(['a', 'b', 'c']);
  });

  test('fails open to [] on non-JSON garbage', async () => {
    const plan = createAnalystQueryPlanner(modelReturning('no queries today, sorry'));
    expect(await plan('q')).toEqual([]);
  });

  test('fails open to [] on a JSON value that is not an array of strings', async () => {
    const plan = createAnalystQueryPlanner(modelReturning('{"queries": "a"}'));
    expect(await plan('q')).toEqual([]);
  });

  test('fails open to [] on malformed bracketed text', async () => {
    const plan = createAnalystQueryPlanner(modelReturning('["unterminated, oops]'));
    expect(await plan('q')).toEqual([]);
  });

  test('fails open to [] when the model throws', async () => {
    const plan = createAnalystQueryPlanner({
      async complete() {
        throw new Error('lane down');
      },
    });
    expect(await plan('q')).toEqual([]);
  });

  test('marks the trace when it fails open, so a dead lane is not read as "nothing to add"', async () => {
    const trace = createSourceAnswerTrace();
    await runWithSourceAnswerTrace(trace, async () => {
      const plan = createAnalystQueryPlanner({
        async complete() {
          throw new Error('lane down');
        },
      });
      expect(await plan('q')).toEqual([]);
    });

    const snapshot = snapshotSourceAnswerTrace(trace);
    expect(snapshot.queryPlannerFailedCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('lane down');
  });

  test('a successful plan records no failure', async () => {
    const trace = createSourceAnswerTrace();
    await runWithSourceAnswerTrace(trace, async () => {
      const plan = createAnalystQueryPlanner(modelReturning('["a"]'));
      expect(await plan('q')).toEqual(['a']);
    });

    const snapshot = snapshotSourceAnswerTrace(trace);
    expect(snapshot.queryPlannerFailedCount).toBe(0);
    expect(snapshot.queryFormulationCount).toBe(1);
  });

  test('sends the question with the one generic prompt, local-only', async () => {
    const requests: AnalystModelRequest[] = [];
    const plan = createAnalystQueryPlanner(modelReturning('["a"]', requests));
    await plan('What changed between the two reports?');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toBe('What changed between the two reports?');
    expect(requests[0]!.system).toContain('up to 3 short, diverse search queries');
    expect(requests[0]!.system).toContain('ONLY a JSON array of strings');
    expect(requests[0]!.localOnly).toBe(true);
  });
});
