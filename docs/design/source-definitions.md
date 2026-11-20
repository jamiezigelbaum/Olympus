# Source definitions: one declaration per source, one gate for every read

Status: DRAFT v1 for review (20 Nov 2026). Not approved. Written by the 1.5
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

## Design

### Part 1. One admission gate (fixes defect 1)

One module, `src/core/admission.ts`, owns the decision "may this content be
used at this stage". Nothing else decides it.

```ts
type AdmissionStage =
  | 'fetch'        // read content from the provider
  | 'extract'      // read text from bytes (local or remote extractor)
  | 'embed'        // write vectors (scheduled sweep AND manual embed)
  | 'search'       // return as a hit (keyword, meaning, recency, people)
  | 'answer'       // put into an EvidencePack
  | 'count';       // show in backlog and status counts

interface AdmissionContext {
  stage: AdmissionStage;
  epoch: AdmissionEpoch;          // grants + approvals + account bindings, snapshotted at start
  egress: 'device' | 'private_cloud' | 'cloud';  // where the content goes at this stage
  scope?: AnswerScope;            // the folder, chat or account the request is limited to
}

interface AdmissionPolicy {       // compiled once per (store, stage, epoch)
  storeFilter: ConnectorStoreItemFilter;   // SQL-side predicate, set-based, no per-row calls
  admits(item: AdmissionFacts): AdmissionVerdict;  // for the single-item paths (fetch, manual embed)
}
```

The verdict is computed only from facts every source can supply, never from
a source id:

- **Owner approval**: the item's scope keys (below) against the approved
  scope set for its account. "Approval decides what is fetched; held mail
  stays searchable" (Jamie's 12:18Z choice) becomes a rule on stage, not a
  Gmail branch: `fetch` requires current approval; `search`/`answer` of
  already-held content requires only that the account binding is current.
- **Account binding**: the item's account generation equals the bound
  account's. A different account reconnected under the same slot fails
  `search` and `answer` for the old items (lane 2's must-fix 2) for every
  source, not just Gmail.
- **Tier and hold**: tier ledger state, hold-until-judged, Secret floor. The
  gate reads these; it never writes them. The judge stays as it is.
- **Egress**: stage plus tier decides whether content may leave the device
  (remote extraction cap, A8; cloud embedding). One rule for all sources.
- **Answer scope**: a folder- or chat-scoped answer admits only corpora whose
  scope model can enforce that scope; others are excluded, not trusted (A6).
- **Epoch**: the policy is compiled under the epoch the request started in.
  Revoking a grant bumps the epoch and returns only after in-flight work on
  the older epoch drains. The six per-path rechecks are deleted.

Every stage calls the gate: scheduled and manual embed (A2), backlog and
status counts (A3), extraction including remote (A8), search, answers,
fetch. A count that uses a different rule than search is the failure we are
removing, so `count` uses the same compiled filter as `search`.

**Children**: hold-until-judged for a child item is set once, at tier
placement, for every child of every source (A9), from the child identity in
`RawItem`. Connectors stop setting it.

**One write path**: content reaches a store only through tier placement
(classify, Secret check, hold). Recovery, extraction sinks and repairs call
placement; they never write chunks directly (A4, A5, already in lane 3's
batch). A guard enforces it.

### Part 2. One declaration per source (fixes defect 2)

Each connector folder exports one `SourceDefinition`, the only place the
source's facts live. `src/core/source-catalog.ts` imports the list of
definitions (the only file that names every source) and builds every roster
from it.

```ts
interface SourceDefinition {
  id: string;                         // 'gmail.email'
  family: SourceFamily;
  display: { name: string; logo: string };
  credential: SourceCredentialKind;   // drives setup and reconnect UI
  inputs: { live?: LiveInputSpec; archive?: ArchiveInputSpec[] };
  connector(ctx: ConnectorContext): SourceConnector;     // the existing contract
  stores: StoreLayoutSpec;            // tier stores via the source-storage registry
  scope: ScopeModel;                  // what the owner approves and rules on
  children?: { kinds: ChildKind[] };  // attachments, media
  cadence: 'live_cheap' | 'sweep' | 'manual';
  search: { fields: SearchFieldSpec[]; recency?: true; people?: PeopleSpec };
  limits?: { maxItemBytes?: number }; // declared, enforced by shared ingest
  status?: { counters: StatusCounterSpec[] };
}

type ScopeModel =
  | { kind: 'paths' }                 // Dropbox, Drive, local files, Evernote notebooks
  | { kind: 'labels'; senders: true } // mail
  | { kind: 'conversations' }         // Telegram, WhatsApp, Apple Messages
  | { kind: 'account' };              // Readwise, X: all or nothing
```

Shared code reads `scope.kind`, `cadence`, `children`, `search` and so on;
it never compares a source id. From the catalog the shared code builds:

| Roster today (audit) | Built from |
|---|---|
| corpus registry, engine overlay, `server.ts` lane list | `stores`, `family` |
| extraction roster, tier-set map | `stores`, `children` |
| embedding scope (A1) | Part 1 gate, `scope` |
| scheduler tasks per source | `inputs`, `cadence` |
| owner-rule kinds by provider (`RULE_SOURCES`) | `scope.kind` (folder rules for `paths`, label and sender rules for `labels`, chat rules for `conversations`) |
| search fields, recency lane, people index, all-sources search (A7) | `search`, `family` |
| status counts, Doctor checks, display names and logos | `status`, `display` |
| delete, export, uninstall | already built from the storage registry (`docs/design/source-storage.md`, approved 24 Oct); joins the catalog |

Shared work currently inside connectors moves out: spool Secret loops,
HTML-to-text (Gmail, mbox, Readwise), Drive's own read cap, per-connector
progress maths, Dropbox extraction-readiness SQL, the Secret detector's home
in the Dropbox folder. Target remains the contract's ~300-line connector;
today's connector folders run 1,700 to 10,000 lines.

`CONTRACTS.md` gets a minor version: `SourceDefinition` wraps
`SourceConnector` without changing it, so this is additive. It follows the
versioned change gate (change log, eval, critical review).

### Part 3. Kits (connector types)

Kits live in `src/workers/kits/<kind>/` and hold what two or more connectors
of a type would otherwise each write. Starting inventory from the audit and
the connector folders (1,700 to 10,000 lines today against a ~300 target):

- **files**: folder walk and change cursor, path scope keys, deferred bytes
  for large files, provider read caps, extraction readiness. Users: Dropbox,
  Drive, local files, Evernote (notebooks as folders), archive imports of
  file trees.
- **messaging**: chat and message records, media children, capture spools
  and their Secret loops, conversation scope keys, group/direct kind.
  Users: Telegram, WhatsApp, Apple Messages, chat archive imports.
- **mail**: MIME parsing, HTML to text, threading, label and sender scope
  keys, attachment children. Users: Gmail, mbox import.
- **library**: saved items with highlights and source URLs, account-level
  scope. Users: Readwise, X bookmarks.

A kit may supply defaults for a `SourceDefinition` (scope model, search
fields, children), so a connector built on a kit declares little. What a kit
must never do is decide visibility, tier or searchability: those stay in
the spine's gate and judge. HTML to text and MIME extraction belong to the
spine's shared extractor, not the mail kit, because files and messages carry
HTML too.

### Enforcement (mechanical, survives any thread)

1. **Synthetic source test**: a fake source defined only by a
   `SourceDefinition` in a test folder is fetched, judged, extracted,
   embedded, searched, answered, counted, shown and deleted with no other
   edit. If adding a source needs an edit anywhere else, this fails.
2. **Source-literal guard** (like `public-surface-guard`): no source id or
   provider string outside its connector folder and `source-catalog.ts`.
   Today's ~930 literals go into an allowlist with a reason each; the list
   only shrinks.
3. **Gate guard**: no stage reads chunks, vectors or content without a
   compiled `AdmissionPolicy` (static check on the store read APIs, plus a
   runtime assertion in tests). Existing `embedding-path-guard`,
   `tier-path-guard` and `tier-hold-until-judged-guard` fold into it.
4. **Placement guard**: chunk writes only from tier placement.

## Sequence

Ordered by risk. Each step is one Gemini build with its guard, one Codex
read, then main.

| Step | What | Fixes | When |
|---|---|---|---|
| G1 | Admission gate for `embed` (scheduled and manual), `count`, `search`, `answer`; account binding; answer scope | A1, A2, A3, A6, A7 (search capability from family), lane 2 must-fix 2 | before the 1.5 candidate |
| G2 | Gate for `extract` and `fetch`, egress rule; child hold at placement; epoch revocation | A8, A9, lane 3 grant revocation (replaces round 3's per-path rechecks) | before the 1.5 candidate |
| D1 | `SourceDefinition` + catalog; synthetic source test; literal guard with allowlist frozen | stops new drift | right after 1.5 |
| D2 to D5 | Derive rosters in batches: stores and extraction; scheduler; owner-rule kinds; search and status and display | the remaining ~70 findings | after 1.5, allowlist shrinks each batch |
| K1 to K4 | One kit at a time (files, messaging, mail, library): move duplicated connector code into the kit, connectors shrink toward ~300 lines | duplication | after D1, in parallel with D2 to D5 |

G1 and G2 replace the point fixes A1 to A9 and lane 2's Part C. The work
is about the same size as nine point fixes, but it removes the cause, so
none of it is thrown away by D1 to D5. Lane 3's round 3 keeps its five
non-revocation fixes; its revocation design becomes G2's epoch.

## Open questions for reviewers

1. Is one gate compiled to a set-based store filter fast enough on the
   search hot path (24 stores, ~1M items on the owner's box), or must
   `search` keep a separate pre-compiled filter that the gate merely owns?
2. Is the stage list complete? Anything that reads content and is not
   fetch, extract, embed, search, answer or count (export? the deep read?
   people index? relay?)
3. Does draining in-flight work on revoke risk a stall (a long deep read
   holding an old epoch)? Should revoke cancel instead of wait past a bound?
4. Is four scope kinds enough (Evernote notebooks as paths; Apple Notes?
   X lists?), or does `ScopeModel` need a fifth?
5. Should G1 and G2 really precede the candidate, or is the risk of a new
   gate on every path in the last days larger than the nine point fixes'?
6. Are the four kits the right cut? Where should Evernote and archive imports sit? Is anything placed in a kit that belongs in the spine, or vice versa?
7. Anything in this draft that re-creates a per-source branch under another
   name (for example `scope.kind` becoming a proxy for "is Gmail")?
