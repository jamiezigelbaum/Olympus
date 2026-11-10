/**
 * The dashboard's progress history as the engine split's front sees it. The
 * background owns `source-dashboard.sqlite`; the front reads progress from a
 * read-only open and hands each render's count samples to the background
 * (`dashboard_samples`), which records them. No sample text exists: a
 * sample is ids, a time and counts.
 */
import { existsSync } from 'node:fs';
import { SqliteSourceDashboardHistory, type SourceDashboardHistory, type SourceDashboardHistorySample } from '../source-dashboard.ts';
import type { EngineCommandClient } from './client.ts';

export function createFrontDashboardHistory(input: {
  path: string;
  client: Pick<EngineCommandClient, 'post'>;
  /** Samples are sent at most this often; the background records one batch per interval. */
  minIntervalMs?: number;
  now?: () => number;
}): SourceDashboardHistory {
  const now = input.now ?? (() => Date.now());
  const minIntervalMs = input.minIntervalMs ?? 30_000;
  let reader: SqliteSourceDashboardHistory | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  const read = (): SqliteSourceDashboardHistory | undefined => {
    if (!reader && existsSync(input.path)) {
      try { reader = new SqliteSourceDashboardHistory(input.path, { readOnly: true }); }
      catch { reader = undefined; }
    }
    return reader;
  };
  return {
    record(samples: SourceDashboardHistorySample[]) {
      if (samples.length === 0 || now() - lastSent < minIntervalMs) return;
      lastSent = now();
      void input.client.post({ kind: 'dashboard_samples', samples: samples as unknown as Record<string, unknown>[] }).catch(() => undefined);
    },
    progressFor: (sample, at) => read()?.progressFor(sample, at),
    movementFor: (sample, at) => read()?.movementFor(sample, at),
    sampleCount: () => read()?.sampleCount() ?? 0,
  };
}
