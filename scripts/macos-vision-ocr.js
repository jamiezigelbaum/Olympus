// Olympus built-in scan reading for macOS.
//
// Run by the file-extraction OCR lane as
//
//   /usr/bin/osascript -l JavaScript macos-vision-ocr.js pdf   <path> <firstPage> <lastPage> <maxPixelEdge>
//   /usr/bin/osascript -l JavaScript macos-vision-ocr.js image <path> <maxPixelEdge>
//
// It reads text on-device with the operating system's own frameworks: PDFKit
// renders each PDF page to a bitmap and Vision's accurate text recognizer reads
// it, with automatic language detection. Nothing is installed and nothing
// leaves the machine. The script reads only the file it is given and writes
// only to stdout and stderr; it requests no privacy permission.
//
// Pages are rendered and recognized one at a time at a bounded pixel size. The
// caller reads a long document in short page ranges, one process per range, so
// memory is bounded by the range rather than by the document, and it bounds
// the wall-clock time of each run.
//
// Output (stdout, one JSON object):
//   { "engine": "apple_vision", "totalPages": n,
//     "pages": [{ "page": 1, "text": "...", "confidence": 0.93, "lines": 12 }] }
//
// Exit codes (the caller maps them to job outcomes):
//   0   success (a page with no text is a success with empty text)
//   64  usage error
//   65  the input cannot be opened or decoded (deterministic)
//   66  the PDF is encrypted / locked (deterministic)
//   69  Vision or PDFKit is unavailable on this system (use another engine)
//   any other non-zero exit is transient

ObjC.import('Foundation');
ObjC.import('stdlib');

const EXIT_USAGE = 64;
const EXIT_INPUT_UNREADABLE = 65;
const EXIT_PDF_LOCKED = 66;
const EXIT_ENGINE_UNAVAILABLE = 69;

function fail(code, message) {
  const stderr = $.NSFileHandle.fileHandleWithStandardError;
  stderr.writeData($(`${message}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(code);
}

function importFrameworks() {
  try {
    ObjC.import('AppKit');
    ObjC.import('PDFKit');
    ObjC.import('Vision');
  } catch (error) {
    fail(EXIT_ENGINE_UNAVAILABLE, `framework import failed: ${error}`);
  }
  if (typeof $.VNRecognizeTextRequest === 'undefined' || typeof $.PDFDocument === 'undefined') {
    fail(EXIT_ENGINE_UNAVAILABLE, 'Vision text recognition is unavailable on this system');
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(EXIT_USAGE, `${name} must be a positive integer`);
  return parsed;
}

function newTextRequest() {
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  if (request.respondsToSelector('setAutomaticallyDetectsLanguage:')) {
    request.automaticallyDetectsLanguage = true;
  } else {
    request.recognitionLanguages = $(['en-US', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR']);
  }
  return request;
}

// Vision returns one observation per text run. A table row ("Hemoglobin",
// "14.2", "g/dL") comes back as separate runs, so runs are regrouped into
// visual lines: sorted top to bottom, a run joins the current line when its
// vertical centre falls inside that line's band, and each line reads left to
// right. That keeps a row's label and value together for the reader.
function recognize(handler) {
  const request = newTextRequest();
  const error = $();
  if (!handler.performRequestsError($.NSArray.arrayWithObject(request), error)) {
    return undefined;
  }
  const results = request.results;
  const count = results.isNil() ? 0 : Number(results.count);
  const runs = [];
  for (let index = 0; index < count; index += 1) {
    const observation = results.objectAtIndex(index);
    const candidates = observation.topCandidates(1);
    if (Number(candidates.count) === 0) continue;
    const candidate = candidates.objectAtIndex(0);
    const text = ObjC.unwrap(candidate.string);
    if (!text || !text.trim()) continue;
    const box = observation.boundingBox;
    runs.push({
      text: text.trim(),
      confidence: Number(candidate.confidence),
      x: box.origin.x,
      midY: box.origin.y + box.size.height / 2,
      height: box.size.height,
    });
  }
  runs.sort((a, b) => b.midY - a.midY || a.x - b.x);
  const lines = [];
  for (const run of runs) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.midY - run.midY) <= Math.max(line.height, run.height) / 2) {
      line.runs.push(run);
    } else {
      lines.push({ midY: run.midY, height: run.height, runs: [run] });
    }
  }
  let weighted = 0;
  let weight = 0;
  for (const run of runs) {
    weighted += run.confidence * run.text.length;
    weight += run.text.length;
  }
  return {
    text: lines
      .map((line) => line.runs.sort((a, b) => a.x - b.x).map((run) => run.text).join('  '))
      .join('\n'),
    confidence: weight > 0 ? Math.round((weighted / weight) * 1000) / 1000 : 0,
    lines: lines.length,
  };
}

function readImage(path, maxPixelEdge) {
  const url = $.NSURL.fileURLWithPath(path);
  const image = $.NSImage.alloc.initWithContentsOfURL(url);
  if (image.isNil() || !image.isValid) fail(EXIT_INPUT_UNREADABLE, 'image could not be decoded');
  const rep = image.representations.firstObject;
  const width = rep.isNil() ? 0 : Number(rep.pixelsWide);
  const height = rep.isNil() ? 0 : Number(rep.pixelsHigh);
  if (!(width > 0 && height > 0)) fail(EXIT_INPUT_UNREADABLE, 'image has no bitmap representation');
  const bitmap = flattened(image, width, height, maxPixelEdge);
  const result = recognize($.VNImageRequestHandler.alloc.initWithDataOptions(bitmap, $({})));
  if (!result) fail(EXIT_INPUT_UNREADABLE, 'text recognition rejected the image');
  return { engine: 'apple_vision', totalPages: 1, pages: [{ page: 1, ...result }] };
}

// The image is redrawn onto an opaque white bitmap no larger than maxPixelEdge
// on its long side before Vision sees it. White, because a screenshot with a
// transparent background otherwise reads as dark text on black; bounded,
// because a photo straight off a camera would otherwise be decoded whole.
function flattened(image, width, height, maxPixelEdge) {
  const scale = Math.min(1, maxPixelEdge / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const bitmap = $.NSBitmapImageRep.alloc
    .initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, targetWidth, targetHeight, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0,
    );
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));
  const rect = $.NSMakeRect(0, 0, targetWidth, targetHeight);
  $.NSColor.whiteColor.setFill;
  $.NSRectFill(rect);
  image.drawInRectFromRectOperationFraction(rect, $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return bitmap.TIFFRepresentation;
}

function readPdf(path, firstPage, lastPage, maxPixelEdge) {
  const url = $.NSURL.fileURLWithPath(path);
  const document = $.PDFDocument.alloc.initWithURL(url);
  if (document.isNil()) fail(EXIT_INPUT_UNREADABLE, 'PDF could not be opened');
  if (document.isLocked && !document.unlockWithPassword('')) fail(EXIT_PDF_LOCKED, 'PDF is encrypted');
  const totalPages = Number(document.pageCount);
  if (totalPages <= 0) fail(EXIT_INPUT_UNREADABLE, 'PDF has no pages');
  const pages = [];
  const last = Math.min(lastPage, totalPages);
  for (let pageNumber = firstPage; pageNumber <= last; pageNumber += 1) {
    const page = document.pageAtIndex(pageNumber - 1);
    if (page.isNil()) {
      pages.push({ page: pageNumber, text: '', confidence: 0, lines: 0, unreadable: true });
      continue;
    }
    const bounds = page.boundsForBox($.kPDFDisplayBoxCropBox);
    const rotated = Math.abs(Number(page.rotation)) % 180 === 90;
    const widthPts = rotated ? bounds.size.height : bounds.size.width;
    const heightPts = rotated ? bounds.size.width : bounds.size.height;
    // Twice the page's point size reads small print well; the long edge is
    // capped so an oversized page cannot balloon one bitmap.
    const scale = Math.min(2, maxPixelEdge / Math.max(widthPts, heightPts, 1));
    const size = $.NSMakeSize(
      Math.max(1, Math.round(widthPts * scale)),
      Math.max(1, Math.round(heightPts * scale)),
    );
    const image = page.thumbnailOfSizeForBox(size, $.kPDFDisplayBoxCropBox);
    const bitmap = image.isNil() ? undefined : image.TIFFRepresentation;
    const result = bitmap && !bitmap.isNil()
      ? recognize($.VNImageRequestHandler.alloc.initWithDataOptions(bitmap, $({})))
      : undefined;
    pages.push(result
      ? { page: pageNumber, ...result }
      : { page: pageNumber, text: '', confidence: 0, lines: 0, unreadable: true });
  }
  return { engine: 'apple_vision', totalPages, pages };
}

function run(argv) {
  const mode = argv[0];
  const path = argv[1];
  if (!path || (mode !== 'pdf' && mode !== 'image')) {
    fail(EXIT_USAGE, 'usage: macos-vision-ocr.js pdf <path> <firstPage> <lastPage> <maxPixelEdge> | image <path> <maxPixelEdge>');
  }
  if (!$.NSFileManager.defaultManager.isReadableFileAtPath(path)) {
    fail(EXIT_INPUT_UNREADABLE, 'input file is not readable');
  }
  importFrameworks();
  if (mode === 'image') {
    return JSON.stringify(readImage(path, positiveInteger(argv[2] ?? '4096', 'maxPixelEdge')));
  }
  const firstPage = positiveInteger(argv[2] ?? '1', 'firstPage');
  const lastPage = positiveInteger(argv[3] ?? String(firstPage), 'lastPage');
  if (lastPage < firstPage) fail(EXIT_USAGE, 'lastPage must not precede firstPage');
  return JSON.stringify(readPdf(path, firstPage, lastPage, positiveInteger(argv[4] ?? '3000', 'maxPixelEdge')));
}
