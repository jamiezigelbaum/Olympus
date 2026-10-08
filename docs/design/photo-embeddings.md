# Photos searchable by content

Status: implemented (branch `claude/photo-embeddings`), 2026-10-07.

Owner decisions (2026-10-07): photos first (video stays names-only), Mac
first, and a photo's content rests Private until a media judge exists.
Owner decision (2026-10-08, replacing that interim rule): ordinary photos are
Personal like the owner's other files; only sensitive photos are Private (see
"Photo judge" below).

## What changes for the owner

A question like "the kitchen" or "the pool" finds the photo of it, not only a
file whose name says so. The built-in model (EmbeddingGemma 2 on LiteRT-LM)
embeds each photo's picture together with its title and a short descriptor,
in the same 768-dimension space as text, so the existing vector search and
relevance bar serve photos with no new search path.

## Pipeline (capability, not source)

Nothing below names a source. Every step is shared and keyed by media type.

1. **Ingestion policy.** Where this machine can prepare pictures (macOS with
   `/usr/bin/sips`; `stillImagePreparationAvailable()`), the default rule that
   kept `image/*` names-only is now video only (`media_default_metadata_only`)
   and still images (jpeg, jpg, png, heic, heif, webp, gif, tif, tiff, bmp) are
   extracted. Elsewhere (Linux, the private host) still images stay
   names-only, so no picture is downloaded for nothing. The book-library rule
   is unchanged, so covers in a Calibre library stay names-only. The
   readiness ladder's deferral list follows the same capability. An
   owner-written `~/.olympus/sources/dropbox.personal.ingestion.json` is used
   as written: one that still lists `image/` keeps photos names-only until
   the owner removes the image entries from its media rule.
2. **Image preparation (text lane).** On macOS the shared text lane converts
   a still image with `/usr/bin/sips` to a JPEG of at most 1,024 pixels on its
   long side (HEIC included) and stores it content-addressed by SHA-256 in an
   owner-only media cache (directory 0700, files 0600):
   `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/media-cache`, or
   a dedicated `olympus-media` subdirectory of `OLYMPUS_MEDIA_CACHE_DIR`
   (Olympus never changes the permissions of a directory the owner named).
   Pictures under 1 KB or under 64 pixels on a side (logos, tracking pixels)
   get no picture and keep the previous behaviour. The extraction is
   `indexed`: its text is
   `Photo` plus any text Apple Vision reads off the picture, and its new
   optional `media` field names the prepared copy. Originals over 64 MB are
   `skipped_too_large`; a `sips` refusal settles `failed_terminal`
   (`image_prepare_failed`), a timeout retries. Off macOS nothing is built and
   images behave exactly as before. Pictures read before (OCR text only) are
   queued once more: the text lane's version for images gains the suffix
   `+image-media-2026-10-07` (`Extractor.versionFor`), and a Private store on
   a machine that prepares pictures lists an image with no picture and no
   `image_media_reads` row (every image reading stored since writes one) as
   a candidate, so each is read once and tiny ones do not come back.
   Photo text an earlier build stored in a Personal or Public store is moved
   to the Private store once (a raised content decision and a queued move,
   per tier set; per-item overrides stay) or, in a plain store, stripped once
   with a `sync_runs` note (`olympus_image_content_private_only`).
3. **Store.** `media` travels runner, sink, store and lands on the item's
   first chunk (`chunks.media_path`, `chunks.media_sha256`; additive schema
   migration v13). The chunk's `embedding_input_hash` includes the picture's
   digest, so a changed picture re-embeds; text-only chunks hash exactly as
   before, so no stored vector moves. Holding and releasing:
   - the extraction holds a staging marker from the moment it writes the
     file; the runner releases it after the sink stored or refused the
     result, so a refused or failed result leaves nothing behind and a twin
     photo deleted meanwhile cannot take the file;
   - a store takes its own marker after its write commits;
   - a delete trigger queues media no chunk references any more, drained
     after every write and delete path (restore, import, sync, strip,
     relinquish, purge, metadata-only strip, embed passes, close), using a
     partial index on `chunks(media_sha256)`;
   - the file is removed with its last marker; a sweep at extraction start
     removes files nothing holds after a day;
   - every path is checked to be the cache's own `<sha256>.jpg` before it is
     read, marked or deleted;
   - `olympus data delete --source` releases the source's pictures, and
     `--all` removes the cache directory wherever it is configured.
4. **Embedding.** `SourceEmbeddingInput` gains an optional `image`. The embed
   lane passes it for a chunk with media. Only a provider with
   `imageSupport()` (the built-in LiteRT provider) reads it; every other
   provider embeds the text alone. For a picture-reading provider: while its
   image encoder is not running (or a restart brought it back without it),
   photo chunks are held, nothing recorded (text keeps embedding, and a log
   line says so); a picture the encoder cannot read fails only its own input
   (`SourceEmbeddingInputsFailedError`), is counted in `chunk_media_failures`
   and retried after 1 h and 2 h, and after three failures is dropped so the
   photo embeds as text; a chunk whose cache file is gone has its picture
   dropped and is re-hashed, so it embeds as text. A dropped picture comes
   back only with the next extraction of a changed file; nothing re-queues
   it. An engine fault is never blamed on a picture (see 5). The document prompt is the usual
   `title: {title} | text: {text}`, plus the picture, as one joint vector.
   Questions are text only.
5. **Built-in helper.** The EmbeddingGemma 2 spec carries
   `vision: { tokensPerImage: 140 }` (LiteRT-LM 0.18.0 accepts 70 or 140;
   280 fails engine creation). The helper enables the vision backend on the
   same device as the text model and accepts `{ text, image? }` items, reads
   each picture (a regular file of at most 16 MB) and calls the batch API with
   per-item input counts. If no device can start the encoder it starts
   without it and reports `vision: false`. A batch a picture breaks is split
   (text alone, then each picture alone); a failing picture comes back in
   `failed` and is never treated as an engine fault, so it does not move the
   model off the GPU. When pictures fail one by one, a known-good 32-pixel
   JPEG is embedded: if that fails too the engine is at fault, the helper is
   replaced and no picture is blamed. The model's identity (`configHash`,
   epoch) is unchanged and frozen by a test.
6. **Tiers.** A picture, and any text read off it, rests in a Private store
   unless the photo judge (below) found the picture ordinary:
   - unjudged (no judgment yet, or one that could not be made): Private,
     `content:image_private_default`, as before;
   - sensitive: Private, `content:image_sensitive:<category>`;
   - ordinary: the item's normal content tier from the shared classifier
     (Personal by default, `content:image_ordinary`), so an account or card
     number read off the picture still makes it Private, and Secrets still
     win. The owner's per-item override decides over every verdict.
   The shared store sink refuses an unjudged or sensitive picture (and the
   text read off any picture without an ordinary verdict) for any store that
   is not Private (`store_image_content_private_only`, names only), whichever
   lane wrote it; the store itself refuses chunk media outside a Private
   store unless it holds an ordinary verdict for that picture (keyed on the
   stored verdict, never on the absence of one); and a tier-move copy keeps
   an ordinary picture (with its verdict and, where the destination embeds
   with the same model, its vector) and drops any other picture. The
   one-time #175 sweep (`tier-image-content-sweep.ts`) and its plain-store
   strip leave judged-ordinary photos where they are. Private chunks are
   embedded only by providers approved for Private content and searched only
   on the Private path. Search results and evidence carry text only: no
   analyst, cloud or local, ever receives a picture's bytes or path.
7. **Coverage.** An image with a stored chunk is no longer reported as an
   extraction gap.

## Measurements (owner's Mac, M3, 2026-10-07)

- 116 real photos embedded as `title: <file name> | text: Photo in <folder>`
  plus the picture: correct photos scored cosine 0.73 to 0.78 for plain
  queries (kitchen, bathroom, pool); queries with no matching photo peaked at
  0.695. The EmbeddingGemma 2 relevance bar of 0.73 stays.
- Enabling the vision encoder leaves text vectors identical: cosine 1.000000
  on the CPU, 0.999998 on the GPU. Hence no re-embed and no identity change.
- About 1.4 s per photo on the M3 GPU.
- End to end through this branch (copies of property photos, real `sips`,
  real model): see the pull request for the run's counts and scores.

## Photo judge (2026-10-08)

Shared and source-neutral (`src/workers/source-index/media-judge.ts`,
`src/workers/connector-store/tier-media-judgment-sweep.ts`).

- **Zero-shot.** The picture's IMAGE-ONLY EmbeddingGemma 2 vector is compared
  (cosine) with six descriptions embedded as
  `task: classification | query: <description>`: id_document, bank_card,
  financial_document, medical_document, intimate, and ordinary. The margin is
  the best sensitive score minus the ordinary score. Sensitive when the margin
  is at least 0.04, or when the intimate score alone beats ordinary by at
  least 0.025; otherwise ordinary. Missing or non-finite scores: unjudged. The
  description vectors are made once per model and process; the prompt set is
  versioned (`photo-judge-2026-10-08`) and each judgment records it with the
  model.
- **No extra pass.** In the embed lane a photo not yet judged is embedded with
  `embedWithImageVectors`: the LiteRT helper gets one more item per picture
  (the picture with no text) in the same call. Photos embedded before the
  judge (an existing install) are judged once from their picture alone
  (`embedImageVectors`, at most 200 per pass). The encoder not running holds
  them (nothing recorded); a picture it cannot read is recorded `unjudged`.
  A provider without these methods judges nothing, so its photos stay
  Private.
- **Stored.** Schema v14 adds `media_judgments` (one row per picture digest:
  verdict, category, margin, per-category scores, judge id, `tier_applied`);
  additive, no released version changed. The row goes with the last chunk
  that carries the picture, and travels with a tier-move copy.
- **Applied.** The sniffer's tick and each tiered sync apply new judgments
  (`applyMediaJudgments`): each item carrying the picture is re-decided from
  its stored copy, exactly as a re-judge does. Ordinary photos are queued to
  leave the Private store and moved by the usual tier-move machinery (the
  sniffer's automatic moves copy the picture vector when the destination
  already embeds with the same model; otherwise the owner-approved
  migration); sensitive ones stay, with the category in their reason. A
  re-read of the same picture lands where its verdict puts it; a changed
  picture is unjudged again until it is embedded.
- **Calibration (shipped judge code, owner's Mac, M3 GPU, 140 vision tokens):**
  22 public specimen images (passports, identity cards, driving licences,
  bank cards, bank statements, payslips): all 22 sensitive (10 id_document,
  9 financial_document, 2 bank_card, 1 medical_document), margins 0.052 to
  0.181, median 0.108. The owner's 116 Dropbox photos: median margin -0.010;
  at the owner's chosen intimate bar of 0.025, 8 flagged: the owner's
  lab-result picture (medical, 0.129) and 7 near "intimate" (beach and family
  photos, a book cover; intimate margins 0.025 to 0.041). The intimate rule
  could not be measured on real intimate pictures, so it stays more cautious
  than the general one and costs a few beach photos a Private tier.

## Not in this step

Video, vision on Linux (no `sips`), and image search or judging for
non-built-in embedding providers.
