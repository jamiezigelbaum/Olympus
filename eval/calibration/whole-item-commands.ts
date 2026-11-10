// Prints exactly what the owner runs for the whole-item calibration round:
// sample on the machine that holds the stores (Sparta), then label and score
// on the Mac. It runs nothing itself.
//
//   bun eval/calibration/whole-item-commands.ts [--count 200] [--store-host sparta]

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1]! : fallback;
};
const count = Number(flag('--count', '200'));
const host = flag('--store-host', 'sparta');
// `~` on purpose: each command runs on its own machine, under its own home.
const dir = '~/.local/share/olympus-calibration/whole';

console.log(`# Whole-item calibration (#883, #864). Store copies and the sample stay in
# ${dir} (owner-only); the labels never leave the Mac.

# --- On ${host}, where the stores are -------------------------------------------
# Copies every store (imported archives included) with production's snapshot,
# draws ${count} whole items, freezes sample + criteria in manifest.json, deletes
# the copies. Prints counts only.
cd ~/Code/Olympus && git pull --ff-only && bun install
bun eval/calibration/sample-whole.ts --from-install --count ${count}

# --- On the Mac -------------------------------------------------------------------
mkdir -p ${dir} && chmod 700 ${dir}
rsync -a --chmod=go-rwx ${host}:${dir}/sample.json ${host}:${dir}/manifest.json ${dir}/
cd ~/Code/Olympus && git pull --ff-only && bun install
# Label in the browser, on 127.0.0.1 only. Every key saves at once; stop any time
# and run the same command to carry on.
#   P Personal · I Private: important · M Private: minor · X Secret · U Not sure
#   then, for Private or Secret, where the sensitive part is:
#   E in the highlighted part · O only outside it · A in an attachment · T in the name
bun eval/calibration/label.ts --dir ${dir}

# --- Later, on the Mac, once labeled: score (counts only) ----------------------------
# Built-in 4B, through the production classifier, in its own local process:
bun eval/calibration/score.ts --dir ${dir}
# Delphi 35B on llama.cpp, through the usual tunnel:
ssh -N -L 8012:127.0.0.1:8012 delphi-admin@delphi.local &
bun eval/calibration/judge-run.ts --endpoint http://127.0.0.1:8012 --dir ${dir} --model <35b-model-name> --owner-words saved --passes 0
bun eval/calibration/score-whole.ts --dir ${dir} \\
  --judge builtin-4b="$(ls -t ${dir}/score-all-*.json | head -1)" \\
  --judge delphi-35b="$(ls -t ${dir}/judge-decision-*.json | head -1)"
# Venice sends item text to api.venice.ai: only with your OK for these items.
#   VENICE_API_KEY=... bun eval/calibration/judge-run.ts --venice <model-id> --allow-venice --dir ${dir} --owner-words saved --passes 0
`);
