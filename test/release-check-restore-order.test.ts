import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { oneMachineAtATime } from '../scripts/release-check/run.ts';

const RUN = readFileSync(new URL('../scripts/release-check/run.ts', import.meta.url), 'utf8');

describe('release check: the restore leg on a driver that runs one machine at a time (run 42918085215)', () => {
  test('the Mac driver runs one machine at a time; Linux runs two', () => {
    expect(oneMachineAtATime('macos')).toBe(true);
    expect(oneMachineAtATime('linux')).toBe(false);
  });

  test('alone, the clean machine comes after the server-mode leg and the evidence, and only once the first machine is destroyed', () => {
    const at = (needle: string, from = 0) => {
      const i = RUN.indexOf(needle, from);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const prepare = at('restore = await prepareRestore(');
    const together = at('if (restore && !alone) await finishRestore(', prepare);
    const serverMode = at('await runServerModeCheck(run);', together);
    const evidence = at('await collectEvidence(run, options.outDir);', serverMode);
    const destroyFirst = at('await run.driver.destroy({ handle: run.machine!.handle });', evidence);
    at('await finishRestore(run, bundlePath, options.outDir, workDir, prepared);', destroyFirst);
  });
});
