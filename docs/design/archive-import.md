# Import an archive

Status: owner direction 2026-10-23. Step 1 (mail with the shared spine),
step 2 (Reflect and Roam), step 3 (WhatsApp chat exports) and step 4
(Telegram Desktop), the last three on 2026-10-24, are built. Where this page
and the code differ, the code is current.

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
- **Reflect and Roam move onto the public product.** Their old connectors were
  on the public-surface allowlist as leftovers; step 2 replaced them with
  archive formats (below).
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
- **Everything that can be read is ingested; no length cut and no size
  refusal** (owner, 2026-10-25). The one-million-character cuts are gone
  (see "No length cut"); Telegram's service messages, its account parts
  (profile, contacts, sessions...) and WhatsApp's status updates chat are
  items. Attachment and media bytes are a separate design (child items).
- **Imported archives stay Private until the private model judges them**
  (owner, 2026-10-23): the local model, or Venice Private where there is no
  local model, as for every source. Personal-first does not apply to them: it assumed a
  wait of minutes, and an import puts years of items in the queue at once.

## Where things stand

| Format | Today |
|---|---|
| Mail (mbox) | Built in step 1 (2026-10-23): the shared spine in `workers/archive-import/`, and a thin mbox connector (`workers/archive-import/mbox/`) that splits the file itself and parses each message with `postal-mime`. Gmail items come from the Gmail API's JSON, so Gmail shares none of it. |
| WhatsApp chat export | Built in step 3 (2026-10-24): one format (`whatsapp_chat`, family `chat`, provider `whatsapp_export`) over `_chat.txt`, `WhatsApp Chat with <name>.txt` and the zip WhatsApp shares, in `workers/archive-import/whatsapp/`, with the line grammar in `workers/archive-import/whatsapp/grammar.ts` (core keeps only the small detection signature). The old export connector (`workers/whatsapp/connector.ts`) is deleted. Live WhatsApp capture is wired separately and untouched. Since 2026-10-25 the status updates chat is read like any chat, notices and empty messages are listed as how it was read rather than as a loss, and a message is never cut by length. |
| Telegram Desktop export | Built in step 4 (2026-10-24): a thin connector (`workers/archive-import/telegram/`) that streams a JSON `result.json`, whole-account or single-chat, as family `chat`, provider `telegram_export`. Live Telegram capture (`telegram-messages/`) is a different provider in different stores, and the import never opens it. Since 2026-10-25 service messages (joins, calls, pins) and the account's own parts (profile, contacts, sessions...) are items, and a message is never cut by length. |
| Reflect export | Built in step 2 (2026-10-24): JSON (a list of notes, or `{"notes": [...]}`, either key style, in a `.json` file or a zip) and Markdown (a zip of `.md` files), as formats `reflect-json` and `reflect-markdown` with thin connectors in `workers/archive-import/reflect/` over the shared notes engine in `workers/archive-import/notes/`. The old connector is deleted. CSV and HTML exports are not read; choosing one gets the supported-formats answer. |
| Roam export | Built in step 2 (2026-10-24): "Export All" as JSON (a list of pages with nested blocks, in a `.json` file or a zip), format `roam-json`, `workers/archive-import/roam/`, same engine. The old connector is deleted. Roam's Markdown and EDN exports are not read. |

`source-family.ts` already models this: ingest mode `archive_import`,
credential kind `archive_path`, custodian `archive_importer`. Mail, Reflect and
Roam are declared there as `working`, because they are shipped; a posture is
`planned` only for a source that is not. Their resting tier is Private
(`secure_local`, S4), the same as `archive.imports`. The Private hold is a
separate thing from availability: until the private model has judged a note,
its content stays Private, and after that it takes the tier the judge and the
person's privacy settings give it (the lane option below).

## Shape

An archive is a source with no account and no live updates. Each imported
archive is a snapshot: "Imported 23 Oct 2026, mail from 2004 to 2019".

| Piece | What it is |
|---|---|
| Format registry | One registry of archive formats (`core/archive-formats.ts`, pure data like `core/file-scope-sources.ts`). Each entry: format id, label, a `detect(path)` probe, the source family, and a connector factory. Adding a format adds one entry and one thin connector. Nothing downstream branches on format. |
| Detection | Cheap probes on names and the first bytes, never a full parse: an mbox starts with a `From ` line; Apple Mail's export is a `Name.mbox` folder holding an `mbox` file; WhatsApp is a text file (or a zip holding one) that starts with a message line, and, in a chosen folder, is named as WhatsApp names it; Telegram Desktop is `result.json` with its export keys; Reflect JSON and Roam JSON by the keys of the records at the start of the `.json` file (or of a JSON member of a zip), never by a word in a note's text: a Reflect note has a body key (`content`, `body`, `document_json`) and a title or date key, a Roam page has a `title` and one of Roam's time or author keys (or `children` with a `uid`), and a file that shows only one key of the kind, or both kinds, is not guessed at (a zip with one JSON file of each is refused too). The first 4 KB decide when they can. When they end inside the first record, before the keys that would tell, the probe reads on through the shared JSON reader (`record-probe.ts`, a generic helper that learns no format's keys) to the end of that record, skipping every value and keeping the key names: memory is the names and one chunk, work is that record (and the first field after it), it stops early once the keys so far decide, and a scan that does not decide is a file that is not told by it, never a refusal for size. When the file is an object and its list of notes has not shown yet (earlier keys with long values), the same read walks the object's top-level keys, skipping their values, until it reaches the list's key (named by the format) and then reads the first note's keys; an object that never has the key is read in constant memory until the allowance runs out. The look is for a picker that must stay fast: a file a format matched on the first bytes alone is never read further (a Telegram `result.json` never gets it), but every other file of the pick is, and so is every member of a zip that no format takes for its own file on its first bytes, so a second export in a chosen folder or zip whose first bytes do not tell it is found beside one that does (two exports are then refused or asked about exactly as when both are told at once, never one imported and one dropped); one document is read for at most 64 MiB in all (`RECORD_PROBE_MAX_SCAN_BYTES`, shared by the passes over it), and past that the answer is "no match", which with nothing else matching is the supported-formats answer. The files of one chosen folder also share 256 MiB between them (`RECORD_PROBE_MAX_FOLDER_SCAN_BYTES`), as do the members of a zip picked on its own (one document's worth, 64 MiB; a zip inside a picked folder draws on the folder's); when that runs out before every file or member was looked through, nothing is imported and the refusal says so in plain words (`ARCHIVE_LOOK_INCOMPLETE_ADVICE`: choose just the export file, or a folder or zip that holds only the export), because an unchecked file could be a second export. A zip's JSON member gets the same read, and the formats that ask about one file share one scan. When a zip member's notes list was not reached and the first-record read found no record, one more read asks whether the list is there and empty, so an empty list after long earlier keys reads as an export with no notes. A zip's other JSON files are not read as that format: they are left out and counted (`section_not_imported`); Reflect Markdown by a zip of `.md` files that shows Reflect's hand (Reflect in the file name, a daily-note file name such as `Tue, March 21st, 2023.md`, or a reflect.app link) and holds no JSON, so a Roam Markdown zip is not mistaken for it. No match: say so and list what is supported. Two matches: ask. |
| Connectors | Thin `SourceConnector`s (contracts.ts), one per format. Pages honour the `done` / `truncated` rule in contracts.ts. |
| Archive identity | Each import gets a persistent archive id at start, used as the connector instance id and `accountScope`. Checkpoints key on it, so two imports of the same format never share a resume position. The old Reflect connector used one constant connector id and the store keyed resume on it; moving Reflect onto the registry (step 2) retired that. |
| Cursor | Position in the archive, bound to the identity (device, inode, size, mtime) of every file the import reads, not only the chosen path. For a folder (Apple Mail's `.mbox`, a folder of WhatsApp exports) that means a manifest of its files, and for a zip its members. A large import resumes after a restart; if any file in an unfinished archive changed or went missing, the import stops and says so instead of resuming against different bytes. |
| Picker | The local-files picker (`workers/local-files/scope-browser.ts`), extended to offer files as well as folders in a "choose one file or folder" mode (today it lists folders only, `scope-browser.ts:121`). |
| Reading | Only the chosen path, through the scope-safe reader (`core/scope-safe-fs.ts`), so no symlink escape. `ScopeRoot.readFile` loads a whole file, so archive reading adds a bounded streaming read on `openRelative`. A message or record over a memory bound is not read and is reported (`message_too_large`, `note_too_large`); the text of one that is read is never cut (see "No length cut"). |
| Storage | Items go into the shared connector store and pipeline unchanged: extraction, per-item tiers from privacy settings plus the judge, index, search, Analyst. No archive-specific code after the connector. Importers set no source-level floor; each item gets its own tier. Until the private model judges an item, its content is held Private (below). |
| Removal | Per archive, not per source. Lifecycle delete today removes a whole source's store (`data-lifecycle.ts:657`) and Reflect has one store for the whole family (`data-lifecycle.ts:404`), so removing one import that way would erase the others. Remove cancels and fences that archive's running work, deletes its items, chunks, vectors and derived data (including private answers built from it, `data-lifecycle.ts:691`), and never touches the user's file. |
| Operation | One operation, `archive_import` (start, status, remove), on the public tool lists, CLI, and MCP. The dashboard calls the same core functions as the operation. An agent cannot import a path just by naming it: start needs a path the user approved, through the dashboard picker or a confirmation the user answers, the same approval the scope picker gives other sources. A prompt-injected or accidental tool call can at most ask. |
| Dashboard | An "Archives" source showing each import: format, file name, item count, date range, progress, two lists behind one button ("Not imported": what Olympus does not have, such as unreadable or too-large messages and pictures and files not imported; "How it was read": what it took as given or left out on purpose, with nothing lost by it, such as a time zone or date order, items repeated and imported once, WhatsApp notices and empty messages), and Remove. Every problem has a route to exactly what failed. |
| Findings | What a connector did not read, left out or took as given is reported as findings, each of a kind with one plain sentence in the dashboard's words (a one and a many form), and each counted once by its position however a restart cuts its pages. An assumption is never one generic finding: each thing taken as given is its own kind, so the sentence says exactly what and, where it is known, the value taken. The kinds every format can use (`ARCHIVE_COMMON_FINDINGS`): `time_zone_assumed` (times carry no zone: read in this computer's), `date_order_assumed` (dates do not say which part is the day: read day first), `item_start_assumed` (a line shaped like the start of an item was taken as one), `zip_overlap_unchecked` (a zip too large to check its members for shared bytes: taken not to share; every engine that opens a zip reports it through one helper, `reportZipOverlap`, once per zip). A format's own kinds live with its connector. `assumption` is kept only as the fallback sentence for an archive recorded before the split; nothing reports it now. Which of the two dashboard lists a kind is shown in is one table beside the sentences (`listOf` in `DASHBOARD_ARCHIVE_COPY`, `workers/dashboard/vocabulary.ts`); `test/archive-import-finding-lists.test.ts` fails when any kind a format reports has no entry, and a kind the table does not know is shown under Not imported, so nothing is hidden. The agent view of `status` has the same two lists (`not_imported`, `how_read`). `item_truncated`, `text_cut`, `service_message` and `status_updates` are reported by nothing now and stay only so an archive imported before reads in plain words. |

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

### No length cut

No format cuts an item's text (2026-10-25). The cuts were each one million
characters (mail body, note, Telegram message, WhatsApp message) and reported
as `item_truncated`; they are removed. Before removing them, each step an
item passes through was checked for a very long item:

- **Chunking and the full-text index.** `chunkText` splits any text into
  4,000-character chunks with no total cap; the full-text index holds one row
  per chunk. A word at the start, the middle and the end of one item is found.
- **The private judge and the classifier.** The classifier's detectors scan
  the whole text; the judge reads a bounded excerpt of any item (the sniffer
  excerpt is 1,200 characters, the model scorer's bound 2,000), so its work
  does not grow with the item.
- **Embedding.** The embed lane takes a bounded number of chunks per pass, so
  a long item is several passes, not one large one.
- **The per-listing byte budget.** The first record of a listing is always
  read, so a record larger than the budget still moves the import on.

What stays is a memory bound on the one record a reader holds whole. A record
over it is not imported, and is reported in plain words (`message_too_large`,
`note_too_large`, or `section_not_imported` for an account entry), never cut
and never silent:

| Format | Bound | Why it stays |
|---|---|---|
| Mail (mbox) | 32 MiB per message | A 30 MB message peaked at 1.18 GB of memory on this Mac (2026-10-25) |
| Reflect, Roam | 16 MiB per record or Markdown file | A 15 MB Roam page peaked at 730 MB |
| Telegram | 16 MiB of JSON per message or account entry | A message at the bound (8 M characters) peaked at 494 MB |
| WhatsApp | 8 MiB per message (4 MiB per line) | A message at the bound peaked at 450 MB |

Those were measured end to end through the real import (a synthetic export of
one very long item between two short ones, one pass, the secure store, search
on the first, middle and last word of the long item): a 1 M-character item
takes about 2 seconds and 180 MB, 5 M about 10 seconds, 8 M about 16 seconds,
30 M about 63 seconds; the time grows in step with the length, not faster.
The bounds are the ones the formats already had. They stay because one record
at its bound already takes up to 1.2 GB; past it nothing is attempted.

### Reflect and Roam, promoted

Built in step 2 (2026-10-24). Both are formats in the registry (family `note`,
providers `reflect` and `roam`, citation labels "Reflect" and "Roam"), read
through the shared JSON stream and zip readers, with the shared notes engine
(`workers/archive-import/notes/`) doing the paging, resume and findings, so
each format is a record parser and a place to find its records. The old
`workers/reflect/` and `workers/roam/` connectors and their tests are deleted,
and their four entries are off the public-surface allowlist. The
`source-family.ts` allowlist entry stays: its other planned postures still
make its reason true.

- **No prior.** The old connectors defaulted to `secure_local` (Private),
  which would have left ordinary notes Private for good: a configured resting
  tier is never lowered by an automatic signal (`resolveVerdicts` in
  `tier-classifier.ts`). The new connectors publish no prior, only the title
  and tags, so each note gets its tier from the privacy settings and the
  judge like every other imported item, and is held Private until the private
  model judges it (the lane option above). Nothing sets `internal` as a
  default either.
- **One note per record.** A Reflect JSON record, a Reflect Markdown file, or
  a Roam page (its blocks as nested `- ` bullets, text as written). Notes with
  nothing written in them are counted as left out (`note_empty`), never
  imported as titles alone or reported as errors. Two records with one id
  are two notes: identity includes the record's place in the file.
- **Dates.** Every item carries `metadata.authoredAt`: the note's own created
  time, else its edited time, else (Roam and Reflect daily notes, in Reflect's
  JSON as well as its Markdown) the day in its title, else the day the archive
  file was saved, which is reported as `note_date_assumed`.
- **Bodies and front matter.** A Reflect body is flattened only when it is
  positively an editor document (an editor node that carries its text or its
  children, alone or in a list); text that merely looks like JSON
  (`{"budget":100}`, `{"type":"text","value":"..."}`) is the note, kept as
  written. Once the document is recognised each node is read on its own: a
  node of a kind Olympus has no rule for, a text that is not text and children
  that are not a list are counted as unsupported and never hide the readable
  nodes beside them. A Roam block is checked the same way (a `string` that is
  there and is not text is unsupported, whatever its children are). A Markdown file's leading
  `---` block is front matter only when every line is a `key: value` pair,
  list item or comment and a key is one Reflect writes (title, dates, tags,
  id); any other text between two rules stays in the note.
- **Findings.** `note_empty` (left out: the body is there and empty, or there
  is none), `note_unreadable` (not a note), `note_too_large` (a record, or a Markdown file, over
  16 MiB is not read and nothing of it is kept; its place is named), `note_content_unsupported` (a body,
  editor node or block of a kind Olympus has no rule for: the rest of the note
  is imported, and a note with nothing else is left out; this is never
  reported as `note_empty`; the same idea as Telegram's
  `message_content_unsupported`), `note_date_assumed`, and the common kinds: `media_not_imported` (other
  files in a zip), `file_damaged` (bad checksum, cut-short JSON), `section_not_imported`
  (a JSON document without the list its notes would be in, or with another
  kind of value there; a Roam document that is not a list of pages; a JSON
  file in a zip that is not this format's). A file whose list is there and
  empty (`[]`, or `{"notes": []}` for Reflect) is an export with no notes and
  reports nothing, in a zip as well as on its own.
- **Streaming.** Records are read one at a time from the JSON stream, a zip
  member through streaming inflate; a page boundary keeps the byte offset,
  the member's running checksum and the JSON reader's resume point, and a
  deflated member's inflater is parked between pages. No whole-file read.
- **Bounds.** The listing's byte budget is held at every record and every
  Markdown member, not after a whole file; the first record of a listing is
  always read, so a listing always moves on. Whether the import is still
  wanted is asked before each record and with every chunk read, so a huge
  record or Markdown member does not outlast a removal: a stop part-way
  through a record is resumed from the last whole one. A JSON file in a zip is
  asked about (its first bytes, and the first record's keys when those do not
  say) under the same limits: the unit limit is checked before each member is
  asked, and the bytes read to ask are charged to the byte budget whether the
  member is taken or not. A deflated member resumed deep inside it (a restart
  empties the parked inflater) is inflated up to the resume point in steps of
  at most 16 MiB or the listing's budget, whichever is smaller, charged to
  the budget; when it is spent the inflater is parked where it got to and the
  next pass goes on, so no pass spends more than a budget catching up. (The
  detection reads and the first-record probes open a member at its start, so
  they have nothing to catch up to.)
- **Checksums.** A stored member's CRC-32 is kept at every whole record as the
  records are handed out (`resume-crc.ts`, generic), so a stop in the middle
  of a record longer than a chunk still resumes with the sum at the last
  whole one; a resume point that carries none is replayed from the member's
  start (charged to the byte budget) before the member is entered. A member
  whose end does not say its checksum matched (`crcOk` is anything but true,
  including not checked) is reported as `file_damaged`, never accepted.

What is known about the real exports. Confirmed from the apps' documentation
and community write-ups: Reflect exports to JSON, CSV, Markdown (zip) and HTML
(zip); the Markdown zip is flat, daily notes are named like `Tue, March 21st,
2023`, and backlinks are Reflect links; Roam's Export All offers JSON,
Markdown and EDN, delivered as an archive. Community-sourced only, with no
published specification: Roam's page keys (`title`, `uid`, `children`, and
`string`, `create-time`, `edit-time` in milliseconds on blocks). Not
confirmed against a real export: Reflect's JSON field names (read liberally:
`id`/`uid`, `subject`/`title`, `content`/`body`, a `document_json` editor
document stored as a JSON string, `created_at`/`createdAt`), whether Reflect's
JSON arrives as a bare file or in a zip (both are read), Reflect's Markdown
front matter (read if present, not required), and the member names inside
Roam's zip (a `.json` member is read when its first record's keys show the
format's hand; the others are left out and counted). The order of the keys
inside a record is unverified too: detection reads past a long text to find
them, so it does not depend on it. A real export from each app is the next
check; anything that differs becomes a parser change, not a new path.

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

The old connectors loaded a whole export at once, so a large export could
run the engine out of memory. The new ones read incrementally (above): only
the current page of notes is held in memory, and no export is too large to
import, only a single note over the per-record bound is left out.

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
  The names that say what an export is by themselves (`_chat.txt`, `WhatsApp
  Chat with ….txt`, `WhatsApp Chat - ….txt`, `WhatsApp Chat….zip`) are kept
  apart from that broad pattern (`signatureNames` in the format definition)
  and are listed and read first, in a folder and inside a zip, so ordinary
  text files ahead of the chat cannot hide it. A zip with no signature member
  whose text files the first look (32 members) did not all read says how many
  it did not (`files_not_looked_at`, "in what you chose"); when nothing is
  detected, the refusal says the look was not complete, in the one sentence
  every format shares (`ARCHIVE_LOOK_INCOMPLETE_ADVICE`, also what a look
  that ran out of its byte allowance says: choose just the export file, or a
  folder or zip that holds only the export). That refusal is
  generic, for every format: files nobody asked for by name that the folder
  look did not read (`othersNotLookedAt` on the probe) count toward it, so a
  format that detects from the first bytes alone is never refused silently.
  Residual: when another format is detected, such an unread file is not
  reported on the record (a media folder would otherwise show thousands).
- **A pass is bounded in bytes, not only in items.** A pass reads at most
  `maxBytesPerListing` (256 MiB) of the archive: the date-order scan, every
  line read or dropped inside a long message, and the re-inflating of a
  zip member to a resume point all count. When the budget is spent the pass
  ends with a resume point, and the next pass goes on from it. A resume point
  can sit inside a message that was cut (dropping lines until the next
  header), so a message of any length costs bounded work per pass.
- **Catching up in a deflated member is stepped, not one call.** A deflated
  member cannot be entered in the middle, so a cold resume re-inflates from
  its start. The shared zip reader does that in steps of at most 16 MiB of
  output (one inflate push, 16 KiB in, can add up to about 17 MiB for highly
  compressible data): `next()` returns an empty chunk and `catchingUp` stays
  true while it is still catching up. The connector calls `catchUp()` in a
  loop against the pass budget; when the budget is spent it parks the
  inflater in the continuation cache and ends the pass with the resume point
  it started from (an empty page, not done). The next pass takes the
  inflater from the cache and goes on; if the cache was lost (a restart), the
  catch-up starts over, which the budget counts again. Any other reader of
  zip members wires it the same way (the header comment of `zip-reader.ts`
  gives the recipe); mbox and Telegram read no zip members.
- **Stored zip members keep their checksum.** The CRC-32 of everything before
  each message header travels in the resume point, so a stored member resumed
  at a header that straddled a read still verifies to its end. A member that
  ends with a checksum that did not match, or that was not read to its end, is
  reported as `file_damaged`, because what was read of it may be wrong. A deflated member resumes from a parked inflater when the resume
  point is in the last chunk read, and otherwise by re-inflating from the
  start of the member in budgeted steps (above).
- **Dates.** The export writes wall time with no zone and in the phone's
  locale order. The order is decided per file from its own headers: the order
  most headers of the file's own style say wins (up to 25 votes, within the
  first 16 MiB) (a day above
  12 settles it for that header), so one header pasted into a message cannot
  decide a file. A header dated before the one above it is left out of the
  vote when it cannot be read as on or after it (up to two in a row; more are
  taken as the file's own dates), so a pasted older date after an ambiguous
  `01/02/2026` cannot turn the file month first. When nothing says, or the
  votes tie, it is read day first and reported as `date_order_assumed`. The time is read in this computer's zone and
  reported once per archive as `time_zone_assumed`. Dates with a weekday or month name, non-Latin
  digits and non-UTF-8 files are not read.
- **Pasted headers.** A line inside a message body that looks like a header
  starts a new message, in its own style, because the format cannot say
  otherwise. Each one in a style other than the file's, or dated before the
  header before it, is counted as `item_start_assumed`, so the person is
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
  place in the file instead of a number, and so is a message dated before the
  one above it (a pasted older header between two real, identical messages
  cannot give both the same id); such a message is not shared across
  overlapping copies. `item_repeated` is counted by each message's position in
  the files beyond the position already counted, not by the page it is in, so
  a restart that cuts its pages differently counts each repeat once.
- **Left out, and counted.** Notices from WhatsApp itself (`system_message`)
  and messages with no text (`message_empty`) are skipped and counted; they
  are not losses, so the dashboard lists them under "How it was read". The
  status updates chat is read like any chat (it was left out before
  2026-10-25; `status_updates` stays only for an old record). Media stays in
  the message text as the phone's marker and is counted as
  `media_not_imported` ("the archive refers to" it). A message over 8 MiB is
  not imported and is counted as `message_too_large` (no length cut; see "No
  length cut"). The notices, empty messages and assumptions
  of a page are told as one finding per kind, and each carries the place of
  every occurrence (`ArchiveImportFinding.at`); the state store counts only
  the occurrences past the position it counted before, so a restart whose
  pages are longer than the first pass's counts each once, and none is lost
  to a tally that started at an occurrence already counted. The other
  archive connectors tell each finding at its own message or record, so need
  nothing more.
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
  - *Items.* One per message, service messages included. The thread is the chat, keyed by its position
    in the file (`chats:3`), because a chat's own `id` repeats across users,
    groups and channels. The text is the words with links kept (`label
    (address)` when they differ), then a line per picture, file, contact,
    place, poll, to-do list, invoice or game (the words of a poll or a list
    can be formatted, so they are read as text, not as strings). `authoredAt`
    is `date_unixtime` (releases 4.0 and later), else the zone-less `date` read in this computer's zone and
    counted once as `time_zone_assumed`.
  - *Control characters.* Telegram writes them as `\xNN`, which is not JSON
    and stops a strict reader at the first one. A byte filter
    (`telegram/json-repair.ts`) turns each into four spaces of the same
    length, so byte offsets in resume points stay file offsets.
  - *Service messages.* A join, a call, a pin, a new title, a group made and
    the other actions are items in their chat: a plain sentence from the
    action's own fields (who called and for how long, who pinned which
    message, who joined), with the sender and the time. They are not left out.
  - *Account items.* Each part of a whole-account export that is not a chat
    (personal information, contacts, frequent contacts, sessions, web
    sessions, profile pictures, stories, profile music, other data) is items
    too: one per entry a person would cite (a contact, a session), the
    profile and the other data one each, in a thread of their own per part
    titled "Telegram account: contacts" and so on. The text is a headline and
    a line for each field the entry carries (`telegram/account.ts`). They
    carry no `authoredAt`: a contact's or session's dates are in the text, and
    the chats' date range stays the messages'. They go through the same lane
    as the messages (held Private until the private model judges each one;
    nothing is tiered by the connector). A profile picture is media: named,
    never opened.
  - *Left out, counted.* Messages with nothing to read are `skipped`
    (`message_without_text`, listed under "How it was read"); media files are
    named in the text and counted as `media_not_imported` (never opened), and
    so is a file the export itself left out, marked "not in the export" and
    keeping the name the export gave it, so a search for the name finds the
    message. A message that carries what the reader does not know (a
    giveaway, a rich message, paid media, a message the writer marks
    `unsupported`, any object the reader has no rule for) is
    `message_content_unsupported`, a gap and not "nothing to read"; its
    words, if it has any, are kept. A message, or an entry of the account
    export, over 16 MiB of JSON is not built: a message is `message_too_large`
    and an entry is `section_not_imported`; no text is cut. A file cut short
    imports what came before and counts `file_damaged`.
  - *Resume.* The cursor is the JSON reader's point after a message or after
    an entry of a part that is not messages, bound to the manifest; any other
    cursor stops the import. The profile and the other data are one item
    each, so a point is placed after the whole of one, never inside it. A
    pass counts the bytes of those parts against its budget too. The reader returns every message it finished before a
    mid-file JSON error, so damage costs only the messages from the damage on.
  - *HTML form.* `messages.html` is recognised and turned away with plain
    advice to export again as JSON (`unsupportedVariants` on the format).
  - *Limits of the finding shape.* A finding has no name or path field, so
    a media gap cannot name the file (the item text does), and the one
    account entry that can be too large to build is counted, not named.
- Both import today as snapshots alongside any live capture of the same
  account, and the overlap is stored twice. Since 2026-10-25 the owner
  requires one dataset: an export is a second input to the source's own
  pipeline, merged with live capture, as designed in
  [one dataset, one pipeline](archive-live-one-dataset.md).

## Order

1. Mail (mbox) as the first format, with the spine it needs: format
   registry, detection, archive identity and checkpoints, per-archive
   removal, `archive_import` operation, Archives source in the dashboard,
   the streaming reader and the file-selecting picker. The
   hold-until-judged rule lands here too, through its classifier gate.
2. Reflect and Roam onto the registry, with streaming reads and no prior
   (each note judged per item, held Private until then); their allowlist
   entries removed. Built 2026-10-24.
3. WhatsApp chat export, with the selected-file, scope-safe reads (built).
4. Telegram Desktop export (built 2026-10-24).

Each step is one PR with focused tests on synthetic fixtures (never real
exports), plus the held-out eval where the step changes the source pipeline.

## Open questions

- **Imported mail that overlaps live Gmail.** Answered 2026-10-25 (owner):
  no duplicates. Mail of the connected account feeds the Gmail pipeline and
  matches by Gmail id or `Message-ID`
  ([one dataset, one pipeline](archive-live-one-dataset.md)).
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
capture apart from a successful empty import, and the export and live
capture make one dataset with nothing stored twice; history merged that way
is deleted with the account, not on its own (owner, 2026-10-25,
[one dataset, one pipeline](archive-live-one-dataset.md)).

Status 2026-10-24: the first paragraph is met for all five formats on fresh
Mac and Linux installs of main `1e043925` (the release check's archive leg,
55 of 55 checks). Each format is imported through the agent tool with the
dashboard's approval; the picker, the private-model-off test and the
changed-file stop run on the mbox fixture, since the spine they exercise is
shared. The second paragraph waits for an owner canary with a paired phone.
