# Child items: attachments and media

Status: owner direction 2026-10-25 ("we also need child handling … should
that be designed before we finish this"). The spine (step 1 of "Order") is
built and tested with a fixture connector; no format connector reads a child
yet.
Reviewed by Astra (Codex, high) in two rounds on 2026-10-25. Every finding
is folded in or settled by the owner's tier decision (see "Review"). Where
this page and the code differ, the code is current.

## Outcome

A file that came inside another item is searched and cited like any other
item. Examples: a PDF attached to an email, a photo or voice note in a
WhatsApp or Telegram export, a picture in an Evernote note. Its words are read
by the same readers that read files on this computer: text, PDF, OCR,
transcription and photo search. An answer can say "the lease says … (lease.pdf,
in 'Flat' from Alice, 3 March 2024)".

Today none of these bytes are read:

- Gmail and mail exports record attachment names on the message.
- Chat exports name media in the message text and list it under
  `media_not_imported`.
- `docs/SOURCE_CAPABILITIES.md` lists attachment bytes as a gap for Gmail and
  Telegram.
- The Evernote connector in progress needs the same thing.

## Owner decisions

- **Everything that can be ingested is ingested** (2026-10-25), at least its
  metadata. Media and attachments go through the shared extraction pipeline.
  Media an export left out keeps its name, type, sender and time.
- **Designed before the archive media work finishes** (2026-10-25), because
  archives, Gmail and Evernote all need it.
- **Each child is judged on its own** (2026-10-25): "They should be private
  unless the specific artifact contains a secret … or they could be
  personal, depends on the artifact. A child of a private email could be
  personal." A child takes no tier from its parent. This replaces the
  four-tier design's rule that an attachment takes the higher of its own and
  its parent's tier (section 2.1, updated with this decision).
- **Already decided, and applied here:**
  - names are Personal (2026-10-02);
  - archive content is Private until judged (2026-10-23);
  - no size refusals;
  - every problem has a route to exactly what.

## What a child is

A child is an item whose bytes came inside another item, its parent. It is
an item of its own, with its own identity, its own two tiers (names and
content), its own chunks and its own citation. It also records its parent.

| Source | Parent | Children | Child key (stable within the parent) |
|---|---|---|---|
| Gmail | message | MIME parts with a file name | MIME `partId` (documented immutable for a message) |
| Mail export (mbox) | message | MIME parts with a file name | MIME part path |
| WhatsApp export | message | the media file the message names | the file's name in the export |
| Telegram Desktop export | message | the `photo` or `file` the message carries | the file's path in the export |
| Evernote (`.enex`, then live) | note | each `<resource>` | MD5 of the decoded bytes (the `en-media` hash), plus an ordinal when one note holds the same bytes twice |

Out of scope:

- **Files inside a zip on this computer.** Local files reads them as files.
- **Linked cloud files.** A Drive link in an email is a link, not bytes.
- **Live WhatsApp media messages.** They are already items of their own, with
  their own MIME type. They are messages, not children.

## Contract change (2.1.0)

All four additions are optional and additive:

```ts
// SourceItemIdentity
parent?: { providerItemId: string; localItemId: string };

// RawItem: how to read a child's bytes later, owned by the connector
deferredBytes?: { locator: string; available: boolean; sizeBytes?: number };

// SourceConnector.fetchItem gains an optional second argument
fetchItem(localItemId: string, options?: { deferredBytes?: { locator: string } }): Promise<RawItem>;

// SourceCitationMetadata
parentLabel?: string;  // "'Flat' from Alice, 3 March 2024"
```

- **`parent`.** A child has the same `family`, `provider`, `accountScope` and
  conversation as its parent. Its `providerItemId` is
  `<parent providerItemId>#child:<child key>`. So archive removal, account
  delete, ledger withdrawal and conversation grouping already reach children.
  Two children of one parent never collide.
- **`deferredBytes`.**
  - `locator` is opaque outside the connector and version-bound. It holds what
    the connector needs to read the bytes again after a restart. Examples:
    - the export file index, its manifest version and the zip member or byte
      range;
    - an Evernote resource's ordinal in its note;
    - a Gmail message id and part id.
  - `sizeBytes` is the size the source states (a zip member's uncompressed
    size, a file's size at binding, a MIME part's decoded size). It is
    checked again while reading.
  - `available: false` means the source says the bytes are not there.
    Examples:
    - a WhatsApp `<Media omitted>`;
    - a Telegram "File not included";
    - a Roam image hosted on a URL.
- **`fetchItem`'s second argument.** At fetch time, the extraction source
  looks up the persisted locator by the child's full identity and expected
  version, and hands it to the connector. After a restart, the connector
  needs nothing but its account and the locator. A job row keeps only the
  identity; the locator is read fresh from the store on each fetch.
- **`parentLabel`.** The parent, as a citation shows it. It is filled only
  under the rule in "Citations".

Why fields, not keys in `metadata`:

- The store keeps no metadata column.
- Removal, tier inheritance and the extraction candidate query need indexed
  columns.
- The contract forbids carrying a shape it does not declare.

Identity is stable within one import of unchanged files, across resume and
restart. A fresh export of the same chats is a new archive with its own
account scope. Repeated items between archives are counted as they are today.

## Listing

- **Names first.** A connector lists each child after its parent, as a
  `metadata_only` item, with:
  - name, MIME type and declared size, from the source;
  - sender and time, the parent's;
  - `deferredBytes`.
- **Children may cross pages.** One parent can have more children than a pass
  budget allows. So the connector's resume point can sit inside a parent's
  children (parent, then child ordinal), bound to the same manifest as every
  resume point. Without this, the store's `maxItems` stop would replay the
  same oversized page for ever.
- **Positions.** A child's position in archive coordinates is the offset of
  its reference inside the parent's bytes. Examples:
  - the MIME part's start;
  - the WhatsApp attachment marker;
  - the Telegram `photo` or `file` field.

  It is strictly after the parent and before the next item, so repeat
  counting keeps its strictly-increasing rule.
- **Big messages still list.** Admission of names is separate from extraction
  limits. A mail message over the splitter's 32 MiB message cap
  (`mbox/split.ts`) still yields its parent row and its children's names. The
  cap becomes a bound on what is held in memory at once, not a reason to skip
  the message.
- **The parent's attachments line.** The parent keeps a short line naming its
  attachments ("Attachments: lease.pdf, floorplan.jpg"). These are the
  parent's own names and Personal by rule, so a search for a file name still
  finds the message. Sizes and part ids leave the parent's text, because the
  child holds them.

## Reading the bytes

- **No fetch while syncing.** Archive sync keeps `fetchContent: true` for
  parents. A child's bytes are not read during listing: the sync uses the
  store's existing `deferMetadataOnlyContent` for `metadata_only` items with
  `deferredBytes`. The tiered set's per-item `contentArrivesLaterFor` routes
  the child's names at listing and lands its content later. It names no
  source:

  ```ts
  (item) => item.deferredBytes !== undefined
  ```
- **Candidates.**
  - The store persists `deferred_locator` and `bytes_available`, and the
    candidate query projects both.
  - A child with `available: false` is never a candidate.
  - The roster's extraction source is the generic connector source. It
    resolves the connector per account scope through the archive registry.
    It stamps each ref with the row's own provider, never one configured
    provider, because one archive family store holds several formats.
- **Manifest.** Bytes are read only from files the import binds.
  - mbox attachments and WhatsApp zip media are inside files already in the
    import's manifest.
  - The manifest itself never changes after the import starts. Its digest
    binds every resume point, and the connector still receives exactly its
    input files.
  - For a chosen folder, each media file a chat export references gets a
    **media binding**: its path under the chosen folder, its file identity,
    size and modification time. Choosing the folder approved them.
    - Bindings live in an append-only table beside the manifest, in the
      archive's record. As built: the record is one JSON file rewritten whole
      on every update, so the table is a SQLite file beside it
      (`raw/archive-media-bindings.sqlite`, reached through the layout
      resolvers), keyed by archive. A resume point does not hash it.
    - A binding is written before the child row and the checkpoint that
      follows it. The child's locator names the binding.
    - Checking that an import is whole covers the manifest and the bindings
      together. The bindings are checked by version (identity, size and
      modification time, from metadata alone) when the listing reaches its
      end and again as the import is marked complete. A pass does not check
      them at its start, which would cost every pass the whole table.
  - For a chosen single file (a lone `result.json` or `_chat.txt`), media
    beside it is not read. It is listed under "Not imported" as "choose the
    export folder to include its media". The choice of one file is never
    widened to its folder.
  - Reads are descriptor-relative, through the scope-safe file module, and
    revalidated after reading. A changed or missing file settles
    `source_version_gone`, and the dashboard says which file changed.
  - Nothing is copied: archives are read in place.
- **Readers.** The factory picks a reader by MIME type, exactly as for a file
  on this computer:
  - text, PDF and PDF OCR;
  - image OCR and photo preparation;
  - audio and video transcription.

  Remote readers stay denied unless the existing extraction policy allows
  them, and the runner rechecks egress. Unread content is at least Private in
  the tiered view.
- **Size.**
  - Names are always admitted, whatever the size.
  - **Each reader declares its input.** The `Extractor` type gains a required
    declaration: either bytes in memory, with a `maxInputBytes`, or a file
    path. Text, PDF and image readers take bytes. Transcription takes a file,
    which it already writes for its tool today.
  - **Bytes readers.** The extraction source checks the child's
    `sizeBytes`, which the store keeps, against the reader's
    `maxInputBytes` before reading. It enforces the bound while reading, by
    reading at most the limit plus one byte, so a size stated wrongly cannot
    overrun memory. A child over the limit keeps its names row and appears,
    with its size and reason, in the existing "files we couldn't read" list.
    One example of a limit is image preparation's 64 MiB.
  - **File readers.** A child that is a plain file under a chosen folder is
    handed to the reader by a scope-safe path to the original, with no copy.
    A zip member or a MIME part is streamed in bounded chunks to a private
    temporary file in the data folder, which is removed after reading. So an
    hour of video is transcribed without being held in memory.
  - These limits are shared by every source.
- **Evernote recognition.** Evernote's own `<recognition>` OCR index is not
  used in the first version. There is one reading path, and the quality of
  text a source supplies is unverified. Revisit with an eval if handwriting
  matters.

## Tiers

A child is judged on its own, like any item (owner, 2026-10-25). It takes no
floor from its parent.

- **Names.** The child's name and type are judged like any item's metadata:
  Personal by default, raised on evidence.
- **Content.** The child's own text decides its tier. It can be Personal,
  Private or Secrets, whatever its parent is:
  - a holiday photo attached to a Private email can be Personal;
  - a scan of a passport attached to a Personal message is Private or
    Secrets.
- **Archives.** The child's content is held Private until the private model
  judges it, like everything in an archive (`holdContentUntilJudged` already
  covers the lane). The parent's state does not hold or release it.
- **Context for the judge.** The judge sees the child's names and content.
  It may also see the parent's names (subject or chat, sender) as context,
  under three rules:
  - The context is authorized and screened on its own before it is queued.
    Context that is not authorized for the judge's route, or that holds a
    secret, is left out.
  - A detector's result on the context never applies to the child. A
    harmless child under a subject holding a credential is judged on itself.
  - The permitted context is part of the judgment's cache identity.

  The parent's content is never passed.
- **Source neutrality.** The connector publishes no tier. Classification
  code reads `identity.parent` only to find the parent's names for context,
  and the classifier-neutrality suite keeps it free of source names.
- **Upward.** A child never raises its parent. A Private medical PDF attached
  to "see attached" leaves the message Personal. Only the PDF's content is
  Private.
- **Overrides.** An owner override on a child or a parent applies to that
  item only.
- **Secrets.** A child whose own content is Secrets is recorded as a location
  only, like any Secret.

## Removal

- **Archive removal.**
  - Removal first marks the archive's generation retired in the archive
    registry. Extraction enumeration, fetch, egress and landing all check the
    generation, so work already in flight cannot enqueue or land children of
    a removed archive.
  - Removal then retires the archive's extraction jobs. The job store gains a
    forget step by `(corpus, account scope)`, registered in the forget
    registry; archive corpora are shared by every archive of a family.
  - The same forget step removes the archive's scratch files from the
    extraction spool. A file reader's input is written under its owner
    (`<spool>/c-<corpus>/a-<account scope>/`, each a digest) in a file named
    for the process that wrote it, so removing an account scope or a source
    removes what a crashed read left, and a start removes at once the files of
    a process that is gone and the folders of an owner with no job left.
  - Only then does it purge the rows, as today.
- **Account delete.** It already forgets extraction jobs by corpus through
  the registry. Children's rows go with the account.
- **A parent tombstoned** (a Gmail message deleted at the provider, or an item
  absent from a re-sync):
  - In one ledger transaction, the parent and its children are hidden and a
    durable cascade row is written per child.
  - A worker then deletes each child's copies in every tier store that holds
    one, with retry.
  - A crash between stores leaves the children hidden, never visible.
  - The parent's own store commits its tombstone before that ledger
    transaction, so the deletion is made durable first: a store about to
    tombstone a parent that has children writes an intent row to the ledger
    inside its writing transaction (if the row cannot be written, the
    tombstone does not commit). The next start settles any intent a crash
    left: the parent is gone, so the children are hidden and owed; the parent
    is still held, so the intent is dropped and the children stay. The
    ledger's intent table is `tier_parent_deletion_intent` (schema 11).
- **Media.** Prepared photo copies in the media cache are released by the
  chunk triggers that already release them.

## Citations

- **What a child cites.**
  - Its title is its file name.
  - `parentLabel` names the parent's subject or chat, sender and date.
  - A Gmail child carries its parent message's web link. An archive child,
    like its parent, has none.
- **When the label is attached.** It is built at pack time, and only when the
  parent's effective names tier may go wherever this candidate goes, under
  this request's scope and destination. A Personal child bound for a cloud
  model gets the label only when the parent's names are Personal. With
  "names are Private" set, a Personal child does not reveal its parent's
  subject.
- **The parent as a dependency.** The dependency covers the parent's names
  only. The parent's content never limits the child. It acts at two points:
  - **Before dispatch.** A label that is not authorized is left out of the
    pack.
  - **After dispatch.** Once a model has read the label, the parent's names
    are a release dependency of the answer, recorded in the release manifest.
    If they stop being authorized before release, the whole answer is
    withheld or regenerated without the label, as the release manifest
    already does for any input that loses authorization. Dropping the label
    alone would leave the subject in the answer's words.
- **Where the label reaches.** The label is carried through the shared output
  schemas:
  - `SourceIndexAnswerEvidence`;
  - the ChatGPT citation, as part of the title text ("lease.pdf, in 'Flat'
    from Alice"). The tool lists and the pinned `/openai/mcp` listing are
    unchanged;
  - unreadable-file entries, which also gain a route to the parent's archive
    or source.
- **The Analyst.** It reads child evidence like any other. The generic prompt
  is unchanged, and no question logic is added.

## Gmail

- **One read per message.** The MIME tree is read and cached once per message
  version, as the listing cache already does to avoid duplicate
  `messages.get` calls.
- **Inline bytes.** A part whose bytes are inline (`body.data`) needs no
  attachment request. Otherwise the fetch resolves the attachment by the
  immutable `partId` from the cached tree, then calls `attachments.get`.
- **Limits.** Requests run under the existing Gmail request budget, with retry
  and backoff, and the scope is revalidated before each fetch. Quota units
  are counted in the source's receipt.
- Gmail's own comment says its attachment ids are not stable. That claim is
  unverified, and nothing here depends on it.

## Dashboard

- **Counts.** An archive's counts gain children, by kind ("1,204 messages, 312
  photos, 18 files"). Gmail's card counts attachments read.
- **Under "Not imported":**
  - Media an export left out. For example: "312 photos weren't in the export.
    Their names, senders and dates are kept. Export again with media to
    include them." It routes to the chats concerned.
  - Media beside a single chosen file.
  - Children the factory could not read, through the existing unreadable
    files list with their parent named.
- **Old kinds.** `media_not_imported` stops being reported. It stays in the
  vocabulary for old records, as `assumption` does. Gmail's
  `attachmentsNotIngested` and `gmail_attachments_not_ingested` count only
  attachments whose bytes are not read yet.

## Storage

- **No new files.** Children are rows in the stores their tiers place them in,
  under the account folder the source-storage design gives each source.
- **Nothing copied.** Export bytes are never copied. The only things written
  are:
  - extracted text and its chunks;
  - prepared photo copies in the shared media cache, keyed by content as
    today.
- **Migrations.** Two are needed, both additive; existing rows have no parent
  and do not move:
  - The store's `items` table gains four nullable columns and an index on
    the parent: `parent_local_item_id`, `deferred_locator`,
    `bytes_available` and `size_bytes`.
  - The archive record gains the append-only media-binding table (a SQLite
    file beside the record, forgotten with each archive on removal and taken
    with the source on Delete).
  - The tier ledger gains the parent key and the cascade queue.

## Later: identical files read once

The same PDF forwarded five times gives five children, and each cites its own
message. The first version reads each one. Reading once needs more than a
lookup:

- a verified byte hash;
- a stored, reusable result per extractor kind, version and configuration;
- reuse inside each child's own leased settlement;
- coalescing of copies planned together;
- rules for a donor that is deleted or settled Secrets.

It is a separate change, made once the first version shows the cost.
Transcription is the likely reason to do it.

## Contract gate

This follows the versioned change gate in `docs/ENGINEERING_PROCESS.md`:

- **Version.** SourceConnector and EvidencePack 2.1.0, additive and optional.
  The fingerprint is recorded in
  `config/source-pipeline-contract-version.json`.
- **Compatibility.**
  - A producer that omits the new fields behaves as under 2.0.0.
  - The migrations are additive. A storage-invariance test proves that
    existing rows, chunks and vectors are byte-identical before and after
    them.
  - The embedding model and epoch are unchanged. Children are new items,
    embedded as any new item is.
- **Eval.**
  - The fixture held-out harness gains cases whose answer exists only inside
    a child, and the cited child must name its parent. Examples:
    - a lease term in a PDF attached to an email;
    - a word spoken in a voice note.
  - The instantiated private held-out run (`bun run eval:real`) was a merge
    precondition of the spine pull request. The owner waived it for merge by
    an exception on 2026-10-25 (recorded on the pull request): the fixture
    held-out cases are the receipt, and the private run happens once a real
    install with data exists.
- **Review.** Astra on this design (done, below), then the critical-review
  receipt on the implementing pull request's head.
- **Checks named for the spine:**
  - contract check;
  - architecture guard;
  - classifier-neutrality suite;
  - `test/tier-hold-until-judged-guard.test.ts`;
  - store-open guard (forget steps for the new queues and the job store's new
    step);
  - public-surface guard, with the allowlist not growing.

## Order

1. **Spine.**
   - It contains:
     - the contract fields;
     - the store and ledger columns;
     - the judge's parent-names context;
     - the cascade and its queue;
     - the generation check;
     - the extraction-jobs forget by account scope;
     - sync deferral;
     - candidate projection;
     - per-account connector resolution and the locator hand-off;
     - each reader's input declaration and the bounded or spooled reads;
     - the citation dependency, with release-manifest invalidation, and the
       output schemas.
   - It is tested with a fixture connector, so no format is touched.
2. **Archives.**
   - The formats, in this order:
     - WhatsApp media (zip and folder);
     - Telegram media (folder);
     - mbox attachments, with the 32 MiB admission change;
     - Reflect and Roam assets.
   - It adds the media-left-out sentences and extends the release-check
     archive leg (below).
3. **Gmail attachments.**
4. **Evernote.** The Evernote connector emits resources as children from its
   first version.

## Done when

- **Release check, fresh installs.** These pass on fresh Mac (Tart) and Linux
  (LXD) installs, through the release check's archive leg:
  - **Finding a child.** An agent finds words that exist only inside a child,
    cited as the file in its message. The cases are:
    - a WhatsApp photo with text and a WhatsApp voice note;
    - a Telegram PDF;
    - an mbox PDF attachment.
  - **Removal.** Removing an archive while its children are being read
    removes the children and their jobs, and nothing lands afterwards.
  - **Tiers.** Each child is judged on its own:
    - a child whose content is ordinary is Personal under a Private parent;
    - a child holding a secret is a Secret location under a Personal parent.
  - **Media left out.** An export without media lists the media it left out,
    by name, under "Not imported". So does a single chosen file with media
    beside it.
- **Gmail.** An attachment's words are answerable and cited with its message
  on a real account (owner canary).
- **Checks.** The private held-out run is green, or the owner's exception is
  recorded, and the checks named above are green.

## Review

Astra (Codex, high), 2026-10-25, two rounds on main `bf8d7e4c`.

Round 2, five findings, all folded in:

- **A consumed parent label.** It is a release dependency: a revoked label
  withholds or regenerates the answer.
- **Media bindings.** The manifest stays immutable; media files are bound in
  an append-only table that resume points do not hash.
- **Readers.** Each declares its input, with a bound enforced while reading
  bytes, or a scoped path or spooled file for file readers.
- **The judge's parent context.** It is screened and authorized on its own;
  its detector result never reaches the child.
- **The locator after a restart.** It reaches the connector through
  `fetchItem`'s optional argument.

Round 1, twelve findings, and how each is settled:

- **Tier dependency and propagation.** Astra's tier dependency finding and
  its propagation finding came from a parent floor, which the owner's
  decision removes: no child waits on, or moves with, its parent.
- **The parent label** needs a destination-scoped authorization and travels
  as a dependency through dispatch and release.
- **Cascade** is a ledger hide plus durable per-store deletes, behind an
  archive generation.
- **Children cross pages**, with positions taken from their references.
- **Media beside a chat export** joins the manifest only under a chosen folder.
- **Reading later** has durable locators, availability, sync deferral,
  per-row provider and per-account connector resolution.
- **Read-once for identical files** is moved to later, with its real
  requirements.
- **Size.** Admission is separate from reader limits, and the mbox 32 MiB
  skip becomes an admission fix.
- **The private held-out run** is a merge precondition.
- **Output schemas and unreadable entries** carry the parent.
- **Gmail** has a per-message MIME cache, inline bytes and a request budget;
  the claim that attachment ids are re-issued is marked unverified.

## Open questions

None for the owner. The Secrets-parent question was settled on 2026-10-25:
each child is judged on its own.
