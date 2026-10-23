import { configFromPluginConfig } from './config.ts';
import { engineServicePaths, readEngineConfig } from './engine-service.ts';
import { finalizedWorkerEnvironment } from './native-worker-service.ts';
import { environmentWithWorkerSetupEnv } from './worker-auth.ts';

/**
 * The environment the installed worker actually runs with, for the commands
 * that must resolve the same paths it does (Delete indexed data in the engine
 * host and the CLI). With an engine configuration it is the launcher's own
 * finalized environment (process env, worker.env, service credentials,
 * configured settings); without one, the process env over worker.env.
 */
export function effectiveWorkerEnvironment(input: {
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: string;
  pluginConfig?: Record<string, unknown>;
}): Record<string, string | undefined> {
  const home = input.homeDir ?? input.env.HOME ?? '';
  try {
    const paths = engineServicePaths({ homeDir: home, env: input.env, platform: input.platform ?? process.platform });
    const pluginConfig = input.pluginConfig ?? readEngineConfig(paths.configPath);
    if (pluginConfig) {
      const config = configFromPluginConfig(pluginConfig, { requireResolvedWorkerSecrets: false });
      return finalizedWorkerEnvironment(config, {
        baseEnv: { ...input.env, HOME: home },
        ...(paths.linux ? { workerEnvPath: paths.workerEnvPath } : {}),
      });
    }
  } catch { /* no usable engine configuration: the base layering below */ }
  return environmentWithWorkerSetupEnv({ env: { ...input.env, HOME: home } });
}
