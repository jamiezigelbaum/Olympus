import { afterEach, expect, test } from 'bun:test';
import type { AnalystModel } from '../src/core/analyst.ts';
import { createDecisionSnifferModel, type SnifferModelRequest } from '../src/workers/classification/sniffer-decision.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { buildSnifferBatchPrompt, SNIFFER_SYSTEM_PROMPT } from '../src/workers/classification/sniffer.ts';
import { waitFor } from './helpers/test-clock.ts';

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

let n = 0;
/** A judge server whose decision call answers only when released; its health answer can be switched off. */
function slowServer() {
  const prefix = `/idle-${++n}`;
  let healthUp = true;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.slice(prefix.length);
    if (path === '/health') return healthUp ? Response.json({ status: 'ok' }) : new Promise<Response>(() => {});
    if (req.method === 'GET') return new Response('', { status: 404 });
    const body = await req.json() as any;
    if (path === '/apply-template') return Response.json({ prompt: body.messages.map((m: any) => m.content).join('\n') });
    if (path === '/tokenize') return Response.json({ tokens: [{ piece: body.content }] });
    if (path === '/completion') {
      if (body.n_predict === 0) return Response.json({ content: '' });
      await released;
      return Response.json({ tokens_cached: 100, completion_probabilities: [{ top_logprobs: [
        { token: 'personal', logprob: Math.log(0.9) }, { token: 'private', logprob: Math.log(0.1) },
      ] }] });
    }
    return new Response('', { status: 404 });
  } });
  servers.push(server);
  const lane: SnifferLane = { kind: 'local', modelId: 'fixture-model', profileId: 'fixture', profile: {
    provider: 'local-openai-compatible', trust: 'local', model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.port}${prefix}/v1`, snifferMode: 'decision',
  } };
  const full: AnalystModel = { async complete() { throw new Error('not used'); } };
  return { model: createDecisionSnifferModel(lane, full, { timeoutMs: 1_200 }), healthDown: () => { healthUp = false; }, release: () => release() };
}

const request = (onAlive?: () => void): SnifferModelRequest => ({
  system: SNIFFER_SYSTEM_PROMPT, prompt: buildSnifferBatchPrompt('content', [{ i: 1, material: 'garden notes' }]), localOnly: true,
  snifferItem: { pass: 'content', material: 'garden notes' }, ...(onAlive ? { onAlive } : {}),
});

test('a judge call that takes longer than the idle bound finishes while the model server keeps answering', async () => {
  const server = slowServer();
  let alive = 0;
  const call = server.model.complete(request(() => { alive += 1; }));
  // Well past the 1.2 s idle bound, the server still answers its health probe.
  await waitFor(() => alive >= 4, { description: 'four liveness answers during the call' });
  server.release();
  const completion = await call as { decisionVerdict?: { tier: string } };
  expect(completion.decisionVerdict?.tier).toBe('personal');
  expect(alive).toBeGreaterThan(0);
}, 15_000);

test('a judge call is given up once the model server stops answering for the idle bound', async () => {
  const server = slowServer();
  server.healthDown();
  const started = Date.now();
  await expect(server.model.complete(request())).rejects.toBeDefined();
  expect(Date.now() - started).toBeLessThan(5_000);
}, 15_000);
