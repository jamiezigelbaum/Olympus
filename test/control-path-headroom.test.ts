import { afterEach, describe, expect, test } from 'bun:test';
import { ControlPathHeadroom, summarizeCpuSamples } from '../src/workers/control-path-headroom.ts';

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* synchronous work, like a bun:sqlite write */ }
};

const headrooms: ControlPathHeadroom[] = [];
afterEach(() => { for (const headroom of headrooms.splice(0)) headroom.stop(); });

describe('control path headroom', () => {
  // The Sparta failure (#784): lanes awaiting synchronous work never return to
  // the event loop, so Bun.serve cannot answer until they finish.
  test('keeps an HTTP request answering while several lanes run synchronous work', async () => {
    const headroom = new ControlPathHeadroom();
    headrooms.push(headroom);
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      let lanesDone = false;
      const lane = async () => {
        const end = performance.now() + 1_500;
        while (performance.now() < end) {
          busy(3);
          await Promise.resolve();
          await headroom.ingestionTurn();
        }
      };
      const lanes = Promise.all([lane(), lane(), lane()]).then(() => { lanesDone = true; });
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      const elapsed = performance.now() - started;
      expect(await response.text()).toBe('ok');
      expect(lanesDone).toBe(false);
      expect(elapsed).toBeLessThan(750);
      await lanes;
    } finally {
      server.stop(true);
    }
  });

  test('a slice with time left costs nothing to await', () => {
    let clock = 0;
    const headroom = new ControlPathHeadroom({ now: () => clock, turn: () => Promise.resolve() });
    headrooms.push(headroom);
    expect(headroom.ingestionTurn()).toBeUndefined();
    clock = 19;
    expect(headroom.ingestionTurn()).toBeUndefined();
    clock = 20;
    expect(headroom.ingestionTurn()).toBeInstanceOf(Promise);
    expect(headroom.snapshot().turns).toBe(1);
  });

  test('a freeze is logged with the background work that was running, by id only', async () => {
    const lines: string[] = [];
    const headroom = new ControlPathHeadroom({ log: (line) => lines.push(line), freezeLogMs: 150 });
    headrooms.push(headroom);
    const leave = headroom.enter('dropbox.files/sync');
    await Bun.sleep(60);
    busy(300);
    await Bun.sleep(120);
    leave();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[olympus:control-path\] the worker could not answer requests for \d+ ms; background work running: dropbox\.files\/sync$/);
    expect(headroom.snapshot().freezes).toBe(1);
  });
});

describe('cpu sample summary', () => {
  test('ranks the functions on top of the stack and under it, by name and code position only', () => {
    const frame = (name: string, line: number) => ({ name, sourceURL: '/opt/olympus/dist/cli.js', line });
    const summary = summarizeCpuSamples([
      { frames: [frame('scan', 10), frame('sync', 5)] },
      { frames: [frame('scan', 10), frame('sync', 5)] },
      { frames: [frame('write', 20), frame('sync', 5)] },
      { frames: [] },
    ]);
    expect(summary.samples).toBe(4);
    expect(summary.self[0]).toEqual(['scan dist/cli.js:10', 2]);
    expect(summary.total[0]).toEqual(['sync dist/cli.js:5', 3]);
  });
});

describe('cpu sample summary from the profiler', () => {
  test('frames with only a sourceID take their file from the sources table', async () => {
    const jsc = await import('bun:jsc') as unknown as { startSamplingProfiler: () => void; samplingProfilerStackTraces: () => { traces: { frames: { sourceID?: number; name?: string; line?: number }[] }[]; sources: { sourceID?: number; url?: string }[] } };
    jsc.startSamplingProfiler();
    const end = performance.now() + 50;
    let spin = 0;
    while (performance.now() < end) spin += Math.sqrt(spin + 1);
    const raw = jsc.samplingProfilerStackTraces();
    const stripped = raw.traces.map((trace) => ({ frames: trace.frames.map(({ sourceID, name, line }) => ({ ...(sourceID !== undefined ? { sourceID } : {}), ...(name !== undefined ? { name } : {}), ...(line !== undefined ? { line } : {}) })) }));
    const summary = summarizeCpuSamples(stripped, 30, raw.sources);
    expect(summary.samples).toBeGreaterThan(0);
    expect(summary.total.some(([key]) => key.includes('control-path-headroom.test.ts'))).toBe(true);
  });
});
