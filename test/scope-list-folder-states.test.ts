import { describe, expect, test } from 'bun:test';
import { scopeListToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { SCOPE_UI_META_KEY } from '../src/workers/chatgpt/dashboard-contract.ts';

// A saved folder choice reaches the picker as saved. Read on demand once came back as Skip (2026-11-14 release check).
describe('scope list folder states', () => {
  test('every saved folder choice reaches the picker unchanged', () => {
    const states = ['ingest', 'metadata_only', 'on_demand', 'exclude'] as const;
    const result = scopeListToolResult({
      kind: 'folders', source_id: 'dropbox.files', account_generation: 'g', scope_revision: 'r', status: 'approved', nodes: [],
      selections: states.map((state) => ({ key: `/${state}`, state })), whole_account_selected: false,
    });
    const copy = (result._meta as Record<string, unknown>)[SCOPE_UI_META_KEY] as { selections: { key: string; state: string }[] };
    expect(copy.selections.map((selection) => selection.state)).toEqual([...states]);
  });
});
