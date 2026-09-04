// olympus doctor must be loopable: a red walk exits non-zero and says which
// checks are red without anyone parsing the JSON.
import { describe, expect, test } from 'bun:test';
import { doctorFailureSummary } from '../src/cli.ts';

describe('olympus doctor exit surface', () => {
  test('doctor failures are summarized in counts and check names only', () => {
    const summary = doctorFailureSummary({
      ok: false,
      checks: [
        { name: 'dependencies', ok: true, detail: 'fine' },
        { name: 'email_worker', ok: false, detail: 'not reachable' },
        { name: 'source_index_status', ok: false, detail: 'not reachable' },
      ],
    });
    expect(summary[0]).toBe('olympus doctor: 1 of 3 checks passed, 2 failed.');
    expect(summary[1]).toBe('Failed: email_worker, source_index_status');
    expect(summary.join('\n')).toContain('run olympus doctor again');
  });
});
