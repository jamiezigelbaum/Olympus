# File tidy with Olympus's private model

Status: owner direction 2026-10-25. Planned, not built. Independent design
review (Astra, High, 2026-10-25, against main `2b58a8ef`): sound with changes;
the changes are folded in below. Where this page and the code differ, the code
is current.

## Outcome

A person can ask their own AI to tidy a folder tree: rename files by content,
re-home them and set proven duplicates aside, with every change undoable. For
files Olympus judges Private, the AI gets a short description written by
Olympus's private model on this computer instead of the file's contents.
Secrets go to no model.

Done when the acceptance checks below pass on a fresh install and on a
consented real folder.

## Owner decisions (2026-10-25)

- **Olympus never changes the person's files.** Moving, renaming, setting
  aside and undoing are the job of a separate skill that the person's own AI
  runs. Olympus does not plan, approve or carry out any change.
- **The skill is separate from Olympus.** It lives in Agent-Skills
  (`skills/personal/file-tidy`, today's consent-mode skill, gains an Olympus
  edition) and may be mirrored to ClawHub. Olympus's setup can link to it;
  Olympus does not bundle it, so "Olympus reads your files, it doesn't change
  them" stays true (`site/terms/index.html`).
- **Olympus offers one read-only, local command.** It runs Olympus's
  classifier, secret detection and private model on files the person names,
  and prints a tier plus a few fixed fields. Nothing else of Olympus is
  involved: no ingest, no index, no agent tool.
- **Without a private model, Private files are tidied from their names only.**
  They are never read by a cloud model.
- **Names built from Private content are capped** to a date, a counterparty and
  a document type from a fixed list. The rule that existing Private file names
  may be seen (names are Personal, content is Private) does not cover a name
  *generated* from Private content, which would move content into the name.
- **After ingest is fine; the skill does not depend on Olympus's index.**

## Who does what

1. The person installs the skill into an AI that can work with files on this
   computer (Claude Code, Codex, OpenClaw, a desktop agent). An AI running in a
   browser, such as ChatGPT on the web, cannot do this.
2. The skill's helper takes an inventory of the folders the person approved.
3. For each file the helper would read, it asks Olympus's command first. Olympus
   answers with the tier and, for Private files, the fixed fields. The helper
   passes the AI full excerpts only for Personal files, fixed fields for Private
   files, and the name alone (or an opaque handle) for Secrets and unclassified
   files.
4. The AI proposes a plan. The person approves it.
5. The helper checks and applies the plan, keeps the journal, and moves set-aside
   files to a trash folder. Undo replays the journal.

## The Olympus command

A new public CLI command (name to be settled at build; working name
`olympus files describe`), added to `V0_4_PUBLIC_CLI_COMMANDS` in
`src/core/public-surface.ts`. Not a native or MCP operation, so no agent can
reach it through Olympus's tools.

- **Input:** explicit file paths. No folder walking, no free prompt, no remote
  route.
- **Reading:** the bounded, descriptor-based reading local files already use
  (`src/workers/local-files/connector.ts`), then the shared classifier
  (`src/workers/classification/`) and the shared `AnalystModel` for the
  description. No file-tidy logic inside the `Analyst` (`docs/CONTRACTS.md`).
- **Output:** versioned JSON per file: tier; for Private, a date (`YYYY-MM-DD`
  or coarser), a counterparty, a document type from a fixed list, or nothing
  when the model is unsure. No free text, no explanations, no raw model
  response, no parser or model error text (today's model errors can carry
  response text: `src/core/analyst-built-in.ts`).
- **Counterparty is the leakiest field.** "Oncology clinic" plus a date says a
  lot. A counterparty is released only when it matches a label the person
  approved, or the person reviews it locally first; otherwise it is left out.
- **Names are checked too.** A file name can itself hold a secret
  (`src/workers/classification/secret-locations.ts`); a withheld name comes
  back as an opaque handle.
- **Unknown means withheld.** A failed, unfinished or provisional
  classification is never treated as Personal.
- **Local only.** The command uses the built-in private model on this computer
  and refuses otherwise. Today the classifier prefers a configured private lane,
  which can be Venice (`src/workers/classification/sniffer-lane.ts`,
  `built-in-sniffer.ts`); this command must not follow that preference
  silently. Whether a person may choose Venice for it is an open question below.
- **One description per file version.** Repeated or targeted describe calls on
  the same file must not become a way to pull content out piece by piece.
- **A status mode** says, without downloading anything, whether this machine is
  supported, whether the private model is installed and turned on, and which
  size it has (16 GB and up gets the 4B model, 8 GB the 2B one, less gets none:
  `src/workers/source-index/built-in-reasoning/manifest.ts`). Asking for a
  description must never start a model download the person did not turn on.

## What the privacy promise can honestly say

- **Enforced only inside the helper and the command.** The person's AI can open
  files itself; the skill can only tell it not to. Docs say so plainly. Stronger
  enforcement would need an AI sandbox without access to the files plus a
  narrow tool that makes the changes, which is out of scope.
- **Secrets, reworded.** Files suspected from their name or location are never
  opened. A secret found inside a file during the local check is never sent to
  any model and the file is then handled by name only. "Secrets are never
  opened" is not promised: Olympus can only find a secret inside a file by
  reading it (`src/workers/classification/tier-classifier.ts`).
- **Duplicates.** Hashes and duplicate groups leave the computer only as group
  handles, never as content.

## The skill: changes needed before an Olympus edition

These are defects in today's `scripts/tidy.py` and `SKILL.md` (Agent-Skills),
found in the same review. They apply to consent mode too.

- **Duplicate proof expires.** `trash-plan` re-reads the file without keeping
  the hash proof or naming the copy that stays; an edit in between can trash a
  changed file. Bind each set-aside to both files' verified versions and the
  kept copy, and re-check just before acting. A visual (render) match is never
  enough to set a file aside automatically.
- **Apply can move the wrong file.** It checks size, time and inode, then
  renames by path later; a file swapped in between gets moved. Undo checks less
  than apply, and records success only after restoring, so a crash mid-undo is
  not recoverable. Apply also accepts a plan without re-applying the
  folder-protection rules that validation used.
- **Sync during a tidy.** Remove "sync clients editing file contents is fine"
  from `SKILL.md`; pause editors and sync while changes are applied, and keep a
  real backup (the trash folder is not one).
- **Secrets inside extraction.** The helper extracts before it detects, reads
  only the first pages or characters, and `compare` renders any path with no
  secret check. Route hashing, extraction and comparison through the same gate.
- **Case-only renames** on a Mac currently fail as "target exists"; skip them in
  the first version.
- **Shared and synced roots.** Leave shared folders and moves that cross a
  source's approved scope out of the first version.

## Olympus's index after a tidy

- Local files: identity is a hash of the path (`localFilesItemId`), so a rename
  is a removal plus a new file; removal needs the next pass to notice it.
- Dropbox: identity is the Dropbox entry id and a moved folder is not deleted
  (`src/workers/dropbox-files/connector.ts`); whether every sync-client move
  keeps the id is unverified.
- Tier rules can depend on path (`privacy-profile.ts`), so a move can change a
  file's rule. After a tidy, check that old paths are gone, citations point to
  the new paths, and privacy rules still apply.

## Docs and legal wording

Folded into the one legal pass (`olympus-legal-review`) when the command ships,
not earlier:

- README and TRUST_MODEL: the command processes files the person names without
  ingesting them; what it releases; that the privacy promise covers only what
  goes through the helper and the command.
- Privacy policy: processing of named files outside connected sources.
- Terms: keep "designed to read your sources, not change them"; state that the
  separately installed skill makes the changes. This is an engineering
  boundary, not an established liability exemption.

## Acceptance checks

- A synthetic Private document (health, tax) is tidied, and the AI's transcript
  holds only the fixed fields: no excerpt, no identifier, no error text.
- A planted secret (a key file, a password line in a text file) is never sent
  to any model; a name-suspected one is never opened. Checked by instrumenting
  file opens and model inputs.
- Adversarial names and contents (a secret in a file name, a diagnosis in a
  counterparty) produce withheld fields, not leaks.
- Undo restores every move in a test tree, including after a crash mid-apply
  and mid-undo, and after a file is edited during the run.
- With no private model, Private files are tidied by name only and nothing is
  downloaded.
- After the tidy, Olympus's index shows no duplicate items and no old paths;
  re-indexing is measured and reported.
- On a consented real folder: share of Private files renamed vs left alone,
  describe time per file, and bytes downloaded.

## Delivery sequence

1. Agent-Skills: fix the helper defects above (benefits consent mode now).
2. Olympus: the command and its status mode, with tests for the fixed output,
   withheld cases and local-only refusal.
3. Agent-Skills: the Olympus edition of the skill, calling the command.
4. Acceptance run on a fresh Mac and Linux install, then the real-folder pilot.
5. Legal pass on the new wording, then Olympus setup links to the skill.

## Open questions

- May a person choose Venice Private instead of the local model for this
  command? Recommendation: local only in the first version.
- Fixed document-type list: start from the skill's naming rules
  (`references/` in Agent-Skills).
