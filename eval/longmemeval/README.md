# LongMemEval retrieval score and the MemPalace comparison (issue #626)

Measured 2026-11-10 on `main` at `55bddb4` (the full-text `note` row re-run unchanged on `4fdf6ca`). Retrieval only: no Analyst, no
model calls, no embeddings (see "Caveats").

## Answer in one line

Olympus's shared keyword retrieval finds an evidence session in the top 5 for
**93.2% of LongMemEval-S questions** (all 500, full session text) and **89.8%**
in MemPalace's own setup (user turns only), against MemPalace's published 96.6%
for dense-embedding retrieval. On the first 100 questions, adding the built-in
embedding lane (hybrid) moves top-5 from 95 to 96 and top-1 from 85 to 89.
Record it; don't publish it until a full hybrid run and an answer-accuracy run
exist.

## What was measured

- **Benchmark.** LongMemEval-S, `longmemeval_s_cleaned.json`: 500 questions,
  each with its own haystack of about 50 chat sessions (19,195 distinct
  sessions in all). Every question was scored; nothing was subsampled.
- **Code path.** [`eval/longmemeval/retrieval.ts`](../../eval/longmemeval/retrieval.ts).
  Each question's sessions become `RawItem`s of a plain `SourceConnector`, are
  synced into a fresh in-memory `LocalConnectorStore` with
  `syncFromConnector`, and the question text is searched as-is through
  `createConnectorStoreCorpusAdapter`, the same routed search every connector
  store serves. Nothing in the path knows it is a benchmark: one session is
  one item, its date is the item's `sentAt`, the title is generic.
- **Retrieval mode.** Keyword only (SQLite FTS5 lane with its empty-result
  relaxation). The product's built-in embedding model could not be installed
  here (below), so the vector lane and RRF fusion did not run.
- **Metric.** Session-level `recall_any@k` (at least one evidence session in
  the top k distinct sessions) and `recall_all@k` (all of them), the
  definitions LongMemEval and MemPalace's `benchmarks/longmemeval_bench.py`
  use. MemPalace's 96.6% is `recall_any@5` over all 500 questions with user
  turns only, one document per session.

## Results (all 500 questions, per-question haystack)

| Indexed text, item family | R@1 | **R@5** | **R@10** | all@5 | all@10 | no evidence returned |
|---|---:|---:|---:|---:|---:|---:|
| User turns only, `note` (MemPalace's raw setup) | 85.2 | **89.8** | **89.8** | 72.8 | 73.2 | 51 |
| User + assistant turns, `note` | 85.8 | **93.2** | **94.0** | 78.8 | 82.0 | 28 |
| User turns only, `chat` | 69.8 | 89.2 | 93.2 | 70.6 | 76.8 | 33 |
| User + assistant turns, `chat` | 59.8 | 90.4 | 95.2 | 70.6 | 83.4 | 20 |

Skipping the 30 abstention questions (LongMemEval's own retrieval scoring
does): user + assistant, `note`, R@5 93.4, R@10 94.0 on 470.

By question type, user + assistant turns, `note` (R@5 / R@10, count):
knowledge-update 96.2 / 96.2 (78), multi-session 94.7 / 94.7 (133),
single-session-assistant 100 / 100 (56), single-session-preference 76.7 / 76.7
(30), single-session-user 95.7 / 95.7 (70), temporal-reasoning 89.5 / 92.5
(133).

**Scale stress test (not a LongMemEval metric).** With `--shared-store`, all
19,195 sessions go into one store and every question searches all of them
(user + assistant turns, `note`): R@1 22.0, **R@5 41.4, R@10 50.4**, all@5
23.4, all@10 30.4; no evidence session returned for 151 of 500; median search
latency 467 ms. By type, R@5 / R@10: knowledge-update 64.1 / 73.1,
multi-session 31.6 / 38.3, single-session-assistant 92.9 / 94.6,
single-session-preference 3.3 / 6.7, single-session-user 28.6 / 41.4,
temporal-reasoning 31.6 / 45.1. This store mixes many simulated users'
histories, so it is harsher than one person's real store of the same size,
but it shows how much of the standard score comes from the 50-session
haystack.

For reference, MemPalace's published LongMemEval R@5 (their numbers, not
reproduced here): raw ChromaDB with all-MiniLM-L6-v2, 96.6%; their BM25
baseline, about 70%; hybrid with LLM rerank, 100% (98.4% on 450 held-out).

Wall clock on a 4-core cloud VM: 14–30 s for all 500 questions; median search
latency 5–7 ms per question.

### What the numbers say

- R@5 and R@10 are nearly equal for `note`: the keyword lane returns few
  sessions, so when it misses it misses entirely (28–51 questions had no
  evidence session returned at all). Those are vocabulary-gap misses, which
  is the vector lane's job; they cluster in preference (6 of 30) and temporal
  (9 of 133) questions.
- Indexing assistant turns helps (89.8 → 93.2 R@5). The product indexes the
  whole item, so the full-text row is the product's real number; the
  user-only row exists only for comparison with MemPalace.
- The `chat` family adds the chat recency lane, which fuses the newest
  sessions in. On a benchmark whose questions are not about the newest
  message, that costs R@1 (85.8 → 59.8) and buys R@10 (94.0 → 95.2). This is
  the product's intended chat behaviour, not a benchmark artefact; it is
  worth knowing when reading chat answers that hinge on an older message.

## The issue's three points

### 1. Public benchmarks — **do** (record), **later** (publish)

- **Do:** keep the harness and this record. It runs the real shared path with
  no benchmark-specific code, so the architecture guard holds, and a full run
  takes under a minute keyword-only.
- **Hybrid score, first 100 questions (measured 2026-11-10, Xanthos, Metal GPU,
  `51a0d08`, EmbeddingGemma 2, semantic lane used on every question).** Keyword
  then hybrid on the same 100: any@1 85 → 89, any@5 95 → 96, all@5 80 → 81,
  any@10 95 → 96, all@10 84 → 84, no evidence 5 → 4. Hybrid gains most at
  top 1; at top 5 and top 10 the keyword lane already finds nearly everything
  in a 50-session haystack. The run took 2.5 h, almost all of it embedding each
  haystack from scratch (search itself: 66 ms median), so all 500 would take
  about 12.5 h on Xanthos. That subset covers only two question types
  (30 multi-session, 70 single-session-user), so it isn't a headline number.
  Results: #626.
- **Later — answer accuracy:** LongMemEval's headline metric is QA accuracy
  with an LLM judge. It needs the Analyst (and `buildEvidencePackDetailed`)
  wired into this harness and a judge model; not done today. Report it next
  to the held-out `eval/`, which stays the definition of done.
- **Later — LoCoMo:** not run. Same harness shape (one conversation's sessions
  as items); worth doing only after the hybrid run.
- **Don't publish yet.** Keyword-only 93.2% is below MemPalace's 96.6%
  headline, and a retrieval-only number invites comparison with QA-accuracy
  numbers it does not measure. Revisit once the hybrid and QA runs exist; if
  hybrid lands at or above the mid-90s, a dated, reproducible "retrieval
  recall, no LLM" line on the site is fair.

### 2. Dated facts (validity windows) — **don't** now, **later** if QA shows the gap

- The `facts` field of an `EvidencePack` candidate (`StructuredEvidenceFact`
  in `src/core/opsec.ts`, reached from `src/core/contracts.ts`) is a cache
  that the connector store does not populate today, and Contract 2 says facts
  are never the answer path. Adding `validFrom`/`validUntil` would change a
  type the contract fingerprint covers, so it is a versioned contract change
  under the gate in `docs/ENGINEERING_PROCESS.md`, not a small increment.
- Olympus already answers "current X" without a fact graph: every item keeps
  its date, `authoredAfter`/`authoredBefore` filters run in every lane, and
  `src/core/evidence-versions.ts` keeps the newest version of a document in
  reach and lets the Analyst pick the date the question asks about.
- Retrieval is not the bottleneck here: knowledge-update questions score
  96.2% R@5 keyword-only. Whether the Analyst then states the newest value is
  an answer-accuracy question; measure it (point 1, QA run) before changing
  the contract. If knowledge-update QA accuracy lags the other types, propose
  validity windows as a contract minor version then.

### 3. Scoped retrieval — **don't** copy the hierarchy; **later**, measure scale

- Olympus scopes retrieval by corpus (each source's store, chosen through the
  corpus registry), by account, and by SQL filters applied in every lane:
  folder paths (`locatorPathScope(s)`), conversation, sender, date range and
  search-context facets (labels, collections). The query planner widens
  wording, not scope. There is no automatic person/project → topic tree.
- MemPalace's "halls" classify each question into a topic before searching.
  That is a per-question routing step, close to the template layer the
  architecture guard exists to keep out. Their own write-up reports palace
  mode only with an LLM rerank (99.4%), the same score as their flat hybrid
  scoring plus rerank, so on LongMemEval the hierarchy shows no gain of its
  own.
- LongMemEval's per-question haystack is itself a tight scope (about 50
  sessions). Searching all 19,195 sessions at once instead
(the stress test above) drops keyword R@5 from 93.2% to 41.4%, so scope is
worth a great deal at real-store sizes, and the standard benchmark hides it. If a later hybrid run shows the same drop,
  the fix to try is a generic date-range or conversation filter chosen by the
  existing planner, not a topic tree.

## How to reproduce

Data stays outside git (`eval/private/` is gitignored):

```sh
mkdir -p eval/private/longmemeval
# longmemeval_s_cleaned.json from the xiaowu0162/longmemeval-cleaned dataset
bun eval/longmemeval/retrieval.ts --include-abstention --roles all  --family note
bun eval/longmemeval/retrieval.ts --include-abstention --roles user --family note
bun eval/longmemeval/retrieval.ts --include-abstention --roles all  --family chat
bun eval/longmemeval/retrieval.ts --include-abstention --roles all  --family note --shared-store
# hybrid, where the built-in model is installed (EmbeddingGemma 2 shown;
# without OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL the env default is Arctic):
OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL=embeddinggemma-2-litert-24d962e \
  bun eval/longmemeval/retrieval.ts --include-abstention --roles all --family note --embedding built-in --limit 100
```

The hybrid run embeds every question's haystack afresh (about 25,000
sessions for all 500), so start with `--limit 100` and say which subset a
recorded number used.

Default `--data` is `eval/private/longmemeval/longmemeval_s_cleaned.json`.
Without `--include-abstention` the 30 `_abs` questions are skipped.
`--limit N` takes the first N questions.

## Caveats

- **Keyword only.** huggingface.co was blocked from the cloud session that
  ran this, and both the built-in model weights (Arctic Embed M v1.5,
  EmbeddingGemma 2) and the dataset are hosted there. The hybrid path is wired
  in the harness (`--embedding built-in`) and reaches the store's embedding
  step, where the model install fails here; no hybrid number exists yet.
- **Data copy.** The dataset file came from a public Git LFS mirror
  (Tencent/ContextPilot, `infer/data/LongMemEval/longmemeval_s_cleaned.json`),
  sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`,
  277,383,467 bytes, 500 questions, matching the upstream counts by question
  type. It was not byte-compared with the Hugging Face original.
- **MemPalace numbers are theirs.** Their 96.6% was not reproduced here.
  The comparable row above matches their indexing (user turns, one document
  per session, all 500 questions, `recall_any@5`), but their retrieval always
  returns 50 ranked sessions, while the keyword lane returns only sessions
  that match.
- **Retrieval is not answering.** These are recall numbers. They say nothing
  about whether the Analyst answers correctly.
