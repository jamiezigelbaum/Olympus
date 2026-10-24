# Import an archive

Status: owner direction 2026-10-23. Steps 1 (mail with the shared spine), 3
(WhatsApp chat exports) and 4 (Telegram Desktop exports) are built; step 2 is
not. Where this
page and the code differ, the code is current.

## Outcome

A new user can point Olympus at an old export (a mail export, a WhatsApp or
Telegram chat export, a Reflect or Roam export) and search it like any other
source. There
is one way to do it: **Import an archive** in the dashboard. Agents call the
same operation, so "have your AI do it" and "click the button" import the
same way, with the same privacy and the same status.

## Owner decisions (2026-10-23)

- **One entry point.** One "Import an archive" action, not a row per format.
- **Olympus detects the format.** The user picks a file or folder; they never
  say "this is Roam".
- **Mail archives first** (mbox), because old mail is the largest gap and no
  importer exists.
- **Reflect and Roam move onto the public product.** Their connectors exist
  but are on the public-surface allowlist as leftovers.
- **Reviewed** by Astra (Codex, high) on 2026-10-23. Its five findings are
  folded in: per-archive identity and removal, bounded streaming reads,
  file-version-bound cursors, collision-safe mail identity, and the
  Reflect/Roam privacy-default conflict. A second round added WhatsApp
  message identity, bounded parsing of chat exports and zips, and the
  snapshot-beside-live acceptance cases. A third round, with Codex's PR review, made
  tiers follow the shared classifier, moved Reflect and Roam to streaming
  reads, bound resume to every file read, and required user approval for
  agent-started imports.
- **WhatsApp and Telegram exports are in scope** (owner, 2026-10-23), after
  mail.
- **Imported archives stay Private until the private model judges them**
  (owner, 2026-10-23): the local model, or Venice Private where there is no
  local model, as for every source. Personal-first does not apply to them: it assumed a
  wait of minutes, and an import puts years of items in the queue at once.

## Where things stand

| Format | Today |
|---|---|
| Mail (mbox) | Built in step 1 (2026-10-23): the shared spine in `workers/archive-import/`, and a thin mbox connector (`workers/archive-import/mbox/`) that splits the file itself and parses each message with `postal-mime`. Gmail items come from the Gmail API's JSON, so Gmail shares none of it. |
| WhatsApp chat export | Built in step 3 (2026-10-24): one format (`whatsapp_chat`, family `chat`, provider `whatsapp_export`) over `_chat.txt`, `WhatsApp Chat with <name>.txt` and the zip WhatsApp shares, in `workers/archive-import/whatsapp/`, with the line grammar in `workers/archive-import/whatsapp/grammar.ts` (core keeps only the small detection signature). The old export connector (`workers/whatsapp/connector.ts`) is deleted. Live WhatsApp capture is wired separately and untouched. |
| Telegram Desktop export | Built in step 4 (2026-10-24): a thin connector (`workers/archive-import/telegram/`) that streams a JSON `result.json`, whole-account or single-chat, as family `chat`, provider `telegram_export`. Live Telegram capture (`telegram-messages/`) is a different provider in different stores, and the import never opens it. |
| Reflect export | Connector exists (`workers/reflect/connector.ts`), unwired, allowlisted. |
| Roam export | Connector exists (`workers/roam/connector.ts`), unwired, allowlisted. |

`source-family.ts` already models this: ingest mode `archive_import`,
credential kind `archive_path`, custodian `archive_importer`. Reflect and Roam
are declared there as `planned`.

## Shape

An archive is a source with no account and no live updates. Each imported
archive is a snapshot: "Imported 23 Oct 2026, mail from 2004 to 2019".

| Piece | What it is |
|---|---|
| Format registry | One registry of archive formats (`core/archive-formats.ts`, pure data like `core/file-scope-sources.ts`). Each entry: format id, label, a `detect(path)` probe, the source family, and a connector factory. Adding a format adds one entry and one thin connector. Nothing downstream branches on format. |
| Detection | Cheap probes on names and the first bytes, never a full parse: an mbox starts with a `From ` line; Apple Mail's export is a `Name.mbox` folder holding an `mbox` file; WhatsApp is a text file (or a zip holding one) that starts with a message line, and, in a chosen folder, is named as WhatsApp names it; Telegram Desktop is `result.json` with its export keys; Reflect and Roam by their JSON shape (the connectors already parse liberally). No match: say so and list what is supported. Two matches: ask. |
| Connectors | Thin `SourceConnector`s (contracts.ts), one per format. Pages honour the `done` / `truncated` rule in contracts.ts. |
| Archive identity | Each import gets a persistent archive id at start, used as the connector instance id and `accountScope`. Checkpoints key on it, so two imports of the same format never share a resume position. Today Reflect uses one constant connector id (`reflect/connector.ts:87`) and the store keys resume on it (`connector-store/local-index.ts:11083`); that changes when Reflect moves onto the registry. |
| Cursor | Position in the archive, bound to the identity (device, inode, size, mtime) of every file the import reads, not only the chosen path. For a folder (Apple Mail's `.mbox`, a folder of WhatsApp exports) that means a manifest of its files, and for a zip its members. A large import resumes after a restart; if any file in an unfinished archive changed or went missing, the import stops and says so instead of resuming against different bytes. |
| Picker | The local-files picker (`workers/local-files/scope-browser.ts`), extended to offer files as well as folders in a "choose one file or folder" mode (today it lists folders only, `scope-browser.ts:121`). |
| Reading | Only the chosen path, through the scope-safe reader (`core/scope-safe-fs.ts`), so no symlink escape. `ScopeRoot.readFile` loads a whole file, so archive reading adds a bounded streaming read on `openRelative`, with a per-message size cap. |
| Storage | Items go into the shared connector store and pipeline unchanged: extraction, per-item tiers from privacy settings plus the judge, index, search, Analyst. No archive-specific code after the connector. Importers set no source-level floor; each item gets its own tier. Until the private model judges an item, its content is held Private (below). |
| Removal | Per archive, not per source. Lifecycle delete today removes a whole source's store (`data-lifecycle.ts:657`) and Reflect has one store for the whole family (`data-lifecycle.ts:404`), so removing one import that way would erase the others. Remove cancels and fences that archive's running work, deletes its items, chunks, vectors and derived data (including private answers built from it, `data-lifecycle.ts:691`), and never touches the user's file. |
| Operation | One operation, `archive_import` (start, status, remove), on the public tool lists, CLI, and MCP. The dashboard calls the same core functions as the operation. An agent cannot import a path just by naming it: start needs a path the user approved, through the dashboard picker or a confirmation the user answers, the same approval the scope picker gives other sources. A prompt-injected or accidental tool call can at most ask. |
| Dashboard | An "Archives" source showing each import: format, file name, item count, date range, progress, gaps (unreadable messages, skipped attachments), and Remove. Every problem has a route to exactly what failed. |

### Mail (mbox), first

- **Formats covered:** Google Takeout (`.mbox` file), Apple Mail "Export
  Mailbox" (`.mbox` folder), Thunderbird (mbox files, often no extension). They
  share one connector. Maildir and `.eml` folders come later on the same entry.
- **Parsing:** stream the file, split on `From ` lines (handling the
  `>From` quoting variants), and parse each message with a proven MIME library
  rather than our own. Candidate: `postal-mime` (no dependencies, runs in Bun).
  Check its licence and size before adding it.
- **Items:** one `RawItem` per message, `family: 'email'`, `mimeType:
  'message/rfc822'`, metadata shaped like Gmail's (subject, from, to, date,
  thread) so answers treat imported and live mail alike. Gmail labels from
  `X-Gmail-Labels` are kept as labels.
- **Identity:** `Message-ID` plus a hash of the whole message, so two
  different messages that share headers never merge. Re-importing the same
  export is detected by the file's identity and offered as "already imported",
  rather than relying on message ids: store identity includes `accountScope`
  (`connector-store/local-index.ts:13447`), so a second import under a new
  archive id would otherwise duplicate everything.
- **Attachments:** named on the message, bytes not read in the first version,
  shown as an honest gap (the same posture as Gmail today). Reading them
  through the shared extraction machinery is a follow-up.
- **Size:** exports can be tens of GB. Streaming with a byte-offset cursor;
  never load the file.

### Reflect and Roam, promoted

Register both in the format registry, wire them into the scheduler and public
source ids, and remove their five entries from
`config/public-surface-allowlist.json`. Re-check both connectors against a
current export from each app first; they were written before the shared
tier classifier and may need their classification signals updated.

Their privacy defaults disagree today: the family postures say `internal`/S3
(`source-family.ts:241`, Personal), the connectors default to `secure_local`
(`reflect/connector.ts:53`, `roam/connector.ts:62`, Private). Keeping
`secure_local` would leave ordinary notes Private for good, because the
classifier does not judge content already at that tier
(`tier-classifier.ts:858`). The connectors' default becomes `internal`, so
notes are judged per item like every other source instead of resting at
Private.

## Privacy while an import is judged

Every item from an imported archive is held Private until the private model
(the local model, or Venice Private where the preset has no local one) judges
it, then moves to its judged tier. Nothing from an import is Personal, and so
nothing reaches a cloud model or cloud embedding, before its own judgment.
Ordinary cloud models never judge.

- **Shared, not per format.** An archive import lane sets one lane option,
  `holdContentUntilJudged`, on its store's tier classification
  (`tier-placement.ts`); only a module under `src/workers/archive-import/`
  may set it (`test/tier-hold-until-judged-guard.test.ts`). The shared
  classifier then holds content without a verdict as for own-record items,
  never sets `content:personal_first`, and records
  `content:held_until_judged`, which every later pass (re-judge, migration,
  rules sweep, override settling, text that lands later) reads back from the
  stored decision. No connector or format branches on it. Built in step 1.
- **Names** follow the existing rule: cleared names stay Personal while the
  content is held (Gmail and Drive already work this way).
- **Secrets, structured identifiers, owner rules and source floors** keep
  their precedence. An owner override of an item still wins.
- **Queue order.** Held import questions join the judging queue behind
  every live question (priority -1, below own-record 10 and ordinary 0), so a
  large import does not delay judgments for new mail; the oldest-question
  slot each queue read reserves keeps the import moving.
  The dashboard shows each archive's judged and still-held counts, so a
  partly judged import is visible rather than silently incomplete.
- **No model ready.** Items stay held until one is; the dashboard says the
  import is waiting for the private model, with a route to set it up.
- **Gate.** This changes classification semantics, so it follows the
  versioned change gate in `docs/ENGINEERING_PROCESS.md`: a `CONTRACTS.md`
  change-log entry (2026-10-23), the held-out eval (an archive-held run of
  the classification corpus) and an independent review. The classifier
  version stays `2026-10-13.p6`: no lane set the option before it, so no
  decision differs (per-case evidence in the change log), and a bump would
  re-judge every routed item for nothing. It lands in step 1, before any
  archive format is public.

Both connectors also load a whole export at once (`reflect/connector.ts:139`,
`roam/connector.ts:69`), so a large export could run the engine out of
memory. They change to read incrementally before either is public: a
streaming JSON parser (a proven library, not our own) for a single export
file, one zip member at a time with streaming inflate, and only the current
page of notes held in memory. No size limit: any export a person has must
import.

### WhatsApp and Telegram exports

Both are in scope. They come after mail because they reuse the same spine
(identity, resume, removal), not because they are optional.

- **WhatsApp chat export** (built, step 3). One format reads the chat text
  file of "Export Chat" (`_chat.txt` from an iPhone, `WhatsApp Chat with
  <name>.txt` from an Android phone, or any `.txt` the person chooses that
  starts with a message line) and the zip WhatsApp shares, which holds that
  file and the media. Only the approved files are read, through the
  scope-safe reader. The text is read as a stream (and a zip member by
  streaming inflate), never loaded whole.
- **What counts as an export.** It depends on who chose the file. A file the
  person chose themselves is an export when it starts like a chat, whatever
  its name. In a chosen folder a file needs more: a `.txt` named as WhatsApp
  names it, or a zip holding such a file, and the start of a chat inside; a
  header-shaped first line alone is not enough, because a build log or a debug
  dump can start the same way. Files that start like a chat but are not named
  like one are left alone and counted (`files_unconfirmed`, "choose it by
  itself to import it"). Detection asks for every `.txt` and `.zip` in the
  folder, past the usual 256-entry bound, up to 1,024 more; the
  files past that are counted (`files_not_looked_at`) instead of vanishing.
- **A pass is bounded in bytes, not only in items.** A pass reads at most
  `maxBytesPerListing` (256 MiB) of the archive: the date-order scan, every
  line read or dropped inside a long message, and the re-inflating of a
  zip member to a resume point all count. When the budget is spent the pass
  ends with a resume point, and the next pass goes on from it. A resume point
  can sit inside a message that was cut (dropping lines until the next
  header), so a message of any length costs bounded work per pass.
- **Stored zip members keep their checksum.** The CRC-32 of everything before
  each message header travels in the resume point, so a stored member resumed
  at a header that straddled a read still verifies to its end. A member that
  ends with a checksum that did not match, or that was not read to its end, is
  reported as `file_damaged`, because what was read of it may be wrong. A deflated member resumes from a parked inflater when the resume
  point is in the last chunk read, and otherwise by re-inflating from the
  start of the member, which the byte budget counts.
- **Dates.** The export writes wall time with no zone and in the phone's
  locale order. The order is decided per file from its own headers: the order
  most headers of the file's own style say wins (up to 25 votes, within the
  first 16 MiB) (a day above
  12 settles it for that header), so one header pasted into a message cannot
  decide a file. When nothing says, or the votes tie, it is read day first and
  reported as an `assumption`. The time is read in this computer's zone and
  reported once per archive. Dates with a weekday or month name, non-Latin
  digits and non-UTF-8 files are not read.
- **Pasted headers.** A line inside a message body that looks like a header
  starts a new message, in its own style, because the format cannot say
  otherwise. Each one in a style other than the file's, or dated before the
  header before it, is counted in an `assumption` finding, so the person is
  told the import took it as a message.
- **Items and identity.** One item per message; the chat is the thread, named
  from the export's file name (the zip's, or its folder's, for a `_chat.txt`).
  The id hashes the chat, the written time, the sender and a hash of the text,
  plus the number of the message among identical ones at that time. The file
  and member are not in it, so a `.txt` and a `.zip` of one chat, or two
  exports that overlap, give one item per message, imported once; the second
  copy is counted (`item_repeated`, "in more than one export file"). Which
  file a message came from is metadata (`sourceFile`, `sourceMember`). More
  than 24 different messages in one written time are told apart by their
  place in the file instead of a number.
- **Left out, and counted.** Notices from WhatsApp itself (`system_message`),
  messages with no text (`message_empty`) and the status updates chat
  (`status_updates`) are skipped and counted. Media stays in the message text
  as the phone's marker and is counted as `media_not_imported` ("the archive
  refers to" it); a message over 1,048,576 characters (or 8 MiB) is cut and
  reported as `item_truncated`.
- **Real exports.** The shapes above come from the open-source parsers of
  real exports and from the synthetic builders in
  `test/support/archive-fixtures-whatsapp.ts`; no real export was read here.
  Localized export file names (`WhatsApp Chat with` in other languages), exports
  with the chat text in a subfolder of a chosen folder, and right-to-left
  locales are unverified. The open-source parsers report that newer iOS
  exports put a narrow no-break space before AM/PM and a left-to-right mark
  before each line; both are handled.
- **Imported chats are a snapshot.** The dashboard says "Snapshot, not
  updated" beside a chat archive's date range (by family, so another chat
  format gets it too).
- **Telegram Desktop export** (JSON only: "Export Telegram data" or "Export
  chat history" with the format set to Machine-readable JSON; `result.json`
  plus media folders). A thin connector, built from Telegram Desktop's own
  JSON writer (`export_output_json.cpp`, read in releases 1.3.10 to 6.0.0;
  no real export was available, so the tests follow the writer's code):
  - *Shape.* A whole-account export is `{about, personal_information,
    profile_pictures, contacts, frequent_contacts, sessions, web_sessions,
    other_data, chats: {about, list: [{name, type, id, messages}]},
    left_chats: {...}}`, the personal sections first, so `chats` starts far
    past any probe. A single-chat export is the chat object itself. Detection
    reads the first keys (`about` and a known section, or `name`/`type`/`id`
    then `messages`); the folder form is found by the name `result.json`.
  - *Items.* One per message. The thread is the chat, keyed by its position
    in the file (`chats:3`), because a chat's own `id` repeats across users,
    groups and channels. The text is the words with links kept (`label
    (address)` when they differ), then a line per picture, file, contact,
    place, poll, to-do list, invoice or game (the words of a poll or a list
    can be formatted, so they are read as text, not as strings). `authoredAt`
    is `date_unixtime` (releases 4.0 and later), else the zone-less `date` read in this computer's zone and
    counted as one `assumption`.
  - *Control characters.* Telegram writes them as `\xNN`, which is not JSON
    and stops a strict reader at the first one. A byte filter
    (`telegram/json-repair.ts`) turns each into four spaces of the same
    length, so byte offsets in resume points stay file offsets.
  - *Left out, counted.* Service messages (joins, calls, pins) and messages
    with nothing to read are `skipped`; media files are named in the text
    and counted as `media_not_imported` (never opened), and so is a file
    the export itself left out, marked "not in the export" and keeping the
    name the export gave it, so a search for the name finds the message. A
    message that carries what the reader does not know (a giveaway, a rich
    message, paid media, a message the writer marks `unsupported`, any object
    the reader has no rule for) is `message_content_unsupported`, a gap and
    not "nothing to read"; its words, if it has any, are kept. Each part of the
    account export that is not messages (personal information, contacts,
    sessions, other data and so on) is one `section_not_imported`, said once
    and never stored. A message over 1,000,000 characters keeps its start
    (`item_truncated`); one over 16 MiB is `message_too_large`; a file cut
    short imports what came before and counts `file_damaged`.
  - *Resume.* The cursor is the JSON reader's point after a message or after
    an entry of a part that is not messages, bound to the manifest; any other
    cursor stops the import. A pass counts the bytes of those parts against
    its budget too, and a pass that starts inside a part does not say the
    part again. The reader returns every message it finished before a
    mid-file JSON error, so damage costs only the messages from the damage on.
  - *HTML form.* `messages.html` is recognised and turned away with plain
    advice to export again as JSON (`unsupportedVariants` on the format).
  - *Limits of the finding shape.* A finding has no name or path field, so
    the dashboard says "6 parts of the archive are not imported" without
    naming them, and a media gap cannot name the file (the item text does).
- Both import as snapshots alongside any live capture of the same account.
  The dashboard keeps "imported archive" and "live capture" apart, as the
  release plan requires. Overlap between an export and live capture is the
  same open question as Takeout mail versus live Gmail.

## Order

1. Mail (mbox) as the first format, with the spine it needs: format
   registry, detection, archive identity and checkpoints, per-archive
   removal, `archive_import` operation, Archives source in the dashboard,
   the streaming reader and the file-selecting picker. The
   hold-until-judged rule lands here too, through its classifier gate.
2. Reflect and Roam onto the registry, with streaming reads and the
   `internal` default; all their allowlist entries removed.
3. WhatsApp chat export, with the selected-file, scope-safe reads (built).
4. Telegram Desktop export.

Each step is one PR with focused tests on synthetic fixtures (never real
exports), plus the held-out eval where the step changes the source pipeline.

## Open questions

- **Imported mail that overlaps live Gmail.** A Takeout export of the same
  account duplicates mail that live Gmail already indexed. Matching on
  `Message-ID` across sources is a spine question; the first version may
  accept duplicates and show both.
- **Copy or reference.** The first version reads the file in place. If the
  user moves or deletes it, the import is already finished and stays; a
  re-import needs the file again.

## Done when

A fresh install on Mac and on Linux can import a synthetic mbox, Reflect,
Roam, WhatsApp and Telegram export through the dashboard and through the agent tool, see each as a
snapshot with counts and gaps, find cited answers from it, and remove it.
No imported item's content is in a Personal store, or embedded by a cloud
model, before the private model judges it; cleared names may be, as above. A test
imports with the private model stopped and checks this.

For WhatsApp and Telegram, also on the same candidate as a supported live
connection (`V0_4_RELEASE.md`, "Qualification action"): the dashboard shows
the connected scope and the history the export covers, tells stale live
capture apart from a successful empty import, and removing the archive leaves
live capture running and its items in place.
