import { builtInAnalystEnabled, resolveBuiltInReasoningModel } from './analyst-built-in.ts';
import { loadConfig } from './config.ts';
import { loadSovereigntyEngine } from './sovereignty.ts';
import { environmentWithWorkerSetupEnv } from './worker-auth.ts';
import { applyBuiltInModelChoice, builtInModelWanted } from '../workers/engine/runtime/judging-models.ts';
import { installBuiltInReasoning } from '../workers/source-index/built-in-reasoning/install.ts';

/** Run inside the incoming release, so its selection, pins and verifier all agree. */
export async function prefetchPrivateModel(
  workerEnvPath: string,
  serviceEnv: NodeJS.ProcessEnv,
  options: { totalMemoryBytes?: number; install?: typeof installBuiltInReasoning; progress?: (line: string) => void } = {},
): Promise<void> {
  const env = { ...environmentWithWorkerSetupEnv({ env: serviceEnv, workerEnvPath }) };
  if (!builtInAnalystEnabled(env)) return;
  const config = loadConfig(env).sovereignty;
  const policy = loadSovereigntyEngine({
    env,
    ...(config?.policy ? { inlineConfig: config.policy } : {}),
    ...(config?.configPath ? { configPath: config.configPath } : {}),
  });
  applyBuiltInModelChoice(policy, env);
  const model = resolveBuiltInReasoningModel(env, options.totalMemoryBytes);
  if (!model || !builtInModelWanted(policy, env)) return;

  const progress = options.progress ?? ((line: string) => console.error(line));
  progress(`Preparing the private model for the update (${model.displayName})...`);
  let lastStage = '';
  let lastBucket = -1;
  await (options.install ?? installBuiltInReasoning)({
    model, env, prefetch: true,
    onProgress(status) {
      if (status.state !== 'downloading' && status.state !== 'verifying') return;
      const bucket = Math.floor(status.percent / 10);
      const stage = `${status.state}:${status.label}`;
      if (stage === lastStage && bucket === lastBucket) return;
      lastStage = stage;
      lastBucket = bucket;
      progress(`  ${status.label} (${status.percent}%)`);
    },
    log: () => {},
  });
  progress('Private model verified for the update.');
}

