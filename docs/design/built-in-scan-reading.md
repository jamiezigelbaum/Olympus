# Built-in scan reading

Status: in 1.0 (owner decision 2026-10-02). Code:
[`apple-vision-ocr.ts`](../../src/workers/file-extraction/extractors/apple-vision-ocr.ts),
[`ocr.ts`](../../src/workers/file-extraction/extractors/ocr.ts) and the packaged
script [`scripts/macos-vision-ocr.js`](../../scripts/macos-vision-ocr.js).
Tests: `test/file-extraction-apple-vision-ocr.test.ts`.

A new Mac user installs nothing extra, and scanned PDFs and images are still
read, on the machine, with the operating system's own text recognition.

## Engine

**Decision: JXA under the system `osascript`, not Swift and not a bundled
binary.** Every Mac ships `/usr/bin/osascript`, and its JavaScript runtime
reaches Objective-C frameworks through `ObjC.import`. That is enough to drive
PDFKit (render a page) and Vision (`VNRecognizeTextRequest`, accurate level,
language correction, automatic language detection, so Spanish and English
pages both read). `swift` needs the Xcode command-line tools, and a compiled
helper would put a signed, per-architecture binary in the npm package. The
script is plain text, ships in the public package, and reads only the file it
is given; it asks for no privacy permission.

| Host | Engine |
|---|---|
| macOS (default, `OLYMPUS_FILE_EXTRACTION_OCR_ENGINE` unset or `auto`) | Vision via the packaged script |
| macOS, Vision unavailable (no script, old macOS, framework missing) | `ocrmypdf` / `tesseract` if installed, else names-only (`ocr_required`) |
| macOS with `OLYMPUS_FILE_EXTRACTION_OCR_ENGINE=tesseract` | `ocrmypdf` / `tesseract` |
| Linux and everywhere else | `ocrmypdf` / `tesseract`, as before |

The lane keeps its `local_ocr_tesseract` kind and `ocr-v1` version: stored
jobs, terminal-reclassification rules and operator tooling key on them. The
engine that read a file is recorded on its derivation as the
`ocr_engine_apple_vision` warning.

## Routing

There is no new lane. The shared text lane already hands a PDF with no usable
text layer (empty, or text the inline decoder cannot decode) to the OCR lane's
PDF reader; it now also hands every image to the OCR lane's image reader. Both
use the built-in engine when it is selected. Off macOS the image hook answers
nothing and images stay names-only in the text lane exactly as before; the
explicit OCR lane still reads them with tesseract when a job asks for it.

Recognized text is ordinary extracted text. It goes through the same sink, the
same bounded-text cap and the same per-item four-tier classification (the
owner's map plus the local sniffer) as any other file. Nothing about OCR text
skips or shortcuts classification.

## Bounds and outcomes

- **Pages.** A PDF is read in ranges of 8 pages, one `osascript` process per
  range, so memory is bounded by a range rather than the document. At most 100
  pages (`OLYMPUS_FILE_EXTRACTION_OCR_MAX_PAGES`) are read; the rest is
  recorded with the `ocr_pdf_pages_capped` warning.
- **Pixels.** A page renders at twice its point size with the long edge capped
  at 3,000 pixels; an image is flattened onto white with its long edge capped
  at 4,096 pixels (a transparent screenshot would otherwise read as black).
- **Time.** Each process runs under the lane's OCR timeout
  (`OLYMPUS_FILE_EXTRACTION_OCR_TIMEOUT_SECONDS`, default 120 s). A whole file
  has a 10-minute budget; each range gets only what is left, and pages already
  read are kept with `ocr_pdf_time_capped` when the budget runs out.
- **Text.** Reading stops once the bounded-text cap is reached.
- **Layout.** Vision returns text runs; runs are regrouped into visual lines
  so a table row's label, value and unit stay together. Each PDF page is
  marked `--- Page N ---`.

| Script outcome | Job outcome |
|---|---|
| text found | `indexed`, confidence = Vision's character-weighted mean |
| no text on any page | `metadata_only` descriptor with `ocr_empty` |
| PDF cannot be opened (exit 65) | `failed_terminal` `ocrmypdf_pdf_invalid` (reroutes to the vision lane like a tesseract refusal) |
| PDF is encrypted (exit 66) | `failed_terminal` `ocrmypdf_pdf_encrypted` |
| image cannot be decoded (exit 65) | `failed_terminal` `ocr_image_unreadable` |
| Vision unavailable (exit 69), no `osascript`, no script | engine marked unavailable for the process; tesseract fallback |
| timeout | `failed_retryable` `ocr_command_timeout` |
| any other failure or malformed output | `failed_retryable` `ocr_command_failed` |

## Proof

2026-10-02, the owner's Mac (macOS 26.5), copies of real files in a temporary
directory, live store untouched, through the default registry's text lane:

| Set | Files | Read | Pages | Characters | Seconds |
|---|---|---|---|---|---|
| PDFs with no readable text layer | 20 | 20 | 190 | 237,854 | 195 (about 1 s a page) |
| Images (PNG) | 3 | 3 | — | 5,497 | 6 |

Lowest mean confidence was 0.86; most files were above 0.95. The repository
test generates an image-only PDF and a PNG on the spot and runs the real script
on macOS; the same suite drives every outcome above through a fake runner on
every platform.

Already-settled jobs are not re-run by this change; new and changed files
are read as they sync. On an existing install, `olympus source extract-pdfs
--run --requeue` re-reads the PDF backlog through the text lane, which now
reads the scans. Images that already settled names-only have no equivalent
requeue command yet; that is a follow-up.

## Not in this step

**Audio and video transcription stays on the configured transcription
command.** The Speech framework (`SFSpeechRecognizer`, on-device mode
supported on this Mac) requires the speech-recognition privacy permission even
for files. Its status for `osascript` is "not determined", and `osascript`'s
bundle carries no `NSSpeechRecognitionUsageDescription`, so a background
request would either be refused outright or raise a system permission prompt,
attributed to `osascript` or the engine's host process, that a user would not
understand. The newer `SpeechAnalyzer` API is
Swift-only. Both are left off; no prompt was triggered while checking.

**Charts and photos** (text-free images) still need a local vision model;
that remains a later step.
