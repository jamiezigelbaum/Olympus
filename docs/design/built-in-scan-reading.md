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
| macOS, Vision unavailable (no script, old macOS, framework missing) | the probed command engines below, else names-only (`ocr_required`) |
| macOS with `OLYMPUS_FILE_EXTRACTION_OCR_ENGINE=tesseract` | `ocrmypdf` run directly, no probe, no fallback engine |
| Linux and everywhere else | the probed command engines below |

### Command engines are probed, not presumed

Where Vision does not read, the text lane runs each command once on a tiny
generated fixture (`extractors/ocr-capability.ts`): the word OLYMPUS as a
picture, wrapped in a one-page PDF with no text layer. A command that exists
but cannot read it is not an engine. The answer picks the engine:

| Scanned PDF | When |
|---|---|
| `ocrmypdf` | its real command, `--clean` included, reads the fixture PDF |
| `pdftoppm` pages read by `tesseract` | otherwise, when both pass (Arch and Omarchy have no `ocrmypdf` in their repositories) |
| not read | otherwise: the PDF stays `ocr_required` |

A picture is read by `tesseract` when it reads the fixture picture, and is
otherwise names-only. The raster engine renders grayscale PNG pages at 200 dpi
in ranges of eight pages, lowering the resolution of each page from that page's
own size (as far as 1 dpi) so every page's long edge stays within the same
3,000-pixel cap as Vision; when `pdfinfo` cannot describe the document it asks
`pdftoppm` to scale the long edge instead (`-scale-to`, at most 2,400 px), reads each page with `tesseract
--psm 3`, and keeps Vision's bounds: 100 pages, the text cap, a 600-second
whole-file deadline, each cut recorded as a warning. It marks its text
`ocr_engine_tesseract`. A PDF `pdftoppm` refuses settles with the lane's
`ocrmypdf_pdf_encrypted` / `ocrmypdf_pdf_invalid` kinds.

The probe result is cached: ten minutes while an engine works, one minute
while none does, so an install is noticed without a process per file.

### Recovery

* A scan or picture the text lane could not read because no OCR engine ran
  settles `metadata_only` with `ocr_required` and `ocr_unavailable` on its
  derivation; the job keeps its identity (no version change). The text
  extractor carries the runner's `reread` policy (`unreadWarnings:
  ['ocr_required']`, `notReadyWarnings: ['ocr_unavailable']`): when the probe
  says OCR works, the item is requeued and read. An item carrying
  `ocr_unavailable` was never read, so it stays eligible until it is; only items
  settled before the marker existed spend the once-ever requeue.
* The decision uses a FRESH probe answer only (an expired "ready" starts a
  probe and answers `pending`), and a command found missing when it is run
  forgets the cached answer, so a stale answer cannot spend a recovery.
* A picture settled before the marker existed carries no `ocr_required`, so it
  is not found by the policy.
* With the engine pinned to `tesseract`, pictures are not read in the text lane
  and are not marked, as before.
* A scan that was only partly read settles with its cut recorded
  (`ocr_pdf_pages_capped`, `ocr_pdf_time_capped`, `ocr_pdf_page_unreadable`),
  also when no page yielded text; a command failure that left nothing read is a
  retryable failure, not an empty scan.

`olympus doctor` (`ocr_reading`) and `olympus setup` (an optional `ocr`
finding) report the engines, or one install command by distribution from
`/etc/os-release` and honour `OLYMPUS_FILE_EXTRACTION_OCR_ENGINE`
(pinned to `tesseract`, the report says what that engine reads and the one
remedy is the setting): `sudo pacman -S --needed tesseract tesseract-data-eng
poppler` (Arch, Omarchy), `sudo apt install tesseract-ocr poppler-utils`
(Debian, Ubuntu), `sudo dnf install tesseract poppler-utils` (Fedora), else the
package names. `ocrmypdf` is never required. Olympus does not bundle tesseract.

The lane keeps its `local_ocr_tesseract` kind and `ocr-v1` version: stored
jobs, terminal-reclassification rules and operator tooling key on them. The
engine that read a file is recorded on its derivation as the
`ocr_engine_apple_vision` warning.

## Routing

There is no new lane. The shared text lane already hands a PDF with no usable
text layer (empty, or text the inline decoder cannot decode) to the OCR lane's
PDF reader; it now also hands every image to the OCR lane's image reader. Both
use the built-in engine when it is selected, else the probed command engines.
With no working tesseract the image hook answers nothing and images stay
names-only in the text lane; the explicit OCR lane still runs the commands
directly when a job asks for it.

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
