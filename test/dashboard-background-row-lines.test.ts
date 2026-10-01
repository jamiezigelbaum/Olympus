import { describe, expect, test } from 'bun:test';
import { dashboardBackgroundRowLines } from '../src/workers/dashboard/pages/background.ts';

describe('home background card lines', () => {
  test('a lane with nothing to say draws no row', () => {
    const lines = dashboardBackgroundRowLines([
      { name: 'Indexing', facts: '98% done', fraction: 0.98, working: true, checks: [] },
      { name: 'Syncing', facts: '', working: false, checks: [] },
    ]);
    expect(lines.map((line) => line.name)).toEqual(['Indexing']);
  });

  test('a lane with only a bar still draws its row', () => {
    const lines = dashboardBackgroundRowLines([{ name: 'Reading files', facts: '', fraction: 0.5, working: true, checks: [] }]);
    expect(lines).toHaveLength(1);
  });
});
