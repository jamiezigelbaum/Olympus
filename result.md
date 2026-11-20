# Legacy Personal body repair

The walker visits the newest stored items first. A held body remains available to the local Private answer path while the judge is unavailable. When the judge becomes available, the dashboard advances from a hold to a completed check without a new source listing.

## Review findings

1. **Existing authorization.** Before placing a live item, the walker checks the set ledger and the ledger beside the Personal store. Both use the full item identity, including the conversation. An exact Personal receipt still applies when the set ledger has only names. A changed body takes the normal Secret check and hold path. The tests cover both ledger locations, a routed names-only record and an edit after judgment.
2. **Historical cloud vectors.** A held body can move to Private even when the set records a cloud embedder or one is configured. The mover verifies the Private copy before purging the old Personal content and vectors. This matches its existing raise behavior. This exception carries no vector-copy or superseded-copy replacement authority. The cloud fixture reaches Private, loses its old vectors and receives an automatic judgment. Ordinary lowerings retain their embedding policy. When automatic moves are disabled, the walker defers a new hold.
3. **Retained content.** Physical chunks identify a body even when its routed Personal copy serves only names. The ledger records the physical source and hides it in the same transaction. A move that cannot queue rolls back the layer change. A names-only Private stub receives the verified text. The mover refuses to overwrite conflicting active bodies. A vector left without any chunks is removed after the writer rechecks for chunks, preserving the item's names. A new walk checkpoint revisits rows that the first implementation could have skipped.
4. **Bounded discovery.** Each tick examines up to 25 item keys and reads up to 128 text chunks per set. The background SQLite reader seeks by item and chunk index and returns ordered, concatenated slices. An oversized item spans ticks. The walker keeps the unfinished text in memory and checkpoints the last completed item. A content-free watch in the store detects edits from other connections. Unrelated writes allow the read to continue, and a restart rereads the unfinished item. The watch table and triggers are removed when the walk retires. Classification and the verified move still operate on a complete item.
5. **Restore order.** Restore checks for conflicting copies, deletes questions about earlier bytes, then reads names for a Personal override. An injected names-read failure proves the obsolete question is already gone.

## Cost of one lap

Two local SQLite fixtures each held 100,000 active items with the same short, one-chunk text, exact judge receipts, one ordering date and no overrides. The production walker ran to retirement, with its background reader and checkpoint writes enabled.

| Receipt location | Items checked | Ticks | Background finder SELECTs | Elapsed |
| --- | ---: | ---: | ---: | ---: |
| Set ledger | 100,000 | 4,001 | 104,001 | 14.6 s |
| Personal store's own ledger | 100,000 | 4,001 | 104,001 | 28.7 s |

Each run completed 4,000 full pages and one empty end probe with zero holds, Secrets dispositions or failures. The reader issued 100,000 bounded chunk queries and 4,001 keyset queries. A page crossing a date boundary can need a second keyset query. Ledger lookups, including sidecar receipts and overrides, are additional to the finder count and included in elapsed time. The timings exclude seeding and use back-to-back ticks while other local checks were running. Large documents add ticks according to their chunk counts. A lap that changes placement is followed by a clean lap before retirement.

## Local verification

All five reported regressions failed on the starting checkout before the production changes. Additional fixtures exercise replacement between slices, unrelated concurrent writes, restart, vector-only remnants and an empty Private destination.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed, including exchange and connect-relay |
| `bun run guards` | All 32 passed |
| `bun run build` | Passed |
| First-round focused tests plus the mover visibility and Gmail rule-sweep suites | 1,393 passed, 0 failed, 1 skipped across 60 files |
| Legacy Personal body settlement suite, included above | 21 passed |

Each focused file ran locally in its own Bun process with a fresh temporary home. The Private answer test exercised retrieval, release checks and citation with a fixture model. The skipped test requires an opt-in real built-in model for a paraphrase search.
