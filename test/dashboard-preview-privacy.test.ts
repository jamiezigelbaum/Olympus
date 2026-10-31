import { describe, expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_STATES, previewPrivacyToolResult } from '../scripts/dashboard-preview.ts';
import { PRIVACY_META_KEY } from '../src/workers/chatgpt/dashboard-contract.ts';

describe('privacy preview fixtures', () => {
  test('provides an editor and a conflict using invented settings', () => {
    expect(DASHBOARD_PREVIEW_STATES).toContain('privacy-edit');
    expect(DASHBOARD_PREVIEW_STATES).toContain('privacy-conflict');
    const current = previewPrivacyToolResult('privacy-edit', 'get');
    expect(current.structuredContent.status).toBe('current');
    expect(current._meta[PRIVACY_META_KEY]!.rules).toHaveLength(3);
    const conflict = previewPrivacyToolResult('privacy-conflict', 'set');
    expect(conflict.structuredContent.status).toBe('conflict');
    expect(conflict._meta[PRIVACY_META_KEY]!.revision).not.toBe(current._meta[PRIVACY_META_KEY]!.revision);
    expect(previewPrivacyToolResult('privacy-edit', 'set').structuredContent.status).toBe('saved');
  });
});
