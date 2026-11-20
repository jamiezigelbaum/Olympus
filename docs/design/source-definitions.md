# Source definitions: one declaration per source, one gate for every read

Status: DRAFT v2 (20 Nov 2026), revised after independent reviews by Codex
Astra and Gemini Neon. Awaiting Jamie's approval. Written by the 1.5
plan owner at Jamie's request after the source-specific audit of main
`d9cf10eb` (olympus-ops run 44736179620). Reviewers: Gemini Neon and Codex
Astra, independently. Code read at `d9cf10eb`.

## The goal (Jamie, 20 Nov 2026 13:12Z)

> We want a very elegant, simple, clear, and well-structured code base where
> as much logic as possible is on one spine. [...] one spine that does as much
> of the ingestion, judging, ordering, embedding, etc., as possible, and then
> the minimal, concise, effective design for connectors. So the per source
> code is exactly what's needed for each source to get properly fed into the
> spine, and nothing more. And it needs to be generalizable for all different
> types of sources. And it might be that there are specific connector types,
> like there's a file system connector, which has some shared machinery for
> things like Dropbox, Drive, and the Finder. And then there's like a
> messaging connector type. [...] Anything that can be replicated should be
> shared across connector types.

Three layers, and the test for each:

- **Spine** (shared): ingest, judge, order, extract, embed, search, answer,
  count, show, delete. Never asks which source or which connector type an
  item came from. It reads only facts the connector declared.
- **Kits** (shared per connector type): file system (Dropbox, Drive, local
  files/Finder, Evernote notebooks?), messaging (Telegram, WhatsApp, Apple
  Messages), mail (Gmail, mbox import), library (Readwise, X bookmarks).
  A kit is a building block a connector uses (path walking and change
  cursors; chat and media spools; MIME and threading; highlight and
  bookmark records). It is composition, not a class hierarchy: a connector
  may use two kits (Gmail attachments are files; WhatsApp media).
- **Connector** (per source): sign in, list and fetch, and translate the
  provider's facts (sharing, version order, folders, labels, chats, rate
  limits) into the spine's vocabulary. Nothing two sources would both write.

Test: a new source is one small connector using a kit; nothing in the spine
or the kits changes. Plan-owner additions to the goal, put back to Jamie:
the spine never branches on kit either (a kit is not a new per-source
branch), and "may this content be read here" is decided at one gate.

## The problem in one paragraph

`docs/CONTRACTS.md` says only `SourceConnector` is per-source. The judge
obeys that: the tier ledger, Secret floor, rejudge, held and override settle,
visibility and loop pass have no source branch. Everything around the judge
does not. Which sources are embedded, extracted, searched, scheduled, counted,
shown and governed by which owner rules is decided by hand-kept lists in
shared code that name sources (about 930 source-name literals outside the
connector folders: `src/core` 476, `src/workers/engine` 330, dashboard 83,
classification 40; `server.ts` alone builds every lane by name). And the
question "may this item's content be read here?" is answered separately at
each stage: scheduled embed, manual embed, backlog count, extraction, search,
folder-scoped answers, attachment holds. Each answer is written by hand and
they drift. The Gmail failure was one of those answers (a Gmail-only approval
branch inside the embedding scope) disagreeing with another; six fixes
patched the branch instead of removing it. The audit found 105 findings, of
which nine can change who sees an item or whether it is searchable (A1 to A9),
and lane 3's grant-revocation fix failed three times for the same reason:
six delivery paths each recheck grants their own way.

So there are two defects, and the draft treats them separately:

1. **No single gate.** Visibility and searchability are decided in many
   places. This is a correctness and privacy defect. (A1, A2, A3, A6, A8, A9,
   lane 2's mismatched-mailbox finding, lane 3's grant revocation.)
2. **No single declaration.** A source is wired in by name in a dozen
   rosters. This is a maintainability defect that keeps producing defect 1:
   a source missing from one roster (Evernote from embedding scope, Readwise
   from search) silently gets a different policy.

## How mature systems solve this

- **Complete mediation** (Saltzer and Schroeder): every access to a protected
  object goes through one reference monitor. Linux does it with the VFS
  permission check and LSM hooks: file systems implement storage, never the
  permission decision. Our equivalent: connectors implement fetching, never
  the admission decision.
- **Connector frameworks** (Kafka Connect, Airbyte, Singer): a connector
  ships a spec (config schema, streams, capabilities); the platform owns
  scheduling, offsets, retries, normalization and destinations, and never
  names a connector. Spotlight importers declare the content types they read;
  the system owns indexing, scheduling and privacy.
- **Revocation ordered against reads**: a revocation takes an epoch; a read
  is judged by the epoch it started under; revoke returns only after reads on
  older epochs drain (the read-copy-update pattern). Lane 3's round 3 design
  is exactly this; this draft makes it the gate's rule for every stage, not a
  privacy-batch special case.

## Design (v2, after both reviews)

Both reviews (olympus-ops#237: Codex Astra, run 44742587961; Gemini Neon,
run 44742592720) verified the diagnosis against the code and returned
"adopt with changes". They agreed on every main change; v2 takes them all.
The biggest change is in what gets built before 1.5 (see Sequence).

### Part 1. One admission policy, enforced at every boundary

v1 proposed one gate that callers consult. Both reviews said that is not
enough: callers forget, and several reads already bypass the store's checks
(owner item browser `tier-owner-items.ts:269`, deep read
`deep-read-jobs.ts:319`, people index `local-index.ts:8343`, conversation
titles and `localContent`, Secret locations, parent labels, manual embed,
source watch). v2 separates **one policy** (defined once) from **its
enforcement points** (where the work actually crosses a boundary).

**The policy** (`src/core/admission.ts`) is a pure function of declared
facts, never of a source id:

```ts
interface AdmissionContext {
  caller: 'owner' | 'remote_grant' | 'watch' | 'internal_judge' | 'migrate' | 'backup';
  purpose: AdmissionStage;          // see below
  layer: 'names' | 'content';       // a folder may show names but not text
  destination: 'device' | 'private_cloud' | 'cloud' | 'recipient';
  account: AccountRef;              // durable owner of the items
  requestScope?: RequestScope;      // folder, chat or account the request is limited to
  authority: AuthoritySnapshot;     // grants and approvals, with their epoch
}
```

Stages: `acquire` (provider I/O, including reads inside a listing pass and
deferred child bytes), `place` (writes, only through tier placement),
`extract`, `embed`, `search`, `answer`, `deep_read`, `people_index`,
`preview` (owner item browser), `watch`, `count` (counts the population the
counter names: backlog = missing vectors; search counts = visible results),
`deliver` (an answer, relay response or item handle leaving the engine),
plus privileged `judge`/`migrate`/`backup` that bypass owner scope by
design and say so.

**Enforcement is sealed, not conventional.** The policy is the only
factory for a `ScopedStoreView` (search, answer, preview, deep read, people
index, counts) or a `PrivilegedStoreView` (judge, migrate, backup). The raw
`LocalConnectorStore` read methods become package-private, so an un-gated
read is a compile error, not a guard catch. Writes go only through tier
placement, which closes A4 and A5 (a read gate cannot).

**Hot path.** The policy compiles to a parameterised SQL shape cached per
`(store, stage, layer)`, with caller, account, scope and authority bound
per use (v1's `(store, stage, epoch)` key could reuse one folder's filter for
another). Per-row `json_each` over folder keys (`local-index.ts:20985`) is
replaced by an indexed `item_scope_keys(scope_key, item_pk)` table. The
existing synchronous live recheck before hydration (`stillVisibleSearchRows`,
`local-index.ts:15702`) stays and becomes the policy's single-item
evaluator. Before switching search over: prove SQL and single-item verdicts
agree on the same fixtures, and compare query plans, p95 latency and
eligible top-k on the owner-scale 24-store workload, narrow scopes and
heavily held stores included.

**Account identity.** Durable item ownership (the provider account the
item came from: a mailbox address, a Dropbox account id) is separate from
the grant generation. Today's approval generation includes `connectedAt`
(`source-scope-approval.ts:171`), so a same-account reconnect changes it;
using it as ownership would hide legitimate history. Specified cases:
same-account reconnect (history kept), different account (old history not
served under the new binding), unproven account (held), disconnected with
retained history, archive-only accounts, legacy rows.

**Provenance** is its own fact: `live` or `owner_import`. An imported
archive stays searchable without live approval, for every source. This is
the real shape of today's Gmail special case (live plus `archive.` mail).

**Revocation.** Publish the new epoch at once across front, background and
queued jobs; cancel long work (deep read, extraction) through its abort
signal; drain only the short commit or hand-off that is already under way,
within a bound; re-acquire authority when a job resumes or a result is
collected; and check the epoch synchronously at `deliver`, so nothing is
released under a stale grant. Tier and hold checks stay independent of the
epoch (an item can turn Secret while a grant stays valid). The existing
release manifest (`release-manifest.ts`) already models what an answer
depended on and is kept.

### Part 2. One declaration per source

Each connector folder exports a `SourceDefinition`: pure data plus lazy
factories, so the CLI, dashboard, tests and the front/background split can
read the catalog without loading provider runtimes or opening SQLite. It
says what a source **supports**. The account registry
(`docs/design/source-storage.md`) says what is **mounted, connected and
approved**; a tier store may appear after start-up and an external mount may
add a principal to an existing lane, and both keep working.

Capabilities are **independent**, never inferred from a category (v1's
`labels ⇒ sender rules`, `family ⇒ searchable`, `children ⇒ extractable`
were per-source branches in disguise). A source declares each one it has:

- scope matchers: `path_prefix` (Dropbox, local files), `container_key`
  (Drive folders, Evernote notebooks, X lists, Apple Notes folders: opaque
  ids that survive renames), `label`, `sender`, `conversation`, `account`;
  and separately which of them can constrain acquisition, owner rules and
  queries;
- `searchable`, `extractable` (a childless PDF is extractable), `children`;
- typed search facets (instead of newline-packed `search_text`);
- tasks with their own cadence (pull, reconcile, confirm), not one cadence
  per source;
- `readiness()`: a generic hook for start-up gates such as local files'
  cleanup recovery (`server.ts:2912`), which stays fail-closed;
- limits, display, status counters.

An answer limited to a folder or chat skips any corpus that cannot enforce
that scope (A6); a search facet alone is never an authorisation fact.

### Part 3. Spine first, kits only for record shaping

Both reviews moved work from kits into the spine. **The spine owns:** HTML
and MIME extraction, byte limits, Secret disposition (spool loops
included), request budgets and quota accounting (`request-budget.ts`),
cursor and checkpoint persistence, tombstones and reconciliation,
parent-child relations (scope exclusion, tier ceiling, hold-until-judged
and delete cascade follow the parent automatically, replacing per-connector
holds (A9), `parentLabels` and `child-visibility.ts`), and a dead-letter
queue with retry and backoff for poison items.

**Kits hold only domain record shaping:**

- **files**: tree walking and change feeds for path and container sources.
- **messaging**: chat, thread, reaction and media-record normalisation.
- **mail**: RFC 822 threading, labels, senders.
- **library**: only once Readwise and X show a real shared operation.

Evernote reuses the container and attachment helpers; it is not forced into
`files`. Archive imports are **input drivers** (`forInput`, already in the
contract) feeding the same connector's record parser with `owner_import`
provenance, not a kit. OS-specific concerns (macOS permissions, volume
identity) stay in their connector. A kit never decides visibility, tier or
searchability, and the spine never branches on kit.

### Enforcement (mechanical)

1. **Sealed views** (Part 1): un-gated reads do not compile.
2. **Connector conformance suite**, run on every real connector and on a
   synthetic one: idempotent resync, tombstone propagation, scope revoked
   mid-sync, split-tier visibility, interrupted replay with verified
   output, a denied operation, a mixed-capability source. Adding a source
   needs no edit outside its folder and the catalog list.
3. **Guards on raw-store access and provider I/O**, not on name literals
   (counting literals would flag display names and aliases). A shrinking
   allowlist like `public-surface-guard`.
4. **Placement guard**: chunk writes only from tier placement.

## Sequence (v2: both reviews said not to cut over before 1.5)

| Step | What | When |
|---|---|---|
| 1.5 fixes | Small, surgical fixes for the real bugs: A1 (Evernote in embedding scope), A2 (manual embed scope for every family), A3, A6 (scoped answer skips corpora that can't enforce scope), A7 (Readwise registered as searchable), A8, A9; lane 3's privacy batch with A4/A5 and its revocation design; lane 2's Gmail redesign | before the 1.5 candidate |
| G0 | `admission.ts` in **shadow**: computes verdicts beside today's checks and logs disagreements; parity tests against `connectorStoreReadScope`, `storeEmbeddingScope`, `connectorStoreStatusScope` across every corpus, Gmail imports and local-files cleanup included | in parallel, ships dark in 1.5 if green |
| G1 | Sealed views; cut search, answer, preview, deep read, people index and counts over to the policy; `item_scope_keys` index; parity and latency proof first | right after 1.5 |
| G2 | Acquisition, placement and delivery boundaries; revocation across processes; provenance and account identity, including the mismatched-mailbox deny (pulled from 1.5 on 20 Nov: a partial deny hid the owner's own mail on installs without a recorded account id and missed four read paths; olympus-ops#236) | after G1 |
| D1 to D4 | `SourceDefinition` catalog with independent capabilities; derive rosters in batches (stores and extraction; scheduler tasks; owner-rule kinds; search, status, display) | after G1, in parallel with G2 |
| S1, K1 to K3 | Move shared machinery into the spine; then files, messaging and mail kits, one demonstrated duplication at a time | after D1 |

## Still open

1. Cost: the reviews give no size for G1 to K3; each step is sized when it
   is briefed.
2. Whether G0 shadow verdicts ship in 1.5 depends on the parity tests being
   green with no hot-path cost; otherwise G0 lands right after.
