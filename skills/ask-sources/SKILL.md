---
name: ask-sources
version: 0.1.0
description: Search Olympus source-index corpora through calling-assistant-safe source tools; email/Gmail, Dropbox, Telegram, X/Twitter bookmarks, Drive, Readwise, and unified private asks use source_answer unless the user needs locator cards from source_index_search or chat sender counts from source_index_status. Never use bash, raw databases, local files, or shell fallback for ordinary source questions.
triggers:
  - user asks the calling assistant to search across sources, source index, or unified search
  - user asks the calling assistant to search email, Gmail, Telegram, X bookmarks, Readwise, Drive, Docs, Dropbox, or other Olympus-indexed sources
  - user asks to rank, count, or compare posters or senders in an indexed chat
  - user asks about Twitter bookmarks, X bookmarks, saved/bookmarked tweets, or saved/bookmarked posts
  - task needs evidence from approved internal or public-safe source corpora
tools:
  - source_answer
  - source_index_search
  - source_index_status
mutating: false
---

# Ask Sources

Use this skill when the user wants the calling assistant to search
Olympus-indexed sources, including the owner's X/Twitter bookmarks and saved
posts.

## Contract

Use Olympus source tools, not raw stores.

- `source_answer` is the default calling-assistant-facing path for answering from indexed
  sources. It returns bounded answer text, safe provenance, policy, and audit
  metadata.
- Use one unified `source_answer` call for ordinary source questions. Set
  `include_secure_local: true` when the user asks for private/personal
  material or the likely evidence may live in private email, Dropbox files, or
  protected Telegram. Omit `corpus_id` on that first private ask so Olympus can
  search all eligible private corpora in one pass.
- Name `corpus_id` or `corpus_ids` only to intentionally force-narrow because
  the user named a source, a prior result selected a source, or a diagnostic
  requires it. Do not infer Dropbox from legal, financial, medical, tax, or
  similar private subject matter; those topics can live in email, files, or
  protected messages.
- Treat `source_answer.answer` as answer-ready. When it directly answers the
  user's question, pass it through with its citations and coverage notes
  instead of re-analyzing the audit or re-synthesizing the source evidence.
- `source_answer.audit.self_heal` reports automatic local repair for incomplete
  source text. If `outcome` is `in_progress`, tell the user Olympus found the
  document but part of it is missing from the local index and is re-ingesting it
  now, retry `source_answer` after `retry_after_ms`, then deliver the answer
  from the retry. Do not ask the user for permission to retry this bounded
  repair.
- Scanned low-confidence Dropbox PDFs can improve after the scheduled local VLM
  PDF re-extraction lane (`qa_raster_ocr_vlm_escalation` -> `local_vlm_pdf`).
  If an answer looks OCR-garbled, say that plainly and note that the scheduled
  escalation lane exists. Do not trigger extraction jobs yourself.
- When composing the visible response, preserve the citation markers returned
  by `source_answer` for every source-backed claim. Do not paraphrase away
  citations or replace them with uncited summaries.
- Do not use `bash`, shell commands, local files, raw databases, session logs,
  workspace memory, web search, or web browsing to answer ordinary source
  questions or to rediscover how source tools work. If the user asks what
  sources say, call the Olympus source tools directly.
- `source_index_search` is for safe result cards, locator lookups, and
  diagnostics. It must not return secure-local source text. Internal X
  connector-store bookmark results may return bounded bookmark passages and
  metadata, but they omit X/Twitter URLs for now.
- When the user asks for a Dropbox file path, Finder link, Dropbox link, or
  "where is this file?", the calling assistant must call `source_index_search` with
  `include_locators: true`.
- Folder locators are unsupported. Do not route a folder request through
  `include_locators: true`; explain that locator release currently covers
  Dropbox files only and ask for a file when that would satisfy the request.
- For slow or private `source_answer` calls that may route through local models,
  secure-local corpora, or multi-source Analyst synthesis, set
  `timeoutMs: 600000`. This is an OpenClaw tool-call watchdog budget, not a
  worker routing knob, and lets Olympus return its normal audited result instead
  of being cut off by the generic 90-second dynamic-tool default.
- For S0-S3/internal or public-safe questions, keep `include_secure_local:false`
  unless the user asks for private/personal material or provides a secure-local
  corpus, approved scope, or selected item. This keeps routine internal answers
  on the cloud-eligible source-answer path.
- `source_index_status` is for aggregate/source readiness checks. It is not a
  source browser. For an ordinary/internal chat whose exact conversation id is
  known, it can also return content-free sender counts with
  `include_sender_aggregation: true`, `corpus_id`, `account`, and
  `conversation_id`. Treat `ranking: approximate` or partial coverage as a
  required qualification, and never describe `providerTraversal:
  not_asserted` as provider-complete history.
Do not use shell, `sqlite3`, raw files, local database paths, provider CLIs,
Xanthos, Dropbox CLI, local mirror probing, OpenClaw `exec`, web search, web
browsing, or ad hoc scripts as fallback search paths in ordinary calling-assistant
sessions. If the Olympus source tools are unavailable, fail clearly and say the
source-search lane is unavailable.

## Telegram

For Telegram, approved ordinary groups and chats live in
`internal.telegram.messages`. The calling assistant may search and answer from that corpus
when OPSEC allows.

Protected Telegram chats are secure-local and should not be searched through a
calling-assistant-visible raw packet or database path. If a question appears to target a
protected chat such as accountant, lawyer, Secret Chat, credential/security, or
other high-risk private material, use unified `source_answer` with
`include_secure_local: true`. Do not pin Telegram unless the user specifically
asked for Telegram or a prior result selected a Telegram item.

Good calling-assistant request shape:

- use `source_answer`
- set `corpus_id` to `internal.telegram.messages` when the user is clearly
  asking about ordinary approved Telegram content
- set `include_internal` to true
- keep `include_secure_local` false unless the user has explicitly asked for a
  secure-local/private lane and the runtime policy allows it
- use a small `max_results` for exploratory searches

For a request to rank the most prolific posters in one ordinary/internal
Telegram chat:

1. Resolve the exact chat through the normal safe search path if needed.
2. Call `source_index_status` with `corpus_id: internal.telegram.messages`, the
   declared Telegram `account`, exact `conversation_id`,
   `include_sender_aggregation: true`, and a bounded `max_senders`.
3. Report the ranking and its coverage marker exactly. The population is active
   indexed items; provider-wide traversal is not asserted.
4. For profiles or thematic analysis, call `source_answer` once per selected
   stable `sender_id`, carrying the same `conversation_id`. The normal evidence,
   provenance, citation, and release controls still apply.

## Email

For email, Gmail, Google Mail, mail threads, senders, inbox commitments, or
private correspondence, use `source_answer`. Do not switch to `email_answer` or
raw Gmail/browser/shell tools for ordinary source questions.

Good private email-capable request shape:

- tool: `source_answer`
- omit `corpus_id` for the first private ask unless the user explicitly says
  "only email"
- `include_secure_local: true` when private email may be relevant
- `include_secure_local_content: true` for bounded derivative answers
- `include_internal: true`
- use `timeoutMs: 600000` for slow private/local reasoning

Only pin `corpus_id: secure_local.email.private` when the user deliberately
wants email-only search or when a prior selected item came from that corpus.

## X Bookmarks

For Twitter/X bookmarks, saved tweets, saved posts, or "I bookmarked/saved
something on Twitter/X", use the Olympus `internal.x.bookmarks` source-index
corpus first. Do not use `xurl`, raw X/Twitter API calls, public web search, or
a signed-in browser as the primary path for personal bookmark search.

Good calling-assistant request shape:

- use `source_answer` when the user wants an answer or synthesis
- set `corpus_id` to `internal.x.bookmarks`
- set `include_internal` to true
- leave `include_internal_content` true when the user asks the calling assistant to reason
  from, summarize, or answer using bookmark contents. X bookmarks are
  `S1`/`internal`, so the calling assistant may receive bounded bookmark passages, author
  signals, and folder names. The connector-store result path omits X/Twitter
  URLs for now.
- use `source_index_search` with `corpus_id: internal.x.bookmarks` when the
  user wants result cards, bookmark passages, provenance, folder signals,
  or diagnostics
- leave `retrieval_mode` unset for the normal adaptive answer path; Olympus
  starts with keyword retrieval and retries with hybrid only when the keyword
  evidence pack is empty/thin. Set `retrieval_mode: keyword` or `hybrid` only
  when deliberately forcing a diagnostic path. Do not set `retrieval_mode:
  hybrid` just because a query is broad or conceptual.

`xurl` is for public X post reads/searches or explicit account actions, not for
the current private bookmark corpus. A natural-language request such as "what TV
shows have I saved in my X bookmarks?" is a source-index request, not an X API
request. Do not enrich bookmark candidates with `xurl read` in the same answer;
use the source-index evidence and state that URL fields are not available from
connector-store results yet. Only use `xurl read` after the user explicitly asks
to inspect a specific public X URL or post ID they provide. If the source-index
lane is stale or incomplete, say that the indexed X
bookmark corpus is partial and needs the browser-authenticated collector; do not
start an OAuth2 `xurl` flow, silently replace it with public X search, or present
guesses as bookmarks.

## Query Behavior

Keep source queries narrow and evidence-oriented:

- prefer concrete terms, names, URLs, or phrases from the user's question
- include time bounds when the user gives them
- target a corpus when the user names the source or when narrowing from a prior
  source result
- avoid expanding a simple search into unrelated corpora unless the user asked
  for unified search

## Dropbox Locators

For Dropbox, default `source_index_search` returns safe result cards without
paths or links. When the user explicitly asks for a file's full path, Finder
link, Dropbox link, where a file lives, or where to look for that file, call
`source_index_search` with:

- `corpus_id: secure_local.dropbox.files`
- `include_locators: true`

This release supports file locators only. Folder locators are unsupported; do
not send `include_locators: true` for a folder-only request.

Dropbox account and scope fields are easy to confuse:

- omit `account` for broad Dropbox search, or use `account: personal` only when
  deliberately narrowing to the indexed personal Dropbox account
- never use `account: dropbox.primary`, `account: dropbox.personal`, or any
  other credential handle as the account value
- `approved_scope_key` is a folder/root scope, for example
  `dropbox.personal:/1 Projects`, `dropbox.personal:/2 Areas`, or
  `dropbox.personal:/3 Resources`
- if a Dropbox status or search call reports zero files for a named account or
  scope, retry once without that account/scope filter before saying the Dropbox
  index is empty

When the user names a broad Dropbox area such as Health, Projects, Areas, or
Resources, use the matching approved scope when it is obvious. For example,
health material is normally under `approved_scope_key:
dropbox.personal:/2 Areas`. If the area is uncertain, omit the scope for the
first search and use locator paths from the results to narrow follow-up calls.

Locator results are metadata only. They may include `locator.display_path`,
`locator.parent_display_path`, Dropbox web URLs, and Finder file URLs when the
runtime has a configured local Dropbox root. Do not use shell, `sqlite3`,
OpenClaw exec, Xanthos filesystem probes, local Dropbox mirrors, or provider
CLIs to recover Dropbox paths in ordinary calling-assistant sessions.

Dropbox can contain medical, financial, credential, legal, and similarly
private content, but private subject matter is not a Dropbox routing rule. Use
Dropbox-specific calls when the user asks for files, file paths, file locators,
or a prior result is a Dropbox item. A folder-only locator request is
unsupported. For broad private questions, start with
unified `source_answer` and `include_secure_local: true` so email, Dropbox, and
protected Telegram can all be considered. Olympus should release only an
OPSEC-scanned bounded derivative answer with citations and gaps. It still must
not return source packets, database rows, provider cursors, OAuth material, raw
secure-local file text, or secret values.

A bounded secure-local question is itself approval to extract the minimum
necessary derivative answer unless the request is bulk, export-like, or
unusually broad. Examples that should go straight to `source_answer`:

- "What were my average tax payments over the last five years?"
- "Analyze my recent labs and tell me the important numbers."
- "Summarize the key terms in this legal document."
- "What changed between my last two reports?"

Examples that should ask for confirmation before releasing because they may
expose a large amount of S4 content:

- "Copy all of my lab reports into a markdown file."
- "Dump every transaction from the last five years."
- "Show the assistant all messages with my lawyer."

For explicitly Dropbox/file secure-local answer extraction, prefer a natural
bounded `source_answer` request:

- `corpus_id: secure_local.dropbox.files` only when Dropbox/files are the
  intended source
- `timeoutMs: 600000` so OpenClaw does not abort the tool call at the generic
  90-second dynamic-tool default while local/private retrieval or the Analyst
  is still working
- leave `retrieval_mode` unset for adaptive retrieval. Force `keyword` for
  exact/date/file/value diagnostics, or force `hybrid` for semantic-recall
  diagnostics when local semantic artifacts are known to be healthy. Do not set
  `hybrid` for the normal first pass.
- `include_secure_local: true`
- `include_secure_local_content: true`
- leave `analyst_provider` unset for the normal first pass so the configured
  secure pool selects an equal member from recent health/latency, or follows
  the deployment's explicit order; constrain to `venice` only when the owner
  explicitly asks for Venice or names a Venice model

Use `account: personal` and `approved_scope_key` only to deliberately narrow the
search when the scope is obvious or when a broad call misses evidence. Health
material is normally under `approved_scope_key: dropbox.personal:/2 Areas`, but
the calling assistant should not treat that value as a required magic phrase for every
secure-local answer. Missing scope by itself is not proof that Dropbox,
extraction, or indexing is down.

If an explicitly Dropbox file question comes back email-flavored or appears to
ignore the file corpus, check `audit.skipped_corpora`. A skipped
`secure_local.dropbox.files` corpus usually means the request did not include
the secure-local flags or the active policy lane did not permit secure-local
content.

When the owner asks to use Venice, set `analyst_provider: venice`; when the owner names
any Venice model, set `analyst_model` to that exact model id. Venice is an
equal first-class secure-pool member when the active sovereignty policy includes
it. Packaged `local-first` explicitly orders local before Venice,
`local-only` contains local only, and `private-cloud-only` contains Venice only.
An `e2ee-*` secure-answer model is typed-refused until local key handling
exists. Do not set implementation-specific analyst provider overrides just to
make ordinary secure-local answers work; the default path should let the pool
choose.

For medical/lab value extraction, use a broad evidence query that includes the
value family, document type, and likely source terms, such as `testosterone labs
blood test hormone panel`. If locator search finds likely Dropbox files but a
scoped `source_answer` call returns no answer, retry once with the same approved
scope and a broader query built from the locator titles and medical terms before
reporting that extracted content is unavailable.

For broad "recent labs" questions, if `source_answer` reports only metadata or
an insufficient cited answer, recover through the source tools before giving up:
call `source_index_search` on `secure_local.dropbox.files`, identify the most
recent comprehensive lab-looking files from safe titles, then call
`source_answer` again with a concrete query built from those titles and the
requested biomarker terms. Do not switch to shell, local files, raw databases,
or memory. If the concrete title-derived answer still cannot extract cited
values, report the extraction gap.

Dropbox photos and videos are metadata-first in the public package. The public
source tools cannot queue media extraction. If the owner asks to process a
particular photo, image folder, or video, report that limitation and preserve
the safe locators returned by `source_index_search`; do not invent or call an
administrative ingestion tool. Do not send PNGs, HEICs, photo folders, or
ordinary saved media through the Venice E2EE document-reasoning path.

Dropbox book libraries are also metadata-first by default. Folders such as
Books, Ebooks, Kindle, Calibre Library, and Audiobooks should tell the calling assistant that
the owner has a folder/library of books, not trigger broad full-text/RAG extraction
of every book. Ebook files and PDFs under those explicit book-library folders
stay inventory-level unless the owner explicitly asks Olympus to process a specific
book or folder through a deliberate lane.

For broad or compound source synthesis that can fit in one evidence budget, make
one broad `source_answer` call instead of splitting the request by source,
biomarker, category, or sub-question. If the relevant corpora are obvious, pass
them together in `corpus_ids` so Olympus avoids all-corpus fanout. For example,
a labs plus Telegram request can target `secure_local.dropbox.files` and
`internal.telegram.messages` in one call with a concise query containing the
requested values and exact Telegram phrase. Stop once you have enough cited
bounded evidence to answer the user's actual question. Do not fan out into unbounded follow-up calls. If one broad source call times out or returns an
explicit extraction gap for the asked value, retry once with a narrower
selected-item or title-derived query, then synthesize from successful source
results and report the remaining gap.

If the owner says the content should stay out of the calling assistant, or asks through an Argus
channel, use the secure-local/Argus path instead and do not set
`include_secure_local_content`.

## Secure-Local Examples

Unified private ask across private email, Dropbox, and protected Telegram:

- tool: `source_answer`
- `question: "What happened with the Lexidy credit?"`
- omit `corpus_id`
- `include_secure_local: true`
- `include_secure_local_content: true`
- `include_internal: true`
- `timeoutMs: 600000`

Bounded answer from an explicitly Dropbox file question:

- tool: `source_answer`
- `corpus_id: secure_local.dropbox.files`
- `question: "What were my average tax payments over the past five years?"`
- `include_secure_local: true`
- `include_secure_local_content: true`

Internal Telegram synthesis:

- tool: `source_answer`
- `corpus_id: internal.telegram.messages`
- `question: "What themes came up in the Happy Fourth group about ApoB and inflammation?"`
- `chat_scope: "Happy Fourth"` when the owner names a Telegram group. Use the
  human group title/name so Olympus can resolve it against indexed Telegram
  conversation metadata.
- `include_internal: true`
- if a prior `source_index_search` identified the approved group by title,
  carry its safe `chat_scope` or `conversation_id` into `source_answer` so the
  answer uses the same conversation evidence
- do not infer `conversation_id` from a search hit that merely mentions a group
  name. A message in Idea Files that says "ClawRyderz" is not proof that the
  conversation is the ClawRyderz group.

Locator-first, then answer:

1. Use `source_index_search` with `include_locators: true` when the owner asks where
   a file is.
2. Use `source_answer` for the follow-up analysis. If the search result exposes
   `hit.selected_item`, pass that object in `selected_items` so Olympus answers
   from that item only. Passing the whole hit is also acceptable when it carries
   `selected_item`; older safe hits that carry only legacy `sourceItem`
   metadata are also accepted when `corpus_id` is set on the answer request.
   Do not copy source text, snippets, packets, database rows, cursors, or file
   paths into `selected_items`.
3. If no safe selected-item handle is available, include the file title and
   relevant terms in the query and report any extraction gap.

## Failure Behavior

If a source tool fails:

- explain which Olympus tool failed
- do not try a raw local database or shell fallback
- suggest a status check through `source_index_status`
- preserve trust-domain boundaries in the explanation
