# Engine split: one writer in the background, a read-only front (#1064)

Status: design, 2026-11-10. Lane 1 of the 1.5 plan. Code baseline: main
`b649295`. Independent Critical review (Astra, olympus-ops cloud job
42815695294, 2026-11-10) requested changes; they are folded in below and
listed under "Review findings and how they are handled".

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
store set (never a live store) and imports into it at full speed while
requests run one after another with a 250 ms pause between them (a
closed loop: a slower layout is offered fewer requests, which hides
queueing). A request is what the search adapter does per
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
The first runs let the separate readers resolve their ledger through the
copied stores' binding, which pointed at the seed ledger; with the readers
given the run's own ledger the Worker layout measured 8.0 s / 9.6 s
(`hasEmbeddings` 5.7 s, keyword 2.3 s), so the conclusion stands.
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

### Re-measured after parts 1 and 2 (2026-11-10)

Main `8a9e2a8` (parts 1 and 2 on, part 3 present but switched off), same
container and Bun, a fresh 500,000-item seed with half its items pending a
move, every fifth item an attachment of the one before, and a current vector
on every chunk. Requests now arrive on a fixed schedule whatever the layout
(an open loop; latency counts from the scheduled arrival, at most 8 wait at
once, and arrivals past that or after the window are shed), every layout
measures the same 56 s window, and each layout ran 3 times, interleaved.
The request's vector-lane check is `vectorLaneServable`, which the search
path calls on main. Median (range) of the 3 runs; RSS is the measuring
process's peak, plus the writer's for the second process. Other sessions'
tests shared the 4 cores at times.

One request every 2 s (all 28 served in every run):

| Layout | Request p50 / max | Vector-lane check p50 | Keyword p50 | Longest freeze | Import rate | RSS |
|---|---|---|---|---|---|---|
| one process, keyword on the request thread | 1.9 s (1.8–1.9) / 2.1 s (2.0–2.4) | 0 ms | 1.8 s | 2.1 s (2.0–2.1) | 5,500 (4,000–6,000)/min | 762 MB |
| one process, parts 1+2 (main today) | 2.3 s (2.3–2.4) / 2.7 s (2.5–2.7) | 0 ms | 2.2 s | 0.92 s (0.90–0.92) | 32,800 (32,500–37,100)/min | 1,015 MB |
| writer in a Bun Worker, read pool | 1.9 s (1.9–1.9) / 2.5 s (2.5–2.7) | 0 ms | 1.9 s | 0.95 s (0.89–0.97) | 36,800 (35,400–39,100)/min | 1,270 MB (one process) |
| split: writer in a second process, read pool | 1.8 s (1.8–1.9) / 2.5 s (2.5–3.1) | 0 ms | 1.8 s | 0.95 s (0.87–0.98) | 35,800 (31,300–35,900)/min | 406 MB front + 950 MB writer |

One request every 250 ms, more than any layout can serve (224 offered; 31,
about 58, about 65 and about 64 served):

| Layout | Request p50 / max | Keyword p50 | Longest freeze | Import rate | RSS |
|---|---|---|---|---|---|
| one process, keyword on the request thread | 25.4 s / 49.4 s | 1.8 s | 2.7 s (2.6–2.7) | 2,400 (2,200–2,500)/min | 712 MB |
| one process, parts 1+2 | 7.6 s (7.3–7.8) / 21.9 s (17.0–22.4) | 7.6 s, mostly waiting for the pool | 0.89 s | 39,500 (37,300–40,000)/min | 1,054 MB |
| writer in a Bun Worker, read pool | 6.7 s (6.5–7.1) / 16.7 s (8.5–17.3) | 6.7 s | 0.91 s (0.88–0.94) | 33,400 (33,100–38,700)/min | 1,261 MB |
| split, read pool | 7.1 s (7.0–7.1) / 17.3 s (8.4–17.6) | 7.1 s | 0.99 s (0.84–1.0) | 36,200 (33,500–37,500)/min | 348 MB front + 960–1,145 MB writer |

Reproduce: `bun scripts/engine-split-bench.ts seed --items 500000`, then
`bun scripts/engine-split-bench.ts run --mode same|thread|process --reads here|pool [--every-ms 2000]`.

What changed. The vector-lane check the search path makes now
(`vectorLaneServable`, which keeps a `true` for a while and reads part 1's
visibility) takes under 1 ms in every layout, against 4.9 to 6.2 s for the
per-request rebuild in the separate-reader layouts before, so a separate
writer no longer makes requests slower. (An unmemoised `hasEmbeddings` on
this seed, now with vectors, still took about 2.7 s in one 20 s probe.) Part 2 took the longest freeze from 2.1 to
2.7 s down to about 0.9 s and let the import run 6 to 16 times faster in a
single process; with both parts the single process now matches the split on
request latency, freeze and import rate, and what the split still adds here
is a smaller front (350 to 400 MB against about 1 GB) and a writer that can
restart on its own, at more memory in all. Two things are left that no
layout fixes: a keyword query is still about 1.8 s per store at this size,
so requests queue as soon as more than about one a second arrive, and the
request thread still stops for about 0.9 s in every pool layout, from work
these runs did not isolate.

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
same in both here, so the measurement does not choose between them; a
process can be restarted on its own, which a thread cannot do without
the dashboard. Re-measured after parts 1 and 2 under equal offered load
(above, 2026-11-10): latency is still the same in both, so the restart
and the smaller front decide it.
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

**The rule that keeps this safe: the SQL table is a pre-filter, never
the authority.** Every row a read returns is still checked against the
current tier ledger and the parent standings across the tier set, after
the store query, as the copy filter and child filter do today
(`withoutChildrenOfHiddenParents`, `child-visibility.ts`). A table that
is a moment stale can then cost recall or make a count briefly off; it
cannot serve a copy that was just raised. This answers the race the
review named: a raise that commits between a reader's cursor check and
its query is caught by the per-row check that runs after the query.

The writer keeps each store's pre-filter in a real table inside the
store file (`tier_visibility`, item pk and flag), written in one
transaction with the cursors it covers, so no reader sees a half-applied
update. The store's change feed becomes a real table with triggers that
cover every column visibility depends on (today's update trigger leaves
out `trust_tier` and `parent_local_item_id`, `local-index.ts:3275`, which
a persistent feed must not). Children stay a per-row check against
parents in every store of the set, transitively, keeping the rule that a
present Secret parent's location establishes presence
(`child-visibility.ts:19-35`).

What each operation may see does not change. Held content stays
available to keyword search and Private answers and is kept out of
vector search; names-only items stay findable by name while their
content is not served (`docs/V0_4_RELEASE.md:48`; `local-index.ts`
around `:10285`, `:11993`, `:14997`). The PR carries an
operation-by-layer table and tests for both sides: what must stay out
and what must stay in, with a second connection reading while the
writer commits.

Measured cost of an SQL filter against a 250,000-row table on the
synthetic store: within noise of no filter on the keyword query, and
about 1 ms per incremental write. This removes the per-query rebuild
behind #1079 and #858 and the JavaScript copy of the set.

### Part 2: store queries off the request thread (rest of #1079)

`searchItemsDetailed`, status counts and the vector scan run on a read
pool (default 2 threads; one connection per store per thread, opened
read-only). The request thread builds the query, merges results and runs
the per-row visibility check. Admission is bounded and fair across
stores; a job past its lane's deadline is dropped from the queue, and a
thread still running one is replaced rather than waited for. The Ask and
answer path never falls back to running the query on the request thread
(today's `off-thread-reads.ts` does, after 120 s); the lane is reported
busy instead. Each read transaction lasts one query, so readers cannot
hold back WAL checkpoints; WAL size and checkpoint progress are measured
under sustained load. "Busy, try again" replaces "cannot search on this computer" for
a lane that timed out (the 1.4.3 patch owns the wording; this part owns
the cause).

### Part 3: the split (behind `worker.engineSplit`)

- **Background entry.** The worker wiring with a role. Boot work that
  needs exclusive ownership (the data-owner lock, deleting marked
  accounts, storage migration; `server.ts:2447-2467`) runs in the
  background only, and the front starts serving stores only after the
  background reports it ready and the schema current. The background
  holds the data-owner lock across its own restarts' handover; the front
  takes no lock and opens ledgers read-only too (today a bound ledger is
  opened writable from read paths, `local-index.ts:3048`). The host
  starts both, with the readiness order, socket ownership and shutdown
  written down for the engine host (`engine-host.ts:95`) and OpenClaw
  hosting (`native-plugin.ts:302-330`), where captures wait for worker
  readiness.
- **Commands from front to background.** Owner actions that write a
  background-owned store become commands on a private unix socket (the
  worker transport already used for the worker socket,
  `src/core/worker-transport.ts`), authenticated as the worker is today.
  The socket acknowledges receipt at once; the command's result comes
  back when the background has committed it, so the dashboard can show
  "saving" and then the real outcome. Commands carry an id so a retry is
  not applied twice, run in arrival order per source, and keep every
  authorization check they have today. The background's import and
  judging work is cut into bounded transactions so a command waits for
  at most one.
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
  interrupted pass is not a failure (#803, PR #1096). The owner-busy
  state for the shared model is re-sent by the front when the background
  comes back.

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
| `POST /dashboard/delete-source-data` (`index.ts:2714` → `:4051`) | `delete_source_data {source}`, in the order below | `removed_count` |
| `olympus tier set` via `/cli` (`index.ts:1189` → `tier-cli.ts:97-359`) | `tier_override {item, tier}` runs the whole command in the background: the override, hiding less private copies at once, scrubbing side stores for Secret, queueing or retargeting moves, `clear` and `not-secret` | the same outcome the command reports today |
| `/source/index/embed` (`index.ts:3841`, `embedChunks` at `:3881`; used by the embedding drain, `scripts/source-embedding-drain.ts:221`) | moves to the background with the rest of embedding | as today |
| Pairing placement and account commands (`cli-operations.ts:64-88`) | `storage_registry_*` | as today |
| Archive `remove`, `stop`, `approveRemoval` (`archive-import/dashboard.ts:925`, `:1060`, `:1076`) | state write stays front; `archive_changed` | accepted |
| Messaging capture start, respond, cancel, scope (`dashboard-messaging-service.ts`) | `capture_*` | the capture's status |

Deleting a source's data. Today the worker marks the account `deleting`
and restarts, and boot removes the files before anything mounts
(`index.ts:4126`, `server.ts:2462-2467`), because open stores must not
outlive the deletion. With two processes: the front stops admitting
reads for that account and drops any results in flight, closes every
connection to its stores on every read thread, and tells the background;
the background marks the account, closes its own handles, deletes, and
reports. The front reopens nothing for that account until a new store
generation appears. A crash at any step resumes from the `deleting` mark
at the next boot, as today.

Some background work also writes shared state that has leases today
(archive findings and state, `archive-import/sync.ts:498,611`; judge
spending reservations, `judge-spending.ts:104-150`). Those stay as they
are; they are listed so nobody assumes the front is their only writer.

**D. In-process signals that become cross-process.** The owner's own
answers preempt the judge (`localModelActivity.onBusy → tierSniffer.preempt()`,
`server.ts:7350`). With the split, the front sends `owner_busy` and
`owner_idle`. Matched-first judging (#1062, PR #1115) is the second
signal: the tier visibility gate reports held items that a search or
answer matched, and the judge takes them first (`judge-boost.ts`). The
front sends `judge_boost {ids}` (at most 20 ids per question, 15-minute
life); without it, matched-first ordering would quietly stop working,
though privacy would not change. On one shared local model this still matters (#1030,
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
machinery that existed only to let requests in. **Not deleted:** the
judge's preemption by the owner's own answers on a shared local model
(`server.ts:7331-7351`, #1030, #1031). That arbitrates a model server,
not a JavaScript thread, and stays, carried across the split as
`owner_busy` and `owner_idle`. Each deletion is its own PR after the
48-hour proof.

## Memory on an 8 GB laptop

Not yet known. The writer process peaked at 79 MB in the measurement
above, but that number was sampled from a thread that was itself frozen
at times, and the read pool (one connection and page cache per store per
thread) was not built. Removing the JavaScript hidden sets helps by an
amount the benchmark did not isolate. Before part 3 is switched on by
default, peak memory of host, background, front, read threads and model
processes is sampled from outside on a real 8 GB machine with many
stores mounted. A second process isolates a writer crash; it does not
keep the dashboard alive if the whole machine runs out of memory.

## Review findings and how they are handled

The Critical review (10 findings, frequency x severity 40 to 60) found no
leak in shipped code; all are about the design. Where they landed:

1. Part 1 had no atomic publication or consistent read (60): the SQL
   table is now a pre-filter only, and a per-row check against the
   current ledger after the query stays the authority. Part 1 PR tests
   a raise committed mid-read.
2. Children depend on sibling stores and the triggers missed columns
   (50): children stay a per-row check across the set; trigger coverage
   fixed.
3. Held and names-only copies are not simply excluded (56): the
   operation-by-layer table and two-sided tests.
4. Deleting data with readers open (40): the deletion order above.
5. Inventory gaps and tier override semantics (56): added above; the
   override runs whole in the background.
6. Boot, lock and acknowledgement semantics (40): background entry and
   commands above.
7. Read pool fairness and WAL growth (49): Part 2 above.
8. Benchmark limits (54): stated above; re-measured after parts 1 and 2
   with equal offered load, children, vectors and repeated runs
   (2026-11-10, above).
9. Memory on 8 GB unproven (48): measured on a real machine before
   default-on.
10. Owner preemption is not event-loop yielding (49): kept.

## Done when (measured on Sparta during a large import)

Dashboard reads under 1 s; no control-path freeze over 1 s; judge at
100 verdicts a minute or more (olympus-ops #134); RSS flat over 24 hours;
Ask finds a known WhatsApp message and a known email during judging; the
time-slicing listed above is deleted.

## Fallback

If part 3 is not proven by the 1.5 freeze, 1.5 ships parts 1 and 2 and
#929, and the split moves to 1.6.
