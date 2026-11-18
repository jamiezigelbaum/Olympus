// A stand-in for `cli.js __worker-service-run` under the worker service's own
// engine split supervisor (test/worker-service-split.test.ts). It records
// what it was started as and when it stops, in EVENTS_PATH, one JSON line per
// event. With the background role it answers the engine readiness probe on
// its command socket, as the real background does once its boot work is done.
//
// Knobs, all optional: SAY prints a line to stdout and stderr at start;
// READY_DELAY_MS holds the background's readiness back; CRASH_AFTER_MS exits 1
// that long after start; SPAWN_EXTRACTION has the background start a long
// extraction command through the real command runner, as a document
// extraction does (its own detached process group). BLOCK_BOOT_MS and
// BLOCK_AFTER_READY_MS hold the background's only thread in one synchronous
// call, as a long SQLite backup does: during its boot work (reported as
// backing_up, as the real one is) and again just after it answers ready.
// FRONT_WAITS has the front wait for the background's receipt as the real
// front does, then record that it serves.
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginBootProgress, finishBootProgress, reportBootStep } from '../../src/core/boot-progress.ts';
import { startEngineHeartbeat, stopEngineHeartbeat } from '../../src/core/engine-heartbeat.ts';
import { waitForBackgroundBootDone } from '../../src/workers/engine-split/runtime.ts';
import { runExtractionCommand } from '../../src/workers/file-extraction/extractors/command-runner.ts';

const role = process.env.OLYMPUS_WORKER_ENGINE_ROLE ?? 'single';
const events = process.env.EVENTS_PATH!;
const note = (event: string, extra: Record<string, unknown> = {}) => {
  appendFileSync(events, `${JSON.stringify({ role, event, pid: process.pid, ...extra })}\n`);
};

// The handlers go in before the start line: a test that signals as soon as it
// reads that line would otherwise find a child that died of the default
// SIGTERM without writing its stop (#1586).
let server: ReturnType<typeof Bun.serve> | undefined;
const stop = (signal: string) => {
  note('stop', { signal });
  void server?.stop(true);
  process.exit(143);
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

note('start', {
  argv: process.argv.slice(2),
  socket: process.env.OLYMPUS_ENGINE_BACKGROUND_SOCKET ?? null,
  managed: process.env.OLYMPUS_MANAGED_WORKER ?? null,
  probe: process.env.SPLIT_PROBE_KEY ?? null,
});
if (process.env.SAY) {
  console.log(`hello from the ${role} on stdout`);
  console.error(`hello from the ${role} on stderr`);
}

const serve = () => {
  const socket = process.env.OLYMPUS_ENGINE_BACKGROUND_SOCKET!;
  rmSync(socket, { force: true });
  server = Bun.serve({
    unix: socket,
    fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${process.env.OLYMPUS_WORKER_AUTH_TOKEN}`) return new Response('no', { status: 401 });
      return Response.json({ ready: true, schema_current: true, instance_id: process.env.OLYMPUS_ENGINE_BACKGROUND_INSTANCE_ID });
    },
  });
};
/** One synchronous call that holds this process's only thread, as bun:sqlite does. */
const blockLoop = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (role === 'background') {
  const readyDelay = Number(process.env.READY_DELAY_MS ?? 0);
  const blockBoot = Number(process.env.BLOCK_BOOT_MS ?? 0);
  const blockAfterReady = Number(process.env.BLOCK_AFTER_READY_MS ?? 0);
  if (blockBoot > 0 || blockAfterReady > 0) {
    // As the real engine does: the heartbeat first, from its own thread.
    startEngineHeartbeat(process.env, 'background');
    beginBootProgress(process.env);
    if (blockBoot > 0) {
      reportBootStep(process.env, { phase: 'backing_up', storeId: 'stand-in' });
      note('blocked', { ms: blockBoot });
      // EXIT_DURING_BOOT: the first background dies part way through its boot work.
      const exitMarker = process.env.EXIT_DURING_BOOT ? `${events}.exited` : undefined;
      if (exitMarker && !existsSync(exitMarker)) {
        writeFileSync(exitMarker, '');
        blockLoop(Math.min(blockBoot, 1_000));
        note('exit');
        process.exit(1);
      }
      // PAUSE_HEARTBEAT: the heartbeat's writes stop for the hold (a stalled disk), then resume.
      if (process.env.PAUSE_HEARTBEAT) stopEngineHeartbeat();
      blockLoop(blockBoot);
      if (process.env.PAUSE_HEARTBEAT) startEngineHeartbeat(process.env, 'background');
    }
    finishBootProgress();
    serve();
    note('ready');
    if (blockAfterReady > 0) {
      // Just after ready: the first answer has not gone out yet.
      setTimeout(() => { note('blocked', { ms: blockAfterReady }); blockLoop(blockAfterReady); }, 0);
    }
  } else if (readyDelay > 0) setTimeout(serve, readyDelay);
  else serve();
  if (process.env.SPAWN_EXTRACTION) {
    // Through a shell that execs the real program, as an interpreter-launched
    // tool does: the process table then shows a different command line than
    // the one spawned, under the same pid.
    void runExtractionCommand({
      command: '/bin/sh',
      args: ['-c', `exec "${process.execPath}" "${join(import.meta.dir, 'extraction-sleeper.ts')}"`],
      timeoutMs: 120_000,
    }).catch(() => undefined);
  }
}
if (role === 'front' && process.env.FRONT_WAITS) {
  void waitForBackgroundBootDone({ env: process.env }).then(() => note('serving'), (error: unknown) => { note('gave-up', { error: String(error) }); process.exit(1); });
}
// FRONT_SERVES: the front answers on its own socket (the unit's process holds
// the worker socket and pipes to it), and /restart exits 75 as a model change does.
if (role === 'front' && process.env.FRONT_SERVES) {
  note('listen', { socket: process.env.OLYMPUS_WORKER_LISTEN_SOCKET ?? null });
  server = Bun.serve({
    unix: process.env.OLYMPUS_WORKER_LISTEN_SOCKET!,
    fetch(request) {
      if (new URL(request.url).pathname === '/restart') setTimeout(() => process.exit(75), 50);
      return new Response(`front ${process.pid}`);
    },
  });
}
const crashAfter = Number(process.env.CRASH_AFTER_MS ?? 0);
if (crashAfter > 0) setTimeout(() => process.exit(1), crashAfter);

setInterval(() => {}, 60_000);
