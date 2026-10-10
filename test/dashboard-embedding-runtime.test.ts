/**
 * The embedding lane's state, model line and operator toggle.
 *
 * The regression these tests exist for is a specific one: the owner did not
 * know embedding was off. So the assertions care less about pretty copy than
 * about two things — that a state the files DO establish is stated plainly, and
 * that a state they do NOT establish renders as unknown rather than as a
 * confident guess.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  DRAIN_REPORT_MAX_AGE_MS,
  GUARD_REPORT_MAX_AGE_MS,
  deriveEmbeddingRunState,
  readEmbeddingDrainReport,
  readEmbeddingModelLine,
  readEmbeddingOperatorOverride,
  readEmbeddingRuntime,
  readGuardReport,
  resolveEmbeddingDrainReportPath,
  resolveEmbeddingOverridePath,
  resolveGuardReportPath,
  writeEmbeddingOperatorOverride,
  type EmbeddingRuntimeFacts,
  type GuardReportFacts,
} from '../src/workers/dashboard/embedding-runtime.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'olympus-embedding-runtime-'));
}

/* --------------------------------------------------------------- paths -- */

describe('guard file paths', () => {
  test('takes the explicit override path the guard honors above everything else', () => {
    const path = resolveEmbeddingOverridePath({
      OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_OPERATOR_OVERRIDE_PATH: '/run/olympus/override',
      OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_STATE_DIR: '/ignored',
      HOME: '/home/ignored',
    });

    expect(path).toBe('/run/olympus/override');
  });

  test('falls back to operator-override inside the guard state dir', () => {
    const env = { OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_STATE_DIR: '/var/olympus/guard', HOME: '/home/ignored' };

    expect(resolveEmbeddingOverridePath(env)).toBe('/var/olympus/guard/operator-override');
    // The report resolves against the same state dir, so a host that moves the
    // guard's directory never ends up reading one and writing the other.
    expect(resolveGuardReportPath(env)).toBe('/var/olympus/guard/latest.json');
  });

  test('falls back to the guard installer default under HOME', () => {
    const path = resolveEmbeddingOverridePath({ HOME: '/home/owner' });

    expect(path).toBe('/home/owner/.local/state/olympus/overnight-source-drain-guard/operator-override');
  });

  test('resolves the drain report the way the drain installer does', () => {
    expect(resolveEmbeddingDrainReportPath({}))
      .toBe('/tmp/olympus-source-processing-supervisor/source-embedding-drain-current.json');
    expect(resolveEmbeddingDrainReportPath({ OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_DIR: '/var/run/olympus' }))
      .toBe('/var/run/olympus/source-embedding-drain-current.json');
    expect(resolveEmbeddingDrainReportPath({ OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_PATH: '/tmp/one.json' }))
      .toBe('/tmp/one.json');
  });
});

/* ------------------------------------------------------------ override -- */

describe('operator override file', () => {
  test('reads the two tokens the guard honors, and absence as normal arbitration', () => {
    const dir = scratch();
    const path = join(dir, 'operator-override');

    expect(readEmbeddingOperatorOverride(path)).toBe('none');

    writeFileSync(path, 'embedding-priority\n', 'utf8');
    expect(readEmbeddingOperatorOverride(path)).toBe('embedding_priority');

    writeFileSync(path, 'paused\n', 'utf8');
    expect(readEmbeddingOperatorOverride(path)).toBe('guard_paused');

    writeFileSync(path, '', 'utf8');
    expect(readEmbeddingOperatorOverride(path)).toBe('none');
  });

  test('refuses a token the guard itself would not honor, rather than guessing at it', () => {
    const dir = scratch();
    const path = join(dir, 'operator-override');

    // The guard reads this file through `tr -d '\r\n'` — line endings and
    // nothing else. A leading space means the guard falls back to normal
    // arbitration, so reporting it as an active override would tell the owner
    // the lane is prioritized while the machine ignores the file.
    writeFileSync(path, ' embedding-priority\n', 'utf8');
    expect(readEmbeddingOperatorOverride(path)).toBe('unknown_token');

    writeFileSync(path, 'embedding_priority\n', 'utf8');
    expect(readEmbeddingOperatorOverride(path)).toBe('unknown_token');
  });

  test('writes the guard token on and removes the file off', () => {
    const dir = scratch();
    const path = join(dir, 'nested', 'operator-override');

    writeEmbeddingOperatorOverride(path, true);
    expect(readFileSync(path, 'utf8')).toBe('embedding-priority\n');
    expect(readEmbeddingOperatorOverride(path)).toBe('embedding_priority');

    // Off removes the file rather than blanking it: absent is the guard's own
    // spelling of normal arbitration.
    writeEmbeddingOperatorOverride(path, false);
    expect(existsSync(path)).toBe(false);
    expect(readEmbeddingOperatorOverride(path)).toBe('none');

    // Off on an already-absent file is not an error.
    expect(() => writeEmbeddingOperatorOverride(path, false)).not.toThrow();
  });
});

/* ------------------------------------------------------------- reports -- */

describe('report freshness', () => {
  test('drops a guard report too old to describe now', () => {
    const dir = scratch();
    const path = join(dir, 'latest.json');
    const stale = new Date(NOW.getTime() - GUARD_REPORT_MAX_AGE_MS - 1000).toISOString();
    writeFileSync(path, JSON.stringify({ finished_at: stale, metadata_window_active: true, actions: [] }), 'utf8');

    expect(readGuardReport(path, NOW)).toBeUndefined();
  });

  test('reads a fresh guard report down to the fields the page uses', () => {
    const dir = scratch();
    const path = join(dir, 'latest.json');
    writeFileSync(path, JSON.stringify({
      kind: 'olympus_overnight_source_drain_guard_report',
      started_at: '2026-08-24T11:58:00.000Z',
      finished_at: '2026-08-24T11:59:30.000Z',
      metadata_window_active: true,
      metadata_window_reason: 'dropbox_metadata_stale',
      writer_drains_parked_without_window: false,
      actions: ['paused olympus-source-embedding-drain.service: metadata sync active'],
    }), 'utf8');

    const report = readGuardReport(path, NOW);

    expect(report?.metadataWindowActive).toBe(true);
    expect(report?.metadataWindowReason).toBe('dropbox_metadata_stale');
    expect(report?.actions).toHaveLength(1);
  });

  test('treats a missing or unparseable report as no report, never as an exception', () => {
    const dir = scratch();
    expect(readGuardReport(join(dir, 'absent.json'), NOW)).toBeUndefined();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{not json', 'utf8');
    expect(readGuardReport(broken, NOW)).toBeUndefined();
    expect(readEmbeddingDrainReport(broken, NOW)).toBeUndefined();
  });

  test('drops a drain report that stopped moving', () => {
    const dir = scratch();
    const path = join(dir, 'drain.json');
    const stale = new Date(NOW.getTime() - DRAIN_REPORT_MAX_AGE_MS - 1000).toISOString();
    writeFileSync(path, JSON.stringify({ updated_at: stale, run_state: 'running', active_phase: 'embedding' }), 'utf8');

    // A drain that claims to be running in a file nobody has touched for six
    // minutes is a drain that died mid-pass.
    expect(readEmbeddingDrainReport(path, NOW)).toBeUndefined();
  });
});

/* ---------------------------------------------------------- derivation -- */

function guardReport(extra: Partial<GuardReportFacts> = {}): GuardReportFacts {
  return { generatedAt: NOW, actions: [], ...extra };
}

describe('state derivation', () => {
  test('operator priority: the override is on and the drain is working', () => {
    const derived = deriveEmbeddingRunState({
      override: 'embedding_priority',
      guard: undefined,
      drain: { updatedAt: NOW, runState: 'running', activePhase: 'embedding' },
    });

    expect(derived.state).toBe('operator_priority');
    expect(derived.stateLine).toBe('Embeddings: running now (operator priority)');
  });

  test('operator priority stands even though the override freezes the guard report', () => {
    // Both override tokens make the guard exit before it writes latest.json, so
    // the guard report is legitimately absent here. Consulting it first would
    // have reported unknown for the state the owner most needs to see.
    const derived = deriveEmbeddingRunState({
      override: 'embedding_priority',
      guard: undefined,
      drain: undefined,
    });

    expect(derived.state).toBe('operator_priority');
    expect(derived.stateLine).toContain('operator priority is on');
  });

  test('running: no override, and the drain report says it is embedding', () => {
    const derived = deriveEmbeddingRunState({
      override: 'none',
      guard: guardReport({ metadataWindowActive: false }),
      drain: { updatedAt: NOW, runState: 'running', activePhase: 'embedding' },
    });

    expect(derived.state).toBe('running');
    expect(derived.stateLine).toBe('Embeddings: running now (metadata caught up)');
  });

  test('running counts the drain phases this lane actually emits', () => {
    // The guard's sync-drain phase tuple contains `syncing`, which the embedding
    // drain never emits, and omits `embedding`, which is its working phase.
    // Copying that tuple would have reported a busy lane as idle.
    for (const phase of ['starting', 'embedding', 'sleeping', 'backoff']) {
      const derived = deriveEmbeddingRunState({
        override: 'none',
        guard: guardReport(),
        drain: { updatedAt: NOW, runState: 'running', activePhase: phase },
      });
      expect(derived.state).toBe('running');
    }

    const complete = deriveEmbeddingRunState({
      override: 'none',
      guard: guardReport({ metadataWindowActive: true }),
      drain: { updatedAt: NOW, runState: 'complete', activePhase: 'complete' },
    });
    expect(complete.state).toBe('parked');
  });

  test('parked: the guard says Dropbox metadata sync owns the lane', () => {
    const derived = deriveEmbeddingRunState({
      override: 'none',
      guard: guardReport({ metadataWindowActive: true, metadataWindowReason: 'dropbox_metadata_stale' }),
      drain: undefined,
    });

    expect(derived.state).toBe('parked');
    expect(derived.stateLine).toContain('Dropbox metadata sync has priority');
    expect(derived.stateLine).toContain('dropbox_metadata_stale');
  });

  test('parked: quotes the guard action naming this unit when no window is open', () => {
    const derived = deriveEmbeddingRunState({
      override: 'none',
      guard: guardReport({
        metadataWindowActive: false,
        actions: ['paused olympus-source-embedding-drain.service: metadata frontier pending'],
      }),
      drain: undefined,
    });

    expect(derived.state).toBe('parked');
    expect(derived.stateLine).toBe('Embeddings: parked by the guard — metadata frontier pending');
  });

  test('guard paused: off, and nothing will start it', () => {
    const derived = deriveEmbeddingRunState({
      override: 'guard_paused',
      guard: undefined,
      drain: undefined,
    });

    expect(derived.state).toBe('guard_paused');
    expect(derived.stateLine).toContain('off (guard paused)');
  });

  test('guard paused with a live drain says running, because a pause stops the arbiter not the lane', () => {
    const derived = deriveEmbeddingRunState({
      override: 'guard_paused',
      guard: undefined,
      drain: { updatedAt: NOW, runState: 'running', activePhase: 'embedding' },
    });

    expect(derived.state).toBe('guard_paused');
    expect(derived.stateLine).toContain('running now');
    expect(derived.stateLine).toContain('guard is paused');
  });

  test('unknown: nothing recent enough to quote', () => {
    const derived = deriveEmbeddingRunState({ override: 'none', guard: undefined, drain: undefined });

    expect(derived.state).toBe('unknown');
    expect(derived.stateLine).toContain('state unknown');
  });

  test('unknown: the guard reported, did not park this lane, and the drain is silent', () => {
    const derived = deriveEmbeddingRunState({
      override: 'none',
      guard: guardReport({ metadataWindowActive: false, writerDrainsParked: false }),
      drain: undefined,
    });

    expect(derived.state).toBe('unknown');
    expect(derived.stateLine).toContain('state unknown');
  });

  test('unknown: the override file itself could not be read', () => {
    const derived = deriveEmbeddingRunState({
      override: 'unreadable',
      guard: guardReport({ metadataWindowActive: false }),
      drain: { updatedAt: NOW, runState: 'running', activePhase: 'embedding' },
    });

    // The control file is unreadable, so the page cannot say whether an override
    // is in force — and "running" without that qualifier would be a half-truth.
    expect(derived.state).toBe('unknown');
  });

  test('NEVER invents a schedule: no state line promises a time of day', () => {
    // The guard has no clock logic anywhere — "overnight" is its unit name, not
    // a window. Any state line offering tonight, a nightly run or an hour would
    // be describing a system that does not exist.
    const cases = [
      deriveEmbeddingRunState({ override: 'embedding_priority', guard: undefined, drain: undefined }),
      deriveEmbeddingRunState({ override: 'guard_paused', guard: undefined, drain: undefined }),
      deriveEmbeddingRunState({ override: 'none', guard: undefined, drain: undefined }),
      deriveEmbeddingRunState({
        override: 'none',
        guard: guardReport({ metadataWindowActive: true }),
        drain: undefined,
      }),
    ];

    for (const derived of cases) {
      expect(derived.stateLine.toLowerCase()).not.toContain('tonight');
      expect(derived.stateLine.toLowerCase()).not.toContain('overnight');
      expect(derived.stateLine.toLowerCase()).not.toContain('night window');
      expect(derived.stateLine).not.toMatch(/\b\d{1,2}\s?(am|pm)\b/i);
    }
  });
});

/* -------------------------------------------------------------- model -- */

describe('model line', () => {
  const localEnv = {
    OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
    OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL: 'http://127.0.0.1:28090/v1',
    OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'secure-local-qwen3-embed',
  };

  test('reads the router live and names it local', async () => {
    const calls: string[] = [];
    const model = await readEmbeddingModelLine({
      env: localEnv,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({
          data: [{ id: 'secure-local-qwen3-embed', metadata: { backendModel: 'qwen3-embedding-4b' } }],
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(calls).toEqual(['http://127.0.0.1:28090/v1/models']);
    expect(model?.live).toBe(true);
    expect(model?.local).toBe(true);
    expect(model?.backendModel).toBe('qwen3-embedding-4b');
    expect(model?.text).toBe('secure-local-qwen3-embed · local (Delphi router) · backed by qwen3-embedding-4b');
  });

  test('falls back to the configured name and marks it, when the router does not answer', async () => {
    const model = await readEmbeddingModelLine({
      env: localEnv,
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });

    expect(model?.live).toBe(false);
    expect(model?.text).toBe('secure-local-qwen3-embed · local (Delphi router) (configured)');
  });

  test('falls back the same way on a non-200 and on a router that does not list the model', async () => {
    const failed = await readEmbeddingModelLine({
      env: localEnv,
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    });
    expect(failed?.live).toBe(false);

    const absent = await readEmbeddingModelLine({
      env: localEnv,
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: 'something-else' }] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(absent?.live).toBe(false);
    expect(absent?.text).toContain('(configured)');
  });

  test('never calls a remote provider local', async () => {
    const model = await readEmbeddingModelLine({
      env: {
        OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'google-gemini',
        OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'gemini-embedding-2',
      },
    });

    expect(model?.local).toBe(false);
    expect(model?.text).not.toContain('local');
  });

  test('says nothing at all when no model is configured', async () => {
    expect(await readEmbeddingModelLine({ env: {} })).toBeUndefined();
  });
});

/* ------------------------------------------------------------ assembly -- */

describe('readEmbeddingRuntime', () => {
  test('assembles state, schedule, model and toggle position off the real files', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'operator-override'), 'embedding-priority\n', 'utf8');
    const drainPath = join(dir, 'drain.json');
    writeFileSync(drainPath, JSON.stringify({
      updated_at: NOW.toISOString(),
      run_state: 'running',
      active_phase: 'embedding',
    }), 'utf8');

    const facts = await readEmbeddingRuntime({
      now: NOW,
      env: {
        OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_STATE_DIR: dir,
        OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_PATH: drainPath,
        OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
        OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'secure-local-qwen3-embed',
      },
    });

    expect(facts.state).toBe('operator_priority');
    expect(facts.overrideOn).toBe(true);
    expect(facts.overridePath).toBe(join(dir, 'operator-override'));
    expect(facts.model?.name).toBe('secure-local-qwen3-embed');
    // The one answer to "when is it supposed to run", and it is a condition.
    expect(facts.scheduleLine).toContain('No fixed hours');
    expect(facts.scheduleLine).toContain('Dropbox metadata sync');
  });

  test('reports unknown on a host where the guard has never run', async () => {
    const facts = await readEmbeddingRuntime({
      now: NOW,
      env: {
        OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_STATE_DIR: scratch(),
        OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_PATH: join(scratch(), 'absent.json'),
      },
    });

    expect(facts.state).toBe('unknown');
    expect(facts.overrideOn).toBe(false);
  });
});

/* --------------------------------------------------------------- page -- */

/**
 * The smallest view model the background body reads. Cast rather than built out
 * in full: these tests are about the embedding block, and every field the block
 * touches is present.
 */
function fixtureView(extra: Record<string, unknown> = {}): SourceDashboardViewModel {
  return {
    generated_at: '2026-08-24T11:59:48.000Z',
    sources: [],
    ...extra,
  } as unknown as SourceDashboardViewModel;
}

function facts(extra: Partial<EmbeddingRuntimeFacts> = {}): EmbeddingRuntimeFacts {
  return {
    state: 'running',
    stateLine: 'Embeddings: running now (metadata caught up)',
    scheduleLine: 'No fixed hours: the guard re-decides every minute.',
    model: {
      name: 'secure-local-qwen3-embed',
      live: true,
      local: true,
      text: 'secure-local-qwen3-embed · local (Delphi router)',
    },
    overrideOn: false,
    override: 'none',
    overridePath: '/home/owner/.local/state/olympus/overnight-source-drain-guard/operator-override',
    ...extra,
  };
}

/* -------------------------------------------------------------- route -- */

describe('embedding-priority route', () => {
  async function withOverridePath<T>(path: string, run: () => Promise<T>): Promise<T> {
    const key = 'OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_OPERATOR_OVERRIDE_PATH';
    const previous = process.env[key];
    process.env[key] = path;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }

  test('writes and removes the override file, on the path the env names', async () => {
    const path = join(scratch(), 'operator-override');
    const worker = createEmailSourceWorker({});
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    await withOverridePath(path, async () => {
      const on = await fetch(new Request('http://worker.test/dashboard/embedding-priority', {
        method: 'POST',
        headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true }),
      }));
      const onBody = await on.json();

      expect(on.status).toBe(200);
      expect(onBody).toMatchObject({ ok: true, embedding_priority: true, override_path: path });
      expect(readFileSync(path, 'utf8')).toBe('embedding-priority\n');

      const off = await fetch(new Request('http://worker.test/dashboard/embedding-priority', {
        method: 'POST',
        headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: false }),
      }));

      expect(off.status).toBe(200);
      expect(existsSync(path)).toBe(false);
    });
  });

  test('takes the worker bearer token and nothing weaker', async () => {
    const path = join(scratch(), 'operator-override');
    const worker = createEmailSourceWorker({});
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    await withOverridePath(path, async () => {
      const anonymous = await fetch(new Request('http://worker.test/dashboard/embedding-priority', {
        method: 'POST',
        body: JSON.stringify({ on: true }),
      }));
      expect(anonymous.status).toBe(401);

      const wrong = await fetch(new Request('http://worker.test/dashboard/embedding-priority', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-the-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true }),
      }));
      expect(wrong.status).toBe(401);

      // The read-only dashboard token is a query token on GET /dashboard only,
      // so it must not reach a control route by any spelling.
      const queryToken = await fetch(new Request('http://worker.test/dashboard/embedding-priority?token=dash_anything', {
        method: 'POST',
        body: JSON.stringify({ on: true }),
      }));
      expect(queryToken.status).toBe(401);

      expect(existsSync(path)).toBe(false);
    });
  });

  test('refuses a body that does not say which way to set it', async () => {
    const path = join(scratch(), 'operator-override');
    const worker = createEmailSourceWorker({});
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    await withOverridePath(path, async () => {
      const response = await fetch(new Request('http://worker.test/dashboard/embedding-priority', {
        method: 'POST',
        headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }));

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('on must be true or false');
      expect(existsSync(path)).toBe(false);
    });
  });
});
