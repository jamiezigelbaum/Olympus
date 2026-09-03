// The two halves of a media criterion are ANDed, as the interface contract and
// the plugin config schema both promise. The size half stands alone only where
// the type half has nothing to read at all — otherwise a rule written for video
// silently refuses every large document in the corpus.

import { describe, expect, test } from 'bun:test';
import {
  createSourceExclusionMatcher,
  parseSourceIngestionExclusions,
} from '../src/core/source-ingestion-exclusions.ts';

const SOURCE = 'dropbox.personal';
const HUNDRED_MB = 100 * 1024 * 1024;
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv'] as const;

describe('media criterion halves', () => {
  test('a large document of a known non-media type is admitted by a video rule', () => {
    const matcher = bigVideoMatcher();
    const over = { sizeBytes: 150 * 1024 * 1024 };

    expect(matcher.evaluateItem({ path: '/2 Areas/scan.pdf', mimeType: 'application/pdf', ...over }).excluded)
      .toBe(false);
    expect(matcher.evaluateItem({ path: '/2 Areas/project.zip', ...over }).excluded).toBe(false);
    expect(matcher.evaluateItem({ path: '/2 Areas/notes.md', mimeType: 'text/plain', ...over }).excluded)
      .toBe(false);
  });

  test('the named media type over the bound is still excluded', () => {
    const matcher = bigVideoMatcher();

    const decision = matcher.evaluateItem({ path: '/2 Areas/wedding.mov', sizeBytes: 4_000_000_000 });
    expect(decision.excluded).toBe(true);
    expect(decision.outcome).toBe('excluded_media');
    expect(decision.ruleId).toBe('big-videos');
  });

  test('an opaque oversized item is still decided by size alone', () => {
    const matcher = bigVideoMatcher();

    // No extension and a MIME that names no type: the type half has nothing to
    // read, so the owner's measured bound is the only evidence there is.
    const decision = matcher.evaluateItem({
      name: 'opaque-provider-id',
      mimeType: 'application/octet-stream',
      sizeBytes: 999_999_999,
    });
    expect(decision.excluded).toBe(true);
    expect(decision.outcome).toBe('excluded_media');
  });

  test('an unmeasurable item of unknown type stays admitted', () => {
    const matcher = bigVideoMatcher();

    expect(matcher.evaluateItem({ path: '/2 Areas/Family' }).excluded).toBe(false);
    expect(matcher.evaluateItem({ name: 'opaque-provider-id', mimeType: 'application/octet-stream' }).excluded)
      .toBe(false);
  });
});

function bigVideoMatcher() {
  return createSourceExclusionMatcher(
    parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'big-videos',
        sources: [SOURCE],
        media: { min_bytes: HUNDRED_MB, extensions: [...VIDEO_EXTENSIONS] },
        reason: 'oversized_media',
      }],
    }),
    SOURCE,
    { enforceable: ['path_prefix', 'media'] },
  );
}
