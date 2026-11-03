import { afterEach, describe, expect, test } from 'bun:test';
import { ControlPathHeadroom } from '../src/workers/control-path-headroom.ts';

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
    expect(lines[0]).toMatch(/^\[olympus:control-path\] the worker could not answer requests for \d+ ms; background work running: dropbox\.files\/sync$/);
    expect(headroom.snapshot().freezes).toBe(1);
  });
});
