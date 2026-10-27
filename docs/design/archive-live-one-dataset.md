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

- **WhatsApp** keeps live's form: a media message is one row with the media
  type and its extracted content. The archive input emits the bridge's media
  record, and the import's media folder is registered as a readable root of
  the account. If those files go, what was extracted stays and unread media
  is reported as unavailable, as the child-items design reports it.
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
| Resume | a cursor bound to its input's version, with named stop codes | archive | a missing Telegram cursor wedges its lane; a WhatsApp cursor whose file vanished silently skips the rest |
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

Per-card Import (owner, 2026-10-25): built, see "Built, per-card Import".
Each source's Import an archive appears as its step registers it.

1. Child items spine (2.1.0, merged).
2. One-pipeline spine (2.2.0, built, awaiting critical review): connector
   inputs and their cursors, the intake lookup and rule, the hold on the item,
   the import record inside a source card with its counts; proved with a
   fixture source that has a live and an archive input (see "Built, step 2").
3. Live capture fixes from "Best of both", each with its own tests:
   streaming spool reads with bounds, cursor recovery, counted bridge
   drops, WhatsApp captions, freshness told apart from quiet.
4. Telegram: the export becomes an input of the Telegram connector (exact
   ids, account hash), with folder media as children; reusable builder and
   new record kinds. After storage's account-identity step.
5. WhatsApp: the export becomes an input (counted keys, zone alignment,
   chat joining); the bridge's records carry the contact's saved name.
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
