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

## Round 2: messages and email

Round 1 is files only. Round 2 adds Telegram, WhatsApp and Gmail, labeled from
what the private judge actually reads: the item's names and its excerpt of at
most 1,200 characters. Its data lives in `round2/` inside the calibration
folder, so it has its own labels and never mixes with round 1.

```bash
bun eval/calibration/sample-messages.ts --stores DIR
```

`DIR` holds copies of each source's four stores, made with `sqlite3 ".backup"`.
It never reads a live store and prints counts only. By default it takes 100
Telegram, 50 WhatsApp and 60 Gmail items from the last two years, at most 3 per
chat or sender while a source has enough to spare. Secrets and anything the
judge would not read are left out.

- **Stratified:** 30% come from items the judge already called Private, so both
  classes are big enough to measure. A score on this sample overstates recall
  unless it is reweighted with each item's `stratum` and the populations in the
  sample's `recipe`.
- **Judge input:** a queued item shows the production input verbatim. An
  answered item's input is rebuilt, because its question is gone, and
  `judgeSeesExact` is false. A rebuilt input lacks names the stores do not keep:
  Gmail's labels, and a Telegram forward's origin or attachment names.

```bash
bun eval/calibration/label.ts --dir ~/.local/share/olympus-calibration/round2
bun eval/calibration/score.ts --dir ~/.local/share/olympus-calibration/round2
```

`score.ts` classifies from the stored names, so it has the same gaps as a
rebuilt input.

## Judge runs on a llama.cpp server

`judge-run.ts` runs the private judge over either round and scores it against
the labels. The system prompt, user message, secret and injection screens, and
the answer parser are imported from production, so they cannot drift. Only
labeled Personal and Private items run; Not sure and Skip are left out.

```bash
bun eval/calibration/judge-run.ts --endpoint http://127.0.0.1:8012 \
  --dir ~/.local/share/olympus-calibration/round2 \
  --model NAME --owner-words FILE --primed-check 20
```

- **Server:** `llama-server --jinja -np 1`. Only a loopback endpoint is accepted,
  so reach another machine through an SSH tunnel.
- **Modes:** `decision` (the default) pre-fills the reply up to the tier and
  reads one token's probabilities; the verdict is Private at P(Private) of 0.5
  or above. `full` is production's whole JSON answer.
- **Reasoning:** off, unless `--thinking` is passed. `decision` needs it off.
- **Priming:** each pass first loads the shared prompt. `--primed-check N` runs N
  items primed and unprimed and reports any answer that differs.
- **Speed:** a warm-up pass gives the verdicts, then 3 timed passes give the
  median and range. Any verdict that moves between passes is counted.
- **Score:** both kinds of mistake, Private and Personal recall and balanced
  accuracy, by source, split and stratum. Round 2 also reports a score
  reweighted to the natural mix. Its stratum sizes count every item the judge
  could read, including kinds the sample leaves out, so the weights are close
  rather than exact.

Output and the saved `judge-*.json` carry ids, counts and metrics, never text.

### On Venice

`--venice MODEL_ID --allow-venice` runs the same items through production's
Venice judge (the adapter the tier sniffer builds, thinking off), in full mode.
Item text then goes to api.venice.ai, so both flags are required and the
loopback guard stays the default. Run it only on items the owner has said may
go to Venice. The key comes from `VENICE_API_KEY` and is never printed.

```bash
VENICE_API_KEY=... bun eval/calibration/judge-run.ts \
  --venice google-gemma-4-26b-a4b-it --allow-venice \
  --dir ~/.local/share/olympus-calibration/round2 --owner-words FILE --concurrency 8
```

- **Policy:** a model whose Venice privacy category is below Private stops the
  run, as it would in production.
- **Concurrency:** `--concurrency N`, 1 to 8, the sniffer's own range.
- **Recorded per pass:** latency (median and 95th percentile), prompt, cached,
  completion and reasoning tokens per item from Venice's usage report, failed
  calls, and the key's request and token limits. Cost follows from the tokens
  and Venice's price list.

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
