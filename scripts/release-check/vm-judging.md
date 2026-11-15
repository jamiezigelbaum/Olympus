# VM judging and time budgets

Disposable VM runs select `release-check-fixture-judge-v1` on
`http://127.0.0.1:19291/v1`. `machine-agent.ts` starts the loopback server,
updates the owner's `sovereignty.json` using the documented classification
profile route, and approves that exact model and prompt with
`olympus tier classifier approve`. No product environment override or `src/`
default selects it. A disabled Private pool gets the normal local answer
profile so the classification profile is eligible; its retrieval setting is
kept intact for the upgrade migration checks. Existing answer endpoints are
kept.

Each synthetic item's own text carries `RC_ITEM_TIER_<TIER>_V1`. Personal
(and Public before an owner publication rule) returns a full-mode Personal
verdict with confidence 1. Private returns Private. Secret fixtures retain
their owner Secret rules and secret detector: the sniffer parser accepts
only Personal/Private, so it cannot grant Secret or Public. A Secret marker
that reaches it is held Private. Missing or conflicting markers return
Private with confidence 0. System messages, owner descriptions and parent
context never grant a verdict. Archive records get markers before encoding,
so MIME, zip, rich-text and import matching still use the real readers.
Empty and media-only records keep their original coverage behavior.

The real Mac canary and the fresh-install Venice path do not set
`fixtureJudge` or start the stand-in. Their model and key setup is unchanged.
The key still comes from the existing runtime key command and stdin path.

`judge.fixture-used` requires calls to the stand-in and reports server time.
`model.answer-time` sums recorded analyst and local-leg time from the
product's content-free answer-latency ledger, deduplicating v1/v2 writes and
rotated traces. This is ledger coverage, not a claim to measure unrecorded
model work. It does not change the answer model.

`run.ts` declares these provisional wall-clock budgets:

| Kind | Minutes |
| --- | ---: |
| Fresh Linux, Ubuntu or Mac VM | 60 |
| Linux or Mac upgrade | 90 |
| Archive-scale (including ordinary checks) | 180 |
| Desktop canary | 30 |
| Accounts canary | 90 |
| Real fresh install | 120 |

Skipping ordinary archives subtracts 20 minutes from a non-scale VM budget.
Named phase limits include
5 minutes for ingest, 6 for front-seed, 8 for archive-beside-live, 12 for
ordinary imports, and 30/20/15/12/12 for scale mbox/Readwise/Roam/Reflect
JSON/Reflect Markdown. Other calls retain their own shorter timeout or a
10-minute ceiling. Install/update and provision have 25 minutes each.
Timeouts clamp VM exec and installer subprocesses, and watchdogs publish
`phase.<name>.time-budget` and `leg.time-budget` immediately. The completed
leg check includes the phase timings. Fresh-host restoration retains its
own bound even after the leg expires.

Failing checks go to stderr and `GITHUB_STEP_SUMMARY` when inserted,
including model-agent checks before the agent finishes. An unwritable
summary falls back to the live log and does not interrupt other checks.

## Timing receipts still required

The current patch must be applied to main before final-SHA measurements.
Its budgets are provisional, not derived from post-change VM receipts yet.
Check the olympus-ops release-check queue before each dispatch: Linux upgrade
and archive-scale share a machine group, and a new pending run can cancel
an older pending run. Run Linux upgrade, Mac upgrade and archive-scale once
on the same final main SHA, record answer-model time, verify the real Mac
and Venice judging receipts, then replace the provisional budgets with the
measured times plus a margin.

The supplied earlier job logs measure provision-start through VM destruction:

| Report | Kind in the actual workflow | VM-minutes before |
| --- | --- | ---: |
| [43666452949](https://github.com/jamiezigelbaum/olympus-ops/actions/runs/43666452949) | Linux fresh nightly (not upgrade) | 112.7 |
| [43751182260](https://github.com/jamiezigelbaum/olympus-ops/actions/runs/43751182260) | Mac upgrade | 116.9 |
| [43648133408](https://github.com/jamiezigelbaum/olympus-ops/actions/runs/43648133408) | Linux archive-scale | 194.1 |

No after VM-minutes or Linux-upgrade before receipt is asserted by this patch.
