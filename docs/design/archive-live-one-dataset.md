# Archives and live connectors: one dataset, one pipeline

Status: design, 2026-10-25, after one critical review round. Owner
requirement; builds on [archive import](archive-import.md) and
[child items](child-items.md).

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
path: builder, store set, placement, tier ledger set, judging, extraction,
children, limits.

So the store and the tier ledger see one connector, one owner and one ledger
set per source, as today. Inputs are the connector's business, below the
`RawItem`; nothing downstream learns that an archive exists, which keeps the
rule that only the connector is per-source.

An input keeps what only it needs: its own cursor (an archive's stays bound
to its files' identity), its findings, its progress and, for an archive, the
import record and its Remove control.

A source with no live connector (Reflect, Roam, Evernote, mail of an account
that is not connected) has its archives as its only inputs, under the
Archives card as today.

### 2. Intake: one version per item, chosen before judging

The connector merges its inputs per item before it builds the `RawItem`, so
the classifier only ever judges content that will be kept. A shared,
source-neutral helper keeps an input table per source:
`(item key, input, record version, supplied content)`.

- A record applies when it is newer than the stored version, in the
  source's own order (Telegram: edit date, then reactions; WhatsApp: the
  message time; mail does not change), whichever input it came from. An
  older record never overwrites a newer one, so a queued live record cannot
  undo a later edit the archive holds.
- At the same version, a record applies only when it brings content the
  stored item lacks: mail outside the Gmail window is names-only, and a live
  WhatsApp photo is metadata only (the bridge downloads voice notes alone).
  Otherwise the stored item stays, and live is kept on a tie.
- Two archives of the same history: the first applies, and the second is a
  further input. Re-importing an export is caught by its file identity, as
  today.

### 3. The hold travels with the item

Today the hold-until-judged rule is a lane option on the archive set. In one
pipeline the lane is the live one, so the hold moves to the item: an item
whose kept content came from an archive input carries `holdContentUntilJudged`
on its `RawItem`, and placement honours it exactly as it honours the lane
option today, through first classification, replacement and child
extraction. Live items are unchanged.

### 4. Matching, per source, inside the connector

- **Telegram:** exact. The archive input writes the chat id in Telethon's
  marked form (users positive, basic groups `-id`, supergroups and channels
  `-100id`, from the export's chat type) and the message id, so its record
  has the live item's key.
- **Gmail:** exact where the export carries the Gmail id (Takeout, to
  verify). Otherwise by `Message-ID`, only when it is unique in the account
  and its `Date` and `From` agree; anything else is its own item. Live Gmail
  adds `Message-ID` to the headers it requests; when an mbox of the connected
  account is imported, a bounded background pass reads it for mail already
  stored (one metadata read per message, within the provider budget), before
  matching starts.
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
  record, and the import's media folder is registered as a readable root for
  that input while the import exists.
- **Telegram and mail** use child items, with keys both inputs can compute:
  Telegram `media` (one per message), mail the MIME part path. A photo the
  archive brings to a message live also holds is a child only the archive
  supplied; if live capture later brings media, it is the same child.

Each child is still judged on its own.

### 6. Removing an archive

Removal removes the input, never by account:

- the input is dropped from the input table;
- an item with no input left is deleted through the child-items cascade:
  hidden in the ledger in one transaction, then deleted from every tier
  store, with its children, chunks, embeddings, extraction jobs, questions
  and Secret locations;
- an item another input supplied stays as it is: by section 2 its content is
  that input's;
- mail whose names-only row the archive had filled returns to names-only:
  the Gmail connector rebuilds it from its live record.

The account-scoped deletes (`purgeAccountScope`, `withdrawAccountScope` and
the child-items design's extraction-job forget by account scope) are never
used for an input; they stay for deleting a whole source. Disconnecting live
keeps the history the archives supplied.

### 7. Same account, or no merge

- **Telegram:** the export's user id, hashed as pairing hashes it, equals
  the pairing's `account_ref`. Imported before pairing, the import records
  it; pairing another account later is refused with a plain route ("this
  Telegram is a different account from the imported history: remove the
  import first"). No rows are ever re-keyed. A single-chat export carries no
  profile; it joins the paired account at the owner's confirmation.
- **Mail:** the export's address, hashed into the opaque account labels the
  source binding keeps, equals the connected Gmail's. Absent, mixed or
  conflicting delivery headers mean no merge. Mail of an account that is not
  connected is archive mail. Connecting that account later offers to join it:
  the file is read again as a Gmail input, then the separate archive is
  removed. If the file is gone, it stays separate and the card says so.
- **WhatsApp:** one WhatsApp is paired per install. The import sheet says
  the chat joins it, and the owner can keep it apart (its own source, as
  today).

### 8. Counts and findings

One dataset shows on one card: the source's own (Telegram, WhatsApp,
Gmail). Its imports are listed inside it, each with its progress, findings
(their plain sentences and two lists) and Remove. The Archives card keeps the
sources with no live connector. The source card counts each item once; an
import counts its own input: "N items from this archive, of which M were
already there from live capture." The card shows the history each input
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
| Removal | per input (section 6) | archive's key, the cascade's mechanism | the account-scoped purge would delete live items |
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
and removal by input are a semantic change: contract 2.2.0, after 2.1.0
(child items), through the versioned gate with an independent critical
review and the private held-out run. Store and ledger ownership do not
change.

## Order

1. Child items spine (2.1.0, in progress).
2. One-pipeline spine (2.2.0): the input table and intake rule, the hold on
   the item, removal by input through the cascade, input cursors, counts;
   proved with a fixture source that has a live and an archive input.
3. Live capture fixes from "Best of both", each with its own tests:
   streaming spool reads with bounds, cursor recovery, counted bridge
   drops, WhatsApp captions, freshness told apart from quiet.
4. Telegram: the export becomes an input of the Telegram connector (exact
   ids, account check), with folder media as children; reusable builder and
   new record kinds.
5. WhatsApp: the export becomes an input (counted keys, zone alignment,
   chat joining); the bridge's records carry the contact's saved name.
6. Mail: live Gmail requests `Message-ID`, with the background pass, and
   gains attachments as children; mbox of the connected account becomes a
   Gmail input.
7. Reflect, Roam, Evernote: their own sources, assets as children.
8. Live Telegram media and live WhatsApp images and video, so both
   inputs bring the same media.

Each step is proved on fresh Mac and Linux installs by the release check's
archive leg, which gains an import-beside-live case per source with a
fixture live input. The owner canary with a paired phone checks the real
apps.

## To verify before step 4

- Telegram Desktop writes bare chat ids, with the type telling the marked
  form. Check against a real export.
- Takeout's mbox separator line carries the Gmail message id in decimal (the
  API id is its hex). If not, mail matches by `Message-ID` only.
- The WhatsApp export's chat names equal the bridge's contact names for
  direct chats. Check with the owner canary.

## Review

Round 1 (independent critical review, 2026-10-25) found no P0 and nine P1/P2
issues against the first draft, which had archives write into live stores as
second connectors. This draft answers them by design rather than patches:

- One writer per source (section 1) removes multi-owner precedence, the
  ledger-owner gap and the separate-ledger refusal.
- Choosing the version before judging (section 2) makes every judgment
  concern kept content.
- The hold travels on the item (section 3).
- Removal by input through the cascade (section 6) never deletes or
  withdraws by account.
- WhatsApp matches by counted keys (section 4), after round 2 showed that
  capture periods cannot partition history.
- Gmail ownership no longer depends on live re-reading stored mail, and the
  `Message-ID` backfill is explicit (sections 2 and 4).
- No re-keying: a mismatched account is refused or re-read (section 7).
- WhatsApp media keeps live's form (section 5).
- Counts are per input and per dataset (section 8).

## Open questions

None for the owner. Defaults chosen: removing an archive removes only the
history it alone supplied; a WhatsApp chat export joins the paired WhatsApp
unless the owner keeps it apart; pairing a different Telegram account than
the imported history is refused until the import is removed.
