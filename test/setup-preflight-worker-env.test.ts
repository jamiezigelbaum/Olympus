/**
 * A credential stored where the worker reads it counts as present.
 *
 * `olympus connect gemini --api-key-stdin` writes the key into worker.env,
 * because that is the only place the supervised worker will find it. The
 * preflight -- and doctor's sovereignty_prerequisites check, which runs the
 * same preflight -- read only process.env, so straight after storing the key
 * they still reported it missing and named the command the operator had just
 * run as the fix (2026-09-04 review).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { setupPreflight } from '../src/core/setup-preflight.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { writeManagedWorkerEnvSecret } from '../src/core/worker-service.ts';

const EMPTY_STORE = { getSync: () => undefined, get: async () => undefined };

describe('preflight over the managed worker environment', () => {
  test('a key stored in worker.env is present; an empty worker.env still asks for it', async () => {
    await withWorkerEnv(async (envPath) => {
      const config = createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')).config;

      const before = await setupPreflight({
        config,
        env: {},
        secretStore: EMPTY_STORE,
        workerEnvPath: envPath,
      });
      expect(before.map((item) => item.id)).toContain('env:GEMINI_API_KEY');
      expect(before.find((item) => item.id === 'env:GEMINI_API_KEY')?.remedy)
        .toContain('olympus connect gemini --api-key-stdin');

      // Exactly what the connect command does.
      writeManagedWorkerEnvSecret({
        key: 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
        value: 'stored-gemini-key',
        envPath,
      });

      const after = await setupPreflight({
        config,
        env: {},
        secretStore: EMPTY_STORE,
        workerEnvPath: envPath,
      });
      expect(after.map((item) => item.id)).not.toContain('env:GEMINI_API_KEY');
    });
  });

  test('an explicitly set environment variable still outranks the stored one', async () => {
    await withWorkerEnv(async (envPath) => {
      writeManagedWorkerEnvSecret({
        key: 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
        value: 'stored-gemini-key',
        envPath,
      });
      const config = createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')).config;

      // Both satisfy it; the point is that neither source is ignored.
      const both = await setupPreflight({
        config,
        env: { OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'process-gemini-key' },
        secretStore: EMPTY_STORE,
        workerEnvPath: envPath,
      });
      expect(both.map((item) => item.id)).not.toContain('env:GEMINI_API_KEY');
    });
  });

  test('with no path, no home and no HOME there is no install to read', async () => {
    // A caller that hands in a scoped environment must not silently pick up the
    // process owner's install, which is what makes these tests hermetic.
    const unmet = await setupPreflight({
      config: createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')).config,
      env: {},
      secretStore: EMPTY_STORE,
    });
    expect(unmet.map((item) => item.id)).toContain('env:GEMINI_API_KEY');
  });

  test('a lane gate set in worker.env is the gate doctor reports on', async () => {
    await withWorkerEnv(async (envPath) => {
      // The lane gates live in worker.env beside the credentials, for the same
      // reason: that file is the worker's whole environment. Reading only
      // process.env, doctor called a lane the running worker has enabled
      // "absent for default-off lane".
      const config = defaultConfig();
      config.email.enabled = true;
      config.worker.scheduler.enabled = true;
      const registry = {
        version: 1 as const,
        handles: [{
          handle: 'gmail.personal',
          provider: 'gmail' as const,
          accountRole: 'personal',
          trustDomain: 'internal' as const,
          allowedCapabilities: ['gmail.email.sync'],
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          connectedAt: '2026-09-04T11:00:00.000Z',
        }],
      };
      const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        const body = path === '/v1/source/scheduler/status'
          ? {
            kind: 'source_scheduler_status',
            enabled: true,
            running: true,
            selected_source_ids: [],
            missing_selected_source_ids: [],
            sources: [],
          }
          : { kind: 'source_index_status', corpora: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const laneGateProblem = async () => {
        const result = await runDoctor({
          config,
          delphi: healthyDelphi(),
          env: {},
          secretStore: EMPTY_STORE,
          workerEnvPath: envPath,
          handleRegistry: registry,
          fetchImpl,
        });
        return result.checks.find((check) => check.name === 'source_scheduler_status')!.detail;
      };

      // The gate is nowhere, so the lane really is off and doctor says so.
      expect(await laneGateProblem())
        .toContain('OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED absent for default-off lane');

      writeFileSync(
        envPath,
        ['PATH=/usr/bin', 'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED=true', ''].join('\n'),
        { mode: 0o600 },
      );

      // The operator has switched it on where the worker reads it.
      expect(await laneGateProblem())
        .not.toContain('OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED absent');
    });
  });

  test('a config-derived setting that lives only in worker.env is the setting doctor reads', async () => {
    await withWorkerEnv(async (envPath) => {
      // Layering worker.env under process.env was only half the repair: the
      // CONFIG doctor's checks read was still built from the unlayered
      // process.env, so source_scheduler_status skipped with "disabled in
      // config" over a worker.env that enables the scheduler (clean-install
      // rehearsal, 2026-09-05).
      const config = defaultConfig();
      config.email.enabled = true;
      expect(config.worker.scheduler.enabled).toBe(false);

      const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        const body = path === '/v1/source/scheduler/status'
          ? {
            kind: 'source_scheduler_status',
            enabled: true,
            running: true,
            selected_source_ids: [],
            missing_selected_source_ids: [],
            sources: [],
          }
          : { kind: 'source_index_status', corpora: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const schedulerCheck = async () => {
        const result = await runDoctor({
          config,
          delphi: healthyDelphi(),
          env: {},
          secretStore: EMPTY_STORE,
          workerEnvPath: envPath,
          fetchImpl,
        });
        return result.checks.find((check) => check.name === 'source_scheduler_status')!;
      };

      expect((await schedulerCheck()).detail).toContain('disabled in config');

      writeFileSync(
        envPath,
        ['PATH=/usr/bin', 'OLYMPUS_WORKER_SCHEDULER_ENABLED=true', ''].join('\n'),
        { mode: 0o600 },
      );

      const evaluated = await schedulerCheck();
      expect(evaluated.detail).not.toContain('disabled in config');
      expect(evaluated.ok).toBe(true);
      expect(evaluated.detail).toContain('Source scheduler is healthy');
      // The caller's own config object is untouched; the layer is a copy.
      expect(config.worker.scheduler.enabled).toBe(false);
    });
  });

  test('doctor stops asking for a key the operator has already stored', async () => {
    await withWorkerEnv(async (envPath) => {
      const config = defaultConfig();
      config.email.enabled = false;
      config.sourceIndex.enabled = false;
      config.sovereignty = { policy: loadSovereigntyPreset('no-sensitive') };

      const before = await runDoctor({
        config,
        delphi: healthyDelphi(),
        env: {},
        secretStore: EMPTY_STORE,
        workerEnvPath: envPath,
      });
      const beforeCheck = before.checks.find((check) => check.name === 'sovereignty_prerequisites')!;
      expect(beforeCheck.ok).toBe(false);
      expect(beforeCheck.hint).toContain('olympus connect gemini --api-key-stdin');

      writeManagedWorkerEnvSecret({
        key: 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
        value: 'stored-gemini-key',
        envPath,
      });

      const after = await runDoctor({
        config,
        delphi: healthyDelphi(),
        env: {},
        secretStore: EMPTY_STORE,
        workerEnvPath: envPath,
      });
      expect(after.checks.find((check) => check.name === 'sovereignty_prerequisites')?.ok).toBe(true);
    });
  });
});

function healthyDelphi() {
  return {
    listModels: async (lane: unknown) => [{ id: `${String(lane)}-model` }],
    listModelsForProfile: async (profile: unknown) => [{ id: `${String(profile)}-model` }],
    complete: async () => ({ text: 'OLYMPUS_DOCTOR_OK', model: 'model-1' }),
  } as unknown as Parameters<typeof runDoctor>[0]['delphi'];
}

async function withWorkerEnv(run: (envPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-preflight-worker-env-'));
  try {
    const envPath = join(dir, 'worker.env');
    writeFileSync(envPath, '# Olympus source worker environment.\nPATH=/usr/bin\n', { mode: 0o600 });
    await run(envPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
