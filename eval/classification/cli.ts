// bun run eval:classification            deterministic fake sniffer (CI)
// bun run eval:classification -- --real  the configured private lane (local model or Venice Private)
// bun run eval:classification -- --archive  the same corpus held until judged (an archive import)
//
// Prints the report as JSON and exits 1 when a hard gate fails. The real run
// sends only the synthetic corpus, and only to a lane the sniffer lane
// resolver admits; a standard-cloud lane is refused before any call.

import { createBuiltInAnalystModel } from '../../src/core/analyst-built-in.ts';
import { createDelphiAnalystModel } from '../../src/core/analyst-delphi.ts';
import { createVeniceAnalystModel } from '../../src/core/analyst-venice.ts';
import type { AnalystModel } from '../../src/core/analyst.ts';
import { loadConfig } from '../../src/core/config.ts';
import { DelphiClient } from '../../src/core/delphi.ts';
import { loadSovereigntyEngine } from '../../src/core/sovereignty.ts';
import { resolveSnifferLane, type SnifferLane } from '../../src/workers/classification/sniffer-lane.ts';
import { archiveHeldCorpus } from './corpus.ts';
import { createFakeSnifferModel } from './fake-sniffer.ts';
import { runClassificationEval } from './run.ts';
import { createInboxReplayModel, runInboxEval, type InboxSet, type InboxSplit } from './inbox.ts';

const FAKE_LANE: SnifferLane = {
  kind: 'local',
  modelId: 'eval-fake-sniffer',
  profileId: 'eval-fake-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'eval-fake-sniffer' },
};

async function main(): Promise<void> {
  const real = process.argv.includes('--real');
  if (process.argv.includes('--inbox')) {
    const split = (process.argv.find(arg => arg.startsWith('--split='))?.split('=')[1] ?? 'all') as InboxSplit;
    if (!['all', 'dev', 'held-out'].includes(split)) throw new Error('Invalid split');
    const set = (process.argv.find(arg => arg.startsWith('--set='))?.split('=')[1] ?? 'inbox') as InboxSet;
    if (!['inbox', 'owner-exemptions'].includes(set)) throw new Error('Invalid set');
    // Only the inbox set carries frozen replay responses; the others measure a real model.
    if (set !== 'inbox' && !real) throw new Error(`--set=${set} measures a real model: add --real --built-in.`);
    if (real && process.argv.includes('--built-in')) {
      const model = createBuiltInAnalystModel({ waitForInstall: true });
      try {
        await model.prepare();
        const report = await runInboxEval({ model, modelId: `built_in/${model.spec.modelId}/${model.spec.file.sha256}`, split, set });
        console.log(JSON.stringify(report, null, 2));
        if (report.mistakes.length || report.secretDispatches) process.exitCode = 1;
      } finally { await model.stop(); }
      return;
    }
    const selected = real ? realSniffer() : { model: createInboxReplayModel(), lane: { modelId: 'inbox-scripted-v1' } };
    const report = await runInboxEval({ model: selected.model, modelId: selected.lane.modelId, split, set });
    console.log(JSON.stringify(report, null, 2));
    if (report.mistakes.length || report.secretDispatches) process.exitCode = 1;
    return;
  }
  const { lane, model, label } = real ? realSniffer() : { lane: FAKE_LANE, model: createFakeSnifferModel(), label: 'fake (deterministic)' };
  const started = Date.now();
  const archive = process.argv.includes('--archive');
  const report = await runClassificationEval({ lane, model, label: archive ? `${label}, archive held` : label, ...(archive ? { cases: archiveHeldCorpus() } : {}) });
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
