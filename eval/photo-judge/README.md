# Photo judge calibration

The photo judge (`src/workers/source-index/media-judge.ts`) compares a
picture's image-only vector with short descriptions. This kit measures it.

1. Score pictures with the real model on a Mac (writes only the output file):

   ```bash
   bun eval/photo-judge/scores.ts --manifest eval/photo-judge/manifest.json --out /tmp/fixtures.json
   bun eval/photo-judge/scores.ts --dir <specimens> --label sensitive --group specimens --out /tmp/specimens.json
   bun eval/photo-judge/scores.ts --dir <owner photos> --label ordinary --group owner --anonymize --out /tmp/owner.json
   ```

2. Replay judges over the scores anywhere, without pictures or the model:

   ```bash
   bun eval/photo-judge/replay.ts /tmp/fixtures.json /tmp/specimens.json /tmp/owner.json
   ```

`fixtures/` holds synthetic pictures: everyday writing (whiteboards, slides,
screenshots, menus, notes), labelled ordinary, and sensitive records (lab
results, prescriptions, statements, payslips, tax forms) with made-up names.
`demo-kit-whiteboard.jpg` is the demo kit's Evernote whiteboard, which the
2026-10-08 judge called a medical document.
