# Cross-language keyword matching

Status: implemented 2026-10-11 after the owner called for the measured Spanish
LOI miss. The proposal below records the original design; implementation
choices and reproducible proof are recorded at the end.

## The problem

Search has two lanes:

- **Vector lane.** It is multilingual: EmbeddingGemma 2 places an English
  question near a Spanish passage on the same topic.
- **Keyword lane.** It matches exact words, so "notary" never matches
  "notario" or "escritura".

Three things depend on keywords:

1. **Counting a match.** Keyword hits decide whether a question matched at
   all.
2. **The relevance bar.** Scores across languages run lower, so a document in
   another language can sit just under the calibrated vector bar (0.73 for
   EmbeddingGemma 2) and be found only as an uncounted neighbour (#207).
3. **Choosing passages.** `selectEvidencePassages` prefers chunks that carry
   the query's terms. With none, it falls back to embedding rank alone.

The 2026-10-10 case was the owner's Spanish letter of intent. For the full
question, the opening chunk scored 0.740 and the deed and expenses clause
0.732.

- #210 lets near-tied chunks (within 0.03) share the budget, which fixed that
  question.
- For a short phrasing such as "Letter of Intent notary", the opening leads by
  0.05, so the deed clause is still not read.

## The proposal: translate the question, not the documents

At search time, add the question's key terms in the languages the owner's
corpus holds to the keyword lane only. The vector lane stays as it is.

1. **Which languages.** Record a per-store language profile at ingest (a
   cheap detector over chunk text, counts only). Translate only into languages
   above a small share, say 5% of chunks. Usually that is one or two.
2. **Translating.**
   - The local built-in model (Qwen) turns the question's content words into
     equivalent terms per language, for example notary → notario, notaría,
     escritura pública; fees → gastos, honorarios; deposit → arras, señal.
   - Output is a bounded JSON list: at most about 8 terms per language, and
     only single words or short phrases.
   - Everything runs on this computer. No Private text is involved: only the
     question, which ChatGPT already sent.
3. **Where the terms go.**
   - Each translated term joins its source term's concept group, as an extra
     alternative in that group. It does not create a new concept, so it
     cannot inflate the minimum-signal or IDF-share checks.
   - The same groups feed `sourceIndexChunkQueryTerms` for passage selection.
   - Hook point: `sourceIndexFtsTerms` / `sourceIndexFtsTermGroups` in
     `src/core/source-index/fts.ts`, which already expands
     `SOURCE_INDEX_SYNONYMS`. A per-request expansion map threaded through
     the request is the same shape.
4. **Caching.** Key by question text plus language profile. The private
   answer jobs already precompute per question, so the translation runs once
   per question.

## Why not translate documents at ingest

- It roughly doubles storage and indexing time for every file not in English.
- Embedding the translated text would be an embedding change, which needs the
  owner's advance approval and a ledger entry.
- Machine translation of legal and medical text drifts. The panel should read
  and quote the original.

## Costs and risks

- **Latency.** One short local model call, about 1–2 s on the owner's Mac.
  It runs in parallel with the vector query embedding, so it adds little in
  practice.
- **Precision.** Translated terms can over-match common words (for example,
  "gastos" appears in many Spanish documents). Keep them inside their source
  term's concept group so they never count as a separate concept, and keep
  the existing minimum-signal rules.
- **Generic.** No per-source or per-language rules in code; the language
  profile comes from the data.

## How to measure before shipping

- Use the blind sets in `olympus-egemma-work/eval-private/`
  (`retrieval-blind.json`, `retrieval-blind-2.json`) plus the four LOI
  phrasings.
- Compare:
  - answers found in the panel's picked items;
  - reads per unanswerable question;
  - whether the LOI passage carries "escritura" for the short phrasing.
- Ship only if the answerable count rises and unanswerable reads do not.


## Implementation and proof

The shared FTS concept groups and passage vocabulary now accept bounded local
translations. The vector query, embedding identity, relevance bars and stored
vectors are unchanged. There is no re-embed or document translation.

The implementation differs from the proposal in these bounded ways:

- Existing stores obtain a lazy, read-only language profile from a uniform
  hash sample (about 1,024 chunks, capped at 2,048), instead of requiring an
  ingest migration. Counts are approximate; languages near the 5% boundary
  may fall on either side. Cached content hashes avoid reclassifying unchanged
  chunks when embeddings or metadata change.
- The three proposed examples (notary, fees and deposit) have a small local
  vocabulary in English, Spanish, Portuguese, French, German and Italian.
  These equivalents preserve the measured LOI fix when the model is absent,
  cold or fails. Other content words use only the registered built-in Qwen.
  The question, content-word IDs and target language names are its entire
  prompt; it receives no document content. No configured cloud model is used.
- Query language detection also checks local function-word data. This prevents
  short English questions misidentified by the character detector from being
  expanded into English synonyms. Foreign function words are excluded from
  topic groups; the existing English product vocabulary stays in place.
- Translation preparation precedes the store lane deadline, rather than
  sharing that deadline with SQL/vector retrieval. An uncached call can add
  up to 20 seconds. Each request pins its result, including failure, through
  hydration; a question/profile cache bounds repeat work across requests.
- Translated alternatives cannot belong to two independent concepts, including
  overlapping prefix phrases and Porter/accent equivalents. Baseline keyword
  rows and their completeness are retained when an expanded fetch saturates.
  Calibrated hybrid retrieval admits novel translated rows only when they
  cover the whole query. Passage focus uses translations only with complete
  coverage across the title and text. These conservative rules preserve the
  historical off-topic read budget; partial translations can still miss.

The independently authored fictional fixture is
`eval/fixtures/cross-language-blind.json`: 22 new answerable cases, four LOI
phrasings and six missing-fact cases. None of its documents is real user
content. Real built-in completions are saved by exact request; deterministic
CI replay exercises production routing, FTS, counting, passage hydration and
local Analyst gap responses. All misses remain visible in
`eval/cross-language-report.json`. The six missing-fact cases are graded for
honesty separately from off-topic read counts, with owner approval.

The two historical blind sets remain outside git. Their replay uses read-only
store copies on Xanthos under the owner's explicit local replay exception;
only aggregate counts enter the PR. Builds and synthetic checks use Sparta.
Activation requires an engine restart; this task does not restart it.
