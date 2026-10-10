# Calibration kit: is Olympus's Private really private?

Step 1 of [the categorization precision plan](../../docs/design/categorization-precision.md).
This kit stands apart from the plugin. It reads your files and Olympus's code
and models, but never opens an Olympus store, ledger or engine, and never
changes what Olympus stores or serves.

Its data lives in `~/.local/share/olympus-calibration/` (owner-only), outside
the repository and outside Olympus's own data. Set `OLYMPUS_CALIBRATION_DIR`
to use another folder.

## 1. Sample (done once)

```bash
bun eval/calibration/sample.ts
```

- **What it reads:** your Dropbox folder on this Mac. It picks 150 real
  documents that already have readable text (PDF, Word, Excel, PowerPoint,
  text, Markdown, CSV, HTML), using Olympus's own text extractor.
  - Online-only files are skipped, so nothing is downloaded.
  - Scans with no text layer are skipped.
- **How it picks:**
  - Half the sample is files whose folder or name suggests someone's own
    records (health, tax, bank, insurance, legal, and so on). These are taken
    where they are densest.
  - The other half is spread across every area for breadth.
  - At most 8 files per area, and 3 per folder.
- **Reproducible:** the same `--seed` gives the same sample. `--force`
  replaces an existing sample.

## 2. Label (about 20 minutes)

```bash
bun eval/calibration/label.ts
```

This opens a page on `127.0.0.1` only, behind a one-time link. Each file shows
its name, folder and text.

| Key | Label |
|---|---|
| **P** | Personal |
| **X** | Private |
| **U** | Not sure |
| **S** | Skip |
| **F** | Show the file in Finder |
| **N** | Next unlabeled |
| ← → | Previous / next file |

Every key saves straight away, so you can stop and come back at any time.

## 3. Score

```bash
bun eval/calibration/score.ts
```

This runs Olympus's production classifier over your labeled files. The
built-in private model answers in its own local process, and the running
engine is not touched. Your privacy words and folder rules are read, never
written. It prints:

- **Private precision**: of the files Olympus made Private, how many you call
  Private.
- **Private recall**: of the files you call Private, how many Olympus made
  Private.
- **Misses**: every miss, listed by file name.

The full result is saved beside the labels. A file Olympus still holds for the
model counts as Private, because that is what you experience.

Targets: 95% precision and 99% recall. It takes about 2 to 3 seconds per file.

## Venice embedding content preference (2026-10-10)

Owner-approved on 2026-10-10, using only committed synthetic eval fixtures:
7 versioned documents and 4 consult-leak candidates, their 6 existing answerable
questions, and all 25 frozen `HELD_OUT_BLIND_2` questions as off-domain controls.
The controls include housing and legal near misses; the documents do not answer
them. No private calibration samples, live stores, engine or sovereignty settings
are read. This is a bounded fixture calibration, not evidence of live-corpus
precision or recall; the consult blind set was written for a different eval.

The shipped Venice request format (title plus text, query instruction, 4096
dimensions) gives an off-domain best-cosine peak of **0.42807838135881765** and
an expected-document true-positive floor of **0.4829398465116097**. The smallest
hundredth above that peak is **0.43**, below every measured positive. As with
Gemini's 0.61 peak / 0.66 floor / 0.62 bar, this earns vector content preference
in fusion; it does not add a vector-lane rejection floor or change embeddings.
Local Qwen3 remains uncalibrated because its identity and dimension differ.

`venice-relevance-result.json` records every score and the fixture digest;
`embedding-ledger.jsonl` records approval and the numbers. To reproduce after
obtaining approval for another credential-bearing API measurement, run on
Xanthos (remote-build forbids secret-bearing jobs):

```bash
set -o pipefail
VENICE_API_KEY=$(secret get Venice-API-Key) bun eval/calibration/venice-relevance.ts
```

The runner imports the production embedding provider and exits nonzero if no
hundredth separates the controls from the expected positive documents. It never
prints credentials. API usage is fixture-sized (42 input embeddings per final
measurement); the repository estimate is $0.0125 per million tokens.
