# Classification evaluation

`cli.ts` retains the existing source-pipeline corpus and adds `--inbox` for
full-message prompt, injection-screen and verdict-mapping evaluation. The inbox
fixture contains 48 complete synthetic emails: 30 Personal, 12 Private and six
Secrets. The owner description and empty rules are frozen from the supplied
privacy settings, with separate content (`label`) and metadata labels. Metadata
labels document independently safe names; this judge eval scores **content only**.

The 24 development and 24 held-out messages have disjoint template families.
They include Portuguese/French records and notices, quoted mail, long messages,
benign imperatives, onboarding notices and actual records. No real email bodies
are included. Credentials are inert placeholders expanded only at runtime;
all six must be refused before model input. They cover the existing password
assignment detector in bodies, a subject, quoted mail and a long tail; they do
not establish detection of OTPs, recovery codes or credential-bearing URLs.

## Commands

CI-safe, using the configured remote container from this worktree:

```sh
~/.local/bin/remote-build run --cwd /Users/zig/Code/olympus-wt/tier-judge -- bun run eval:classification -- --inbox
~/.local/bin/remote-build run --cwd /Users/zig/Code/olympus-wt/tier-judge -- bun test test/classification-eval.test.ts test/tier-judge-inbox.test.ts
```

Run later **on the laptop**, explicitly selecting its built-in local model:

```sh
REMOTE_BUILD_LOCAL_REASON=laptop-private-model-evaluation bun run eval:classification -- --inbox --real --built-in --split=dev
REMOTE_BUILD_LOCAL_REASON=laptop-private-model-evaluation bun run eval:classification -- --inbox --real --built-in --split=held-out
```

Run from the repository root. This is a deliberate local inference benchmark,
not a remote build. `prepare()` downloads/verifies the selected pinned model if
needed. There is no cloud fallback. The command stops its model server on exit.
For a configured privacy-approved lane instead, omit `--built-in`; the existing
`--real` route resolves that lane (which can be Venice), so check that choice
before using it. The default without `--real` never calls a provider.

The real run measures Private precision/recall, Personal recall, Secrets recall,
unresolved/schema-invalid output, calls and elapsed judgment time per item. It
records the actual built-in model/revision/weights hash, prompt version and
frozen policy digest. Use dev for changes, then held-out once for evaluation.
A 48-message set cannot establish population-wide 95% precision/99% recall.

## Replay evidence and limits

`fakeJudgment` is a frozen scripted response, explicitly separate from the owner
label. The replay submits only the message to the production prompt builder,
then exercises the production screen, parser and mapper. The scripted model
ignores prompt wording: this proves wiring, **not semantic prompt quality**.
The existing larger vocabulary-driven fake eval still tests the production
classifier, queue, cache, ledger and per-item isolation.

Executed before/after on the same frozen responses:

| Metric | Before | After |
| --- | ---: | ---: |
| Correct | 25/48 | 48/48 |
| Private precision | 33.33% | 100% |
| Private recall | 91.67% | 100% |
| Personal recall | 26.67% | 100% |
| Secrets recall | 100% | 100% |
| Secret-bearing model dispatches | 0 | 0 |
| Dev correct | 11/24 | 24/24 |
| Held-out correct | 14/24 | 24/24 |

No real-model run has been performed. Full messages avoid production excerpt
truncation deliberately, so these results do not prove production material
coverage, metadata-floor repair, pending age, movement latency, or availability
after 1/5/10 minutes. Those require the integrating pipeline/laptop run.

## Policy and compatibility

Owner text governs both private and shareable kinds. Only when no owner text is
supplied does the prompt default to Private for own health, therapy, financial,
legal and identity records and intimate/family conversations; ordinary work,
notices, logistics and reference material default to Personal.

The response separates `category` (topic), `ownRecord` and `privateKind` (the
private kind **under the owner policy**, or `none` for an exception). The parser
folds a protected own record into Private before the existing store persists
it. Contradictory Personal/private-kind conversations are rejected. Private
verdicts are never lowered by topic. Personal output requires both new fields;
legacy Private output can remain Private without permitting any release.
The prompt digest changes automatically, invalidating prior prompt verdicts.

Immediate screen refusals have a stable specific rule ID. The existing resolver
uses the stable aggregate rule `classifier_instruction` for queued refusals;
specific queued rule provenance requires the resolver owner's integration.

## Integration handoff

Cache model identity is **deferred**, not fixed in this slice. A prototype using
the actual model spec exposed a P1: the service uses the same `modelId` for both
cache keys and approval/revocation. Changing `built_in` silently bypasses an
owner revocation recorded against that stable ID. The unsafe prototype was
removed. Separate a stable approval identity from the actual weights/revision
cache identity in the resolver/service/store integration, then test old and new
revocations and a changed-model cache miss. Those files belong to other builders.

For the 95-row evidence, rows 56, 59–61 and 90–92 can reach judgment under the
new screen if their full material contains only the benign shapes; their bodies
were not supplied, so an exact changed tier cannot be asserted. Topic-only
forcing is removed for rows 68–74, 78–79, 83–86 and 88–89. A new valid Personal
response without owner-private information maps Personal; actual records remain
Private. Rows 80 and 87 require a corrected model verdict, not just a mapping
change. Old Private metadata floors require the other builder's re-judging
work. Pending/moving rows and existing settled Personal rows have no guaranteed
placement change from this slice alone.

## Builder validation receipt (2026-10-13)

- Initial red: 1 passed, 11 failed (including the subsequently deferred identity prototype).
- Calendar/belongings regression red: 12 passed, 1 failed.
- Contradictory private-conversation regression red: 13 passed, 1 failed.
- Final focused validation: 167 passed, 0 failed across 11 files, including the
  existing classification eval, source architecture/public-surface guards and
  built-in approval/revocation tests. TypeScript `--noEmit -p .` passed.
- Independent review found no remaining P1/P2 in delivered source blob
  `97c02e211de8209e4a43f49976f500f417b48ace`; it explicitly excluded the deferred
  identity change and did not claim real-model proof.
- Detailed red/green logs: `tier-review-evidence/logs/claude-tier-judge-*.log`
  in the evidence directory beside this worktree. Source/eval content alone went to
  remote-build; the real-evidence folder remained outside the upload.
