# Engine split: one writer in the background, a read-only front (#1064)

Status: design, 2026-11-10. Lane 1 of the 1.5 plan. Code baseline: main
`b649295`. Needs an independent Critical review before the build.

## The problem in one paragraph

The worker runs HTTP (dashboard, approvals, pairing, remote surfaces, Ask
and answers) and all background work (connector syncs, imports,
extraction, privacy judging, tier moves, embedding sweeps) on one
JavaScript thread, and most of that work is synchronous `bun:sqlite`.
When the background is busy, every request waits. Each fix so far sliced
the work finer (`control-path-headroom.ts`, `runStepsInTurns`) or moved
one query to a thread (`off-thread-reads.ts`). On Sparta 1.4.2 on
2026-11-10 the worker still froze 32 to 45 s and every Ask lane timed out
(#1079). The CPU samples there named two costs: the synchronous keyword
search (`searchItemsDetailed`) and the hidden-copy set rebuilt from
`hasEmbeddings` on every query.

## What was measured

`scripts/engine-split-bench.ts` builds a synthetic, disposable tiered
store set (never a live store) and imports into it at full speed while a
request runs every 250 ms. A request is what the search adapter does per
store on each Ask query: `hasEmbeddings` (which rebuilds the hidden set)
plus `searchItemsDetailed`. A 50 ms heartbeat on the requesting thread
records freezes. Three layouts, 60 s each, on a 500,000-item store with
half its items pending a move (like Sparta's 645k sniffer backlog on
2026-11-04), cloud container with 4 cores, Bun 1.4.4:

| Layout | Request p50 / max | `hasEmbeddings` p50 | Keyword p50 | Longest freeze | Import rate | RSS |
|---|---|---|---|---|---|---|
| same thread (today) | 1.9 s / 4.4 s | 8 ms | 1.8 s | 4.4 s | 5,800 items/min | 261 MB |
| writer in a Bun Worker | 7.2 s / 7.9 s | 4.9 s | 2.1 s | 7.9 s | 45,500 items/min | 849 MB (one process) |
| writer in a second process | 8.8 s / 9.2 s | 6.2 s | 2.4 s | 9.2 s | 34,900 items/min | 622 MB front + 79 MB writer |

Reproduce: `bun scripts/engine-split-bench.ts seed --items 500000`, then
`bun scripts/engine-split-bench.ts run --mode same|thread|process`.
Synthetic text uses a 45-word vocabulary, so a one-word query matches
about 1 in 15 items, more than a real query would. Children
(attachments, chat media) were not seeded, so `hiddenChildSteps` costs
nothing here; on Sparta it was 16% of one frozen window.

A second probe on a copy of the same store, in plain SQL: a hidden-pk
table of 250,000 rows took 1.0 s to fill once, 1 ms per incremental
write, and added nothing measurable to the keyword query (449 ms with
the filter against 475 ms without, one common word; 0.1 ms to find the
first visible row).

### What the numbers say

1. **Moving the writer out makes import 6 to 8 times faster** (5,800 to
   35,000 to 45,500 items a minute), because it no longer gives its
   thread to requests. This is also #893 (the judge runs at half speed
   because it yields).
2. **Moving the writer out makes requests slower, not faster, as the code
   stands.** A front that opens the stores read-only rebuilds the whole
   hidden set on every request (4.9 to 6.2 s). The incremental rebuild
   depends on a TEMP trigger journal that only the writer's own
   connection has (`createVisibilityJournal`,
   `src/workers/connector-store/local-index.ts:3260`); a read-only
   connection sees each external commit as a changed `data_version` and
   starts again from nothing (`tierLedgerHiddenSteps`, `:3302`). The
   hidden set is also kept in JavaScript, which is most of the front's
   600 to 850 MB.
3. **The keyword search is about 2 s on its own at this size**, in every
   layout. Wherever it runs on the thread that serves requests, it
   freezes that thread.

So neither a thread nor a process fixes the dashboard by itself. The
split works only with two changes that also help today's single process:
visibility kept in SQLite, and store queries run off the request thread.

## Decision

**A second process for all writing, plus a small pool of read threads in
the front.** Not "stay as is", and not worker threads alone.

- **Background process: the only writer.** Connectors and captures,
  archive import, extraction, privacy judging and tier moves, embedding
  sweeps, scheduler. It owns every connector store, tier ledger, sniffer
  and classification store, secret-locations index and embedding ledger.
  It serves no HTTP except a private command socket.
- **Front process: HTTP, dashboard, approvals, pairing, remote surfaces,
  Ask and answers.** Opens the background-owned stores read-only (WAL
  allows it) and runs every store query on a read pool of Bun Worker
  threads (the `off-thread-reads.ts` pattern, generalised), so its event
  loop never runs one. Lane timers then fire on time.

Why a process and not a Worker thread for the writer: latency was the
same in both (table above), and a process can be restarted on its own.
That makes #957 (memory growing during long judging runs) a supervised
restart instead of a leak hunt under deadline, and #803 (a restart counted
as a task failure) stops touching the dashboard at all. A crash or out of
memory in the writer no longer takes the dashboard with it. The service
hosts already supervise child processes of this kind (embedding drain,
relay; `src/core/engine-host.ts:96`), so this is one more of a known
shape, not a new mechanism.

Why read threads in the front and not just the process: the 2 s keyword
search would still freeze the front's own thread.

## The three parts, in build order

Each part ships behind the `worker.engineSplit` switch only where it
changes topology. Parts 1 and 2 help the current single process and land
first; they are also the fallback if part 3 is not proven by the freeze.

### Part 1: visibility in SQLite (#858 option 1)

The writer keeps each store's visibility in a real table inside the store
file (`tier_visibility`, one row per hidden or held item pk and flag, and
the hidden children), maintained by the same incremental refresh it runs
today, and stamped with the ledger and store feed cursors it covers. The
store's change feed (`item_visibility_changes`) becomes a real table
written by the writer's triggers, so other connections can read it, like
the ledger's `tier_visibility_changes`
(`src/workers/classification/tier-ledger.ts:3555`).

A reader (the front, or today's process) never rebuilds from scratch. It
reads the table and applies only the feed entries past its cursors,
which are few. **Fail closed:** if a feed has dropped entries past the
reader's cursor (retention gap), the reader serves nothing from that
store and reports the lane as busy until the writer's next refresh
catches up. It never serves a set it cannot prove current. Searches,
counts and the embedding check filter with `NOT EXISTS` against the
table in SQL. Measured cost of the filter: none; of the upkeep: about
1 ms per write.

This removes the per-query rebuild behind #1079 and #858 and the
JavaScript copy of the set. Guards: the privacy-per-item and architecture
guards stay green, plus a test that a hidden, held, names-only and
pending-move copy and the child of a hidden parent are excluded from
search, counts and the embedding check through the table, including
across two connections.

### Part 2: store queries off the request thread (rest of #1079)

`searchItemsDetailed`, status counts and the vector scan run on a read
pool (default 2 threads; one connection per store per thread, opened
read-only). The request thread builds the query and merges results. Each
lane's 10 s timer can then fire, and one slow store cannot starve the
others. "Busy, try again" replaces "cannot search on this computer" for
a lane that timed out (the 1.4.3 patch owns the wording; this part owns
the cause).

### Part 3: the split (behind `worker.engineSplit`)

- **Background entry.** The same worker wiring with a role: the
  background mounts lanes writable and runs scheduler, sniffer, captures,
  extraction and embedding; the front mounts the same stores read-only
  and runs none of them. The host starts both (engine host on Mac and
  Linux, the native service in OpenClaw hosting).
- **Commands from front to background.** Owner actions that write a
  background-owned store become commands on a private unix socket (the
  worker transport already used for the worker socket,
  `src/core/worker-transport.ts`), authenticated as the worker is today.
  A command returns when the background has committed it, so the
  dashboard can show the result. The background answers its socket from
  a thread that does no store work, so a busy import cannot delay a
  command's acknowledgement; the write itself queues behind at most one
  write transaction.
- **State from background to front.** Counts and progress the front
  shows (import progress, judging rate and backlog, capture and scheduler
  status) are published by the background as a small snapshot, written
  atomically every few seconds; the front reads the last one and shows
  its age. No request waits on the background for status.
- **Stores the front keeps writing.** Its own files stay its own: remote
  connections, waiting private questions, answer jobs, dashboard
  sessions, settings files. Nothing else writes them.
- **Restart.** The host restarts the background on exit and, with the
  switch on, when its RSS passes a threshold between batches (#957). An
  interrupted pass is not a failure (#803, PR #1096).

The writes the front still needs are listed in the next section; each is
either kept front-owned or becomes one command.

## Writes the front still needs

From an inventory of the request handlers on main `b649295` (handler
bodies are in `src/workers/email-source/index.ts`; route sets in
`src/workers/http.ts:600-720`). No request handler calls the sniffer or
the tier-move code directly, and no answer path writes a verdict or a
ledger. What the front does write falls into four kinds.

**A. Front-owned files that stay front-written.** Remote connections
(`src/core/remote-connections.ts`), waiting private questions
(`src/core/waiting-private-questions.ts`), private answer and question
jobs (in memory), dashboard control sessions, remote OAuth and pairing,
ChatGPT handoffs, dashboard messaging grants, remote-access and agent
settings. Nothing in the background writes these.

**B. Config files the front writes and the background reads.** Connected
handle registry (connect and disconnect), file and mail scope approvals
(`src/core/source-scope-approval.ts`), the exclusions and owner rules file
(`src/workers/source-dispositions.ts`), the embedding override file,
model choices and judge spending, archive-import state and request queue.
These stay front-written: each is already written atomically and re-read
by the background. What changes is the wake. Today the handler then calls
the scheduler in-process (`refreshDashboardSchedulerSources`,
`index.ts:4254`; `startApprovedSourceRun`, `server.ts:7669`;
`wakeTasksOfKind`); with the split it sends one command, `reload` with the
kind of file, and the background re-reads and rewakes.

**C. Writes to background-owned data that become commands with a
synchronous answer.**

| Today | Command | The front needs back |
|---|---|---|
| `POST /dashboard/sync-now` (`index.ts:2419`; admission at `:4194`) | `sync_now {source}` | `checking`, `busy` or `too_soon` |
| Approve and start (`server.ts:5919`, `:5986`) | `start_approved {source}` | `ingestion_started` or why not |
| Scope approval invalidating extraction jobs (`server.ts:6016`) | part of `reload scope` | done |
| `POST /dashboard/disconnect`, `/unpair` (`index.ts:2526`, `:2780`) | registry write stays front; then `sources_changed`, and `capture_stop` for messaging | lanes parked |
| `POST /dashboard/delete-source-data` (`index.ts:2714` → `:4051`) | `delete_source_data {source}`: the background, which holds the files, deletes them | `removed_count` |
| `olympus tier set` via `/cli` (`index.ts:1189` → `tier-cli.ts:321`, `ledger.setOverride`) | `tier_override {item, tier}` | applied |
| Archive `remove`, `stop`, `approveRemoval` (`archive-import/dashboard.ts:925`, `:1060`, `:1076`) | state write stays front; `archive_changed` | accepted |
| Messaging capture start, respond, cancel, scope (`dashboard-messaging-service.ts`) | `capture_*` | the capture's status |

A command is acknowledged once the background has committed it, so the
dashboard keeps showing a real result. Delete-source-data stops doing a
front-side delete of background-owned files, which today relies on
checking that no read is running (`index.ts:4061`).

**D. In-process signals that become cross-process.** The owner's own
answers preempt the judge (`localModelActivity.onBusy → tierSniffer.preempt()`,
`server.ts:7350`). With the split, the front sends `owner_busy` and
`owner_idle`. On one shared local model this still matters (#1030,
#1031); with the model on Delphi or Venice it stops mattering.

**State the front reads, published by the background** in its snapshot:
scheduler status (11 call sites), sniffer backlog and pending
classification count (`server.ts:2562`, `:6860`), judge spending and
runtime, capture statuses (`server.ts:2591`), unreadable-file state
(`server.ts:4995`, `:5023`), the archive dashboard view, and manual-sync
runs. The tier visibility gate (`tier-visibility.ts:48`) already reads the
ledger per query and works read-only; the store memos are replaced by
part 1.

Not yet verified: the full remote MCP and OpenAPI operation registry
(they call the same handlers, so they inherit this list), and whether
`olympus tier set` rewrites stores or only the ledger
(`tierCommandRewritesStores`, `tier-cli.ts:91`). Both are checked when
part 3 is built.

## What gets deleted

When part 3 is proven on Sparta: `ControlPathHeadroom` and every
`ingestionTurn()` call that exists only to let requests in, the
`runStepsInTurns` variants of the visibility builds, the status-counts
memo age (`STATUS_COUNTS_MAX_AGE_MS`), and the sniffer's yield-to-answers
machinery that only protected the request path (#1030, #1031). Each
deletion is its own PR after the 48-hour proof.

## Memory on an 8 GB laptop

The second process costs a Bun runtime plus its own SQLite page cache:
79 MB peak for the writer in the measurement above, before models (the
built-in model already runs as its own llama-server process). The front
loses the JavaScript hidden sets, which were most of its RSS here. Net
expected change on a laptop: under 150 MB more, to be confirmed on the
first real install.

## Done when (measured on Sparta during a large import)

Dashboard reads under 1 s; no control-path freeze over 1 s; judge at
100 verdicts a minute or more (olympus-ops #134); RSS flat over 24 hours;
Ask finds a known WhatsApp message and a known email during judging; the
time-slicing listed above is deleted.

## Fallback

If part 3 is not proven by the 1.5 freeze, 1.5 ships parts 1 and 2 and
#929, and the split moves to 1.6.
