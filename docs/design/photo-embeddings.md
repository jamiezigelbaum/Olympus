# Photos searchable by content

Status: implemented (branch `claude/photo-embeddings`), 2026-10-07.

Owner decisions (2026-10-07): photos first (video stays names-only), Mac
first, and a photo's content rests Private until a media judge exists.

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
6. **Tiers.** A picture, and any text read off a picture, is stored only in
   a Private store: the shared store sink refuses image content for any
   other trust domain (`store_image_content_private_only`, settled names
   only), whichever lane wrote it (a Google Drive lane with no tier set
   included); the store itself refuses chunk media outside a Private store;
   and a tier-move copy into a Personal store keeps the text and drops the
   picture. A still image's content tier is Private by default
   (`content:image_private_default`), whatever its OCR text says and whatever
   rule set its names; the names keep their own tier. Secrets read off the
   picture still make it Secrets, and the owner's per-item override still
   decides. Private chunks are embedded only by providers approved for
   Private content (the built-in model; Venice Private embeds the text alone
   and never receives the picture) and searched only on the Private path.
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

## Not in this step

Video, a media judge that could lower a photo's tier, vision on Linux
(no `sips`), and image search for non-built-in embedding providers.
