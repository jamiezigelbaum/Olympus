// bun run eval:classification            deterministic fake sniffer (CI)
// bun run eval:classification -- --real  the configured private lane (local model or Venice Private)
//
// Prints the report as JSON and exits 1 when a hard gate fails. The real run
// sends only the synthetic corpus, and only to a lane the sniffer lane
// resolver admits; a standard-cloud lane is refused before any call.

import { createDelphiAnalystModel } from '../../src/core/analyst-delphi.ts';
import { createVeniceAnalystModel } from '../../src/core/analyst-venice.ts';
import type { AnalystModel } from '../../src/core/analyst.ts';
import { loadConfig } from '../../src/core/config.ts';
import { DelphiClient } from '../../src/core/delphi.ts';
import { loadSovereigntyEngine } from '../../src/core/sovereignty.ts';
import { resolveSnifferLane, type SnifferLane } from '../../src/workers/classification/sniffer-lane.ts';
import { createFakeSnifferModel } from './fake-sniffer.ts';
import { runClassificationEval } from './run.ts';

const FAKE_LANE: SnifferLane = {
  kind: 'local',
  modelId: 'eval-fake-sniffer',
  profileId: 'eval-fake-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'eval-fake-sniffer' },
};

async function main(): Promise<void> {
  const real = process.argv.includes('--real');
  const { lane, model, label } = real ? realSniffer() : { lane: FAKE_LANE, model: createFakeSnifferModel(), label: 'fake (deterministic)' };
  const started = Date.now();
  const report = await runClassificationEval({ lane, model, label });
  console.log(JSON.stringify({ ...report, elapsed_ms: Date.now() - started }, null, 2));
  if (!report.gates.passed) process.exit(1);
}

function realSniffer(): { lane: SnifferLane; model: AnalystModel; label: string } {
  const lane = resolveSnifferLane(loadSovereigntyEngine({ env: process.env }));
  const profile = lane.profile;
  if (lane.kind === 'local' && profile.provider === 'local-openai-compatible' && profile.baseUrl) {
    const config = structuredClone(loadConfig());
    config.argus.modelProfiles.source_answer = {
      ...config.argus.modelProfiles.source_answer,
      baseUrl: profile.baseUrl,
      model: profile.model,
      purpose: 'text_reasoning',
    };
    return {
      lane,
      model: createDelphiAnalystModel(new DelphiClient(config), { profile: 'source_answer', preflightTimeoutMs: 5_000 }),
      label: `real local ${lane.modelId}`,
    };
  }
  if (lane.kind === 'venice' && profile.provider === 'venice') {
    const apiKey = process.env.OLYMPUS_SOURCE_INDEX_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim();
    if (!apiKey) throw new Error('Set OLYMPUS_SOURCE_INDEX_VENICE_API_KEY (or VENICE_API_KEY) for a real Venice run.');
    return {
      lane,
      model: createVeniceAnalystModel({ apiKey, model: profile.model, thinking: 'disabled', reasoningEffort: 'low', reasoningHeadroomTokens: 0 }),
      label: `real venice ${lane.modelId}`,
    };
  }
  throw new Error(`The resolved sniffer lane (${lane.profileId}) cannot be built for the eval.`);
}

await main();
