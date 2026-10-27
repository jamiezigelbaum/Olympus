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

Mail that matches no Gmail account, and an archive of a different account
than the connected one, stay under Archives as today (`archive.imports`, one
account scope per import), with their Remove; the dashboard shows them under
Other archives. A source with no live connector (Reflect, Roam, Evernote) is a
source of its own on the dashboard, with its own card listing its imports
(step 7), and its imports are stored the same way, under `archive.imports`
with their Remove, as [source storage](source-storage.md) keeps archive-only
formats.

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
- **Gmail:** exact where the export carries the Gmail id (Takeout does, on
  every message: "Built, step 6"). Otherwise a message is the Gmail message
  whose `Message-ID`, `Date`, `From` and `Subject` all agree, and its own
  item when none or several do. Two mails that agree on all four (a list
  resend) are taken as one, a residual this rule accepts. Live Gmail adds
  `Message-ID` to the headers it requests. A message without the id is
  looked up in Gmail itself (`rfc822msgid:`, then the four headers of each
  candidate), under the provider budget and the current mail approval. This
  replaces the background pass the first draft had, which would have read
  every stored message's headers into a local index (step 6 explains why).
- **WhatsApp:** an export has no message ids, so nothing can make it
  certain; this is the closest the data allows. A message's key is its chat,
  its minute, its sender and its text (caption included). The sender is
  "me" for the owner's own messages, and otherwise the contact's saved name
  from the bridge's contact store, which is what the export shows, falling
  back to the push name. Matching is strict, and done on the import side
  only, against the live messages already stored: an export message is one
  of them only when its minute is certain (read whole, at most 200
  messages), exactly one export message in it holds its key, and exactly
  one live message ever held it, in any version, as its current one, by a
  live index caught up to the spool's end. Media without words is never
  matched. Anything else is its own item, with an id from what it is (its
  content and the names of the files it carries, never its place in the
  export): when in doubt, a visible duplicate, never a wrong merge. A
  live message always keeps its own id, so one the bridge delivers after an
  export already brought it is a second item. That is an accepted residual:
  exports are mostly past history, and a stored id never changes.
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
  account needs that label among the account's labels (or none: an account
  known by immutable labels only) and the owner's confirmation. An account
  that carries another address is a different account. With no connected account, the account is created with the
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
| Item text | service messages as items, sender names, forward names, captions | archive (Telegram), new (WhatsApp) | live Telegram's search context left out the chat and sender names the helper records (its explicit search text was the words alone), wrote a service message as an empty item and a forward as a bare flag; the WhatsApp bridge drops captions. Neither Telegram input has a reply's sender name: the export gives only the replied-to message id, as live does (corrected 2026-10-25; this row said "reply names") |
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

Per-card Import (owner, 2026-10-25): built, see "Built, per-card Import".
Each source's Import an archive appears as its step registers it.

1. Child items spine (2.1.0, merged).
2. One-pipeline spine (2.2.0, built, awaiting critical review): connector
   inputs and their cursors, the intake lookup and rule, the hold on the item,
   the import record inside a source card with its counts; proved with a
   fixture source that has a live and an archive input (see "Built, step 2").
3. Live capture fixes from "Best of both", each with its own tests:
   streaming spool reads with bounds, cursor recovery, counted bridge
   drops, WhatsApp captions, freshness told apart from quiet. WhatsApp part
   built (see "Built, step 3: WhatsApp").

   drops, WhatsApp captions, freshness told apart from quiet. Telegram's
   part built (see "Built, step 3: Telegram"); WhatsApp's in its own lane.
4. Telegram: the export becomes an input of the Telegram connector (exact
   ids, account hash), with folder media as children; reusable builder and
   new record kinds. After storage's account-identity step. Built (see
   "Built, step 4: Telegram"); reading the children's bytes waits for the
   shared archive-input media reader and the Telegram extraction roster.
5. WhatsApp: the export becomes an input (counted keys, zone alignment,
   chat joining); the bridge's records carry the contact's saved name.
   Built (see "Built, step 5: WhatsApp").

6. Mail: live Gmail requests `Message-ID`, and gains attachments as children;
   mbox of a Gmail account becomes a Gmail input (built, PR #546, see "Built,
   step 6"; attachments are children, read by one extraction lane, in the PR
   stacked on #546).
7. Reflect, Roam, Evernote: their own sources, assets as children.

6. Mail: live Gmail requests `Message-ID`, with the background pass, and
   gains attachments as children; mbox of a Gmail account becomes a Gmail
   input. After storage's account-identity step.
7. Reflect, Roam, Evernote: their own sources, assets as children (built,
   see "Built, step 7").
8. Live Telegram media and live WhatsApp images and video, so both
   inputs bring the same media. WhatsApp part built (see "Built, step 8:
   WhatsApp").

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
  version are each judged.
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
  applies that record at the item's version; the owed body stays owed through
  names-only records of any version until a body or a deletion resolves it.
  Residuals: an owed `content` or `names` write waits for its own record; a newer
  names-only record holds behind an earlier run's owed write until that write is
  finished.
- **Pending states hold the boundary (2026-10-26).** The lookup reads the
  persisted intent before any row, and no row is never read as absent: a pending
  Secret or deletion is the item's state (tombstoned, at its version) even when
  no store holds a row yet, and a pending body or names write is the item at
  its version, incomplete, with the version of the record whose body is owed,
  so an older record never replaces it and the owed write is replayed. A deletion of an item no store ever held is
  recorded as a tombstone row in the Private store (with a `deletion` intent
  that carries the item's family, so a cut-off write is finished from the intent
  alone), which also refuses older versions afterwards; rows that are all
  tombstones the ledger marks as such an unseen deletion are not a lane's item,
  so a newer record routes it afresh; a tombstone a lane left keeps the lane's
  placement. A
  parent's deletion tombstones each leg's child at that leg's own version
  (a cascade is not an event of the child), under a versionless `deletion`
  intent written per child before its removal and cleared when it is whole,
  so a failed removal is finished at the next pass start and hides the child
  meanwhile, whatever becomes of the parent. A record whose body is empty
  (text that is blank: authoritative for a connector that sent it, unlike a
  record with no body at all) replaces the stored text in every leg before the
  version moves, under a `content` intent so a cut is repeated by its replay.
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
  cursor (read again from the old cursor, the rows already there), and the
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
  (`sender_contact_name`), else the push name. Doubt is per minute: a
  minute is certain only when it was read whole (the count carries in the
  resume point across a page that ends inside it, and its rest is read
  ahead within a byte bound) and holds at most 200 messages; otherwise
  nothing in it is matched. The resume point holds the current minute
  only, within that cap. The
  live side is the spool index's digests (`live_keys` for each message's
  current version, `live_version_keys` for every key any version had;
  built as the spool is indexed, within a read budget; no rescan, no
  text). A message is the stored live one only when one export message and
  one live message hold the key, and it is that message's current key;
  media without words never. Otherwise it is its own item, with an id from
  its chat, minute, sender, whole text with its file names (WhatsApp names
  each file apart) and its number among exactly identical messages, so a
  re-import, or a fuller or shorter export, gives it the same id. A media
  file one export left out is never guessed to be one a later export has.
  The import matches only against a live index caught up to the spool's
  end: a pass that finds it still catching up decides nothing and waits
  for the next. An unmatched message
  with a live message of the chat within a minute is counted as a
  near-miss (`match_near_miss`, How it was read).
- **One direction.** Matching is the import's alone: live capture never
  claims an imported item, and a live message keeps its own id always. A
  message the bridge delivers after an import brought it is a second item,
  a visible duplicate (section 4).
- **The owner.** The export shows the owner's own name. The name under which
  the sample's messages match live capture's own messages most is taken as
  the owner's.
- **Time zone.** Chosen on the first pass from the export's messages in the
  window live capture covers (its first and last message, a day either
  side; up to 50,000 messages within 1 GiB of the export): this computer's
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
  read brings content, so a later record of the same message with the bytes
  fills one that could not be read. A file one export left out is never
  guessed to be one a later export has (they are different messages by
  content). Reading them is the shared reader of an input's media
  (`archive-import/input-media.ts`: a folder binding or a zip member by its
  place, served only while the import is an input of a source and not being
  removed), wired into WhatsApp's extraction in step 8.
- **Account.** An export names no account: it joins the source's account at
  the owner's confirmation in the import sheet, or creates it, or stays
  under Archives by the owner's choice. WhatsApp has no exclusive runner:
  the scheduler key keeps an import from running beside a live pull.
- **Release check.** `ARCHIVE_FORMATS.whatsapp_chat` has an import beside a
  seeded live input (`archive-live-seed-whatsapp.ts`): the account question
  is answered Add, and the Archives case answers Keep apart. WhatsApp chats
  rest Private by the source's own rule (no automatic signal lowers it), so
  the beside case expects the imported word in the Private store only and
  no search answer carrying it through the drain bound (`search:
  'withheld'`), where Telegram's, judged like its own, is cited.

## Built, step 8: WhatsApp

Live WhatsApp pictures and videos are children of their message, as an
export's media are (section 5).

- **The bridge saves them all** (`tools/whatsapp-bridge`; owner's ruling,
  2026-10-26: every message and every piece of media is ingested): pictures
  in `media/images` and videos and video notes in `media/video` of its state
  folder, beside the voice notes, with no size bound, no quota and no
  eviction. A download streams into a temp (`DownloadMediaWithPathToFile`,
  never whatsmeow's `Download`, which reads it all into memory). The one
  safeguard is the computer's own: a free-space floor on the volume, the
  larger of 5 GB and 5% of it (`media_waiting.go`). Below it no download
  starts, and one running stops (the temp writer checks as it writes); the
  message is still spooled, its media `waiting_for_disk`, with what a later
  download needs on the line (where the media is, its keys and hashes, its
  type and size). That line is the only record: the bridge keeps no list of
  waiting media. The owner decided that Olympus fetches it (2026-10-26):
  "Olympus asks the bridge for the exact message version, receives the
  bytes into its own folder, re-checks the judgment before indexing, and
  keys everything by version". See Secrets below. The bridge answers that
  one local call (`media_serve.go`): an owner-only Unix socket named in
  `media-download.json` in its state folder, which does nothing but
  download. It decrypts into an unnamed temp, so it writes no file and
  keeps no state; below the floor it answers a passing failure. While media
  waits below the floor, the capture status says so (no count), as does
  Olympus's own pass, and the card shows "media waiting for disk space"
  with what to do. Every temp has one name,
  `.olympus-media-<pid>-<boot>-<stem>-*.tmp` (boot: this boot's nonce, since
  a pid is unique only within a boot): removed on every failure, and swept
  at start and before Secrets clearing when its writer is gone (pid dead, or
  of another boot). A live writer's temp is never swept, however long its
  download stalls; only an older build's temp is judged by age (30
  minutes). Olympus finds temps in every media folder, the kind folders
  inside a folder account's media root included, through one walk shared by
  the sweep and a message's cleanup (`media_files.go`, `live-connector.ts`).
- **The connector lists them** (`live-connector.ts`, `childrenOf`): a
  picture, video or video note line is its message (its caption, or its
  names alone) with the file as a child keyed `media`, located by
  `whatsapp-media-file:v1:<path>`. The saved file is the child's to read,
  never the message's metadata. A file the bridge could not save is a child
  that cannot be read, so a later line with the bytes fills it. Voice notes
  keep their one row and transcript. Every media child, live or imported,
  is held Private until its own judgment (`holdContentUntilJudged`,
  child-items.md "WhatsApp media").
- **One child reader** (`child-media.ts`): a saved file is read only when
  it really lives under one of the account's media folders (a spool line is
  data and must never name another file): opened once without following a
  link at the end, proved to be that file (device and inode), and read from
  that descriptor only, never past what the file held when it was checked
  or the caller's own bound (there is no content cap). An export's file is read only
  while its import serves it. The connector's `fetchItem`, the live pull and the
  extraction source (`extraction-factory.ts`, built by the runtime and, with
  the archive imports, by the engine) read children through it, by the
  locator the store keeps at the child's version. Extraction lists them
  across the lane's tier stores (WhatsApp is in the engine's extraction tier
  sets), so a child routed out of the Private store is still read and
  judged.
- **Media folders** (`defaultWhatsAppMediaRoots`): the account's media
  folder (or, in the older layout, the audio folder) and the bridge's
  picture and video folders beside it.
- **Secrets.** Saved media follows the judgment of what it is part of.
  Media that waited for disk space is fetched by Olympus alone
  (`media-fetch.ts`).
  - **Recording.** The listing tells Olympus of each waiting line as it
    reads it, before the pull commits past it. Olympus keeps it as a row
    keyed by the message and its version digest, with the line's place in
    the spool (`media-fetch.sqlite`, beside the spool index).
  - **Each message, in the pull after the clearing:**
    1. The message is stored at the row's version. Neither it nor its
       media child is Secret there: each is stored at that version, not
       hidden, and not judged Secret since. The names of both are settled,
       and the disk has room. An uncaptioned picture qualifies.
    2. Olympus asks the bridge for that version's media and receives the
       bytes into `<stem>~<version digest><ext>.part` in its own folder
       (`media/olympus`), fsynced.
    3. It checks step 1 again. On a Secret or another version the part is
       deleted; otherwise it is renamed and the folder fsynced.
    4. The file is read into the stored item through the connector's own
       record builder (`mediaFill`), from the version's own spool line. That
       fills the picture's or video's child, or the voice note itself, and
       nothing else: no caption goes out this way. Extraction and judgment
       follow as for any media.

    Each fill is fenced, one item at a time, under the ledger's write hold
    (`TierLedger.holdingWrites`): step 1 is checked, the fill alone is synced
    (no embedding and no other settlement; writes a cut-off pass owes and
    the orphaned-children sweep run before the hold), and step 1 is checked
    again. A decision another process makes waits for
    the hold. One this process makes meanwhile is seen by the last check,
    which takes the fill back at once. A row is done only once the stores
    are seen to hold the file at that version, so a fill a sync did not land
    is filled again. A line read again (a replay, or a recovered spool)
    gives the row its new place; a done version asks nothing again. The
    bridge sends a bare newline while a download runs: Olympus gives up
    only on a call that stalls, and never on one for its length.
  - **Take-back, every pass.** A row whose message is now Secret (the
    message or its media) is taken back, done rows included. The row is
    marked first, so a take-back of that version is owed until it is
    confirmed. The picture's or video's child at that version is made
    Secret through the one Secrets path (`settleRoutedSecrets`, or
    `settleLegacySecrets` for a row the set never routed), whether or not the
    file is still there. Its copies, chunks and embeddings go, and the side
    stores forget it. Only once the child is confirmed Secret, with no active
    copy of that version anywhere, is its file deleted and the folder
    fsynced; the row is forgotten last.

    A take-back cut off anywhere is taken up again by the next pass, but only
    for that version and only while a Secret still covers it. A Secret
    cleared meanwhile drops the obligation with nothing settled or deleted. A
    newer version stored meanwhile is never touched; only the old version's
    file goes. A legacy settlement cut off after its tombstones resumes from
    the Secret location it recorded first. Without a location index, the
    decision is written before any tombstone, so leftover copies are
    finished on retry.

    A row stored at another version, or whose message is gone, loses its
    file and is forgotten. A file no row names is deleted. The clearing
    deletes a fetched copy whose media is judged Secret too, and every
    Secret deletion fsyncs its folder. Fetched media is stricter than saved
    media: a Secret caption keeps a live-saved picture but takes a fetched
    one back.
- **Reading large media.** Keeping every file does not mean reading every
  file into memory: the extraction source hands a file reader the media as
  a file (`fetchFile`), copied a chunk at a time from the descriptor the
  confinement check opened. A
  picture or video is judged as its own child (`<id>#child:media`): when it
  is Secrets, its file, every temp of it (by the message's file stem), its
  path and its re-download keys go, whatever the caption's judgment; a
  Secret caption alone leaves the picture. A file or temp that cannot be
  removed (anything but its being gone already) fails that line's clearing:
  the keys stay, the pull reports the failure, and the next pull tries
  again. A voice note or document is the
  message, so its media goes with the message's judgment. A file is deleted
  only under the media folders and only when no other message names it.
- **Residual (owner's ruling, post-launch).** A captionless picture both
  live capture and an export bring stays two children, even with identical
  bytes: a duplicate, never a wrong merge (the strict-match rule of step
  5). Matching such media by file digest is a follow-up.

## Built, step 3: Telegram

Live Telegram capture, with no change to what it stores for an ordinary
message beyond its search context (`src/workers/telegram-messages/`,
`scripts/telegram-telethon-reader.py`; tests
`test/telegram-live-capture-fixes.test.ts`,
`test/telegram-telethon-richer-records.test.ts`).

- **Reading.** The spool is read a line at a time in 1 MB chunks
  (`spool-lines.ts`). One read stops after 64 MB or 200,000 lines and hands
  back where it stopped, so a backlog of any size is read in passes; the
  768 MB failure is gone. A record over 32 MB is counted as damaged and
  passed without being held. Cursors keep their `<file>:<lines>` shape (the
  Secrets rewrite relies on it); because the helper only appends and the
  rewrite keeps every record's byte length, the byte offset of a line once
  found is remembered in the process and checked (same file, a newline just
  before it), so a page no longer re-scans its file from the top. The
  freshness check reads only a file's last 16 MB. The helper's report now
  counts and dates the spool in chunks and passes a damaged line, where it
  used to load every record each cycle and stop on the first bad one.
- **Cursor recovery.** A lane cursor whose file is gone while older files
  remain, or whose file holds fewer lines than it says, no longer stops the
  lane for good: that lane reads the spool again from its start (writes are
  idempotent; skipping could lose history), and the receipt says so
  (`telegram_spool_cursor_reset`, `spool_cursor_resets`). Reading again never
  puts back an older version: both lanes now read the spool as the live
  input of the Telegram connector, through the one record builder
  (`record-builder.ts`) and the intake rule, so a record older than what the
  stores hold is not applied (review, #545). A live version is the
  helper's (edit time, reactions) plus the capture's order: when the helper
  captured it, the helper's capture sequence (a counter kept beside the
  spool, `.capture-seq`, that only grows; records written before it read as
  0), and its place in the spool as the last tie-break. Two captures at the
  same edit time are ordered, also across a day file removed and written
  again, and a capture read again after a reset never puts back an older
  count; an export's version has no capture mark, so ties go to live.
- **Protected claims.** A protected lane's claim applies to the message,
  whatever the version (`protection-claims.ts`). Before either lane writes,
  each claimed message the ordinary lane still serves moves into the
  protected lane with one tier move (the lower copy superseded first, so
  every read hides it, its content copied up, purged only once the protected
  copy is verified; a pre-tier row has its placement adopted first). When the
  spool holds a newer version, that version is then listed in the protected
  lane and replaces the moved copy. Nothing is deleted on the way, and a
  move a crash left unfinished is finished by the next pull. The claim is
  then kept in the set's ledger, so a later ordinary record is never
  admitted to the ordinary lane. Any step that fails stops the pull before
  either cursor passes the claim. The protected lane judges a claimed record
  against what it alone holds, so a claimed record newer than its own copy
  always lands there. (The spine's persisted write intent, #540, will take
  this move over; it already goes through the tiered set's move API.)
- **A cursor knows its file.** Each lane cursor is bound to the identity its
  day file had (`connector-store/spool-file-identity.ts`, shared with
  WhatsApp: device, inode, birth time and a digest of the first line, kept
  in the set's ledger); a file removed and written again under the same name
  is read from its start. The helper's capture-sequence counter is replaced
  whole (a temporary file, synced, renamed, the folder synced) under a lock
  file of its own, so a kill at any step leaves the old value or the new one.
- **The spool contract** (shared with WhatsApp, `spool-file-identity.ts`).
  Only the capture helper writes the spool, and only by appending; only
  Olympus's own Secrets clearing rewrites records, in place and at their
  length, and it records its boundaries again after it runs. The spool folder
  is owner-only (0700, files 0600). Every boundary Telegram records (each
  lane's cursor, where the clearing has reached) keeps the file's identity
  and a digest of the 4 KiB that end at it, checked before the boundary is
  used. A boundary is trusted only on a receipt for exactly its position: a
  missing receipt, or one for another position (a crash between a cursor's
  commit and its receipt, or the first pull after this change), counts as a
  mismatch, which costs one read of the file again. Detected: a file removed and written again, and any change within
  the 4 KiB before a boundary (a record rewritten under a cursor, longer or
  as another lane's). On a mismatch every boundary in that file is dropped:
  its lanes read it again from its start under the intake rule, and the
  clearing is owed again from the start of the spool, recorded only as far as
  it then runs. Not detected: an in-place rewrite by anything else further
  back than 4 KiB before every boundary; that breaks the contract and cannot
  be seen within the read bounds (scoped out by the coordinator, 2026-10-26).
- **Quiet is not stale.** After every finished cycle (it read every approved
  chat) the helper writes `.capture-heartbeat.json` beside the spool. The
  receipt's age is from the newer of the newest record and the heartbeat,
  so a quiet account with a running helper reads fresh and only a stopped
  capture reads stale; `capture_quiet` says when only the heartbeat is
  fresh. Same rule as WhatsApp's lane, which adds it to the shared
  `capture-freshness.ts`; Telegram moves onto that once both have landed.
- **Richer text.** One builder (`telegramMessageItem`) turns a spool
  message into its item, ready for the archive input. A service message's
  event is recorded by the helper under the export's own action names and
  becomes the export reader's sentence ("Ada made a phone call that lasted 1
  minute 5 seconds."), where it used to be an empty item. A forward records
  who it came from when Telethon already holds it (no extra request). The
  search context adds the chat, the sender and the forward's origin to the
  words and attachment names. A Secrets rewrite of a spool record now also
  takes the forward's origin and the per-sender names with the names, and a
  service event's words (a title, an amount) with the text. Every name the
  search context adds beyond the chat and the sender (the forward's origin,
  attachment names) is passed to the classifier as the item's names, so a
  Secret in one of them makes the names Secrets (review, #545). The Secrets
  rewrite itself reads a spool file in 1 MB chunks, holding one record at a
  time, instead of the whole file.
- **Cost.** An existing item is rewritten only when it is read again, and
  its new search context then re-embeds it once.

## Built, step 4: Telegram

A Telegram Desktop JSON export of the paired account is an input of the
Telegram connector (`src/workers/telegram-messages/`: `export-records.ts`,
`export-input.ts`, `archive-target.ts`, `record-builder.ts`; tests
`test/telegram-export-input.test.ts` with the real-source harness
`test/support/telegram-one-dataset-harness.ts`).

- **One builder, one intake.** The live spool and the export both yield
  the spool's own record shape, and one builder turns each into its items.
  The live lanes and the export run through the intake rule against the
  set's stored versions, so neither input ever replaces a newer version:
  Telegram's version order is the edit (else sent) time; versions of the
  same time are a tie, whatever reactions each saw, and on a tie live's
  copy is kept.
- **Exact keys.** A message is keyed by Telethon's marked chat id (a user
  or bot as is, a basic group `-id`, a supergroup or channel `-100id`, from
  the export's chat type; checked against the helper, which keys a chat by
  Telethon's `dialog.id`) and the message id. The marked ids are computed
  by number (`peer-id.ts`, `-(1000000000000 + id)` for a channel, as
  Telethon's `get_peer_id`), never by joining text (review, #553). A chat type this does not know
  is kept apart (`export:<type>:<id>`) rather than risk joining the wrong
  live chat. Senders take the same form (`user<id>`, `channel<id>`).
  History from before a supergroup migration (negative ids) is its own
  items under the supergroup. A left chat that repeats messages is read
  once (the intake sees the same version and keeps the first).
- **Record kinds.** Service messages are their event by the export's names
  (the builder writes the sentence live capture writes); contacts,
  sessions, the profile and the other parts of an account export are
  records of their own kinds, one per entry, in a conversation per part
  (`account:contacts`, ...), keyed by what says who the entry is (a
  contact's user id, else its phone and name; a session's device, app and
  start). A contact is its user id, else its number (digits only), else its
  names and the date it was added; contacts of one export that still share
  that key are told apart by their place among them, never merged by name.
  Without a user id, a contact whose number changed between two exports is
  two rows: a visible duplicate, accepted over a wrong merge. An entry's
  version is the export's content time, the newest `*_unixtime` the export
  holds (`export-facts.ts`; never a file's modification time, which copying
  or restoring changes), so a later export's snapshot replaces an earlier one
  and an older export never does; two snapshots at the same content time, or
  one with no time at all, are a tie, and a tie keeps what is stored. A message with nothing to read (empty, or
  a kind this reader cannot read) is still an item, by its names, and is
  counted (review, #553).
- **Account.** The export's `personal_information.user_id`, hashed as
  pairing hashes it (`telegram:` + `sha256(id)[:16]`), is the account's
  hash. An export without a profile (a single chat, or an account export
  made without it, as the owner's was) asks the owner. Another account's
  export stays under Archives. Telegram has no account guard, so its imports
  run without the exclusive runner, under the Telegram pull's own scheduler
  key.
- **Media.** A photo or file a message names in the export's folder is a
  child of the message (`<message>#child:media`, one per message, the key
  live capture computes too), listed by
  name with a media binding and a locator in the shared
  `archive-input-media:v1:<archive>:b:<binding>` shape; a file the export
  left out (or one beside a single chosen `result.json`) is a child that
  is named and not readable. A readable child brings its content, so a
  later export with the file present makes a named-only child readable. The bytes are read once the shared reader for
  archive-input media lands (WhatsApp lane) and Telegram has an extraction
  roster for its stores.
- **The trust lanes.** The secure lane's claim on an item is now a row it
  wrote itself (or a pre-tier row), not any row in the Private store: an
  item the set placed there (held, or judged Private) keeps taking its live
  edits through the internal lane, and the set places each version by its
  own tiers. Before, such an item's later live edits were dropped.
- **Production.** The worker registers the target when the Telegram store
  lane is up; without it an export stays under Archives, as before.

## Built, step 6

Mail (PR #546). An mbox export of a Gmail account is an input of the Gmail
connector; any other mbox stays under Archives, as before.

- **One record.** Both inputs yield the Gmail connector's own record, a
  parsed mail (`google-connectors/gmail-mail-record.ts`), and one builder
  makes the items. Live converts an API message
  (`gmailMailRecordFromMessage`); the mbox input converts each message
  (`archive-import/mbox/gmail-input.ts`). Mail does not change, so every
  version of a message is the same: the intake rule keeps what is stored,
  fills in the text of mail live holds by name only, and keeps live's copy
  on a tie.
- **Ids.** Takeout's `From <decimal>@xxx` is Gmail's id in decimal and
  `X-GM-THRID` the thread's; both become the API's hex form, so an imported
  message names the live item. Labels Takeout names are given as live
  Gmail's ids (`Inbox` is `INBOX`; `Opened` and `Archived` are absences);
  user labels are resolved to the account's label ids through Gmail's label
  list and kept by id and by name, so an owner rule on either applies. When a
  rule names a label and the list cannot be read, the import waits rather
  than store mail the rule could miss.
- **Header matching** (`google-connectors/gmail-header-match.ts`) for a
  message without Takeout's id. The first draft had a background pass read
  every stored message's `Message-ID` into a local index. Gmail already
  indexes `Message-ID` for every message, so the input asks it directly:
  one search, and one metadata read per candidate (at most five), only for
  such messages, under the day budget and only while the mail approval is
  current. A Takeout import costs no request; no new store is kept.
- **One budget model** (`google-connectors/gmail-import-allowance.ts`).
  Imports read Gmail through their own client, whose day counter charges
  every HTTP attempt, retries included, to the imports' allowance and then to
  the lane's day counter, so nothing goes around it. The allowance is half of
  the day's budget. The client retries a failed request once, so one message
  costs at most 14 attempts (the mailbox check, the search, five candidates)
  and the label list 2; the smallest accepted budget (32) holds both, so any
  accepted budget moves at least one message a day. A message, or the label
  list, is begun only when the allowance holds its worst case, and a refusal
  spends nothing. The label list is asked only when an owner rule names a
  label, and once a day while the rules stay the same.
- **Waiting is findable.** Waiting, what was read goes out with its resume
  point and the import waits for its next scheduled pass. The import record
  keeps why (`waiting`), its row says it in a plain line (the day's share is
  spent; the day's requests are spent; a rule names a label Gmail cannot
  read now; or the daily limit is too low, with the setting
  `OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET` and the least it must
  be), and a limit too low is a Needs you item too. The pass's receipt names
  the reason (`archive_import_waiting_for_provider: …`). The note goes with
  the next pass that does not wait.
- **Account** (`archive-import/mbox/gmail-account.ts`). Headers of the first
  500 messages (or 64 MB) are read: every one must carry a Gmail marker, and
  the topmost `Delivered-To` of the received ones must name exactly one
  address. An address is something the export's author wrote, and an
  address can change hands, so `resolveImportAccount` never takes it as
  proof: it joins only an entry that carries that address (or no address),
  at the owner's yes; an entry with another address is another account.
  With no Gmail account yet, the import makes it, named by the address
  label, and a later connect of that address joins it. The first messages
  decide the account, so every message is checked again as it is read: one
  whose topmost `Delivered-To` names another address is counted ("delivered
  to another address left out") and never written. The look stops at its
  byte bound inside the splitter, an oversized message included.
- **Lane.** The worker registers the target when the Gmail lane's stores
  exist. Imports write the Gmail stores and ledger with the live lane's own
  sync options and the owner's current rules, under Gmail's scheduler key
  and inside `runExclusiveForSource('gmail.email')`. The account scope is
  the connected handle's account role, else `personal`, unless the Gmail
  stores already hold Gmail rows under one other scope: then every reader and
  writer, live included, keeps that one (`gmailItemAccountScope`), so an
  import made before the connect and a connect under another role still name
  one item. The Private store's approved-scope filter (status counts, private
  embedding) accepts an observation by an import's input (`archive.<id>`)
  beside the live lane's scoped one: the owner approved each import.
- **Before Gmail is connected.** Importing Takeout first and connecting
  later is a normal first run. Live approval governs live reads, not the
  account's own stores: an import pass embeds what it writes, as a live pull
  does (under the live scope binding when there is an approval); with no live
  lane, a Gmail scheduler source with no sync of its own carries the
  embedding sweep and the private meaning backfill; and the Private store's
  counts and backfill accept what the imports brought (`archive.` observations
  alone) while live Gmail is not connected and approved. Live mail stored
  under an approval that no longer stands is neither counted nor embedded by
  that path.
- **What an import does not apply.** The owner's mail scope (skipped
  senders and categories, the one-time-code filter, the content window)
  governs what live reads; an import is its own approval, as it was under
  Archives. Spam and Trash are skipped, as before.
- **Children** (on, a PR stacked on #546). Every attachment part is a child
  item of its message, from both inputs, by one rule
  (`isGmailAttachmentPart` in `gmail-mail-record.ts`): a part with a file
  name, a forwarded message (`message/rfc822`), and any other non-text part
  (an inline picture, an invite), named by file name, else content id, else
  type and part; never a multipart, and never the message's own plain or
  HTML text. A forwarded message's own parts are children too (its parts
  under its path, `P.0`, `P.1`, …, on both inputs; how Gmail numbers inside a
  forward is not yet checked against a real mailbox), to a depth of 8, and
  its text is its own child's, never the message's body. Its id is
  `<message>#child:<part path>` (`core/child-item-id.ts`; the whole-message
  part is `root`), the part path both inputs compute alike for one message
  (Gmail's `partId`; the export's own MIME tree, `archive-import/mbox/mime-parts.ts`),
  never a file name. A child carries its name, type and size, the parent's
  sender and date, and its own tier judgment; it follows its parent's
  deletions (child visibility, as every child does). Every child is held
  until it is judged (`holdContentUntilJudged`), live and imported alike, so
  its text is never served before its own judgment. Live listing keeps a message and its attachments within
  the item budget, can resume inside one message's attachments, and resumes a
  cut-short page after the last message it handled, by id (`after`). A child
  listed with `deferredBytes` is always deferred to extraction, whatever the
  lane's sync option, and its tier set places its names now and its text when
  it lands (`gmailContentArrivesLater`).
- **Mail stored before children.** A one-time, resumable backfill
  (`backfillChildren` in `gmail-live-sync.ts`, the scheduler task
  `gmail.email_children_backfill_v1`) walks the stored messages of this
  account that hold content, name an attachment in their search text and
  have no child row, asks Gmail for each message once (at most 20 a pass,
  under the same day budget and approval check), and stores its children as
  the live lane does, under the current mail scope; bodies are not rewritten.
  A pass stopped by the budget or a changed approval keeps its place; once
  both stores hold no such message it is done for good. Imported messages
  (`mbox-` ids) are not backfilled: they were imported with children.
- **Reading attachments** (`google-connectors/gmail-attachment-extraction.ts`).
  One extraction roster entry over the Gmail stores (a corpus per legacy
  store, Private and Personal, the Private one listing the Public store too),
  with one reader for both locators. Each locator is bound to its child: it
  names the message and the part, and a read for any other child fails
  closed. `gmail-part1:<message>:<part>` reads through the Gmail lane's
  connector under the current mail scope. The approval is checked again
  before every HTTP attempt, a retry after a backoff included. The message
  is checked against the scope as it is now: fetched whole the first time,
  and by a fresh metadata read (labels and sender) before each later part of
  the same message. A parent now outside the scope is refused, and its child
  keeps its names only; one deleted in Gmail is not found. The part's
  declared size is checked before its bytes are asked for and its decoded
  size after (an understated part is too large), under the lane's day budget.
  `mbox-part1:<import>:<file>:<offset>:<digest>:<message>:<part>` reads from
  the import's own approved files (`archive-import/mbox/part-reader.ts`: the
  folder and every file the versions imported; the message at the offset
  must have the bytes the import recorded there, by the digest of their
  SHA-256, whatever form the parent's id takes, and be the named parent; the
  part bounded before it is decoded; only for an import joined to Gmail and
  not being removed). A forwarded message is read as its headers and text.
  Before a child's bytes are fetched, and again before its text is accepted,
  the child must still be there and its parent visible (child visibility);
  a queued read of a child whose parent was deleted meanwhile is closed and
  its text dropped. The product keeps one live reader per account and
  approval revision for up to five minutes, so a message's body is fetched
  once for all its parts. **Follow-up:** a child live listed first
  keeps only its live locator when an import later brings the same message
  (intake skips the same version), so once live Gmail is disconnected its
  bytes wait although the import holds them; a second locator per child, or
  an index from message to its place in the import, would let the import
  serve it. Only children are
  candidates. A readable attachment's text is read, held, judged and stored
  like any file's; one over the readers' limits keeps its names and is listed
  as a file Olympus could not read. The Gmail source (live, or the one with no
  sync of its own) runs the lanes.
- **Release check.** The import-beside-live case is
  `GMAIL_TAKEOUT_FIXTURES` in `scripts/release-check/archive-fixtures.ts`
  (`SOURCE_INPUT_FORMATS`), run through the product by
  `test/release-check-source-input-fixtures.test.ts`. It is not in
  `ARCHIVE_FORMATS`: the leg's archive path expects a row under Other
  archives and a Remove, which a merged import does not have, and a fresh
  machine has no live Gmail input. The leg's journey for it is still to
  build.

## Built, per-card Import (owner-approved 2026-10-25)

Which button to use is decided by where the export came from, and the page
says so.

- **A source's own card.** Every source whose connector reads its exports as
  inputs (a registered `ArchiveSourceTarget`) gets **Import an archive** in its
  ⋯ menu, before Disconnect and Delete. It opens the picker titled "Import an
  archive into Telegram", whose opening sentence names only that source's exports.
  The approval names the card (`source_id`), and the engine recognises only that
  source's formats (`prepareArchiveImport` with the target's formats). Any other
  export is refused in the picker: "This isn't a Telegram export. From the
  Telegram card, Olympus imports only these: … For any other export, use Import
  another archive under Other archives." A card gets the entry only once its
  source registers (steps 4 to 7), so no card offers an import that would land
  elsewhere. The computer lists the cards in `ComputerDashboardMeta.archiveSources`;
  while the list of imports cannot be read, no card offers it.
- **Other archives.** The Archives card is its own section below Sources,
  titled Other archives, with the line "For an export that isn't from one of
  your sources above." and the button **Import another archive**, always in
  sight (never in ⋯). It still sends an export to its source when one reads
  it (`forFormat`, as before), and lists only the archives that cannot join a
  source. Its picker says so: "An export from one of your sources joins that
  source; any other is kept under Other archives."
- **Where it shows.** A start says where the import is: "Importing result.json
  into Telegram. It shows in Telegram as it is read." or "… It shows under Other
  archives as it is read." (`started.source` on the approval).
- **ChatGPT.** The section is there too; its button opens the computer's
  dashboard. A card's own Import an archive is on the computer only (the picker
  is the computer's).

## Built, step 7

Reflect, Roam and Evernote are sources of their own on the dashboard, and an
Evernote export is a new format whose attachments are child items.

- **One card each.** A format no live connector reads names its import-only
  source in the format registry (`ArchiveFormatDefinition.sourceCard`):
  `reflect.archive` (Reflect's JSON and Markdown exports), `roam.archive` and
  `evernote.archive`, the ids their source postures already had. Each card sits
  in Sources with "Import an archive", whose picker takes only that source's
  exports, and lists its imports with their progress, findings and Remove (as
  the Archives row does). "Import another archive" sends the same file to the
  same card, and Other archives no longer lists them. A start says "Importing
  Field notes.enex into Evernote. It shows in Evernote as it is read."
- **Storage does not move.** The imports stay where source-storage.md (step 4e)
  keeps archive-only formats: `archive.imports`'s note store set, one account
  scope per import, with their Remove. The cards are views of the public
  Archives source (`public_source_id`), so no new public source id, scheduler
  source, store set or relay enum is added, and nothing moves on disk. What
  this does not give: deleting one card's imports together (each has its
  Remove, and the Archives source's Delete removes all), and a card count of
  items by corpus (the card counts its imports).
- **Not inputs of a connector.** No live connector reads these formats, so
  there is no live input to share a dataset with and no `ArchiveSourceTarget`:
  the format's archive connector reads each export, as before. Two exports of
  the same graph are two imports (their notes are identified by place), as
  under Archives.
- **Evernote (.enex).** A shared streaming XML reader
  (`archive-import/xml-stream.ts`) hands out one `<note>` at a time with a
  resume point, never holding base64 `<data>`; it reports its byte range. Each
  note is a note item (ENML to plain lines; `<en-crypt>` is never decrypted and
  is reported as content Olympus cannot read). Each `<resource>` is a child item
  with a locator to its base64 range, read later by the extraction factory and
  judged on its own.
- **Assets of Reflect and Roam: there are none to read.** Their exports link to
  pictures on the provider's servers rather than holding them (community
  reports for Roam's Export All; Reflect's documentation does not say), and an
  import never fetches from the network. Evernote is the only one of the three
  whose export holds its files, so it is the only one with children.
- **Evernote's recognition text is not used yet.** Each attachment's
  `<recognition>` (Evernote's own reading, handwriting included) is left in the
  file and never held. Using it needs `RawItem.providerText` (child-items.md,
  "Text the provider supplies"), a contract change that lands on its own after
  2.2.0 (branch `claude/provider-text-2-3-0`).

## To verify before step 4

- Telegram Desktop writes bare chat ids, with the type telling the marked
  form. **Checked 2026-10-25** against the owner's full-account JSON export
  (133 chats and 85 left chats, about 449,000 messages). A script read field
  names and the form of ids only, never names or text.
  - Chat ids are bare positive integers, and the type gives the marked form:
    `private_group` takes `-id` and `private_supergroup` takes `-100id`. The
    export held only groups and supergroups, so direct chats, bots and
    channels are still unchecked; step 4 maps them by type as Telethon marks
    peers and keeps an unknown type apart.
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
  API id is its hex). **Checked 2026-10-25 against the published format**
  (community and vendor samples, and Google's IMAP documentation, which says
  `X-GM-MSGID` and `X-GM-THRID` are the decimal forms of the API's hex ids):
  every message starts `From <decimal>@xxx <date>` and carries `X-GM-THRID`
  in decimal and `X-Gmail-Labels` by name. Not yet checked against a real
  export: the owner canary confirms the `From` number is the message id.
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
