---
name: import-archive
version: 0.1.0
description: Import an old export the user wants searched, such as a mail export (an .mbox file from Google Takeout or Thunderbird, or an Apple Mail .mbox folder) or a WhatsApp chat export (the .txt or .zip from Export Chat). archive_import only asks; the user approves every import and every removal on the Olympus dashboard on their computer.
triggers:
  - user mentions an old mail export, a Google Takeout download, an .mbox file, or an Apple Mail export they want searchable
  - user mentions an exported WhatsApp chat (a _chat.txt, a "WhatsApp Chat with" file, or the zip WhatsApp shares) they want searchable
  - user asks to remove an archive they imported earlier
  - user asks how an archive import is going
tools:
  - archive_import
mutating: true
---

# Import Archive

Use this skill when the user has an old export on their computer and wants
Olympus to search it like any other source. Today that means mail: an `.mbox`
file (Google Takeout, Thunderbird) or an Apple Mail export folder ending in
`.mbox`; and WhatsApp chats exported with Export Chat: the `.txt`, the `.zip`
WhatsApp shares, or a folder of them. A chat export is a snapshot: later
messages are not added. In a folder, only files named the way WhatsApp names
an export (or zips holding one) are taken; a chat saved under another name
imports when the user chooses that file by itself. Messages that appear in two
export files of the same chat are imported once. When a folder holds more files
than the first look takes in, Olympus says some files were not looked at; ask
the user to choose the export file itself.

A Telegram Desktop export works too: its `result.json` (or the folder that
holds it), exported as Machine-readable JSON. Messages are imported as text;
pictures and files are counted, not imported. If the user only has the HTML
form (`messages.html`), tell them to export again from Telegram Desktop
(Settings, Advanced, Export Telegram data) with the format set to
Machine-readable JSON.

A Telegram Desktop export works too: its `result.json` (or the folder that
holds it), exported as Machine-readable JSON. Messages are imported as text;
pictures and files are counted, not imported. If the user only has the HTML
form (`messages.html`), tell them to export again from Telegram Desktop
(Settings, Advanced, Export Telegram data) with the format set to
Machine-readable JSON.

## The rule

`archive_import` only asks. The user approves every import and every removal on
the Olympus dashboard on their computer, and nothing happens before they do.

- Never open, read, copy, list or move the export yourself. Olympus does not
  look at the path either until the user approves it. Do not use bash, shell
  or file tools to inspect it.
- Never retry, rephrase or look for another route to get around the approval.
  A second `start` for the same path adds nothing.
- The file stays where it is. Removing an archive deletes what Olympus made
  from it, never the file.

## Importing

1. Offer it when the user mentions an old export. Ask for the full path of the
   file or folder if they have not given it.
2. Call `archive_import` with `action: "start"` and the `path` (it must start
   with `/`).
3. The result is `ok: false, code: "needs_approval"`. That is expected, not an
   error. Tell the user, in the words of its `message`, to open Olympus on
   their computer and choose Import under Sources, Archives. `open` names that
   page (`olympus://open/archives`, or the `page` link).
4. Follow it with `action: "status"`. Do not ask the user again while it waits.

If Olympus already holds an earlier import from the same path, the result
carries it as `existing_record` (`archive_id`, `name`, and its actual `state`:
imported, importing, stopped or removing) beside the request. A matching path
does not show that the file is the same export: it may have been replaced by a
newer one. So `start` still records the request, and does not say the file is
already imported. Olympus has not opened the file. When the user approves,
Olympus opens it and compares it with what it already holds; if it is the same
export it says so and imports nothing. Do not tell the user it is a duplicate
before then.

If `code` is `too_many_requests`, tell the user the dashboard already has
requests waiting and to answer those first. Any other `ok: false` with a
`message` is a refusal: tell the user in those words.

Names in `message`, `existing_record` and `status` are shown with every
character that cannot be seen written out, as `⟨U+200B⟩`. Repeat them as
given; do not tidy them. If a name carries one, say so: the file name has a
hidden character.

## Status

`action: "status"` lists each archive with its format, file name, folder, date
range, message counts, progress, how many messages are judged and how many still
wait for the private model, anything that could not be read in plain words, and
whether it stopped. It also lists the requests waiting for the user. It carries
no message text, subject or snippet.

- Imported messages stay Private until the private model has judged them. A
  large "waiting for the private model" count means the private model is
  slow or off, not that the import failed. Say so in those terms.
- A list Olympus cannot read comes back as unreadable (`code:
  "archives_unreadable"`, or `requests_unreadable`), never as an empty list.
  Report it as unreadable. Do not say there are no archives.
- `archive_id` narrows `status` to one archive.

## Removing

`action: "remove"` with the `archive_id` from `status`. It also needs the
user's approval on the dashboard (the same `needs_approval` result). Tell the
user to choose Remove on the request. Then follow with `status`; the archive is
gone when it no longer appears.
