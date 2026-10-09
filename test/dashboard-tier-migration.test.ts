// P3 dashboard: a source's Sensitivity section shows its four-tier facts —
// items per tier, Secrets as locations only, items pending classification,
// superseded chunks kept hidden — and the owner's tier migration, only on the
// sources whose stores the plan touches. Counts only.

import { describe, expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_NOW, buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';

describe('dashboard tier counts and migration state', () => {
  test('the view model sums a source\'s tier facts and names the migration only where it applies', () => {
    const view = buildDashboardPreviewView('tier-migration');
    const dropbox = view.sources.find((card) => card.source_id === 'dropbox.files')!;
    expect(dropbox.tier_composition.map((tier) => [tier.label, tier.indexed_items])).toEqual([
      ['Private', 1_240],
      ['Personal', 2_760],
    ]);
    expect(dropbox.tier_classification).toEqual({
      secrets_located: 3,
      pending_classification_items: 40,
      superseded_chunks: 3_100,
      names_only_kept_chunks: 0,
      migration: {
        state: 'running',
        label: 'Tier migration running',
        approval_entry_id: 'tier-migration-approval:tm-3f2a9c1d7e5b4a60:8b1e',
      },
    });
    const readwise = view.sources.find((card) => card.source_id === 'readwise.library')!;
    expect(readwise.tier_classification).toBeUndefined();
  });

});
