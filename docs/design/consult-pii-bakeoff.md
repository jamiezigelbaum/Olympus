# Consult gate: PII detector bake-off (evaluation only)

Date: 2026-10-08. The question: would an open PII/NER model help the outbound gate on the "Your situation, without
names" level (`unnamed`, Standard)? The gate is in `src/core/consult-gate.ts`. It has no PII model today. It uses
a vocabulary allowlist, identifier-shape detectors and comparison against the private snapshot.

The owner's ruling for this level is answerability first. Only hard identifiers must be blocked: personal names,
exact dates and years, exact money amounts, account, phone and ID numbers, addresses, emails and handles (see
`docs/design/private-answers.md` and `docs/design/consult-writer-instructions.md`).

This PR measures and recommends. It does not change the gate. The harness and how to rerun it are in
`eval/consult-pii/` (see its README).

## Answer in brief

- **The best model is `urchade/gliner_multi_pii-v1`** (GLiNER multi-PII, Apache-2.0, multilingual mDeBERTa).
  - **What it fixes:** the unnamed level's false refusals on the situation set drop from 16 to 12 of 30, and on
    the recorded real-writer outputs from 17 to 10 of 40.
  - **Leaks:** it adds no hard-identifier leak on any set measured. That covers 67 unnamed leak variants, 102
    leak-corpus cases, 500 name and city probes, and 32 multilingual identifier probes.
  - **Speed and size:** it runs in 48 ms p50 / 65 ms p95 per question on this Mac's CPU. Shipped as ONNX q4f16
    (472 MB) it runs in 103 / 118 ms.
- **The ceiling is low: only 4 of the 16 refusals are the kind a PII model can rescue.** Every candidate that
  rescues all four lands at 12 of 30. The other 12 are refused for copying five or more document words (7),
  figures (3) or snapshot identifiers (2).
  - So a PII model is not the main lever for this level's usability. The copy rule is.
  - This contradicts the working assumption that most refusals were the allowlist reading unknown words as
    names. On main they are not.
- **OpenAI Privacy Filter**, the owner's suggestion, is real, open (Apache-2.0) and runs locally. It is not a fit
  here.
  - It has no place or organisation label, and on these short questions it misses many bare given names.
  - Under the combined policy it lets through 8 of 67 unnamed leak variants and 149 of 500 name probes.
  - Its weights are 2.8 GB.
- **Perplexity PII-Tracer** (MIT) and the smaller models do worse on recall of the identifier kinds this level
  needs to catch.
  - **PII-Tracer:** 9 of 67 leaks and 99 of 500 probes; 165 ms p50.
  - **Smaller models:** Scrub, ai4privacy and Presidio.
- **The recommendation is conditional.** Adopt GLiNER multi-PII as a rescue-only second opinion if, and only if,
  the owner wants those 4 (+7 recorded) questions back at the cost of a 472–580 MB model download. The work is
  sized under "What it would take" below. Fixing the copy rule first is the larger and cheaper win.

## Candidates

Checked against primary sources (Hugging Face model cards and file listings, GitHub, PyPI) on 2026-10-08. Sizes
are the weights a shipping build would download.

| Candidate | Repo | Licence | Params | Weights | Languages (EN PT ES FR DE) | Labels relevant here | Run here |
|---|---|---|---|---|---|---|---|
| GLiNER multi-PII | `urchade/gliner_multi_pii-v1` (+ `onnx-community/gliner_multi_pii-v1`) | Apache-2.0 | ~280M (mDeBERTa-v3-base) | 1,156 MB fp32; ONNX fp16 580 MB, q4f16 472 MB | all five | open-label: person, org, city, address, date, money, IDs, phone, email | yes (torch, ONNX fp16, ONNX q4f16) |
| GLiNER2-PII (Fastino) | `fastino/gliner2-privacy-filter-PII-multi` | Apache-2.0 | ~307M | 1,244 MB fp32 (community ONNX q4 479 MB) | all five | 42 labels incl. person, city, IDs, dates; no money | yes |
| Knowledgator GLiNER-PII edge / base | `knowledgator/gliner-pii-{edge,base}-v1.0` | Apache-2.0 | ettin-32m / deberta-v3-small | ONNX quint8 46 MB / 197 MB | English backbones | open-label | yes (torch) |
| OpenMed Privacy Filter multilingual v2 | `OpenMed/privacy-filter-multilingual-v2` | Apache-2.0 | 1.4B MoE (fine-tune of OpenAI's) | 2.8 GB, no ONNX | 16 languages incl. all five | 54 labels incl. names, city, amount, IDs | yes |
| **OpenAI Privacy Filter** | `openai/privacy-filter` (released 2026-04) | Apache-2.0 | 1.4B MoE, 50M active | 2.8 GB; ONNX q4 917 MB | "primarily English" | person, address, email, phone, url, date, account number, secret; no place, org or money | yes, with constrained BIOES Viterbi as its `opf` runtime does |
| **Perplexity PII-Tracer** | `perplexity-ai/PII-Tracer` (HF 2026-07, announced 2026-10-02) | MIT | 596M (Qwen3 encoder) | 1.19 GB bf16 (community WebGPU q4 487 MB) | "en, multilingual" (paper: 13 languages) | OpenAI's 8 labels + other_pii | yes (`trust_remote_code`; code read first, imports only torch/transformers) |
| SporeLabs Scrub | `SporeLabs/scrub` (2026-10-05) | Apache-2.0 weights, MIT code | 17M + rules | ONNX int8 19 MB | English | person, address, phone, email, username, IDs, secrets; by design no dates, places or money | yes; vendor claims unverified |
| ai4privacy multilingual | `ai4privacy/llama-ai4privacy-multilingual-categorical-anonymiser-openpii` | MIT | 150M (ModernBERT) | 599 MB; ONNX int8 151 MB | no PT | given name, surname, city, date, IDs; no money | yes |
| Microsoft Presidio | `presidio-analyzer` 2.2.364 + spaCy `en_core_web_lg` | MIT | n/a | ~590 MB spaCy model | per-language spaCy models; default English only | person, location, date, IDs, phone, email | yes (baseline: default English) |
| Piiranha | `iiiorg/piiranha-v1-detect-personal-information` | **CC-BY-NC-ND-4.0** | 278M | 1.1 GB | no PT | 17 types | **excluded: non-commercial, no derivatives** |
| NVIDIA GLiNER-PII | `nvidia/gliner-PII` | **NVIDIA Open Model License (custom, not OSI)** | 570M | 1.8 GB | English | 55+ | not run; flagged |

Other findings:

- **No other new open PII models from Google, Mozilla or NVIDIA.** Nothing open and PII-specific was found
  for 2025–2026 beyond `nvidia/gliner-PII`. The only Gemma PII model found is a community one (Gemma licence,
  generative).
- **PII-TRACE (Perplexity's benchmark) is only partly public.** The public part is a 500-conversation
  **English** subset (MIT). The 13-language set the paper describes is not released. It was not added: it is not
  multilingual, and this bake-off uses only the repo's synthetic data.
- **The OpenMed leakage figures were not verified.** A community comparison circulated "OpenMed 3.5%, GLiNER-PII
  8.1%, Presidio 18.9%" leakage. No primary source was found for those numbers, so they are not relied on.

## Method

**Data.** Only the repo's synthetic eval data, exported by `eval/consult-pii/export.ts`: 1,281 distinct questions
in 2,019 gate requests.

- **The unnamed situation set:** 30 legitimate questions and 67 leak variants
  (`eval/consult-leak/unnamed-questions.ts`).
- **The recorded qwen3.5-4b writer outputs:** 40 requests, from `eval/consult-reid/recorded*.json`.
- **The leak corpus** (`corpus.ts`), graded at the unnamed level: 40 legitimate (clean and known-gap) and 102
  leak cases.
- **The held-out clean sets** in EN, PT, ES, FR and DE, against every corpus snapshot.
- **The false-refusal question set.**
- **Two new probe sets:**
  - The repo's fixed cross-cultural name sample (`name-sample.ts`): 200 given names, 200 full names and 100
    cities in short situation questions. Each name is in the snapshot the writer read.
  - `eval/consult-pii/probes.ts`: hand-written probes in EN, PT, ES, FR and DE. Each language has two legitimate
    questions and eight identifier kinds: name, place, date, amount, account number, email, phone and address.

**Truth.**

- Leak variants and probes carry their kind.
- A leak-corpus case in `identifier`, `exact_figure`, `exact_date` or `multilingual` counts as a hard identifier
  when the independent canary oracle (`eval/consult-leak/run.ts`) finds a planted string.
- Every legitimate question counts as carrying none.
- Gate-only leaks (encoded, verbatim, stuffing, technical, secret) are not scored for detection. They are still
  counted in the policy rows.

**Categories.** Each model's labels map onto one set. Hard: person, organisation, place finer than a country,
address, date, amount, ID, email, phone, URL, handle, secret.

- A place span that is a whole country name, in English or the question's language, is not hard: the level
  allows a jurisdiction.
- Age, time, job title and gender are not hard.

**Metrics.**

- **(a) Recall:** share of hard-identifier questions where the model finds at least one hard span.
- **(b) False flags:** share of legitimate questions where it finds one.
- **(c) The combined policy** that would ship, unnamed level only (general is unchanged):
  - The gate runs as it does today.
  - A question it refused **only** for `unknown_word` and/or `snapshot_name` passes when the model finds no
    hard-identifier span over its rescue tokens.
  - The gate stops at the vocabulary rule before it reads the snapshot. So a question refused for an unknown
    word is first run again with those words admitted. It is rescuable only if the snapshot rules then raise
    nothing but `snapshot_name`.
  - **Rescue tokens** are the unknown words, the capitalised words (not articles, pronouns, auxiliaries or
    numbers), and words the snapshot writes capitalised, including inflected copies ("fenwicks" for "Fenwick").
  - **A rescue token holding a digit is never rescued.**
- **(d) Latency:** this Mac (Apple M3, 24 GB) on CPU with 4 threads, one question at a time, tokenisation
  included, after warm-up. It is the local exception to the remote-build policy, because that is where the model
  would run. RSS is the process growth on load, including the Python runtime's share.
- **(e) Languages:** the language rows of (a) and (b), and the PT/ES/FR rows of (c).

**Disclosure: the three rescue-token rules were set after a first pass on this same data.** That first pass
rescued the following leaks under every model:

- "Vehicle KT19 XLB" (the digit rule);
- a lower-case copied name, "fenwick" (the snapshot-capitalised rule);
- legitimate questions refused because GLiNER's span "An employee" covered the capitalised "An" (the
  closed-class rule).

They are policy rules, not model tuning, but this is not a held-out result. A shipped version needs its leak
gate re-proved on fresh probes.

## Results

### Combined policy (c), unnamed level

Legitimate refused, then hard-identifier leaks passed. Lower is better.

| | Unnamed set refused | Recorded writer refused | Leak corpus legit refused | Held-out EN refused | Unnamed leaks passed | Leak corpus leaks passed | Name probes passed | ID probes EN/PT/ES/FR passed |
|---|---|---|---|---|---|---|---|---|
| **main (gate only)** | 16/30 | 17/40 | 14/40 | 4/272 | 0/67 | 0/102 | 1/500 | 0/32 |
| **gliner-multi-pii** (torch) | **12/30** | **10/40** | 12/40 | 0/272 | **0/67** | **0/102** | **1/500** | **0/32** |
| gliner-multi-pii ONNX fp16 | 12/30 | 10/40 | 12/40 | 0/272 | 0/67 | 0/102 | 1/500 | 0/32 |
| gliner-multi-pii ONNX q4f16 | 12/30 | 10/40 | 12/40 | 0/272 | 0/67 | 0/102 | 2/500 | 0/32 |
| gliner2-pii | 12/30 | 10/40 | 11/40 | 0/272 | 1/67 | 0/102 | 5/500 | 0/32 |
| knowledgator edge | 12/30 | 12/40 | 11/40 | 0/272 | 0/67 | 0/102 | 19/500 | 0/32 |
| knowledgator base | 12/30 | 12/40 | 11/40 | 0/272 | 1/67 | 0/102 | 117/500 | 0/32 |
| openmed multilingual v2 | 12/30 | 11/40 | 11/40 | 0/272 | 3/67 | 2/102 | 6/500 | 0/32 |
| openai-privacy-filter | 12/30 | 9/40 | 11/40 | 0/272 | 8/67 | 3/102 | 149/500 | 4/32 |
| pii-tracer | 12/30 | 9/40 | 11/40 | 0/272 | 9/67 | 3/102 | 99/500 | 3/32 |
| presidio | 12/30 | 10/40 | 11/40 | 0/272 | 3/67 | 3/102 | 25/500 | 3/32 |
| scrub | 12/30 | 10/40 | 11/40 | 0/272 | 7/67 | 2/102 | 104/500 | 2/32 |
| ai4privacy multilingual | 12/30 | 9/40 | 11/40 | 0/272 | 6/67 | 2/102 | 247/500 | 6/32 |

How to read the table:

- **The leaked probe on main** is "Will gave short notice…": the gate already passes it, because "will" is a word.
- **The extra q4f16 leak** is "Santiago".
- **PT, ES and FR held-out sets and the false-refusal set:** 0 refused under every candidate. Main refuses none
  of PT/ES/FR and 1 of 247 false-refusal questions.
- **German** has no shipped vocabulary pack, so the gate refuses every German question for
  `vocabulary_unavailable` and the policy leaves it refused.

**Why 12/30 is the floor.** The unnamed set's 16 refusals on main, by every reason the gate finds:

| Reasons | Count |
|---|---|
| `shared_token_run` (copy of five or more document words) | 6 |
| `unknown_word` + `shared_token_run` | 1 |
| `snapshot_figure` | 3 |
| `snapshot_identifier` alone or with `snapshot_name` | 2 |
| `snapshot_name` only (rescuable) | 3 |
| `unknown_word` only (rescuable) | 1 |

Of the recorded writer's 17 refusals, 9 are rescuable. GLiNER multi-PII rescues 7 of them.

### Detection alone, all languages

| Candidate | Recall | False flags | Names (426) | Places (116) | IDs (51) | Amounts (19) | Dates (11) |
|---|---|---|---|---|---|---|---|
| gliner-multi-pii | 98% | 43% | 100% | 100% | 80% | 95% | 100% |
| gliner2-pii | 95% | 32% | 99% | 98% | 75% | 58% | 100% |
| knowledgator edge | 95% | 39% | 96% | 100% | 84% | 89% | 100% |
| knowledgator base | 80% | 40% | 73% | 100% | 80% | 95% | 100% |
| openmed multilingual v2 | 95% | 4% | 97% | 98% | 84% | 47% | 100% |
| openai-privacy-filter | 64% | 0% | 85% | 2% | 49% | 11% | 64% |
| pii-tracer | 73% | 12% | 91% | 25% | 63% | 0% | 91% |
| presidio | 87% | 14% | 92% | 96% | 63% | 26% | 82% |
| scrub | 71% | 4% | 96% | 4% | 55% | 16% | 27% |
| ai4privacy multilingual | 51% | 2% | 46% | 63% | 57% | 68% | 55% |

- **Recall** is over 649 questions with a hard identifier. **False flags** are over 571 legitimate questions.
- **GLiNER's false flags** are common nouns read as people or organisations ("tenant", "employer", "Canadian
  employer").
- **Why that matters little here:** under policy (c) the model is consulted only over unknown or capitalised
  words, so those false flags barely count.
- **The reverse policy** uses the model as an extra blocker on questions the gate passes. With GLiNER it would
  refuse 29 of 30. That form is not proposed. `eval/consult-pii/score.ts` reports it as "policy c+".

### Languages

Recall / false flags. The non-English samples are small: 8 hard and 22 legitimate questions per language (FR
19 / 35).

| Candidate | EN | PT | ES | FR | DE |
|---|---|---|---|---|---|
| gliner-multi-pii | 98 / 44% | 100 / 27% | 100 / 36% | 95 / 51% | 100 / 45% |
| gliner-multi-pii q4f16 | 98 / 39% | 88 / 27% | 100 / 32% | 95 / 46% | 100 / 32% |
| gliner2-pii | 95 / 31% | 88 / 27% | 100 / 32% | 89 / 40% | 88 / 36% |
| openmed multilingual v2 | 95 / 4% | 100 / 5% | 88 / 0% | 89 / 6% | 100 / 14% |
| openai-privacy-filter | 65 / 0% | 75 / 0% | 75 / 0% | 42 / 0% | 75 / 0% |
| pii-tracer | 74 / 13% | 75 / 0% | 75 / 18% | 47 / 17% | 75 / 5% |
| presidio (English model) | 89 / 11% | 50 / 23% | 63 / 18% | 47 / 9% | 88 / 77% |

Under policy (c), the GLiNER models and OpenMed leaked none of the 32 EN/PT/ES/FR identifier probes. OpenAI,
PII-Tracer, Presidio, Scrub and ai4privacy leaked 2–6 of them. No candidate refused a PT/ES/FR held-out
question.

### Speed and size (this Mac, CPU, 4 threads)

| Candidate | p50 ms | p95 ms | Resident growth | Ship size | Licence |
|---|---|---|---|---|---|
| gliner-multi-pii (torch fp32) | 48 | 65 | 1.7 GB | 1,156 MB | Apache-2.0 |
| gliner-multi-pii ONNX fp16 | 123 | 154 | 1.5 GB | 580 MB | Apache-2.0 |
| gliner-multi-pii ONNX q4f16 | 103 | 118 | 1.3 GB | 472 MB | Apache-2.0 |
| gliner2-pii | 60 | 67 | 1.9 GB | 1,244 MB | Apache-2.0 |
| knowledgator edge | 11 | 13 | 0.5 GB | 46 MB (quint8 ONNX) | Apache-2.0 |
| knowledgator base | 29 | 39 | 1.1 GB | 197 MB (quint8 ONNX) | Apache-2.0 |
| openmed multilingual v2 | 68 | 95 | 2.0 GB | 2.8 GB | Apache-2.0 |
| openai-privacy-filter | 72 | 95 | 3.1 GB | 2.8 GB (ONNX q4 917 MB) | Apache-2.0 |
| pii-tracer | 165 | 299 | 0.9 GB | 1.2 GB | MIT |
| presidio + en_core_web_lg | 3 | 5 | 0.9 GB | ~590 MB | MIT |
| scrub | 1.3 | 2.1 | 0.3 GB | 19 MB | Apache-2.0 / MIT |
| ai4privacy multilingual | 26 | 34 | 0.7 GB | 151 MB (int8 ONNX) | MIT |

- **Resident growth** includes the Python runtime's share of each process. The ONNX rows also import torch
  through the `gliner` package, so a Bun process holding only onnxruntime and the weights should sit well below
  these figures.
- **Dynamic int8 quantisation broke GLiNER multi-PII.** `onnxruntime` `quantize_dynamic`, applied to all ops
  or to MatMul only, pushed every entity score under the 0.5 threshold (0% recall). The published
  `onnx-community` int8 file is the same 349 MB size and was not used.
- **fp16 and q4f16 keep accuracy**, but the CPU provider runs them slower than fp32.
- **The Core ML execution provider was not measured.**

## Recommendation

1. **Fix the copy rule first.** 7 of the 16 unnamed false refusals are `shared_token_run`. No PII model touches
   them, and the change needs no download. That is the larger answerability win for the Standard level.
2. **Then, if the owner wants the last vocabulary and name refusals back, use GLiNER multi-PII as a rescue-only
   second opinion.** It runs at the unnamed level, under policy (c) with its three guards.
   - **Model:** `urchade/gliner_multi_pii-v1`, shipped as `onnx-community` q4f16 (472 MB). fp16 (580 MB) is the
     fallback if the 4-bit build shows drift.
   - **What it recovers:** 4 of 30 on the situation set, 7 of 40 recorded real-writer requests and 4 of 272
     held-out EN pairs, with no new leak measured.
   - **It never makes the gate more permissive than a pass by the rules below it.** A model failure, a missing
     model or a timeout leaves the refusal standing.
3. **Do not use OpenAI Privacy Filter, PII-Tracer, Scrub, ai4privacy or Presidio for this job.**
   - They miss the kinds the rescue path exists to catch: places and organisations (OpenAI, PII-Tracer, Scrub),
     and bare or non-English given names.
   - Each one leaks under the policy.
   - OpenAI's and OpenMed's 2.8 GB weights are also too large.
4. **OpenMed's multilingual Privacy Filter is the precision leader** (4% false flags, all five languages). If it
   gets an ONNX build under 1 GB, it is worth re-running. It still leaked 3 unnamed variants: sentence-initial
   surnames.

## Integration sketch (not built)

**Where it runs.** In the engine process, beside the gate. It is lazily loaded the first time a Standard-level
consult is refused for `unknown_word` / `snapshot_name`. It is dropped after an idle period, so the half-gigabyte
of weights is resident only around consults.

**The gate change.**

1. At the unnamed level, the vocabulary rule stops short-circuiting. Unknown words are recorded and the snapshot
   rules still run.
2. A verdict whose reasons are only `unknown_word` / `snapshot_name` becomes `refuse` with a `rescuable` flag and
   its rescue tokens.
3. The orchestrator calls the detector on those questions only. It passes the question if no hard span overlaps
   a rescue token and no rescue token holds a digit.
4. The gate itself stays pure and synchronous. The detector is an injected, optional async step after it.

**Runtimes compared.**

- **onnxruntime-node from Bun (recommended).**
  - It runs `onnx-community/gliner_multi_pii-v1` `model_q4f16.onnx`. The mDeBERTa tokenizer comes from its
    `tokenizer.json` via `@huggingface/transformers` (transformers.js).
  - GLiNER's pre- and post-processing is about 300 lines to port or vendor: word split, label prompt, span
    scoring and greedy non-overlap decode. The MIT `gliner` npm package (GLiNER.js) already implements it over
    onnxruntime.
  - It needs no new language runtime. The model is a pinned asset (sha256, like the vocabulary packs) fetched on
    first use.
  - **Risk:** onnxruntime-node under Bun's N-API must be proven on macOS arm64 and Linux x64 before relying on
    it. The fallback is `onnxruntime-web` (WASM) in Bun, which is slower.
- **The pinned llama-server.** Not viable as checked. llama.cpp serves causal LMs and some BERT-style embedders.
  It has no GLiNER span head or DeBERTa-v2 token-classification path, so this would mean porting a model
  architecture into a fork.
- **A Python sidecar** (torch + `gliner`, as in this harness). It is the fastest to prototype and gives the best
  measured latency (48 ms fp32). It is the worst to ship: about 1–2 GB of Python and torch per platform, a second
  process to supervise and update, and a new attack surface. It is fine for evaluation, not for the product.

**Proof before shipping.**

- **Parity.** The TS path must reproduce `eval/consult-pii/out/pred-gliner-multi-pii-onnx-q4f16.jsonl` on the
  exported items, span for span within a score tolerance.
- **Leak gate.** Policy (c) gets added to `eval/consult-leak/unnamed-level.ts` with a leak ceiling of 0 on every
  set above.
- **Fresh probes.** A new held-out set of names, places and identifiers, written after the guards were frozen,
  must also pass with 0 leaks. The guards were set on this data, as disclosed above.

## What it would take

| Step | Estimate |
|---|---|
| Copy-rule rework (recommendation 1; separate change, larger usability win) | 1–2 days, its own review |
| Gate restructure at unnamed: run the snapshot rules past `unknown_word`; return rescuable + rescue tokens | 0.5–1 day |
| Detector in TS: onnxruntime-node + tokenizer + GLiNER decode, pinned model asset, lazy load/unload, fail-closed | 1.5–2 days |
| Bun + onnxruntime-node proof on macOS arm64 and Linux x64 (the release targets) | 0.5 day |
| Parity test against the harness predictions; policy (c) in the unnamed-level eval with a 0-leak gate; fresh held-out probes | 1 day |
| Independent review (security-relevant gate change, new native dependency, ~0.5 GB model download in the install path) | 0.5 day plus review time |

Total is about 4–5 days for the model path, on top of the copy-rule work. Costs:

- one 472 MB download per install that enables Standard consults;
- about 100 ms per rescued question (CPU);
- about 0.5–1 GB resident while loaded.
