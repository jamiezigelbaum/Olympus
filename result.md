# Earlier-build Personal body repair

The tier sniffer now finds stored text without waiting for the source to list it again. Restore and the background walker use the same per-item placement rule. An exact, authorized Personal body stays in place. The walker screens unjudged text for Secrets and sends a detected Secret through the existing location and cleanup path. For other unjudged bodies, one ledger transaction hides the Personal copy, records the hold, and queues the move.

The mover transfers eligible bodies to Private. The local answer path can find and cite them there while judgment is pending. A Personal verdict bound to the complete text, plus the normal Secret and move checks, returns the body to Personal. The dashboard reports cumulative holds and completed body verdicts. Repeated observations of the same hold or verdict count once.

The walk starts with the newest source date, uses descending insertion order for ties and undated items, and saves its position across ticks and restarts. The question queue preserves discovery order among these holds. Existing priorities for live arrivals, owner requests, and aged questions still apply.

## Move authority

A hold immediately removes the old body from Personal keyword and vector results. Physical transfer, Private retrieval and automatic judgment depend on the existing mover accepting the move. The historical X recovery fixture reaches Private automatically with built-in local embeddings. A second run exercises the existing restriction on a set with a recorded cloud embedding provider. In that case the transfer stays queued and the body cannot answer through Private yet. The built-in local embedding fixture exercises physical Personal vector removal, Private citation and automatic return.

When two active copies of the same item contain different bodies, the Personal copy is hidden. The mover preserves both versions and reports the conflict.

## Local verification

| Check | Result |
| --- | --- |
| Typecheck, including exchange and connect-relay | Passed |
| Repository guards | All 32 passed |
| Build | Passed, including generated bundles and relay dashboard assets |
| New earlier-build settlement tests | 12 passed |
| Held-until-judged tests | 23 passed |
| Engine store copy and restore tests | 12 passed |
| X bookmark content recovery tests | 11 passed |
| Tier sniffer idle tests | 14 passed |

Across 58 focused test files, 1,338 tests passed and one opt-in real-model paraphrase test skipped. The Private citation test exercised the public local answer path, its visibility and release checks, and a fixture model. The new repair test failed on the starting checkout while the embedded row was still searchable in Personal. Tests used disposable home directories. The macOS restore suite used the native system copy utility.

## Expected cost for 100,000 active Personal items

Each tick examines at most **25 item keys per set** and yields between body candidates. A page uses one or two indexed keyset reads and one batched chunk read if it found keys. It reads complete text and chunk hashes without reading vectors. The query-plan tests verify index seeks at the start, across dates, and across equal-date ties.

For a fixed 100,000-row store, a full traversal takes **4,000 full pages and one empty end probe**. That is **8,001–12,001 page-finder SELECTs**, depending on date ties, plus index-readiness checks. A store upgraded without the ordering index builds it once through the existing background index worker.

For a clean store with 100,000 authorized text bodies and no overrides or images, budget another **500,000 point reads**. Each body takes two store reads to recheck its fingerprint and three ledger reads for its decision, override and copies. Page checkpoint and binding reads are additional. Processing time also scales with total text bytes. Adoptions, holds, Secrets cleanup, moves and model judgments add work only for affected items. A traversal that changed anything is followed by a clean traversal before the done marker retires the walker. These are query-count estimates. No 100,000-item timing benchmark was run.
