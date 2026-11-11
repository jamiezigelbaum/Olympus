import { describe, expect, test } from 'bun:test';
import { openingLinkOf, openingLinkOrThrow } from '../scripts/release-check/opening-link.ts';

describe('the opening link a release check navigates to', () => {
  const link = 'http://127.0.0.1:8787/dashboard/launch#olympus_launch_ticket=abc';

  test('is the url of the command\'s JSON answer, even after a notice line', () => {
    expect(openingLinkOf({ code: 0, stdout: JSON.stringify({ url: link, opened: false, hint: 'see http://example.com' }, null, 2), stderr: '' })).toEqual({ url: link });
    expect(openingLinkOf({ code: 0, stdout: `A notice about http://127.0.0.1:8787/\n${JSON.stringify({ url: link }, null, 2)}`, stderr: '' })).toEqual({ url: link });
  });

  test('is never the worker address a failed mint names (#1338)', () => {
    const failed = {
      code: 1,
      stdout: '',
      stderr: 'Error [email_unreachable]: The Olympus worker at http://127.0.0.1:8787 did not answer the opening request.\nFix: Start the worker (olympus worker status) and run this again.',
    };
    const read = openingLinkOf(failed);
    expect(read).toEqual({ problem: 'exit 1: Error [email_unreachable]: The Olympus worker at http://127.0.0.1:8787 did not answer the opening request.' });
    expect(() => openingLinkOrThrow(failed, 'olympus dashboard --no-open --target dashboard')).toThrow('printed no opening link (exit 1: Error [email_unreachable]');
    expect(openingLinkOf({ code: 0, stdout: 'http://127.0.0.1:8787/', stderr: '' })).toHaveProperty('problem');
  });
});
