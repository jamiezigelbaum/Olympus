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

- **Context:** `--context 2` keeps the 2 messages either side of each item, so
  a bare link or a short reply can be read. The labeling page greys them out and
  marks them context only; you label the middle message alone. They stay in the
  owner-only sample file, and no judge run reads them.
- **Long messages:** a message longer than the judge's excerpt shows in full on
  the labeling page, up to its 6,000-character limit, with a badge. The parts the
  judge reads are highlighted and the rest dimmed, so you label the whole message.
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

## Whole-item round: a probability sample of whole items (#883, #864)

```bash
bun eval/calibration/whole-item-commands.ts   # prints exactly what to run, and where
```

Sample on the machine that holds the stores (Sparta), then label on the Mac:

```bash
# On Sparta
bun eval/calibration/sample-whole.ts --from-install --count 200
# On the Mac
mkdir -p ~/.local/share/olympus-calibration/whole && chmod 700 ~/.local/share/olympus-calibration/whole
rsync -a --chmod=go-rwx sparta:~/.local/share/olympus-calibration/whole/sample.json \
  sparta:~/.local/share/olympus-calibration/whole/manifest.json ~/.local/share/olympus-calibration/whole/
bun eval/calibration/label.ts --dir ~/.local/share/olympus-calibration/whole
```

- **Copy:** `--from-install` finds this machine's stores the way the running
  Olympus does. It copies every active account's stores, tier ledger and
  sniffer file into `whole/stores`, plus the extraction jobs, using
  production's snapshot (the copier never opens an install file with SQLite).
  Imported archives are included, one store set per family, and each family is
  a source of its own for stratification (`archive.imports.<family>`). It
  removes the copies after sampling unless you pass `--keep-stores`.
  `--install-home DIR` does the same for a copy of another machine's home
  folder, read with the default layout under it. `--stores DIR` reads copies
  you already made.
- **Population:** every tier-ledger item that is not moving, not in Secrets,
  still stored and top-level, from the last two years (`--since`). It must
  have at least 15 characters of text, or be an item whose extraction failed.
  Attachments are not counted on their own; they are shown with their parent.
  Counts are taken after these filters, so they describe exactly what the
  sample is drawn from. The recipe also records each source's ledger rows and
  every exclusion by reason.
- **Design:** a stratified simple random sample, stratified by source and by
  whether the judge called the item Private (30% of the count, for recall).
  Every cell gets at least 3, and the rest follows population size. There are
  no per-group caps and nothing is rejected after the draw. Each item records
  its inclusion probability, and a score reweights by cell population over the
  items labeled in that cell.
- **Split:** each item's half is decided by the related group it belongs to:
  its conversation, folder, or an email's sender (which stands in for a
  template). Items that share any of these land in the same half, and the id
  is never used.
- **Whole items:** each item is stored with all of its text, up to 400,000
  characters. Attachments come with their own text and how each was read. The
  item also records its extraction outcome (read, OCR, transcript, failed or
  pending), whether the judge reads all of it, and whether the injection
  screen holds it. Text comes from the ledger's current copy, not a
  superseded one left after a tier move.
- **Frozen:** `manifest.json` holds the sample's SHA-256 and the acceptance
  criteria (`whole-item-criteria.json`: weighted Private precision of at least
  95% and recall of at least 99%, and no Important or Secret item let through,
  read on the test half), hashed together. The scorer refuses a sample or
  manifest that has changed since.

The labeling page shows the whole item, with the part the judge reads
highlighted, then each attachment, and flags any text Olympus could not read.
The keys are **P** Personal, **I** Private: important, **M** Private: minor,
**X** Secret and **U** Not sure. For Private or Secret it then asks where the
sensitive part is: **E** in the highlighted part, **O** only outside it,
**A** in an attachment, **T** in the name.

Once the items are labeled, run each judge with its usual tool, then score
them together:

```bash
bun eval/calibration/score.ts --dir ~/.local/share/olympus-calibration/whole            # built-in 4B
bun eval/calibration/judge-run.ts --endpoint http://127.0.0.1:8012 --dir ~/.local/share/olympus-calibration/whole \
  --model NAME --owner-words FILE --passes 0                                              # Delphi 35B, via SSH tunnel
bun eval/calibration/score-whole.ts --dir ~/.local/share/olympus-calibration/whole \
  --judge builtin-4b=FILE --judge delphi-35b=FILE [--judge venice=FILE]
```

For each judge, the scorer reports:

- the whole matrix of owner label by verdict;
- Private→Personal and Personal→Private, as counts, unweighted rates, and
  weighted rates with Wilson intervals at Kish's effective sample size;
- injections, counted apart from the matrix;
- per-source counts and scores;
- the frozen criteria, read on their half;
- scores broken down by extraction outcome and by attachments, by whether the
  judge read the whole text, and by where the owner said the sensitive part
  was. These measure extraction and excerpt selection separately from the
  judge. Scoring production's own placement, per component, is #1159.

It also reports paired disagreements between every two judges, with an exact
McNemar test. Output is counts and rates only, with no text, names or item
ids. `judge-run.ts` and `score.ts` now record the sample's hash. The scorer
refuses a result that has no hash or a different one. Both tools score Secret
labels as Private instead of dropping them. On a whole-item sample they also
use each item's group split for `--split`. A judge without a verdict on every
labeled item fails the criteria on `coverage`, so a subset never passes.
`--owner-words saved` reads this machine's saved privacy words.

## Judge runs on a llama.cpp server

`judge-run.ts` runs the private judge over either round and scores it against
the labels. The system prompt, user message, secret and injection screens, and
the answer parser are imported from production, so they cannot drift. Only
labeled Personal and Private items are scored. Skip is left out, Not sure is
reported on its own line as the share called Private, and `--exclude ID,ID`
leaves out any others.

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

Private items can be split by how much they matter, one pass per folder:

```bash
bun eval/calibration/label.ts --importance --dir ~/.local/share/olympus-calibration
bun eval/calibration/label.ts --importance --dir ~/.local/share/olympus-calibration/round2
```

It shows only the items labeled Private: **I** Important, **M** Minor, **U** Not
sure, **P** Actually Personal. The answers go to `importance.json` beside the
labels. P instead changes that item's label in `labels.json` to Personal, marked
`correctedInImportancePass`, and clears any tag. When `importance.json` exists, a run leads with `privateMissed`: Private
items sent to Personal, as important, minor and untagged.

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
- **Concurrency:** `--concurrency N`, 1 to 64. Production's sniffer allows at most 8 today; a higher value measures what a Venice key could sustain.
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

## Replay stored sniffer verdicts

`sniffer-replay.ts` reads only explicitly supplied SQLite backup copies, never
opens the live lane, and takes each judged item from the tier ledger. Its input
is rebuilt through the sampler's `storedSignals` / `judgeInput` path; the
inventory's `exactInput` says how many rebuilt inputs hash to a stored verdict,
since the stores do not keep every name the judge saw (Gmail's labels, for one).
Copies must not be in WAL mode (`PRAGMA journal_mode=DELETE` on the copy) or a
read-only open fails. All six source folders use the same reader, and items
that cannot be rebuilt are counted and never sent to the model.

```bash
bun eval/calibration/sniffer-replay.ts --stores DIR \
  --endpoint http://127.0.0.1:8012 --model NAME --owner-words FILE \
  --out replay.jsonl --disagreements disagreements.jsonl --deadline-seconds 600
bun eval/calibration/sniffer-replay.ts --out replay.jsonl --report
```

Use an SSH tunnel to a llama.cpp server (`--jinja -np 1`); only literal IPv4
loopback addresses and `::1` are allowed. `--sources a,b` selects source folder
names; `--limit N` bounds additional comparison rows. Runs interleave sources.
Repeating the same command resumes the checkpoint, reusing completed hash
judgments, including when several old model/prompt/map rows share a hash.
Changing the model, endpoint, owner words, production prompt or saved verdicts
requires a new checkpoint. A torn final JSONL line is refused; restore or
remove that incomplete line before resuming. Both output files are mode 600
and appended with an fsync per row. Disagreements contain only source, hash
and matching item IDs; the checkpoint contains no item IDs or text. Keep both
files outside the stores directory. Raw responses and error details are never
logged. The llama.cpp server must also have prompt/request logging disabled.

The tool calls production's `completeSnifferQuestion` and
`createDecisionSnifferModel`: same owner-context prompt, parent-context
filter, secret/injection screens, strict parser, coverage floor and decision
bar. Coverage and P(Private) come from the production adapter itself. Full-mode
fallback is refused. One failed call stays undecided; replay does not invent a
Private fail-safe or spend production's three-attempt retry budget.

Reports show inventory, agreement matrices, counts and inference throughput
(the median latency converted to items/minute, and unique hash attempts divided
by their total call time; store reconstruction and checkpoint I/O excluded).
Only real old Personal/Private decisions compared to real new decisions enter
agreement percentages. Stored undecided, fail-safe and injection verdicts have
separate matrix buckets. Errors, timeouts, parse failures, below-floor coverage,
secret refusals, fail-safes and injection regressions are explicit, including zeros.
Coverage and probability are null for screened inputs or transport failures.

This is a decision replay, not a live resolver run: it cannot exercise owner
approval/sovereignty discovery, queue scheduling, budgets, live revalidation,
cache/ledger writes, retries, held lowerings or small-built-in-model record
holds. Those require the live item state and are intentionally outside this
read-only tool. The production transport still enforces redirects and its
zkAPI endpoint refusal. No live stores, owner calibration data or model server
are needed by `test/sniffer-replay.test.ts`; it uses invented SQLite fixtures
and a loopback fake server only.

## Injection screen hits, by shape

```bash
bun eval/calibration/injection-screen-shapes.ts --dir ~/.local/share/olympus-calibration/round2 \
  [--baseline ~/Code/Olympus/src/workers/classification/sniffer.ts] [--json]
```

Runs the sniffer's injection screen over every item's judge input (built as
`judge-run.ts` builds it) and prints one row per hit: item id, owner label,
source, the rule that fired, and shape only: names or excerpt, the length of
the smallest span that still fires the rule, its position, the lines it covers,
which of the screen's own fixed keywords it holds, and yes/no markers (quoted
reply line, header-like line, code punctuation, tag, URL, address, first or
second person, forwarded item). No item text is printed. `--baseline` loads
another checkout's `sniffer.ts` (a `main` checkout, say) and lists that
screen's hits too, each with the rule today's screen fires on it or `clear`.

## Counts-only embedding pre-filter scorer

From a source checkout with dependencies available, select a SavedModel-format weights file from the offline trainer:

```sh
bun --no-install eval/calibration/score-prefilter.ts --weights /absolute/path/to/weights.json \
  --embedding-dir /absolute/path/to/installed/built-in-embedding
```

The default sample root is `~/.local/share/olympus-calibration`; override it with
`--calibration-dir DIR`. Read rounds 1–4, using `round3/labels.final.json` and
`labels.json` in the other rounds. Do not deduplicate across rounds or silently
substitute a preliminary label file. Missing rounds fail with an error count.
`--synthetic` replaces all sample/label reads with one in-memory synthetic item,
for a safe runtime smoke check. It still needs installed model/runtime files.

This tool never installs or downloads anything, never opens an Olympus store,
and never uses provider configuration, a remote helper or a cloud model. It
starts the local built-in LiteRT helper directly, pinned to production's
`embeddinggemma-2-litert-24d962e` manifest, and releases it on exit. Its only
writes are the native runtime's temporary compiled-program cache, removed on
exit; it never writes text, vectors or per-item results. A malformed file or
startup failure prints only `{"errors":1}`. Item-level failures increment
`unscorable`, with no exception text.

The vector recipe reuses production `chunkText` (trim, contiguous 4,000-character
chunks, no three-chunk truncation), `buildConnectorStoreEmbeddingText`, the
built-in document `promptText` prefix and normalization, Float32 storage rounding,
and `prefilterVector`'s complete-chunk arithmetic mean. File titles use `name`;
message titles use `signals.title`, never the sampler's synthetic `name`/id.
MIME type and modification time come from the sample. Owner-only neighbouring
messages and `judgeSees` are not added to the embedding input.

**Historical sample limit:** the saved samples do not contain the original
`search_text`, exact chunk boundaries or every embedding metadata column.
Message sampling joined/truncated stored chunks; round 3's replay sampler put
judge material in `text`. This is the exact production recipe applied to the
saved representation, not byte-for-byte reconstruction of the original stored
vectors or proof of live clearance recall. The old Python embedding scripts
used different framing and a three-chunk cap; this scorer does not reuse those
vectors or generate replacement files.

Output is one JSON object: labelled Personal/Private/unsure counts, unscorable
count, and clearance and Private-miss counts at p < 0.001, 0.002 (production), 0.01, 0.02 and 0.05.
Scoring calls production `privateProbability` directly, without a prior correction. Each miss
contains only `p` and `round`. Unsure items count as unsure and can contribute to
clearance counts, never Private misses; skipped/unlabelled items are not scored.
The owner runs the real calibration; synthetic checks alone establish wiring.


This scorer is the gate for **any change to clearing**: there must be **0
owner-label Private misses before rollout**, at the intended clearing cutoff.
Check all rounds and the unscorable count; synthetic checks do not establish
owner-label safety or useful coverage. Restoring the scorer and correcting label
selection do not establish that the present fitter meets that gate.

Gate result, 2026-11-08 (#1025, L-BFGS fit trained offline on Sparta from 5,000
Personal and 2,824 Private judge labels): of 486 owner-Personal and 127
owner-Private items, p < 0.002 clears 77 with 0 Private misses; 0.001 clears 52
(0); 0.01 clears 184 (1 miss, p 0.0028); 0.02 clears 245 (4); 0.05 clears 333
(10). Production clears below 0.002. The worker retrains daily, so a later
model is not covered by this result.

## Read-only offline training

From an unpacked release or a checkout with rebuilt dist:

```sh
bun ./dist/cli.js prefilter-train-offline --out /absolute/path/to/prefilter-weights.json
```

Optional `--data-dir DIR` selects an install. The command reuses the worker's
key-ordered 32-row scan windows, round-robin ledger order, judge-label/vector
eligibility, 5,000-per-class fitting cap and the same `trainLogisticSteps` as the worker.
The fit uses class-balanced C=10 L-BFGS with an unpenalized, zero-initialized
intercept: at most 500 iterations, 10 history pairs, 40 Armijo backtracking
trials per iteration and a scaled-gradient infinity-norm tolerance of 1e-8.
It yields per example/evaluation and rejects a fit that does not converge.
It continues counting all eligible rows after the caps fill. It needs the same
2,000 examples per class as the worker and reads the recorded install training
judge identity rather than inferring one from row labels.

All ledgers, stores and sniffer caches are inspected through the dry run's
private, temporary, read-only snapshots. No install SQLite file is opened by
SQLite. It never writes ledger/meta/checkpoint/audit state, installs weights or
enables clearing. The only retained output is a SavedModel-format weights file
at `--out`, created exclusively with mode 0600. The parent must exist; existing
files and symlinks are refused, as are output paths inside the install data
root (including through parent symlinks). Temporary snapshots are removed on
normal completion or failure. Snapshots across databases are not one transaction.

Stdout is one JSON object with uncapped eligible Personal/Private counts per
fixed public source name (unknown providers aggregate under `other`), capped
fitting counts and `trained`, `too_few` or `failed` outcome. Errors never print
paths, item identities, body text, vectors or exception messages. Too few labels
or a failed scan/fit produces nonzero exit and no weights file. Run the scorer
above against the output; do not copy it into an active model directory.
