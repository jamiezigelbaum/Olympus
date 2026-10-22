/**
 * The first walk of Files on this computer: while items are still being
 * listed there is no total, so the row publishes what is known (how many were
 * found so far) and no percentage; the ordinary percent returns once a total
 * exists. The signal is the shared listing progress every file source has
 * (Dropbox, Drive), not a local-files special case.
 */
import { describe, expect, test } from 'bun:test';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';

function rowFor(state: string) {
  const model = buildChatGptDashboardViewModel(buildDashboardPreviewView(state), { now: DASHBOARD_PREVIEW_NOW });
  return { model, row: model.sources.find((source) => source.id === 'local.files')! };
}

describe('progress while the first walk is counting', () => {
  test('publishes how many were found and no percentage', () => {
    const { row } = rowFor('local-files-finding');
    expect(row.status).toBe('Working');
    expect(row.progress).toEqual({ stage: 'listing', unit: 'files', done: 12_400, total: 0, stalled: false });
    expect('percent' in row.progress!).toBe(false);
    // The copy the panel receives keeps it that way.
    const copied = copyDashboardViewModel(rowFor('local-files-finding').model);
    expect(copied.sources.find((source) => source.id === 'local.files')!.progress).toEqual(row.progress);
  });

  test('a walk that has read some files is still listing: the count so far, not a share', () => {
    const { row } = rowFor('local-files-indexing');
    expect(row.progress).toMatchObject({ stage: 'listing', done: 6_200, total: 0 });
    expect('percent' in row.progress!).toBe(false);
  });

  test('once listing is done the ordinary stage and percent are back', () => {
    const { row } = rowFor('local-files-reading');
    expect(row.progress?.stage).not.toBe('listing');
    expect(row.progress?.total).toBeGreaterThan(0);
    expect(row.progress?.percent).toBeGreaterThan(0);
  });
});

describe('the page-wide line while any source is still on its first walk', () => {
  test('has no percent and no items left, only what was found so far', () => {
    const { model } = rowFor('local-files-finding-page');
    expect(model.sources.filter((source) => source.status === 'Working').length).toBeGreaterThanOrEqual(2);
    expect(model.progress).toBeDefined();
    expect('percent' in model.progress!).toBe(false);
    expect('itemsLeft' in model.progress!).toBe(false);
    expect(model.progress!.details[0]).toMatchObject({ done: 16_400, total: 0 });
  });
});
