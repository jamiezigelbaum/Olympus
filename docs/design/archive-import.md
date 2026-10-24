# Import an archive

Status: owner direction 2026-10-23. Step 1 (mail with the shared spine),
step 2 (Reflect and Roam) and step 4 (Telegram Desktop), the last two on
2026-10-24, are built; step 3 (WhatsApp) is not. Where this page and the code
differ, the code is current.

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
- **Imported archives stay Private until the private model judges them**
  (owner, 2026-10-23): the local model, or Venice Private where there is no
  local model, as for every source. Personal-first does not apply to them: it assumed a
  wait of minutes, and an import puts years of items in the queue at once.

## Where things stand

| Format | Today |
|---|---|
| Mail (mbox) | Built in step 1 (2026-10-23): the shared spine in `workers/archive-import/`, and a thin mbox connector (`workers/archive-import/mbox/`) that splits the file itself and parses each message with `postal-mime`. Gmail items come from the Gmail API's JSON, so Gmail shares none of it. |
| WhatsApp chat export | Parser and connector exist (`workers/whatsapp/connector.ts`, `parseWhatsAppChatExport`) and are tested, but nothing in the product calls them. Live WhatsApp capture is wired separately. |
| Telegram Desktop export | Built in step 4 (2026-10-24): a thin connector (`workers/archive-import/telegram/`) that streams a JSON `result.json`, whole-account or single-chat, as family `chat`, provider `telegram_export`. Live Telegram capture (`telegram-messages/`) is a different provider in different stores, and the import never opens it. |
| Reflect export | Built in step 2 (2026-10-24): JSON (a list of notes, or `{"notes": [...]}`, either key style, in a `.json` file or a zip) and Markdown (a zip of `.md` files), as formats `reflect-json` and `reflect-markdown` with thin connectors in `workers/archive-import/reflect/` over the shared notes engine in `workers/archive-import/notes/`. The old connector is deleted. CSV and HTML exports are not read; choosing one gets the supported-formats answer. |
| Roam export | Built in step 2 (2026-10-24): "Export All" as JSON (a list of pages with nested blocks, in a `.json` file or a zip), format `roam-json`, `workers/archive-import/roam/`, same engine. The old connector is deleted. Roam's Markdown and EDN exports are not read. |

`source-family.ts` already models this: ingest mode `archive_import`,
credential kind `archive_path`, custodian `archive_importer`. Reflect and Roam
are still declared there as `planned` (Personal, S3); `working` would read
false while their notes are held Private until judged.

## Shape

An archive is a source with no account and no live updates. Each imported
archive is a snapshot: "Imported 23 Oct 2026, mail from 2004 to 2019".

| Piece | What it is |
|---|---|
| Format registry | One registry of archive formats (`core/archive-formats.ts`, pure data like `core/file-scope-sources.ts`). Each entry: format id, label, a `detect(path)` probe, the source family, and a connector factory. Adding a format adds one entry and one thin connector. Nothing downstream branches on format. |
| Detection | Cheap probes on names and the first bytes, never a full parse: an mbox starts with a `From ` line; Apple Mail's export is a `Name.mbox` folder holding an `mbox` file; WhatsApp is `_chat.txt` or a zip holding one; Telegram Desktop is `result.json` with its export keys; Reflect JSON and Roam JSON by key names in the first bytes of the `.json` file (or of the one JSON member of a zip), the two sets never overlapping; Reflect Markdown by a zip of `.md` files that shows Reflect's hand (Reflect in the file name, a daily-note file name such as `Tue, March 21st, 2023.md`, or a reflect.app link) and holds no JSON, so a Roam Markdown zip is not mistaken for it. No match: say so and list what is supported. Two matches: ask. |
| Connectors | Thin `SourceConnector`s (contracts.ts), one per format. Pages honour the `done` / `truncated` rule in contracts.ts. |
| Archive identity | Each import gets a persistent archive id at start, used as the connector instance id and `accountScope`. Checkpoints key on it, so two imports of the same format never share a resume position. The old Reflect connector used one constant connector id and the store keyed resume on it; moving Reflect onto the registry (step 2) retired that. |
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
  time, else its edited time, else (Roam and Reflect daily notes) the day in
  its title, else the day the archive file was saved, which is reported as
  `note_date_assumed`.
- **Findings.** `note_empty` (left out), `note_unreadable` (not a note),
  `note_too_large` (a record over 16 MiB is not read; its place is named),
  `note_date_assumed`, and the common kinds: `item_truncated` (text over one
  million characters keeps its start), `media_not_imported` (other files in a
  zip), `file_damaged` (bad checksum, cut-short JSON), `section_not_imported`
  (a Roam document that is not a list of pages).
- **Streaming.** Records are read one at a time from the JSON stream, a zip
  member through streaming inflate; a page boundary keeps the byte offset,
  the member's running checksum and the JSON reader's resume point, and a
  deflated member's inflater is parked between pages. No whole-file read.

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
Roam's zip (any `.json` member is read). A real export from each app is the
next check; anything that differs becomes a parser change, not a new path.

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

- **WhatsApp chat export** (`_chat.txt`, or the zip WhatsApp shares). The
  existing parser (`parseWhatsAppChatExport`) is reused, but the connector
  cannot join as is: it reads every `.txt` and `.zip` in a folder
  (`whatsapp/connector.ts:321`), so pointing it at one chat's parent folder
  would import neighbouring chats, and its plain reads bypass the scope-safe
  reader. It changes to read exactly the selected files through the
  scope-safe reader. Picking a folder of exports imports each chat in it, as
  the user chose.
- **WhatsApp message identity.** Today an id hashes chat, time, sender and
  position only (`whatsapp/connector.ts:298`), so a `.txt` and a `.zip`
  export of the same chat in one folder can overwrite messages whose text
  differs. Ids gain the source file (or zip member) identity and a hash of
  the message text. Test with an overlapping-export fixture.
- **Bounded parsing.** The parser splits the whole text and keeps every
  message (`whatsapp/connector.ts:155`), and zip entries are inflated whole
  (`whatsapp/connector.ts:397`). Both become incremental: line-by-line
  parsing, streaming inflate, with limits on expanded bytes and zip members.
  Hitting a limit fails visibly, naming the file. The same rule applies to
  Telegram's `result.json` (streaming JSON) and to any zip a format accepts.
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
2. Reflect and Roam onto the registry, with streaming reads and no prior
   (each note judged per item, held Private until then); their allowlist
   entries removed. Built 2026-10-24.
3. WhatsApp chat export, with the selected-file, scope-safe reads.
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
