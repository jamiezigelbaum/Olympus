/**
 * The most bytes each kind of bytes reader takes in memory (`Extractor.input`).
 *
 * Shared by every source: a source enforces the bound while reading, and an
 * item whose stated size is over it is listed as too large and never read. A
 * reader that takes a file path declares no bound here, because nothing is
 * held in memory.
 *
 * Doc comments here are always multi-line blocks.
 */

/**
 * Documents (text, PDF, office files) read whole. Generous, so a large
 * ordinary document is read, while a huge file cannot exhaust memory.
 */
export const DOCUMENT_READER_MAX_INPUT_BYTES = 256 * 1024 * 1024;

/**
 * A reader of still images alone: a phone photo is a few megabytes, and the
 * image preparation (`image-prepare.ts`) takes this same bound as its own.
 */
export const IMAGE_READER_MAX_INPUT_BYTES = 64 * 1024 * 1024;
