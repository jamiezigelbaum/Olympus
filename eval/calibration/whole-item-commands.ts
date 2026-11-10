// Prints, for this machine, exactly what the owner runs for the whole-item
// calibration round: sample, label, and (after labeling) score. It runs
// nothing itself.
//
//   bun eval/calibration/whole-item-commands.ts [--count 200]

import { join, resolve } from 'node:path';
import { CALIBRATION_DIR_DEFAULT } from './files.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--count');
const count = at >= 0 ? Number(argv[at + 1]) : 200;
const repo = resolve(import.meta.dir, '..', '..');
const dir = join(CALIBRATION_DIR_DEFAULT, 'whole');
const quote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
const latest = (pattern: string) => `"$(ls -t ${quote(dir)}/${pattern} | head -1)"`;

console.log(`# Whole-item calibration (#883, #864). Everything stays on this Mac:
# the store copies, the sample, the labels and the scores live in ${dir}, owner-only.

cd ${quote(repo)}

# 1. Sample: copy this Mac's stores privately, draw ${count} whole items, freeze the
#    sample and its acceptance criteria (manifest.json). Prints counts only.
bun eval/calibration/sample-whole.ts --from-install --count ${count}

# 2. Label in the browser, on 127.0.0.1 only. Every key saves at once; stop any time
#    and run the same command to carry on.
#    P Personal · I Private: important · M Private: minor · X Secret · U Not sure
#    then, for Private or Secret, where the sensitive part is:
#    E in the highlighted part · O only outside it · A in an attachment · T in the name
bun eval/calibration/label.ts --dir ${quote(dir)}

# --- Later, once labeled: score (counts only) ---
# Built-in 4B, through the production classifier, in its own local process:
bun eval/calibration/score.ts --dir ${quote(dir)}
# Delphi 35B, through an SSH tunnel to a llama.cpp server (llama-server --jinja -np 1) on Delphi:
#   ssh -N -L 8012:127.0.0.1:<port> <delphi-host> &
bun eval/calibration/judge-run.ts --endpoint http://127.0.0.1:8012 --dir ${quote(dir)} --model <35b-model-name> --owner-words <owner-words-file> --passes 0
# Venice sends item text to api.venice.ai: only with your OK for these items.
#   VENICE_API_KEY=... bun eval/calibration/judge-run.ts --venice <model-id> --allow-venice --dir ${quote(dir)} --owner-words <owner-words-file> --passes 0
bun eval/calibration/score-whole.ts --dir ${quote(dir)} \\
  --judge builtin-4b=${latest('score-all-*.json')} \\
  --judge delphi-35b=${latest('judge-decision-*.json')}
`);
