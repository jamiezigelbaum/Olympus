// How the LiteRT helper keeps one picture from failing a whole batch, without
// mistaking an engine fault for bad pictures (litert-helper.ts). Pure: the
// native calls are passed in, so the policy is testable without LiteRT.

/**
 * A 32 x 32 JPEG the image encoder must always be able to read. When pictures
 * fail one by one, this tells a bad picture (it reads) from an engine that
 * cannot read pictures right now (it fails too: a lost GPU, memory pressure).
 */
export const KNOWN_GOOD_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAIAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMACQkJCQkJEAkJEBYQEBAWHhYWFhYeJh4eHh4eJi4mJiYmJiYuLi4uLi4uLjc3Nzc3N0BAQEBASEhISEhISEhISP/bAEMBCwwMEhESHxERH0szKjNLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS//dAAQAAv/aAAwDAQACEQMRAD8A8witvatGK29q0Yrb2rRitvavZqYgzweKM6K29q0Yrb2rRitvatGK29q8+piD6/B4o//QpxW3tWjFbe1aEVt7VoxW3tWNTEHymDxRnxW3tWjFbe1aEVt7VoxWvtXn1MQfX4PFH//Z';

/** Raised by the native caller for a failure inside LiteRT-LM itself. */
export class EngineFaultError extends Error {}

/**
 * The engine failed the known-good picture: it cannot read pictures right
 * now, though it may still read text. The parent counts these, and holds
 * pictures for a while when they keep coming, so text keeps embedding.
 */
export class PictureEngineFaultError extends EngineFaultError {}

/**
 * Embeds `indexes` with `run`, isolating pictures that fail. A batch that
 * fails because of a picture is retried as text alone, then each picture
 * alone. If any picture fails alone, the known-good picture is embedded: if
 * it fails too, the engine is at fault and a PictureEngineFaultError is
 * thrown (the parent replaces the helper, and no picture is blamed).
 * Otherwise the failing pictures are returned, and everything else was
 * embedded.
 */
export function embedIsolatingPictures(
  indexes: readonly number[],
  hasImage: (index: number) => boolean,
  run: (indexes: readonly number[]) => void,
  probeKnownGoodPicture: () => void,
): number[] {
  if (indexes.length === 0) return [];
  try {
    run(indexes);
    return [];
  } catch (error) {
    if (!(error instanceof EngineFaultError) || !indexes.some(hasImage)) throw error;
  }
  const textOnly = indexes.filter((index) => !hasImage(index));
  if (textOnly.length > 0) run(textOnly);
  const failed: number[] = [];
  for (const index of indexes.filter(hasImage)) {
    try {
      run([index]);
    } catch (error) {
      if (!(error instanceof EngineFaultError)) throw error;
      failed.push(index);
    }
  }
  if (failed.length > 0) {
    try {
      probeKnownGoodPicture();
    } catch (error) {
      if (!(error instanceof EngineFaultError)) throw error;
      throw new PictureEngineFaultError(`The image encoder could not read a known-good picture: ${error.message}`);
    }
  }
  return failed;
}
