// A stand-in for `cli.js __worker-service-run` under the worker service's own
// engine split supervisor (test/worker-service-split.test.ts). It records
// what it was started as and when it stops, in EVENTS_PATH, one JSON line per
// event. With the background role it answers the engine readiness probe on
// its command socket, as the real background does once its boot work is done.
import { appendFileSync, rmSync } from 'node:fs';

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

let server: ReturnType<typeof Bun.serve> | undefined;
if (role === 'background') {
  const socket = process.env.OLYMPUS_ENGINE_BACKGROUND_SOCKET!;
  rmSync(socket, { force: true });
  server = Bun.serve({
    unix: socket,
    fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${process.env.OLYMPUS_WORKER_AUTH_TOKEN}`) return new Response('no', { status: 401 });
      return Response.json({ ready: true, schema_current: true, instance_id: process.env.OLYMPUS_ENGINE_BACKGROUND_INSTANCE_ID });
    },
  });
}

const stop = (signal: string) => {
  note('stop', { signal });
  void server?.stop(true);
  process.exit(143);
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
setInterval(() => {}, 60_000);
