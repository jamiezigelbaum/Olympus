# Held-out eval

This is the **definition of done** for the source pipeline. A change is done
when it passes these questions — not when a known-answer demo passes.

## Why it exists

The previous answer layer was graded by demos on questions the code had already
been tuned against. That metric literally rewards templates and regexes: hand-
code the shape, the demo goes green. The held-out eval closes that loophole. The
questions in [`questions/held-out.json`](questions/held-out.json) are
deliberately *not* represented in any answer template. A regex/template layer
cannot pass them, so passing forces the general path — retrieve evidence, reason
over it with the `Analyst`, cite, and report gaps honestly.

See [`../docs/CONTRACTS.md`](../docs/CONTRACTS.md) for the architecture this
eval protects.

## What the question set is

[`questions/held-out.json`](questions/held-out.json) holds generic questions
with `{placeholders}` so the set stays reusable by any operator, not bespoke to
one corpus. Nine question *shapes* (see [`types.ts`](types.ts)) each probe a
generalization trap the per-question approach failed:

- `value_lookup` — a specific value on a specific date/record
- `trend_or_chronology` — how something changed over time, in order
- `count_or_aggregate` — how many / how much across items
- `locator` — where a file/message is (path + link)
- `cross_source_synthesis` — combine two or more sources into one answer
- `summary_or_sentiment` — gist or tone of a thread/document
- `coverage_negative` — the honest answer is "I have nothing on this"
- `gap_honesty` — some evidence is unextractable; the analyst must say so
- `version_conflict` — several versions of one document disagree; the answer
  gives the newest version's value and names it by date (or each version's
  value), and repeated runs state the same facts

## How to run it against a real corpus

1. **Instantiate the placeholders.** Copy `held-out.json` and replace each
   `{placeholder}` with a real value from your corpus (a real metric, document
   type, project, topic, etc.). Adding new question shapes is encouraged;
   weakening grading to make a demo pass is not.
2. **Fill the expectations.** For each question set `expectedAnswerContains`
   (substrings a correct answer must contain) and `expectedEvidence` (the
   file/message that must be cited — set `providerItemId` for precise grading,
   or omit it to require at least one citation). Leave them empty to skip that
   dimension. Set `mustReportGap: true` where the honest answer is a reported
   coverage gap. For a question whose answer exists only inside an attachment
   or a piece of media, cite the child and set `parentLabel` on the expected
   evidence: the citation must name the item it came inside (the fixture proof
   is `test/eval-child-items.test.ts`).
   `runEval` rejects datasets that still contain `{placeholders}` or questions
   with no expected answer, expected evidence, or required gap, so an unfilled
   template cannot produce a green score.
3. **Wire the seams and call `runEval`.** The harness in [`run.ts`](run.ts)
   is real grading with injected dependencies it does not fake:

   ```ts
   import { runEval } from './run.ts';
   import dataset from './questions/held-out.json' with { type: 'json' };

   const report = await runEval(dataset, {
     buildPack,   // (question) => EvidencePack   — Phase 1 retrieval/pack builder
     analyst,     // Analyst                       — Phase 1 reasoning capability
     releaseFor,  // (pack, result) => released answer + audit — required for source_answer parity
     auditFor,    // (result) => OpsecReleaseAudit — legacy optional privacy-only hook
   });
   ```

   `localOnly` is derived automatically: any pack containing `secure_local`
   evidence routes reasoning to Argus on Delphi.
   When grading the live `source_answer` path, provide `releaseFor` so answer,
   citation, gap, and privacy checks run against the Castor-visible released
   answer, not the raw Analyst draft. `releaseFor` intentionally receives only
   the pack and raw result, not held-out expectations.

Until `buildPack` + `analyst` exist (Phase 1), `bun run eval` exits non-zero
with instructions on purpose — the harness will not fabricate the pipeline to
produce a green number.

## How grading works

[`grade.ts`](grade.ts) scores four independent dimensions; a question passes
only if all hold (privacy is `pending` when no opsec audit is supplied):

- **answerCorrect** — the released answer contains every
  `expectedAnswerContains` string.
- **evidenceCited** — each `expectedEvidence` item is cited in the released
  result.
- **gapHonest** — when `mustReportGap` is set, `result.unanswered` is non-empty
  in the released result (absence is reported, not hallucinated).
- **privacyRespected** — no raw `secure_local` content is exposed, and any cloud
  escalation went through the release gate. Secure-local questions and
  escalation results require an `OpsecReleaseAudit`; other questions remain
  `pending` when no audit is supplied.

Failure details are intentionally non-secret: they report missing counts or
indexes rather than echoing private expected answer strings or evidence hints.

## Running for real

The instantiated dataset carries private corpus values, so it lives outside git
in `eval/private/` (gitignored — never commit it). On a machine with a hydrated
local Dropbox index and a reachable Argus lane:

1. Copy [`questions/held-out.json`](questions/held-out.json) to
   `eval/private/held-out.real.json`; replace every `{placeholder}` with real
   corpus values and fill `expectedAnswerContains` / `expectedEvidence`
   (`runEval` refuses placeholder or expectation-free datasets). Pick expected
   substrings robust to model phrasing — values and dates, not sentence shapes.
2. Run against the canonical shared connector store:

   ```sh
   OLYMPUS_SOURCE_INDEX_ACCOUNT=personal \
   bun run eval:real
   ```

   The runner searches the way Ask does: every Dropbox tier store this
   install has (Private, Personal, and Public when it exists), through the
   same answer lanes live answers use, judged by the source's tier ledger. It
   finds each store where this install keeps it (the account folder,
   `sources/dropbox.files/1/stores/<tier>.sqlite` under the data folder, or the
   legacy `dropbox-files-connector-store.sqlite` for the Private store until
   the boot migration moves it). `OLYMPUS_EVAL_DROPBOX_STORE=<path>` names
   another Private store file, a copy for instance;
   `OLYMPUS_EVAL_DROPBOX_PERSONAL_STORE`, `OLYMPUS_EVAL_DROPBOX_PUBLIC_STORE`
   and `OLYMPUS_EVAL_DROPBOX_LEDGER` do the same for the other stores and the
   tier ledger. Every store opens query-only; nothing relocates the worker's
   own stores.

   Meaning search uses the built-in embedding model this install configures,
   loaded once per question process (bounded by
   `OLYMPUS_EVAL_EMBEDDING_WARM_TIMEOUT_SECONDS`, default 180). When the model
   is not installed, is not the built-in one, or does not load, the run falls
   back to keyword search and says so on its `eval retrieval:` line and in the
   report's `retrieval` field. It never downloads a model.

   Gaps are graded from the release step's structured coverage notes (the
   notes the released answer carries), not parsed back out of its text.

   Set `OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY` only if the instantiated
   private question set is intentionally limited to one Dropbox approved scope.
   Leaving it unset evaluates against the approved local Dropbox corpus instead
   of accidentally excluding expected evidence in another approved folder.

   The runner writes a progress report after every question to
   `eval/private/report.latest.json` by default. Override with
   `OLYMPUS_EVAL_REPORT_PATH`. Each question has a default 240-second timeout;
   override with `OLYMPUS_EVAL_QUESTION_TIMEOUT_SECONDS`. A timeout is a failed
   eval result with a partial report, not a silent hang.

   By default, the real eval uses literal-query retrieval so the gate stays
   usable. Set `OLYMPUS_EVAL_QUERY_PLANNER_ENABLED=true` only for a targeted
   recall experiment; it adds a local-model planning call before each question.
   The gate's evidence budget is 5 candidates at Ask's per-candidate budget
   (3,000 chars); override with `OLYMPUS_EVAL_MAX_RESULTS` and
   `OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE` for targeted diagnosis. A local
   Analyst is sent the pack Ask's local leg would send: fitted to 13,500 prompt
   bytes, or to `OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES` when set (the
   same override Ask reads). After the gate, the same questions run again at
   Ask's own pack size (24) as a second, informational score in the report's
   `informational` section; it never decides pass or fail. Set
   `OLYMPUS_EVAL_INFORMATIONAL_MAX_RESULTS` to another size, or 0 to skip it.
   For ordering runs that must not depend on machine load, lift the per-store
   lane deadline with `OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS=120000` (0 turns
   it off) and report deadline losses at the product cap separately.
   To tell a steady Analyst misreading from a coin flip, set
   `OLYMPUS_EVAL_ANALYST_REPEATS=3` (and optionally
   `OLYMPUS_EVAL_ANALYST_REPEAT_QUESTIONS=value-2,secure-summary-1`): the
   Analyst answers each named question's frozen pack that many times. The
   first answer is graded; the others are listed in `answerRepeats` by shape,
   cited seats and value flags only. Raise the question timeout to match.
   To tell distraction from misreading, set
   `OLYMPUS_EVAL_ANALYST_EXPECTED_SEAT_ONLY=1`: after the graded answer, the
   Analyst answers once more on a pack holding only the seats with the
   question's expected items, read whole. `expectedSeatOnly` reports those
   seats and that answer by shape and flags (or `failed`), with each model
   prompt's length and a 12-character SHA-256, so two runs can tell identical
   prompts from different ones. The seat-alone pack's coverage counts only
   the seats it holds, as Ask's own fit does. Right alone but
   wrong in the full pack means the other seats distract it; wrong alone means
   it misreads that document as extracted. It follows
   `OLYMPUS_EVAL_ANALYST_REPEAT_QUESTIONS` when set.
   Every answer stage also reports `promptLayout`, which shows where the bytes
   of the prompt the Analyst was sent went. It holds the text every prompt
   carries (system rules, question, coverage), each sent seat's header (name,
   trust, provenance and citation labels) and its passages, and what the same
   seats would cost in each evidence format (`fullPromptBytes`,
   `compactPromptBytes`). `evidenceFormat` names the format the prompt was
   sent in, which follows the Analyst: a local run sends the compact format, as
   Ask's local leg does. These are byte counts only.
   The value-token flag counts an answer token as held by a cited seat when
   it is in that seat's text, facts, tables or citation fields, including the
   date of a citation timestamp, each segment of its locator path and a file
   name without its extension, since
   the Analyst sees those in the seat's citation line.
   The shared Analyst also caps model output at 1,600 characters by default so
   local eval questions fail or answer quickly instead of generating long JSON.

   The analyst lane defaults to local. To prove the Venice secure lane against
   the same fixture, run with `--analyst-provider venice` or set
   `OLYMPUS_EVAL_ANALYST_PROVIDER=venice`, plus a Venice key in
   `OLYMPUS_EVAL_VENICE_API_KEY`, `OLYMPUS_SOURCE_INDEX_VENICE_API_KEY`,
   `VENICE_API_KEY`, `API_KEY_VENICE`, or `Venice-API-Key`. The eval report
   records only `analystProvider`, not secret values.

[`run-real.ts`](run-real.ts) wires the REAL pipeline — connector store →
`buildEvidencePack` → Analyst on Argus/Delphi → the same release gate the live
`source_answer` path uses — so the privacy dimension grades real gate decisions,
not a stub. Exit code 0 means the instantiated set passed.

## Where this plugs into the gate

`bun run verify` (typecheck + tests) is the local inner loop and the GitHub
Actions backstop; it covers the harness machinery and the fixture wiring. The
real instantiated eval (`bun run eval:real`) is the definition-of-done
measurement for pipeline changes and a required step in the runtime proof
(see `docs/roles/cto/RUNTIME_REHYDRATION_RUNBOOK_2026-06-10.md`).

## Source-generic migration qualification

[`qualification.ts`](qualification.ts) adapts both migration-time answer
surfaces to this same `runEval`/`gradeAnswer` machinery:

- `createInProcessSourceAnswerEvalAdapter` evaluates an injected
  `SourceIndexAnswerHandler`. X uses the thin
  `createXBookmarksQualificationLoopback` composition so the connector store
  can be qualified before activation while ordinary reads remain on the legacy
  index.
- `createAuthenticatedSourceAnswerEvalAdapter` runs the same private dataset
  through authenticated `/v1/source/answer` after a future provisional
  authority flip. It creates no shadow endpoint.

Private datasets and legacy observations remain owner-private. The
activation-consumed receipt produced by
`buildSourceQualificationEvalReceipt` strips the full report down to question
ordinals, booleans, counts, timings, and bounded failure hashes. It binds that
summary to the exact Git object, worker PID/CWD digest, logical connector-store
digest and schema, prerequisite receipt digests, manifest/drop-in digests,
read authorities, and expiry.

Gap grading requires two facts: a genuine structured degradation (provider
window/cap, adapter absence, lane failure/timeout, extraction gap, or zero
evidence after an actual search) and that gap surviving into the released
answer. The second fact grades the release/redaction layer, not the model: the
analyst folds pack coverage gaps into `unanswered` whatever the model reported,
so a gap can only be lost on the way out. Mechanical selection reasons such as
`not_requested` never qualify.

For X, exact citation expectations in the private dataset must use
`https://x.com/i/web/status/<provider_item_id>`. The generic grader compares
the exact URI; it does not contain an X-specific branch. The activation gate
verifies a post-flip receipt with:

```sh
bun run x-bookmarks:qualification-receipt -- verify \
  --receipt /owner-private/qualification-eval.json \
  --git-sha <full-git-object-id> \
  --worker-pid <pid> \
  --worker-cwd <cwd> \
  --store /owner-private/x-connector-store.sqlite \
  --preservation-receipt /owner-private/x-preservation.json \
  --reconcile-receipt /owner-private/x-reconcile.json \
  --manifest /owner-private/private-host.env \
  --dropin /owner-private/75-x-bookmarks.conf \
  --as-of 2026-07-23T00:00:00.000Z
```

The real authority flip, generalized deployment lock, and transaction rollback
remain XE4 responsibilities. XE3 exposes only a failure contract: a red
post-flip eval invokes an injected rollback callback and then requires
`legacy_index` to be restored.

## Classification eval (four-tier)

`eval/classification/` holds a synthetic, labeled corpus (email, file, chat,
note and bookmark items across Public, Personal, Private and Secrets) and runs
it through the production path: the shared tier classifier, the cache-backed
sniffer, the tier ledger and the sniffer's background pass
(docs/design/per-item-four-tier-classification.md, section 7).

```sh
bun run eval:classification            # deterministic fake sniffer (CI runs this via test/classification-eval.test.ts)
bun run eval:classification -- --real  # the configured private lane: a local model or Venice Private
bun run eval:classification -- --archive  # the same corpus held until judged, as an archive import brings it
```

Hard gates (exit 1 when any fails): 100% secret recall; no hard-category
Private item (health, therapy, financial, legal, identity) below Private; at
most 1% Private-to-Personal leakage on the ambiguous set; no injection-set item
(or a batch-mate) below Private, against a fake sniffer that obeys any
instruction it is shown; no owner item lowered by another item's instruction,
including blocklist-evading shapes (fullwidth, zero-width, look-alikes,
letter-spacing, plain English), Spanish and French, a paraphrase, novel
phrasing and Dropbox file-request names beside the owner's ambiguous files
(every item is asked on its own call); no item the model answered badly below
Private; in an archive-held run (`--archive`), no held item usable below
Private before its own judgment. Also reported:
Personal and Public precision, Personal recall, the pending rate, the
`no_signal` set (Private items with no sensitive word anywhere, which the
flag-then-ask pipeline does not sniff by design), and the sniffer's calls and
estimated tokens.

The fake sniffer proves the wiring, not a model's judgment: it has two
deliberate error modes (under-confident Personal, and Personal paired with a
hard category) that the threshold and the hard-category guard must absorb.

## Built-in private model benchmark

[`private-model-bench.ts`](private-model-bench.ts) runs the built-in private
model (`built_in` analyst) over a synthetic Private question set built from the
fictional demo data in `chatgpt-plugin/demo-data`, graded with this eval's
answer and citation rules, and reports tokens/s, time to first token, peak RAM
and pass count. Results and the chosen defaults live in
[`../docs/design/private-model-benchmark.md`](../docs/design/private-model-benchmark.md).


## Cross-language keyword matching

`fixtures/cross-language-blind.json` is an independently authored, frozen
fictional set. Run `bun eval/cross-language-keywords.ts --record` through
remote-build to obtain actual built-in Qwen 2B completions and return
`eval/fixtures/cross-language-completions.json` plus
`eval/cross-language-report.json` (set `OLYMPUS_KEYWORD_REPORT` to that path).
`--replay` uses only those exact-request completions and no live model.
`test/source-index-cross-language-blind.test.ts` runs that deterministic replay
in CI. Missing recordings, loss of an existing hit, no aggregate improvement,
or a dishonest gap response fail the gate. `--measure` keeps a diagnostic
report even when the gate is not met; it is not a passing receipt.

The six missing-fact cases may retrieve explicit absence evidence and are
therefore graded for gap honesty. The unchanged-or-lower read budget applies
to the historical off-topic negatives. Keep historical questions, stores and
model output local; only aggregate replay counts belong in the PR.
