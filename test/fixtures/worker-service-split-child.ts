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
// extraction does (its own detached process group).
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runExtractionCommand } from '../../src/workers/file-extraction/extractors/command-runner.ts';

const role = process.env.OLYMPUS_WORKER_ENGINE_ROLE ?? 'single';
const events = process.env.EVENTS_PATH!;
const note = (event: string, extra: Record<string, unknown> = {}) => {
  appendFileSync(events, `${JSON.stringify({ role, event, pid: process.pid, ...extra })}\n`);
};

note('start', {
  argv: process.argv.slice(2),
  socket: process.env.OLYMPUS_ENGINE_BACKGROUND_SOCKET ?? null,
  managed: process.env.OLYMPUS_MANAGED_WORKER ?? null,
});
if (process.env.SAY) {
  console.log(`hello from the ${role} on stdout`);
  console.error(`hello from the ${role} on stderr`);
}

let server: ReturnType<typeof Bun.serve> | undefined;
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
if (role === 'background') {
  const readyDelay = Number(process.env.READY_DELAY_MS ?? 0);
  if (readyDelay > 0) setTimeout(serve, readyDelay);
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
const crashAfter = Number(process.env.CRASH_AFTER_MS ?? 0);
if (crashAfter > 0) setTimeout(() => process.exit(1), crashAfter);

const stop = (signal: string) => {
  note('stop', { signal });
  void server?.stop(true);
  process.exit(143);
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
setInterval(() => {}, 60_000);
