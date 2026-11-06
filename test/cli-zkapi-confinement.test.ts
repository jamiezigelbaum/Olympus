import { expect, test, spyOn } from 'bun:test';
import { printConfinementStatus } from '../src/cli.ts';

test.each([
  [true, 'network confinement: ready (test)'],
  [false, 'network confinement: unavailable: namespace_unavailable; One step needs an administrator.\n\nsudo example'],
  [false, 'network confinement: unavailable: launcher_missing_or_untrusted; helper missing'],
])('prints the check unchanged and returns readiness', async (ok, line) => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await printConfinementStatus({ limit: '', check: async () => ({ ok, line }) })).toBe(ok);
    expect(log).toHaveBeenCalledWith(line);
  } finally { log.mockRestore(); }
});
