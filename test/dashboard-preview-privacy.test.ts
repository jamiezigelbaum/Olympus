import { describe, expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_STATES, previewPrivacyToolResult, previewPrivacySteps, previewPrivacyScope } from '../scripts/dashboard-preview.ts';
import { PRIVACY_META_KEY } from '../src/workers/chatgpt/dashboard-contract.ts';

describe('privacy preview fixtures', () => {
  test('deep links reach every sheet step, Details and conflict; picker fixtures have no names in structuredContent', () => {
    for (const state of ['privacy-edit', 'privacy-add-kind', 'privacy-add-pick', 'privacy-add-confirm', 'privacy-details', 'privacy-conflict', 'privacy-add-folder', 'privacy-add-label'] as const) {
      expect(DASHBOARD_PREVIEW_STATES).toContain(state);
      expect(previewPrivacySteps(state)).toStartWith('key:privacy:edit');
    }
    expect(previewPrivacySteps('privacy-add-confirm')).toEndWith('key:privacy:sender:add');
    expect(previewPrivacySteps('privacy-conflict')).toEndWith('key:privacy:sheet:confirm');
    expect(previewPrivacySteps('privacy-details')).toEndWith('key:privacy:details');
    for (const source of ['gmail.email', 'dropbox.files']) {
      expect(JSON.stringify(previewPrivacyScope(source).structuredContent)).not.toMatch(/Health|Family|Travel/);
    }
  });
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
