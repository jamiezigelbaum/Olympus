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
one corpus. Eight question *shapes* (see [`types.ts`](types.ts)) each probe a
generalization trap the per-question approach failed:

- `value_lookup` — a specific value on a specific date/record
- `trend_or_chronology` — how something changed over time, in order
- `count_or_aggregate` — how many / how much across items
- `locator` — where a file/message is (path + link)
- `cross_source_synthesis` — combine two or more sources into one answer
- `summary_or_sentiment` — gist or tone of a thread/document
- `coverage_negative` — the honest answer is "I have nothing on this"
- `gap_honesty` — some evidence is unextractable; the analyst must say so

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
   coverage gap.
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
   OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH=~/.olympus/indexes/dropbox-files-connector-store.sqlite \
   OLYMPUS_SOURCE_INDEX_ACCOUNT=personal \
   bun run eval:real
   ```

   In the private-host/OpenClaw reference runtime, use the same hydrated connector
   store configured for the source worker instead of the retired index:
   `$HOME/.local/share/openclaw/olympus/dropbox-files-connector-store.sqlite`.
   You can confirm the active path in
   `~/.config/systemd/user/olympus-email-source.service.d/79-dropbox-connector-store.conf`.

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
   The default evidence budget is 5 candidates at 1,500 chars each; override
   with `OLYMPUS_EVAL_MAX_RESULTS` and
   `OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE` for targeted diagnosis.
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
