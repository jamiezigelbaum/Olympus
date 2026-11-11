import { afterEach, describe, expect, test } from 'bun:test';
import { ControlPathHeadroom, summarizeCpuSamples, tracesInStalls } from '../src/workers/control-path-headroom.ts';

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

describe('cpu samples taken during a freeze', () => {
  test('keeps only the traces inside a stall window, on the profiler clock', () => {
    const traces = [{ timestamp: 100.0 }, { timestamp: 100.5 }, { timestamp: 101.2 }, { timestamp: 103 }, {}];
    // performance.now() 1000 ms is profiler 100.0 s.
    const kept = tracesInStalls(traces, [{ startMs: 1_400, endMs: 2_300 }], 99);
    expect(kept).toEqual([{ timestamp: 100.5 }, { timestamp: 101.2 }]);
    expect(tracesInStalls(traces, [], 99)).toEqual([]);
  });

  test('a busy stretch on the real profiler lands in its own window', async () => {
    const jsc = await import('bun:jsc') as unknown as { startSamplingProfiler: () => void; samplingProfilerStackTraces: () => { traces: { timestamp?: number; frames?: { name?: string }[] }[] } };
    jsc.startSamplingProfiler();
    jsc.samplingProfilerStackTraces();
    function heldTheThread(ms: number) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }
    function afterwards(ms: number) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }
    const startMs = performance.now();
    heldTheThread(150);
    const endMs = performance.now();
    afterwards(60);
    const spinUntil = performance.now() + 3;
    while (performance.now() < spinUntil) { /* spin */ }
    const anchorMs = performance.now();
    const traces = jsc.samplingProfilerStackTraces().traces;
    const newest = Math.max(...traces.map((trace) => trace.timestamp ?? -Infinity));
    const kept = tracesInStalls(traces, [{ startMs, endMs }], newest - anchorMs / 1000);
    const named = (trace: { frames?: { name?: string }[] }, name: string) => (trace.frames ?? []).some((frame) => frame.name === name);
    expect(kept.length).toBeGreaterThan(0);
    // The clock anchor is good to a few ms, so a sample at the window's edge may
    // fall either side (CI, 2026-11-05). Bound counts, not ratios: a slow runner
    // keeps 9 or fewer samples, where one edge sample alone is over 10% (#1372).
    const edge = Math.max(1, Math.floor(kept.length * 0.1));
    expect(kept.filter((trace) => named(trace, 'heldTheThread')).length).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(kept.length * 0.8) - edge));
    expect(kept.filter((trace) => named(trace, 'afterwards')).length).toBeLessThanOrEqual(edge);
  });
});
