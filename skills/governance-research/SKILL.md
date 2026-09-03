---
name: governance-research
version: 0.1.0
description: Operate Solon, the owner's governance research agent, for governance library use, source intake, Gemini Enterprise RAG-backed answers, Google Docs service-account collaboration, and approved Anna Archive intake. Use when the owner asks Solon or the governance researcher to search, synthesize, add sources, ingest approved material, answer from the governance library, or help with governance writing.
triggers:
  - user asks for Solon
  - user asks to use the governance researcher
  - user asks Solon or the governance agent to answer from its library, add sources, ingest books or PDFs, or work in Google Docs
  - user asks to search or import Anna Archive material into the governance library
tools:
  - domain_ask
  - domain_source
  - rag_corpus
  - domain_doc
  - annas_archive_search
  - annas_archive_import
  - castor_workspace
mutating: true
---

# Solon Governance Research

Use this skill for Solon, the owner's governance researcher.

Do not use this skill to create new agents. When the owner asks to spin up a new
domain-specific agent or clone the Solon pattern, use `agent-workshop`.

## Product Rule

Solon is the persona for the governance domain. This skill is Solon's operating
manual: library use, source intake, grounded governance answers, Google Docs
collaboration, and approved book/PDF intake.

Solon is not the `domain_id`. For Solon, always use `domain_id=governance`.
The OpenClaw agent/topic identity is `solon`, and the default workspace is
`castor-solon`. Do not use another `domain_id` from this skill.

Solon's canonical source library is the owner-visible Dropbox folder
`Castor Workfiles/Solon/`, currently including `Yearn/` and
`Eigen Foundation/`. The OpenClaw workspace is scaffolding, doctrine, memory,
registry, scratch, and pointers only; it is not the library of record.

This is not fine-tuning and it is not the secure-local `source_answer` lane.
Domain experts use cloud-eligible, source-reviewed material through Gemini
Enterprise RAG Engine. Private `secure_local` and unclear S4/S5 material stay
on the frozen Olympus source pipeline unless the owner explicitly approves a new
posture.

## Asking The Domain Expert

Use `domain_ask` when the owner asks Solon or the governance researcher to answer
from its library, synthesize open questions, compare authors, build reading
lists, or ground a governance project in the curated corpus.

Good default:

- `domain_id=governance`
- `question` as the owner asked it
- use the single governance corpus, addressed by its display name or its
  numeric id — both resolve. This installation's corpus is named in
  `docs/roles/researcher/GOVERNANCE_RAG_DEPLOYMENT.md`
- omitting `corpora` falls back to that same single live corpus

The expected final answer must include citations and explicit gaps. Do not add
per-question answer code, regexes, or domain-specific synthesis branches in
Olympus.

## Adding Sources

Use `domain_source` for books, PDFs, EPUBs, Google Docs, blog posts, notes, and
web pages that should enter the governance library.

Canonical file intake is by folder: put real source files under
`Castor Workfiles/Solon/<Source>/`. Real files in this folder are seen by the
Olympus Dropbox source and can flow to the
`internal.solon.governance-library` corpus after classification. Finder aliases
inside Castor Workfiles may be read/exported through `castor_workspace`, but
the Dropbox sync indexes only the alias file, not the target. Use real files
for the Olympus corpus, or rely on the target's native Olympus source.

For pasted links, use `domain_source`. Do not treat a chat link as already in
the file library until the approved runtime has fetched/staged/imported it.

For a URL:

- `action=add`
- `domain_id=governance`
- `kind=blog_post`, `pdf`, `google_doc`, `book`, `epub`, or the closest fit
- `url`
- `title` and `author` when known
- `copyright_posture` when the source is a book, paywalled text, private doc,
  or anything not plainly public

For a workspace file:

- `action=add`
- `domain_id=governance`
- `relative_path` inside `Castor Workfiles/Solon/` or a delegated
  read/export alias

If the source is private, sensitive, copyrighted, or unclear, ask the owner before
importing it into a cloud corpus. Discovery and metadata planning are fine;
download/import is not.

## RAG Corpus Lifecycle

Use `rag_corpus` for Gemini Enterprise corpus create, import, stage_import,
notion_import, status, and refresh planning.

### Staging local library files into a corpus (`stage_import`)

`rag_corpus import` needs a `gcs_uri` or `drive_file_id` — it cannot read
workspace files directly. When the material sits in your workspace (e.g. a
compiled source bundle under `sources/`), use `stage_import` (deployed
2026-07-05): the worker uploads the files to the domain staging bucket itself
and then runs the import, so you never need `gcloud` or credentials.

```
rag_corpus action=stage_import corpus_id=<display name or numeric id>
  workspace_relative_path=<path relative to the workspace ROOT — include the
  workspace folder prefix, e.g. castor-solon/sources/yearn-forum-staging>
  dry_run=true
```

If you get `workspace_path_not_found`, the path is missing the workspace
folder prefix (`castor-solon/...`).

Run `dry_run=true` first and check the plan: eligible files (md/txt/pdf/html,
≤10 MB each, ≤100 MB per batch), skipped files with reasons, the resolved
corpus, and the destination (always under the domain's allowed GCS prefix,
e.g. `gs://<staging-bucket>/staged/governance/<batch>/`). If the plan
looks right, rerun with `dry_run=false`; the result lists staged URIs with
per-file sha256 and the import operation. Then confirm with
`rag_corpus action=status` and update your source registry entry
(`domain_source`) so `ingest_status` reflects the completed import.

The governance project and staging bucket are per-installation and are recorded
in `docs/roles/researcher/GOVERNANCE_RAG_DEPLOYMENT.md`, not here; the default
location is `us-central1`; staged GCS URIs must stay under the domain allowlist
returned by the tool. Do not call `gcloud`, `gsutil`, or Google APIs directly
from a normal agent session. The runtime worker owns credentials through
SecretRef.

### Importing Notion pages/databases (`notion_import`)

Use `notion_import` for `notion.so` or `notion.site` material. Do not use
`web_import` for Notion URLs; it returns `notion_requires_api_import` because
public Notion pages are client-rendered.

Prerequisites:

- The domain-expert worker must have `OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN`
  wired from `olympus connect notion` or the 1Password runtime wrapper.
- The target page or database must be shared with the Notion integration.
- The material must be approved for the target Gemini RAG corpus.

```
rag_corpus action=notion_import corpus_id=<display name or numeric id>
  urls=<notion page URLs> page_ids=<optional raw ids>
  database_ids=<optional database ids> dry_run=true
```

Review the dry-run plan, then rerun with `dry_run=false`. The worker writes
markdown derivatives under `sources/notion-imports/<batch-id>/`, stages them
through the normal GCS allowlist, imports the staged directory, and appends a
`kind: notion_import` source-registry record. Database rows import under a
database-title subdirectory and report skipped rows if the object cap is hit.

If the workspace is too large for API import or pages cannot be shared with the
integration, ask the owner for a Notion export folder, place it under
`Castor Workfiles/Solon/<Source>/`, and use the `stage_import`/folder-import
path instead.

Deployment identity — service account, IAM project, staging bucket, corpus
resource name and worker unit — is per-installation and is NOT recorded here.
This file ships in the release tarball to every installation, so a concrete
tenant's identifiers in it would be published to all of them. Read this
installation's values from `docs/roles/researcher/GOVERNANCE_RAG_DEPLOYMENT.md`,
which is not packaged, and ask the owner if that file is absent.

- corpus addressing: the worker resolves display names to numeric IDs, so a
  corpus display name, its numeric id, or a full resource name all work for
  import/ask/status
- corpus doctrine: there is ONE Solon governance corpus. The owner's governance
  writing, essays by other authors, and governance books all live in it; never
  create per-author corpora. Preserve attribution in staged file display names
  and source registry `author`/`title` fields.

The Gemini lane is for Solon's own answers over cloud-eligible, source-reviewed
material. The Olympus corpus
`internal.solon.governance-library` is the gated lane for other consumers:
S0-S3/internal or public-safe classified items can surface, while
unclassified, S4+, blocked, stale, or personal-journal material stays out of
that corpus and remains on the secure-local source pipeline.

### Importing owner-library folders (`import this`)

When the owner says "import `<library folder>` into `<corpus>`" and the files are
already under `Castor Workfiles/Solon/`, use the delegated workfiles lane
instead of copying files by hand:

1. Run `castor_workspace action=export_gcs` with
   `root_id=castor_workspace`, `relative_path=<folder relative to Castor
   Workfiles>`, and
   `destination_uri=gs://<staging-bucket>/staged/governance/<batch>/`.
   Keep `dry_run=true` first. The plan recursively exports md/txt/pdf/html
   files, skips dotfiles/`._*`/`.DS_Store` as `junk_file`, reports other
   skipped extensions, and can include media only with `include_media=true`.
2. If the dry-run file results match the intended source set, rerun the same
   export with `dry_run=false`.
3. Run `rag_corpus action=import corpus_id=<display name or numeric id>
   gcs_uri=gs://<staging-bucket>/staged/governance/<batch>/`.
4. Confirm with `rag_corpus action=status`, then update the source registry
   with `domain_source` so the folder or item records show the completed
   import status and batch.

Operator prerequisite: the delegated workspace root must allow the domain
staging bucket in its `allowedGcsPrefixes` (for Solon,
`gs://<staging-bucket>`). If `export_gcs` returns a destination-denied
error, stop and ask the operator to update the root allowlist; do not use
shell, `gcloud`, or ad hoc file transfer as a workaround.

## Talk & Media Import Workflow

(Adopted 2026-07-05 from Skill Workshop proposal
`governance-talk-media-import-20260704-8405145e08`, with the owner's
2026-07-05 transcription approval folded in.)

When the owner asks to import talks, podcasts, interviews, or a page listing
them, target `corpus_id=governance-jamie-docs` and prefer sources in this
order — transcript-bearing pages beat transcription:

1. Official transcript or episode page on the publisher's site.
2. Public podcast page with readable show notes or transcript.
3. Direct PDF/HTML transcript.
4. The YouTube URL. Caption extraction is attempted first; when captions are
   missing or empty the pipeline automatically downloads the audio and
   transcribes it (Gemini ASR; transcript frontmatter says
   `transcript_source: asr`). The owner approved this posture for their public
   talks on 2026-07-05 — an explicit "import this" is sufficient; no
   separate per-item transcription approval is needed.
5. Owner-provided transcript/audio files (via `stage_import`) as a last
   resort.

For a talks index page: fetch it, extract per-item title/date/venue/URL,
`web_import dry_run=true` the candidate URLs, inspect derived files and
per-URL errors, then rerun live for the eligible items. Register every item
with `domain_source action=add` (usually `kind=transcript`) including title,
speaker, URL, trust and copyright posture, and the corpus id. If an item
still cannot be imported, register it anyway with the failure code and what
it needs (alternate page, transcript, or audio) so the queue stays visible.

Worked lesson (2026-07-04): raw YouTube imports from the talks page failed
caption extraction for 11 of 14 videos, while the Delphi Digital publisher
page for "DISRUPTORS: Why DAOs?" imported cleanly through the generic HTML
handler. Search for publisher episode/transcript pages before treating
YouTube as the only source; use YouTube-with-ASR when no better page exists.

## Google Docs Collaboration

Google Docs is the writing surface for now.

Use `domain_doc` for:

- reading the doc
- leaving comments
- proposing replacement text in comments
- making approved visually marked direct edits
- accepting or rejecting marked agent edits after review

Use per-domain service account identity by default. Direct edits must be
visually obvious: Solon foreground color, optional highlight, `[Solon]` prefix
on block insertions, and a companion comment for non-trivial changes.

Do not claim that native Google Docs suggestion-mode edits can be created by
the Docs API. Treat exact Suggesting-mode UX as a separate browser/UI automation
spike. The normal product path is comments plus approved direct edits in a
visible review style.

## Anna Archive

Use `annas_archive_search` to find candidate books and files. It returns
structured candidate metadata when the runtime API worker is configured. If
the endpoint or API key is missing, it fails with
`annas_archive_not_configured`; it never substitutes a planner result under
that tool name. It must never expose `Annas-Archive-API-Key`.

Use `annas_archive_import` only after the owner has approved the selection and
copyright/import posture for that source. The live path saves the approved file
into the owner's Xanthos books folder first, refuses duplicate/overwrite cases, and
logs the selection/download. Set `ingest=true` only with an explicit
`corpus_id`; otherwise report the `needs_corpus_decision` state instead of
inventing a governance or general Castor corpus. For general Anna Archive book
acquisition mechanics, also follow `annas-archive-acquisition`.

## Failure Behavior

Report a lane as unavailable ONLY from a domain tool result returned in THIS
session. Never conclude lane health from notes, memory, prior sessions, or
the failure descriptions in this document — lane state is one live call away,
and cached or recited verdicts outlive outages. (2026-07-28: a healthy lane
was reported down minutes after it had served an answer, in this document's
own taught wording, without any tool having been called.)

If the domain tools are absent from your tool list, say only that they are
unavailable on the current agent surface. Absence alone does not identify
worker health, backend configuration, gateway registration, or per-agent
policy as the cause.

If a domain tool returns `domain_expert_not_configured`, report that the
deployed lane has refused at one of two independent gates. The gateway-owned
`domainExpert.enabled=true` and `domainExpert.liveToolsEnabled=true` pair
controls whether the tools are registered. The standalone worker-owned
`OLYMPUS_DOMAIN_EXPERT_ENABLED=true` and
`OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED=true` pair controls `/v1/domain`
dispatch at the gateway's configured `domainExpert.baseUrl`. A typed
`domain_expert_not_configured` returned by a present domain tool is a worker
dispatch refusal; do not diagnose it as proof that the gateway pair is false.
Name the worker by its role, not by unit name, since the serving unit changed
at the 2026-07-28 cutover and may change again. A disabled lane does not
provide a gateway-side static planner. Use
`bun run domain-expert:serve:1password` only as an operator/manual relaunch
path when working on the runtime; it defaults the worker pair true while
preserving explicit operator exports. Bare `bun run domain-expert:serve`
remains fail-closed; for non-secret local dry-run dispatch, export both
worker-owned flags true for that command only. Do not fall back to shell,
browser scraping, raw local files, raw Drive credentials, `gcloud`, `gsutil`,
or ad hoc scripts.
