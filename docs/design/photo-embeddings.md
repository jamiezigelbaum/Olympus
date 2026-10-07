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

1. **Ingestion policy.** The default rule that kept `image/*` names-only is
   now video only (`media_default_metadata_only`). Still images (jpeg, jpg,
   png, heic, heif, webp, gif, tif, tiff, bmp) are extracted by default. The
   book-library rule is unchanged, so covers in a Calibre library stay
   names-only. The readiness ladder's deferral list follows.
2. **Image preparation (text lane).** On macOS the shared text lane converts
   a still image with `/usr/bin/sips` to a JPEG of at most 1,024 pixels on its
   long side (HEIC included) and stores it content-addressed by SHA-256 in an
   owner-only media cache (directory 0700, files 0600):
   `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/media-cache`, or
   `OLYMPUS_MEDIA_CACHE_DIR`. The extraction is `indexed`: its text is
   `Photo` plus any text Apple Vision reads off the picture, and its new
   optional `media` field names the prepared copy. Originals over 64 MB are
   `skipped_too_large`; a `sips` refusal settles `failed_terminal`
   (`image_prepare_failed`), a timeout retries. Off macOS nothing is built and
   images behave exactly as before.
3. **Store.** `media` travels runner, sink, store and lands on the item's
   first chunk (`chunks.media_path`, `chunks.media_sha256`; additive schema
   migration v13). The chunk's `embedding_input_hash` includes the picture's
   digest, so a changed picture re-embeds; text-only chunks hash exactly as
   before, so no stored vector moves. A delete trigger queues media no chunk
   references any more, and the store releases it; each store holds a marker
   beside a cache file it references, and the file is removed with its last
   marker (a tier move's copy keeps it alive in the other store).
4. **Embedding.** `SourceEmbeddingInput` gains an optional `image`. The embed
   lane passes it for a chunk with media; a chunk whose cache file is missing
   is skipped (not embedded as text under a hash that names the picture).
   Only the built-in LiteRT provider reads it; every other provider embeds
   the text alone. The document prompt is the usual
   `title: {title} | text: {text}`, plus the picture, as one joint vector.
   Questions are text only.
5. **Built-in helper.** The EmbeddingGemma 2 spec carries
   `vision: { tokensPerImage: 140 }` (LiteRT-LM 0.18.0 accepts 70 or 140;
   280 fails engine creation). The helper enables the vision backend on the
   same device as the text model and accepts `{ text, image? }` items, reads
   each picture (a regular file of at most 16 MB) and calls the batch API with
   per-item input counts. If no device can start the encoder it starts
   without it and refuses pictures. The model's identity (`configHash`,
   epoch) is unchanged and frozen by a test.
6. **Tiers.** A still image's content tier is Private by default
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
