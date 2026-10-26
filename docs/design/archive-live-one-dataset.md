# Archives and live connectors: one dataset, one pipeline

Status: design, 2026-10-25, after two critical review rounds and the owner's
removal decision. Owner requirement; builds on
[archive import](archive-import.md), [child items](child-items.md) and
[source storage](source-storage.md).

## Owner requirement

- **One dataset.** An archive of an account and that account's live connector
  make one dataset with nothing stored twice, for every source (owner,
  2026-10-25: "one continuous data set without overlaps … one complete
  Telegram archive that is being updated in real time from the connector").
- **One pipeline.** An archive is not a second way to process a source. The
  archive connector takes an archive and "pushes it through the same Telegram
  ingestion pipeline as the live connector … for all sources" (owner,
  2026-10-25).
- **Best of both.** Where the two mechanisms built so far differ, keep the
  better one, without adding bugs (owner, 2026-10-25).
- **Merged history stays.** An import that joins a live source becomes part
  of that account's history; it is deleted with the account's data, not on
  its own (owner, 2026-10-25, option A of two).

## Today (main, 2026-10-25)

An archive is its own source: its own provider (`telegram_export`,
`whatsapp_export`, `mbox`), a fresh account scope per import, ids built from
places in the file, its own stores and tier ledger set
(`archive.imports.<family>`), and its own item builders. Live capture uses
provider `telegram` / `whatsapp` / `gmail`, a constant account scope
(`telegram.personal`, `personal`, `personal`), the provider's ids and its own
builders. A message held by both is stored, judged and embedded twice.

| Source | Live history | What an archive can match on |
|---|---|---|
| Telegram | newest 150 messages of each approved chat when paired, then everything new | exact: the export carries Telegram's chat and message ids; the pairing proof `account_ref` is `sha256(user id)[:16]` and the export's profile carries the user id |
| WhatsApp | nothing before pairing (the bridge ignores history sync) | no ids: the export has the chat name, a minute-precision local time, the sender as shown and the text |
| Gmail | the scope window (default two years) with content, older mail names-only | Takeout: the Gmail message id (to verify, below); any mail export: `Message-ID`, which live Gmail does not request today |

Archive import has not shipped (none of it is in v1.1.0), so changing its
identity moves no user's data.

## Design

### 1. One connector per source; an archive is one of its inputs

Each source keeps one connector, and it is the only thing that writes the
source's items. The live reader (the Telegram reader's spool, the WhatsApp
bridge's spool, the Gmail API) is one input. Each imported archive is another
input: the archive layer reads the export and emits the live reader's own
record shape (a Telegram message record, a WhatsApp bridge record, a parsed
mail), and the source's connector turns every record into an item the same
way, whichever input it came from. Everything after the record is one code
path: builder, store set (the account's own stores, [source
storage](source-storage.md)), placement, tier ledger set, judging,
extraction, children, limits.

So the store and the tier ledger see one source and one ledger set per
account. Inputs are the connector's business, below the `RawItem`; nothing
downstream learns that an archive exists, which keeps the rule that only the
connector is per-source.

An input keeps what only it needs: its own cursor (an archive's stays bound
to its files' identity), recorded under its own connector id in the sync
runs so it never moves the live cursor; its findings; its progress; and, for
an archive, the import record with a Stop control. Stopping keeps what was
imported.

A source with no live connector (Reflect, Roam, Evernote), mail that matches
no Gmail account, and an archive of a different account than the connected
one stay under Archives as today (`archive.imports`, one account scope per
import), with their Remove.

### 2. Intake: one version per item, chosen before judging

The connector decides, per record, whether it applies before it builds the
`RawItem`, so the classifier only ever judges content that will be kept. It
compares the record with the stored item through a lookup the store lane
gives it (stored version and whether the item holds content), as live Gmail
already does for stored mail. The decision keeps no state of its own: the
store is the record of what applied, so a crash replays the record and
decides again.

- A record applies when it is newer than the stored version, in the
  source's own order (Telegram: edit date, then reactions; WhatsApp: the
  message time; mail does not change), whichever input it came from. An
  older record never overwrites a newer one, so a queued live record cannot
  undo a later edit the archive holds. The stored version is the newest any
  row of the item holds, whatever the item's completeness or visibility: an
  item written to one leg only, or left as a Secret's location or a
  deletion's tombstone, still has its version, so an old export never
  restores what was deleted or made a Secret, nor overwrites a partly
  written item. A record of an incomplete item's own version completes it (an item is incomplete while a write intent for it is pending).
- At the same version, a record applies only when it brings content the
  stored item lacks: mail outside the Gmail window is names-only, and a live
  WhatsApp photo is metadata only (the bridge downloads voice notes alone).
  Otherwise the stored item stays, and live is kept on a tie.
- A second archive of the same history adds only what is newer or missing.
  Re-importing an export is caught by its file identity, as today.
- Each version of an item an input brings is accepted, classified and routed
  on its own (an edit that adds a key is a Secret even if the version before
  it was ordinary), and the input's resume point never passes a record whose
  accepted version no store has taken.

### 3. The hold travels with the item

Today the hold-until-judged rule is a lane option on the archive set. In one
pipeline the lane is the live one, so the hold moves to the item: an item
built from an archive record carries `holdContentUntilJudged` on its
`RawItem`, and placement honours it exactly as it honours the lane option
today, through first classification and child extraction. As today, the
persisted hold keeps applying to that item's later versions until the
private model has judged it; a live replacement of a held item is therefore
held too, which errs Private. Items built only from live records are
unchanged.

### 4. Matching, per source, inside the connector

- **Telegram:** exact. The archive input writes the chat id in Telethon's
  marked form (users positive, basic groups `-id`, supergroups and channels
  `-100id`, from the export's chat type) and the message id, so its record
  has the live item's key.
- **Gmail:** exact where the export carries the Gmail id (Takeout, to
  verify). Otherwise a message is the live item whose `Message-ID`, `Date`,
  `From` and `Subject` all agree, and its own item when none or several do.
  Two mails that agree on all four (a list resend) are taken as one, a
  residual this rule accepts. Live Gmail adds `Message-ID` to the headers it
  requests; when an mbox of the connected account is imported, a bounded
  background pass reads it for mail already stored (one metadata read per
  message, within the provider budget), and matching waits for the pass to
  finish.
- **WhatsApp:** an export has no message ids, so nothing can make it
  certain; this is the closest the data allows. A message's key is its chat,
  its minute, its sender and its text (caption included). The sender is
  "me" for the owner's own messages, and otherwise the contact's saved name
  from the bridge's contact store, which is what the export shows, falling
  back to the push name. Messages with equal keys are counted on each side,
  and the dataset keeps as many as the side with more: each side's count is
  at most the truth, so identical messages are neither lost nor doubled.
  Live capture periods cannot replace this: the bridge receives missed
  messages after a reconnect with their original times, and a full queue
  drops a message while capture is running.
  - The export's times carry no zone. The input chooses a time zone, not
    an offset, and converts each line with the rules for its own date, so
    daylight-saving changes are followed. It tries this computer's zone
    first, then the zones whose offset on the overlap's dates fits, and
    keeps the one under which most keys match; when none matches, this
    computer's zone is used and reported as assumed, as today.
  - A message the two sides show differently can still appear twice: a
    contact renamed between export and capture, a caption the bridge dropped
    (until the caption fix), a message the bridge never wrote. The input
    counts each near-miss (same chat, within a minute, sender or text
    differing) under "How it was read", by chat and time, so they are
    findable.
  - The export's chat joins the live chat of the same name, when exactly one
    has it. Otherwise, as for groups (the bridge leaves group names
    unresolved), it is its own conversation in the WhatsApp source, with a
    "join to a chat" control on the import record. A split thread is
    findable and fixable; a merged wrong chat would be neither.

### 5. Media: one form per source

Each source has one representation of its media, and both inputs use it.

- **WhatsApp** (revised 2026-10-26, step 5): a voice note keeps live's form,
  one row with the media type and its transcript. A photo, video or
  document is the message (its caption, the bridge's text since step 3) with
  the media as a child keyed by the file's name in the export, read later by
  a locator into the import (`archive-import/input-media.ts`). The caption
  and the picture are two things to judge, so they are two items. A voice
  note the bridge already saved is not added again from the export. Media
  the export left out is a child that cannot be read, counted. Live images
  and video become the same children in step 8.
- **Telegram and mail** use child items, with keys both inputs can compute:
  Telegram `media` (one per message), mail the MIME part path. A photo the
  archive brings to a message live also holds is its child; if live capture
  later brings the same media, it is the same child.

Each child is still judged on its own.

### 6. Deleting

- **Merged history** is deleted with the account: deleting the account's
  data removes live and imported items together, through the existing
  whole-source delete. There is no per-import removal, so no per-item record
  of inputs, no single-item delete and no account-scoped purge for an input.
- **An import under Archives** (section 1) keeps today's Remove by its own
  account scope, which no other input writes.
- **Disconnecting live** keeps the history the archives supplied.

### 7. Same account, or no merge

Accounts are resolved by the storage service by source and provider account
hash (a [source storage](source-storage.md) step agreed 2026-10-25, before
steps 4 and 6 below); live connect and pairing record the hash.

- **Telegram:** the export's user id, hashed as pairing hashes it, is the
  account's hash. Imported before pairing, the account is created with it;
  pairing another account later is refused with a plain route ("this
  Telegram is a different account from the imported history: delete that
  history first"). A single-chat export carries no profile: it joins the
  source's only account at the owner's confirmation, or creates the account
  without a hash, which the first pairing sets.
- **Mail:** an mbox with Gmail's own markers (`X-Gmail-Labels`,
  `X-GM-THRID`) and one delivered-to address is a Gmail account, hashed into
  the opaque address label the source binding keeps; matching a connected
  account needs that label among the account's labels and the owner's
  confirmation. With no connected account, the account is created with the
  label and a later connect of that address joins it. Absent, mixed or
  conflicting addresses, or no Gmail markers, make it archive mail under
  Archives.
- **WhatsApp:** an export never names its account. It joins the source's
  only account at the owner's confirmation in the import sheet, or creates
  the account, which pairing then joins; the owner can keep it apart under
  Archives instead.
- **Another account's archive** (an old Telegram account, say) stays under
  Archives, as today, until more than one account per source exists.

No rows are ever re-keyed.

### 8. Counts and findings

One dataset shows on one card: the source's own (Telegram, WhatsApp,
Gmail). Its imports are listed inside it, each with its progress, findings
(their plain sentences and two lists) and Stop. The Archives card keeps the
imports of section 1's last paragraph. The source card counts each item
once; an import counts its own run as it goes: "N items from this archive,
of which M were already there". The card shows the history each input
covers: imported up to the export's date, live since pairing.

### 9. Connector work this needs

Each live connector's record-to-item code is private and tied to its
transport today. It becomes a builder any input can call, bounded as now,
and gains record kinds for what exports hold and live capture does not read
yet: Telegram contacts, sessions and service messages; the WhatsApp status
chat. Live capture can then bring them too. The live Telegram builder's
limit (four million characters a message) is the limit for imports; a longer
one is a gap.

## Best of both

A stage-by-stage comparison of the two mechanisms on main (2026-10-25)
decides what the one pipeline keeps. What is kept brings its existing tests;
what is new (the per-item hold, the intake rule, merged-input cases) needs
its own.

| Stage | Kept | From | Why |
|---|---|---|---|
| Reading | chunked streaming, a bound per record and per pass, damage reported as a finding | archive | live Telegram re-reads whole spool files from its cursor each page and fails once the files one read visits pass 768 MB; live WhatsApp scans its whole spool for freshness each pull, with no byte bound; neither prunes |
| Resume | a cursor bound to its input's version, with named stop codes | archive | a missing Telegram cursor wedges its lane; a WhatsApp cursor whose file was replaced by a shorter one silently skipped that file's first lines, and one whose file vanished went on with no count (corrected 2026-10-25: the draft said the vanished case skips the rest; it resumes at the next file) |
| Identity and versions | account, chat and message ids; a version that tracks edits and reactions, with explicit clears | live | archive Telegram ids hash file positions, WhatsApp's hash time, sender, text and occurrence, mbox's the raw message, and versions hash text, so a second export of the same chat would not match |
| Item text | service messages as items, sender names, reply and forward names, captions | archive (Telegram), new (WhatsApp) | live Telegram keeps a sender id without a name and a forward as a bare flag; the WhatsApp bridge drops captions |
| Privacy signals | chat id as the folder key, priors, protected floors, owner chat rules | live | archive copies today carry file positions as folder keys, so an owner rule on a chat never reached its imported history |
| Hold | held until judged, per item, for every archive input | archive | section 3 |
| Media | the extraction factory for every input; WhatsApp voice notes as live reads them | both | only live WhatsApp reads any media today (voice notes); archives count media as not imported |
| Problems | findings by kind, counted once per position, in plain sentences, in two lists | archive | live reports receipt counters, and a full bridge queue drops a message with only a log line |
| Freshness | capture freshness, told apart from a quiet account | live, fixed | live judges staleness from the newest message's time, so a quiet account reads as stale |
| Deleting | with the account for merged history, by archive for imports under Archives | both | section 6 |
| Progress | percent of the input read, items held, attention when held | archive | live shows freshness only |
| Tests | shared fixtures and the release check's real-machine leg | archive | live is driven in the release check only through stand-ins |

Fixes this brings to live capture, each its own step with its own tests,
since live capture must not regress: streaming spool reads with bounds,
cursor recovery, counted bridge drops, WhatsApp captions, and freshness told
apart from quiet. The live Telegram builder gains the archive's richer text.

Neither mechanism does these well, and they stay outside this design:
deletes and revokes at the provider, spool retention, live Telegram history
older than the newest 150 messages, and WhatsApp history sync. An archive
input fills the last two for the history it covers.

## Contract

`RawItem.holdContentUntilJudged`, connector inputs with their own cursors,
and the intake lookup of the stored version are a semantic change: contract
2.2.0, after 2.1.0 (child items), through the versioned gate with an
independent critical review and the private held-out run. Store and ledger
ownership and the delete paths do not change.

## Order

1. Child items spine (2.1.0, merged).
2. One-pipeline spine (2.2.0, built, awaiting critical review): connector
   inputs and their cursors, the intake lookup and rule, the hold on the item,
   the import record inside a source card with its counts; proved with a
   fixture source that has a live and an archive input (see "Built, step 2").
3. Live capture fixes from "Best of both", each with its own tests:
   streaming spool reads with bounds, cursor recovery, counted bridge
   drops, WhatsApp captions, freshness told apart from quiet. WhatsApp part
   built (see "Built, step 3: WhatsApp").
4. Telegram: the export becomes an input of the Telegram connector (exact
   ids, account hash), with folder media as children; reusable builder and
   new record kinds. After storage's account-identity step.
5. WhatsApp: the export becomes an input (counted keys, zone alignment,
   chat joining); the bridge's records carry the contact's saved name.
   Built (see "Built, step 5: WhatsApp").
6. Mail: live Gmail requests `Message-ID`, with the background pass, and
   gains attachments as children; mbox of a Gmail account becomes a Gmail
   input. After storage's account-identity step.
7. Reflect, Roam, Evernote: their own sources, assets as children.
8. Live Telegram media and live WhatsApp images and video, so both
   inputs bring the same media.

Each step is proved on fresh Mac and Linux installs by the release check's
archive leg, which gains an import-beside-live case per source with a
fixture live input. The owner canary with a paired phone checks the real
apps.

## Built, step 2

Contract 2.2.0 and the machinery, proved with a fixture source and no real
source or format (`test/support/one-pipeline-harness.ts`,
`test/one-pipeline-spine.test.ts`, `test/source-inputs.test.ts`,
`test/eval-one-pipeline.test.ts`). No production source registers an archive
input yet, so nothing changes for a real install until steps 4 to 7.

- **Where things live.** The intake rule and the connector that applies it
  are `src/core/source-inputs.ts` (`decideIntake`, `inputConnector`); the
  lookup is `TieredStoreSet.storedItem`, over the stores' existing columns.
  The archive layer binds an input's cursor to its files, holds its items,
  and counts what it read (`src/workers/archive-import/source-input.ts`,
  `sync.ts`); a source registers what only it knows in `source-targets.ts`.
- **Cursors.** Each input is a connector id in the set's sync runs: the live
  input's own, and `archive.<archive id>` per import. An archive's cursor is
  prefixed with its manifest digest, so a cursor of other files stops the
  import instead of reading different bytes from where the old ones ended.
- **Account and lock.** Resolution happens at approval (`start.ts`) and again
  at every pass, inside the source's exclusive runner when the source has an
  account guard. A pass whose account is no longer the export's stops with
  `account_changed` and writes nothing more.
- **Stop** keeps what was imported. Merged imports have no Remove, so
  choosing the same export again resumes a stopped import from its cursor.
- **What the design left unstated.** A newer archive record over an item
  that live already stored as Personal raises the item to Private (the hold
  is the item's, so it applies to the replacement). A raise that queued a
  move would hide the old body and later copy it, never the newer one, and
  the archive's resume point had already passed the record, so the set
  replaces the item in one write instead: the lower copies go first, then
  the new body lands in the Private store, held until judged. A record whose
  item is in the middle of a move cannot be stored yet: the set keeps its
  resume point and the import is not complete until it is, so the next pass
  reads the record again. (A names-only newer record over an item whose text
  was not read still leaves the stored copies as they are, as every lane
  does.) At the same version none of this arises unless the stored item
  lacked its content. Revisit when the first real source adopts inputs.
- **Item budget.** A listing's limit counts items, not records: a record
  that expands into a parent and children is cut inside the record when the
  budget runs out, and the page carries a cursor that resumes inside it
  (parent stored, children pending). An import is marked imported only when
  the stores consumed the listing's last page.
- **Account confirmation.** The owner's yes is bound to the account it was
  given for (the registry account's incarnation and its provider account),
  recorded with the import and checked at every pass. A source bound to
  another account since, or an account that is gone, stops the import with
  nothing more written; choosing the export again asks the question again.
- **Delete.** An import record that cannot be read fails the whole-source
  delete (no store is removed; the owner runs it again once the file reads),
  so no import survives to put the history back.
- **Delete wording.** The delete confirmation on the computer says that the
  archives imported into the source go with it and the files stay where they
  are. The ChatGPT surface has no imports list, so its confirmation says
  nothing of them (open).
- **Read back before moving on (2026-10-26).** The set's resume point passes a
  listing only once every item the input accepted is read back through the
  stores with the lookup intake uses (`storedItem`): its version is the one
  reported or a newer one, brought content is there and complete, a deletion or
  Secret is no longer active. Anything else counts as unstored, so the import
  is not marked imported and the next pass replays it. Copy rows and deferred
  removals are cleanup and moves only; they do not decide completion. A newer
  names-only record over stored content moves the stored version (the text
  stays), and a Secret or deletion moves a tombstone's version with the
  tombstone, or on its own for a row that already is one.
- **One record per item in a page (2026-10-26).** A page is reduced, per item
  and independently for parents and children, to its newest accepted record
  (same version: a deletion beats content, otherwise the later record). A
  newer names-only record keeps the content an older record of the page
  brought. A record without a version is accepted as the version the store
  holds and keeps it. The page's provisional state records deletions and
  carries content a names-only record did not remove. Children that only a
  superseded parent listed stay (they are items of their own). Names alone
  never bring a deletion or a Secret back, within a page or across pages: a
  names-only record after a deletion stays a deletion at the newer version, and
  only content from after the item's last deletion is carried forward. A merged
  item resumes from the record that brought its content, so a pass cut between
  the two does not lose it. The routing plan is keyed by the item's identity,
  its version and a digest of the text and names judged, so two bodies of one
  version are each judged. Known residual: a deletion of an item no pass ever
  stored leaves no row, so a later tie or unversioned body can still be stored.
- **Order and resume (2026-10-26).** A page emits an item before its
  children, and a page cut resumes at the earliest record any unyielded item
  still depends on (a merged names-only item depends on the record that
  brought its body), so a cut never loses a body or stores a child ahead of
  its parent.
- **Write intents (2026-10-26).** An item's legs are written one after the
  other, so a crash between them used to leave a half state that the next pass
  had to interpret from the rows (an "incomplete" rule in the intake, a live
  tie exception, a deferred names-only version move, a hold on skipped
  incomplete items). That is gone. The ledger holds one **write intent** per
  item (`tier_write_intents`, schema 10), written in the same transaction as
  the placement and cleared last, after every leg has its write. Kinds:
  `deletion` and `secret` (redone from the intent alone), `advance` (a version
  move over rows that hold the item; the intent is the redo), `content` and
  `names` (a body or names the legs are owed). At the start of every pass,
  before any record is read, the set finishes every deletion, secret and
  advance intent, and the children of a finished deletion go with it. While an
  intent is pending the lookup reports the intended state (the intent's version
  and `incomplete`), and reads hide an item with a deletion or Secret intent at
  once. No path lowers a stored version: a names-only record moves a version by
  an `advance` intent put in place of the content intent it follows, once every
  leg has its write. Deviation from "keep the body in the Private held copy":
  the body and the names are not kept in the ledger, so a `content` or
  `names` intent is repaired by replaying its own record; when a newer
  names-only record took an older record's body, the intent also holds that
  record's version (`bodyVersion`, read back as `owedBodyVersion`) so the replay
  applies that record at the item's version. Residuals: a deletion of a
  never-stored item leaves no row; an owed `content` or `names` write waits
  for its own record; a newer names-only record holds behind an earlier run's
  owed write until that write is finished.
- **The hold survives a fetch (2026-10-26).** A held archive item's hold is
  carried by whatever replaces it: the archive input decorates `fetchItem` as
  well as `listItems`, and the local-index lane keeps the hold on both of its
  `fetchItem` replacements. `test/archive-import-hold-guard.test.ts` fails when
  a connector method is added without a decision (`holds` or `neutral`).
- **A refused item is told (2026-10-26).** When placement refuses an item (for
  example a trust domain that does not match), the import still completes but
  shows it as a gap, "Not imported" (`item_refused`), with the count, as the
  other fail-closed skips do.
- **Counting.** An import counts its own run ("N items from this archive, of
  which M were already there"), advanced under the position of the record it
  last read so a replay after a crash counts each record once; the card counts
  each item once.

## Built, step 3: WhatsApp

Live WhatsApp capture, with no change to identities or stores
(`src/workers/whatsapp/spool-reader.ts`, `spool-index.ts`,
`live-connector.ts`, `store-sync.ts`,
`tools/whatsapp-bridge/capture_status.go`; tests in
`test/whatsapp-live-capture-fixes.test.ts`,
`test/whatsapp-live-review-fixes.test.ts` and
`tools/whatsapp-bridge/capture_status_test.go`).

- **The spool contract.** A spool file is append-only for every writer but
  one: the bridge only appends whole lines, and Olympus's own clearing of
  Secrets rewrites a line in place at its own length, updating what it
  keeps of the file (what was cleared, the index's record) in the same step,
  so its rewrite never reads as a break. Anything else breaks the contract
  (a file replaced, cut and written again, edited) and is caught cheaply: at
  every boundary kept in a file (cleared-through, indexed-through) the
  digest of the 4 KiB ending there is kept too, and is read again before the
  boundary is trusted (`connector-store/spool-file-identity.ts`). A mismatch
  is a file read again from its start, keeping none of its old boundaries:
  cleared again in full from byte 0, its index rows rebuilt, and the
  listing's cursor moved back to it. Detected: a file replaced, cut shorter
  than a boundary, or rewritten in the 4 KiB before one. Not detected: a
  rewrite in place elsewhere in the file by anything but the bridge or
  Olympus; finding it would mean reading the whole prefix on every pass,
  which the read bounds forbid, so the contract is held by who can write:
  the spool folder is the owner's alone (0700, files 0600, the bridge
  making it so at start), written only by the bridge and by Olympus.
  Index rows, the files' records and the high-water mark commit in one
  transaction. A boundary and its receipt (the offset and the digest that ends there)
  are one record, written in one step, so a boundary is never trusted at an
  offset its receipt was not taken for: a crash before clearing records its
  new boundary leaves the old record, whose window is checked on the next
  pull. The listing's cursor carries no receipt and is never what decides
  whether a Secret is cleared; clearing's own record does. A boundary is
  what a scan reached, fixed before the scan starts (the lines the file held
  then, or the cursor's), never recounted after: a line appended while
  clearing runs is owed to the next pull. A listing reset (a file replaced,
  cut or rewritten under a cursor, or the disposable index rebuilt, since it
  then no longer knows what the files held) adds one to a single durable
  counter beside the spool (`spool-resets.ts`), written before the index
  forgets anything. Every cursor carries the count as `~r<count>`; a cursor
  with another count, or none, reads the whole spool again from its start.
  That is safe because intake is idempotent by identity and version, and a
  reset is rare enough for a full replay to be cheap. Nothing is owed or
  settled per reader: a reader is caught up when its cursor carries the
  current count, so one reader catching up never affects another, and a pass
  that fails before its cursor commits reads the spool again. A counter or
  index that cannot be opened fails the listing before anything is forgotten,
  and no cursor is handed out; the first index build the counter sees counts
  as a reset too. Clearing the Secrets already known never waits on a
  replay: a file past the cursor that was never cleared, or no longer holds
  what clearing recorded of it, is cleared of them from its start on the
  next pull, whatever the cursor or item limit (bounded by bytes, one whole
  file at least), with none of its lines certified for a later judgment. Every
  other durable write that comes before the one
  that depends on it is safe to repeat: a Secrets rewrite before its cleared
  record (redone, the same rewrite), the index's rows before the tier set's
  cursor (read again from the old cursor, the rows already there), the match
  ledger's ids and aliases before the store (the same ids again), and the
  index's refresh after clearing (a missed refresh reads as a replacement,
  counted and read again).
- **One builder, the intake rule.** The spool is the WhatsApp connector's
  live input: its records become items through the connector's one record
  builder under the shared intake rule (`core/source-inputs.ts`), versions
  ordered by the message's time. A record read again (a recovered cursor, a
  redelivery) never replaces a newer version the stores hold. A record that
  restates a message's reactions applies at the same version, as live's word.
- **Streaming reads with bounds.** A spool file is read in 256 KiB chunks
  from the resume point, never whole. The cursor is `<file>:<lines>@<offset>`
  and a resume seeks to the offset (a cursor from before offsets is resolved
  by counting its lines once). Every byte read is spent from the pull's
  budget (64 MiB), and a read pauses once it is spent: between records, or
  inside an over-long record (over 1 MiB), which is never held, is counted
  once (`oversized_spool_records`) and is skipped on from the place the
  cursor names (`…@<offset>s`), never read again. A record within the bound
  is finished before a pause, so a pull reads at most its budget plus one
  record's bound. The pull no longer scans the whole spool for its receipt:
  the newest message time is read back from the end of the spool (4 MiB at
  most), and malformed lines and unresolved reactions are counted for what
  this pull read.
- **Reactions from a persistent index.** `spool-index.sqlite` beside the
  spool keeps each message's newest line (by position) and each actor's
  current reaction to each message, built as the listing reads, within its
  budget; an index started on an existing spool catches up from the spool's
  start, a budget at a time, before a page is aggregated. A page's reactions
  are aggregated from a few rows and the reacted-to message is read from its
  one line; memory does not grow with the spool's history. The index holds
  ids, positions and reactions, never a message's text, and is a cache:
  deleting it costs one catch-up. `fetchItem` reads from it too, and scans
  the spool only for a message the index does not hold. Each indexed file
  is known by its identity (device, inode, birth time where the platform
  keeps one, and a digest of its first line, so a replacement on a reused
  inode is told apart; the time of the last change is left out, since every
  append changes it) and its size, and every listing
  reconciles the index with the files that are there before trusting it: a
  file that is gone loses its rows (its reactions stop counting), and one
  put in another's place, even of the same length, is indexed again. A
  reacted-to message is read from its one line in 4 KiB steps, out of the
  same budget as the rest of the pass, so a page of many reactions pauses
  like any other.
- **Cursor recovery.** A cursor's file only grows, so one shorter than its
  cursor, or where the cursor's offset is not the start of a line, was
  replaced (the spool folder removed and capture started again the same
  day): it is read again from its start, its index rows dropped, and
  counted (`spool_cursor_recovered`); the intake rule keeps what the stores
  hold newer. A cursor whose file has gone is counted
  (`spool_cursor_file_missing`) and listing goes on at the next file. Not
  covered: a replaced file whose bytes at the old offset happen to start a
  line, and a file named earlier than the cursor's (a clock set back).
- **Secrets clearing.** The shared rewrite streams its files
  (`connector-store/capture-spool-secrets.ts`, from the Telegram lane). What
  was cleared is kept per file, by the file's identity and size, never by a
  line number alone: a file is owed again from its start whenever its
  identity changed (a replacement, a cursor reset) or it is shorter than
  when it was cleared, and an appended file from the line clearing reached.
  Every pull clears whatever it owes, however little it read, and records a
  file only once its clearing succeeded; a pull that owes nothing reads no
  spool file. The whole-spool pass still runs when the set of Secrets
  changed. A seeded test runs appends, prunes, replacements (same and other
  length, inodes reused), failed cleanups and cursor resets, and checks that
  no known Secret survives a pull that succeeded and that no reaction from a
  file that is gone is emitted (`test/whatsapp-spool-bookkeeping.test.ts`).
- **Counted bridge drops.** The bridge writes `spool/capture-status.json`
  every minute and on connect and disconnect: connected, the last time it
  knew it was connected, and the messages a full queue dropped, carried
  across restarts. The pull reports the count (`capture_dropped_messages`)
  and warns while the last drop is within the stale threshold.
- **Captions.** The bridge keeps the caption of a photo, video, video note
  or document as the line's text, and spools a document sent with a caption
  (before, it was taken for protocol noise and not spooled at all). The
  connector reads a captioned media line as a text item with its media type
  kept; Secrets are judged and cleared on the caption like any text.
- **Freshness told apart from quiet, and from stopped.** `captureLiveness`
  in `connector-store/capture-freshness.ts` ages a feed by the newer of its
  newest message and the bridge's last connected time, and reports
  `capture_quiet` when the bridge is connected and no message arrived within
  the threshold. A bridge that says it is disconnected for more than ten
  minutes is stale and stopped (`capture_stopped`, warning
  `whatsapp_capture_disconnected`), never quiet; the stale route on the card
  is to open WhatsApp on this computer and link it. A bridge that writes no
  receipt is judged by its newest message, as before. The Telegram lane
  adopts the same rule.
  Open: the dashboard's stale wording says "newest message" for an age that
  can now be the bridge's last connected time.

## Built, step 5: WhatsApp

The WhatsApp chat export is an input of the WhatsApp connector
(`src/workers/whatsapp/archive-input.ts`, `export-match.ts`, `export-zone.ts`,
`archive-target.ts`; the record builder in `live-connector.ts`; tests in
`test/whatsapp-export-input.test.ts`, `test/archive-input-media.test.ts`).

- **One builder.** The export reader (`archive-import/whatsapp`) reads the
  export with its bounds, resume points and findings; the input turns each
  message into the bridge's record, and the WhatsApp connector builds it
  with the same code as a live message, under the intake rule, held until
  judged, into the account's stores.
- **Matching** (`match-keys.ts`). A message's key is its chat, its minute
  (its second when the export shows seconds), its sender and its text
  without media markers; keys are digests. The sender is "me" for the
  owner; otherwise the contact's saved name, which the bridge now spools
  (`sender_contact_name`), else the push name. Occurrences are counted on
  the key itself in the export's order (two photos in one minute are two),
  the count carried in the resume point across a page that ends inside a
  minute. The live side is the spool index's digests of each live
  message's current version (`live_keys`, built as the spool is indexed,
  within a read budget; no rescan of the spool, no text). The export's k-th
  message with a key is the k-th live message with it, so intake keeps one
  item. An unmatched message with a live message of the chat within a
  minute is counted as a near-miss (`match_near_miss`, How it was read).
- **Both directions** (`match-ledger.ts`, `export-matches.sqlite` in the
  spool folder, durable, digests and ids only). An export message live does
  not hold gets an id of its own, recorded by its key and occurrence: a
  re-import reuses it. When the bridge delivers that message later (it was
  offline), indexing it finds the recorded id under the same key and
  occurrence and aliases the live message to it: live capture stores it as
  the imported item, never a second copy, and reads, reactions and Secrets
  clearing follow the alias. (Rows are never re-keyed, as section 7 says;
  the live message takes the item's id instead.)
- **The owner.** The export shows the owner's own name. The name under which
  the sample's messages match live capture's own messages most is taken as
  the owner's.
- **Time zone.** Chosen on the first pass from the export's messages in the
  window live capture covers (its first and last message, a day either
  side; up to 2,000 messages within 256 MiB of the export): this computer's
  zone first, then every zone whose offsets on the sample's days differ,
  keeping the one under which most keys match; converted with each line's
  own date. No overlap or no match: this computer's zone, reported as
  assumed (How it was read).
- **Chats.** An export's chat joins the live chat of the same name when
  exactly one has it; the status chat (`status@broadcast`) joins the status
  posts. Otherwise it is a conversation of its own in the WhatsApp source.
  The decision is kept in the input's resume point, so a chat never splits
  across passes. Open: the "join to a chat" control on the import record is
  not built.
- **Status posts** are a record kind (`recordKind: 'status'`, conversation
  "Status updates"), live and imported; live capture no longer skips them.
- **Notices** from WhatsApp itself stay left out (owner).
- **Media** become children (section 5), keyed `media` as live capture keys
  its own, so a picture both inputs bring is one child; a child that can be
  read brings content, so a later export (or live capture) with the bytes
  fills one an earlier export left out. Reading them is the shared reader
  of an input's media (`archive-import/input-media.ts`: a folder binding or a
  zip member by its place, served only while the import is an input of a
  source and not being removed); wiring it into WhatsApp's extraction is
  step 8's.
- **Account.** An export names no account: it joins the source's account at
  the owner's confirmation in the import sheet, or creates it, or stays
  under Archives by the owner's choice. WhatsApp has no exclusive runner:
  the scheduler key keeps an import from running beside a live pull.
- **Release check.** `ARCHIVE_FORMATS.whatsapp_chat` has an import beside a
  seeded live input (`archive-live-seed-whatsapp.ts`): the account question
  is answered Add, and the Archives case answers Keep apart.

## To verify before step 4

- Telegram Desktop writes bare chat ids, with the type telling the marked
  form. **Checked 2026-10-25** against the owner's full-account JSON export
  (133 chats and 85 left chats, about 449,000 messages). A script read field
  names and the form of ids only, never names or text.
  - Chat ids are bare positive integers, and the type gives the marked form:
    `private_group` takes `-id` and `private_supergroup` takes `-100id`. The
    export held only groups and supergroups, so direct chats, bots and
    channels are still unchecked.
  - Senders are `user<id>` or `channel<id>`. Edits carry `edited_unixtime`;
    reactions carry `reactions`.
  - **History from before a group became a supergroup** is listed under the
    supergroup with negative message ids: 475 messages in 18 supergroups, all
    but one dated before the migration. Live capture would see these under
    the old group's id, with positive ids, so they cannot match exactly.
    Step 4 imports them as items of their own under the supergroup. A
    duplicate is possible only if live capture also read the old group, and
    it reads the newest 150 messages of a chat.
  - **Left chats repeat some messages byte for byte** (5 chats, about 2,000
    messages). They are imported once, by id.
  - **The export can carry no account information.** This one has no
    `personal_information`, so it gives no account hash. It joins the account
    at the owner's confirmation, like a single-chat export (section 7).
- Takeout's mbox separator line carries the Gmail message id in decimal (the
  API id is its hex). If not, mail matches by its headers only.
- The WhatsApp export's chat names equal the bridge's contact names for
  direct chats. Check with the owner canary.

## Review

Independent critical review, two rounds on 2026-10-25, no P0 in either.

- **Round 1** (first draft, archives as second connectors writing into live
  stores): nine P1/P2 issues. Answered by one writer per source (section
  1), choosing the version before judging (section 2), the hold on the item
  (section 3), no re-keying (section 7), WhatsApp media in live's form
  (section 5) and counts per input and per dataset (section 8).
- **Round 2** (one writer, inputs, removal by input): five P1s.
  - No commit protocol for the input table, removal re-selecting a version
    from a surviving input, and Gmail live ownership of skipped mail: all
    came from removing one import after it merged. The owner chose to
    delete merged history only with the account (section 6), so the input
    table, per-input removal and the cascade dependency are gone, and the
    intake keeps no state of its own (section 2).
  - WhatsApp capture periods cannot partition history: replaced by counted
    keys, with zones by date (section 4).
  - Intake regression and lost media: a version order across inputs and
    same-version content fill (section 2).
  - P2s: the hold's persistence is stated (section 3); the Gmail rule no
    longer claims uniqueness (section 4); the comparison table's wording
    was corrected.
- Review-bot comments on the PR (WhatsApp capture gaps, daylight saving,
  re-selection on removal) are answered by the same changes.

## Open questions

None for the owner. Defaults chosen: a WhatsApp or single-chat Telegram
export joins the source's account at the owner's confirmation; pairing a
different Telegram account than the imported history is refused until that
history is deleted; another account's archive stays under Archives.
