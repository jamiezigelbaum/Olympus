# Parallel experiment: observed A/B results

The alternative has a smaller maintenance surface and matches the tested
retrieval and model-input behavior. This is not full release qualification or
a demonstrated improvement in answer quality or speed.

Tested main baseline: `911caf3f834433f3547049ca07a7bb8d8d268ee7`.
Tested alternative: `7aac1040d7235574925ddf94002dd1b42f8591ed`.
Current main was also checked at `6a78f5bd7c67a9117884a78323a50d6bcab1bf5a`:
its intervening restart-script/protocol change does not alter `src/`, `eval/`,
package/lock inputs, or build scripts. This experiment remains a separate
branch; nothing was merged, rebased onto current main, or deployed.

| Test | Main | Alternative | What this establishes |
|---|---:|---:|---|
| Actual local OpenClaw install, load and foreground restarts | Pass | Pass | Public package runs in separate disposable profiles on one macOS host |
| SQLite ingest, process kill, resume, replay, 32 title queries | Parity pass | Parity pass | Stable 32 identities, 30 readable items, 2 honest unreadable gaps; identical ranked hits, provenance and content |
| Frozen strict answer rubric, 16 questions | 5/16 | 4/16 | Raw scores retained; this is not a clean quality pass |
| Additional q11 samples with exact original request bodies | 2/3 | 2/3 | The original citation-score difference varies within both builds |

## Model comparison and limits

The fixture contains 32 fictional S0/public-safe records across the seven
sources. The corpus and 16 questions were hashed before model results.
No expected values or evidence labels are supplied to the model. Each arm uses
its revision's actual store adapters, content provider, source-answer handler,
Analyst, model adapter and evaluator. Copies of the same consolidated SQLite
files are opened read-only; whole-file hashes are checked before and after.

The model was `gemini-2.5-flash` through the explicit cloud lane, with keyword
retrieval, temperature zero, thinking disabled, 12 candidates, 800 characters
per candidate and 1,024 output tokens. Query planning, self-heal, secondary
Analyst auditing and embeddings were disabled. Both arms used Bun 1.3.8 and the
same dependencies in isolated scratch state. Credentials remained on the
configured host and are absent from these artifacts.

All 16 pairs had identical retrieval, hydration, prompts and request bodies.
Thirteen answer strings were byte-identical; q04, q11 and q13 varied in wording
or citation markers. Fifteen pairs had identical grades and evidence identities;
all had identical extraction-gap observations. The only strict-score difference
was q11: the first main sample cited both expected records, while the alternative
sample cited only the supporting Telegram record.

Three additional q11 pairs used unchanged source and snapshot bytes and refused
network requests unless the complete body hash matched the original. Each build
passed two of three repeats, and the pass direction reversed in the second
pair. The same input can produce either citation selection in either revision.
This supports model variability; the small sample does not prove statistical
equivalence or superiority. The original 5/16 and 4/16 results remain unchanged.

The evaluator accepts only narrow literal answer forms and, for some questions,
requires every listed citation even where another supplied source suffices.
Read-only semantic inspection found the following reasons for the shared
failures; this interpretation does not replace the recorded grades:

| Questions | Interpretation |
|---|---|
| q03 | Correct date/budget changes; one expected supporting citation omitted |
| q05, q09 | Correct values and pilot counts; paraphrases fail literal matching; q09 also omits one specifically expected supporting citation |
| q07 | Exact URL returned but path omitted; the fixture uses generic `metadata.path`, whereas the real Dropbox connector emits `pathDisplay`/`pathLower` |
| q08 | Correct date but exact channel omitted; the fixture puts the channel in `metadata.channel`, whereas the real Telegram connector uses the chat title as `metadata.title` |
| q10, q12 | Correct requested owner/outcome or tone/risk; extra date, wording and citation expectations make the rubric stricter than the question |
| q13, q14 | Honest absent-fact answers; the rubric expects both literal wording and structured extraction/coverage degradation, which an absent fact need not create |
| q15, q16 | Correctly report unreadable evidence and cite the document; literal expected wording differs |

The q07/q08 answers are incomplete on the fixture, but the generic connector
projection does not establish the behavior of real provider metadata. These
remain qualification limits, not confirmed live-provider defects. No labels,
questions or runtime source were changed to improve scores.

## Harness corrections and retained defect

An initial answer attempt mistakenly left local SQLite corpora with the default
cloud-query eligibility. With internal queries disabled, both revisions refused
all seven corpora. It made zero question-model requests and is excluded from
answer-quality evidence. The initial files are preserved in the local evidence
archive. Before any question-model outcome, the harness was corrected to declare
local SQLite retrieval with `cloudQueryApproved: false`, and a new execution
specification and new snapshots were frozen. Cloud synthesis remained explicit.

The store test's original zero-changed-on-identical-replay hypothesis failed
on two metadata-only Dropbox records in both revisions. The identical
`src/workers/connector-store/local-index.ts` blob
`d716298386db487461ca83cd7f05dee1f12cc4d9` unconditionally reports
`ftsContentChanged: true` for empty content at line 5200; aggregation at line
4412 counts this as changed. The metric contract at line 654 describes actual
progress. This is a shared, pre-existing counter overcount. It does not show
content progress or duplicate records. The defect is retained and disclosed;
zero-change replay correctness is not claimed.

## Evidence and reproduction

- [Overall machine-readable interpretation](summary.json)
- [Real host observations](host-summary.json)
- [Store comparison and shared counter defect](store-summary.json)
- [Frozen corpus](corpus.json), [questions](questions.json), [input manifest](sha256-manifest.json)
- [Answer execution specification](answer-execution-spec.json) and [unaltered grades and answers](answer-results.json)
- [Repeat specification](repeat-execution-spec.json) and [repeat observations](repeat-results.json)
- [Paired answer harness](paired-answer.ts) and [exact-input q11 repeat harness](q11-repeat.ts)

The full initial/corrected/repeated model observations, harnesses and original
consolidated SQLite snapshots are retained locally at
`release-artifacts/parallel/ab-evidence/synthetic-evidence.tgz` (302,268 bytes,
SHA-256 `747c6160f4d4fe690d7257ac97c7a612a0c66157ecc6cc5aa6e6b0d768cbdd84`).
It contains fictional test data only and is not a release input. The host and
store runners and their raw observations are retained in the same local
`ab-evidence/` directory. They are not included in the public package.

To rerun the paired test, export the exact two revisions with `git archive`
(`src`, `eval`, `package.json`, `bun.lock`, `tsconfig.json`) into separate scratch
roots. Install the locked dependencies, then invoke `paired-answer.ts` with
Bun and `--prepare`, `--rootMain`, `--rootParallel`, `--corpus`, `--questions`,
`--snapshotDir` and `--outputDir` pointing to those roots, these frozen fixture
files and fresh output directories. Inspect the frozen spec; invoke `--smoke`
with the same arguments plus `--workerEnv` pointing to an already configured
Olympus worker environment on that host. Inspect the successful smoke before
invoking `--run`. The key must stay on its configured host. The repeat harness
additionally requires `--priorReport` and `--sourceSnapshotDir` from the retained
original run and uses new snapshot/output directories. It is bound to the
original report and exact q11 request hashes.

The session counted 42 request attempts conservatively, including one early
transport check whose response was not captured; 38 were actual question
requests. All recorded model calls succeeded. Each request was bounded to
40,000 UTF-8 body bytes, 1,024 output tokens and 45 seconds; the session ceiling
was 64 requests. No provider connection, production configuration, service or
private corpus was changed. Real-provider onboarding, automatic sync/extraction,
private-corpus held-out evaluation, embeddings/default preset routing, real
service-manager lifecycle, a second host platform and owner dashboard acceptance
remain unproven. The measured timings are single-run observations, not benchmarks.
