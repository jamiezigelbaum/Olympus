// Fit snapshots only. No worker, writable ledger, model installation or clearing.
import { closeSync, fsyncSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { olympusDataRoot } from '../../core/olympus-layout.ts';
import { selectPrefilterTrainingExample, type SavedModel } from './embedding-prefilter.ts';
import { trainLogisticSteps, type LogisticExample } from './embedding-logistic.ts';
import { countPrefilterTrainingSteps } from './prefilter-training-counts.ts';
import { runPrefilterTrainingDryRun } from './prefilter-training-dry-run.ts';

export function prefilterTrainOfflineMain(args: readonly string[]): number {
  const report = { per_source: {} as Record<string, { personal: number; private: number }>,
    examples: { personal: 0, private: 0 }, outcome: 'failed' as 'failed' | 'too_few' | 'trained' };
  try {
    let dataDir: string | undefined, out: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i], value = args[++i];
      if (!value || value.startsWith('--')) throw new Error();
      if (flag === '--out' && !out) out = value;
      else if (flag === '--data-dir' && !dataDir) dataDir = value;
      else throw new Error();
    }
    if (!out) throw new Error();
    // Never overwrite an install file or install weights, including through a parent link.
    const root = realpathSync(resolve(dataDir ?? olympusDataRoot()));
    const output = resolve(realpathSync(dirname(resolve(out))), resolve(out).split(sep).pop()!);
    const within = relative(root, output);
    if (!within || (!within.startsWith(`..${sep}`) && within !== '..')) throw new Error();
    let saved: SavedModel | undefined;
    const scan = runPrefilterTrainingDryRun({ dataDir: root, inspect: ({ judge, revisions, members }) => {
      const examples: LogisticExample[] = [], counts = [0, 0];
      const scans = members.map(member => countPrefilterTrainingSteps({ ...member, onExample: example => {
          if (selectPrefilterTrainingExample(example, counts)) {
            examples.push({ vector: example.vector, private: example.private });
            counts[Number(example.private)]!++;
          }
        } }));
      // Rotate 32-row ledger windows as the worker does; continue counting after
      // the fitting caps fill without retaining further vectors.
      while (scans.length) for (let i = 0; i < scans.length;) {
        const step = scans[i]!.next();
        if (!step.done) { i++; continue; }
        scans.splice(i, 1);
        for (const [source, values] of Object.entries(step.value.per_source)) {
          const total = report.per_source[source] ??= { personal: 0, private: 0 };
          total.personal += values.personal; total.private += values.private;
        }
      }
      report.examples = { personal: counts[0]!, private: counts[1]! };
      const fit = trainLogisticSteps(examples);
      let step = fit.next();
      while (!step.done) step = fit.next();
      if (!step.value) { report.outcome = 'too_few'; return; }
      saved = { judge, revisions, model: step.value, trainedAt: Date.now(), version: randomUUID() };
    } });
    if (scan.errors) throw new Error();
    if (saved) {
      // Exclusive creation refuses existing files, symlinks and hard links. No sidecar.
      const fd = openSync(output, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(saved)); fsyncSync(fd); }
      catch (error) { rmSync(output, { force: true }); throw error; }
      finally { closeSync(fd); }
      report.outcome = 'trained';
    }
  } catch { report.outcome = 'failed'; } // Counts/fixed outcome only, never exceptions or paths.
  console.log(JSON.stringify(report));
  return report.outcome === 'trained' ? 0 : 1;
}
