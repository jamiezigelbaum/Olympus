import { builtInAnalystEnabled, createBuiltInAnalystModel, resolveBuiltInReasoningModel } from '../../core/analyst-built-in.ts';
import { installedEngineConfig } from '../../core/config.ts';
import { isStandaloneEngineProcess, loadSovereigntyEngine } from '../../core/sovereignty.ts';
import { environmentWithWorkerSetupEnv } from '../../core/worker-auth.ts';
import { resolveTierSnifferRuntime } from './built-in-sniffer.ts';

/** Resolve the same installed lane as the worker without starting a model. */
export function installedSnifferRuntime(env: Record<string, string | undefined>) {
  const workerEnv = environmentWithWorkerSetupEnv({ env });
  const standalone = isStandaloneEngineProcess(env)
    || (!env.OLYMPUS_CONFIG && installedEngineConfig(env)?.olympusStandalone === true);
  const spec = !standalone || workerEnv.NODE_ENV === 'test' || !builtInAnalystEnabled(workerEnv)
    ? undefined : resolveBuiltInReasoningModel(workerEnv);
  const model = spec ? createBuiltInAnalystModel({ env: workerEnv, model: spec }) : undefined;
  return resolveTierSnifferRuntime({
    engine: loadSovereigntyEngine({ env: workerEnv }),
    standaloneEngine: standalone,
    ...(model ? { builtIn: { model, available: () => false, cacheModelId: `${model.spec.modelId}:${model.spec.revision}:${model.spec.file.sha256}` } } : {}),
  });
}
