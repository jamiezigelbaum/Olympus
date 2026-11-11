import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const RUN = readFileSync(new URL('../scripts/release-check/run.ts', import.meta.url), 'utf8');

describe('release check: the restore leg, whose drivers run one machine at a time (runs 42918085215, 42960983714)', () => {
  test('no second machine is provisioned while the first is up, on either driver', () => {
    expect(RUN).not.toContain('oneMachineAtATime');
    expect(RUN).not.toMatch(/restore && !alone/);
  });

  test('the backup is made before the control exploration, which leaves Readwise disconnected and its data deleted (#1323)', () => {
    const prepare = RUN.indexOf('restore = await prepareRestore(');
    const explore = RUN.indexOf("await run.inLeg('explore', () => runExploreLeg(run, options.outDir))");
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(explore).toBeGreaterThan(prepare);
    // After the journeys, so the item fix-one-item changed is in the backup.
    expect(RUN.indexOf("await run.inLeg('journeys', () => runJourneyLeg(run, options.outDir))")).toBeLessThan(prepare);
  });

  test('the clean machine comes after the server-mode leg and the evidence, and only once the first machine is destroyed', () => {
    const at = (needle: string, from = 0) => {
      const i = RUN.indexOf(needle, from);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const prepare = at('restore = await prepareRestore(');
    const serverMode = at('await runServerModeCheck(run);', prepare);
    const evidence = at('await collectEvidence(run, options.outDir);', serverMode);
    const destroyFirst = at('await run.driver.destroy({ handle: run.machine!.handle });', evidence);
    at('await finishRestore(run, bundlePath, options.outDir, workDir, prepared);', destroyFirst);
  });
});
