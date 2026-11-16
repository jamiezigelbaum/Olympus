// The ChatGPT private panel follows the owner's own Private answer route: a
// local model first in the secure_local pool answers with limits sized from
// its served window; anything else leaves the panel on the built-in model,
// never on a cloud route of its own. Synthetic fixtures only.

import { describe, expect, test } from 'bun:test';
import type { AnalystModel } from '../src/core/analyst.ts';
import type { SovereigntyResolvedProfile } from '../src/core/sovereignty.ts';
import { PANEL_ANSWER_LIMITS, panelLimitsForWindow } from '../src/workers/chatgpt/private-answer-model.ts';
import { createLocalPrivateRoute } from '../src/workers/engine/runtime/private-analysts.ts';

const localMember: SovereigntyResolvedProfile = {
  id: 'delphi',
  profile: { provider: 'local-openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'big-local' },
} as SovereigntyResolvedProfile;
const cloudMember: SovereigntyResolvedProfile = {
  id: 'venice',
  profile: { provider: 'venice', model: 'cloud-model' },
} as SovereigntyResolvedProfile;
const fakeModel = { complete: async () => ({}) } as unknown as AnalystModel;

describe('panel limits from the served window', () => {
  test('an unknown or small window keeps at least today\'s limits', () => {
    for (const window of [0, 4_096, 12_288]) {
      const limits = panelLimitsForWindow(PANEL_ANSWER_LIMITS, window);
      for (const key of ['maxItems', 'maxPromptBytes', 'maxAnswerChars', 'leadingEvidenceChars', 'summaryEvidenceChars', 'deepEvidenceChars', 'deepPromptBytes', 'deepAnswerChars'] as const) {
        expect(limits[key]).toBeGreaterThanOrEqual(PANEL_ANSWER_LIMITS[key]);
      }
    }
  });

  test('a 32k window reads more items and more evidence, together', () => {
    const limits = panelLimitsForWindow(PANEL_ANSWER_LIMITS, 32_768);
    expect(limits.maxPromptBytes).toBe(27_000);
    expect(limits.maxItems).toBe(9);
    expect(limits.summaryEvidenceChars).toBeGreaterThan(PANEL_ANSWER_LIMITS.summaryEvidenceChars * 2);
    expect(limits.deepPromptBytes).toBe(27_000);
    // Evidence must fit the prompt it is sized for.
    expect(limits.summaryEvidenceChars).toBeLessThan(limits.maxPromptBytes);
    expect(limits.deepEvidenceChars).toBeLessThan(limits.deepPromptBytes);
  });
});

describe('the owner\'s Private route for the panel', () => {
  test('a cloud first member is never taken: the panel stays on the built-in model', async () => {
    let built = 0;
    const route = createLocalPrivateRoute({
      firstMember: () => cloudMember,
      model: () => { built += 1; return { model: fakeModel, modelId: 'cloud-model' }; },
      reachable: async () => true,
      window: async () => ({ windowTokens: 32_768 }),
    });
    expect(await route()).toBeUndefined();
    expect(built).toBe(0);
  });

  // Jamie, 2026-11-16: "for my Olympus, we should never be using the small model".
  test('an owner model that is down is reported, never swapped for the built-in model, and reachability is asked at most every 30 s', async () => {
    let at = 0;
    let checks = 0;
    let up = false;
    const route = createLocalPrivateRoute({
      firstMember: () => localMember,
      model: () => ({ model: fakeModel, modelId: 'big-local' }),
      reachable: async () => { checks += 1; return up; },
      window: async () => ({ windowTokens: 32_768 }),
      now: () => at,
    });
    expect(await route()).toEqual({ unavailable: true, modelId: 'big-local' });
    up = true;
    at = 10_000;
    expect(await route()).toEqual({ unavailable: true, modelId: 'big-local' });
    expect(checks).toBe(1);
    at = 31_000;
    expect(await route()).toEqual({ model: fakeModel, modelId: 'big-local', windowTokens: 32_768 });
    expect(checks).toBe(2);
  });

  test('where the built-in model stands in for the local member (nothing bigger set up), a down member leaves the built-in model answering', async () => {
    const route = createLocalPrivateRoute({
      firstMember: () => localMember,
      model: () => ({ model: fakeModel, modelId: 'big-local' }),
      reachable: async () => false,
      window: async () => ({ windowTokens: 32_768 }),
      builtInStandsIn: () => true,
    });
    expect(await route()).toBeUndefined();
  });

  test('once the owner model has answered, the built-in model never stands in for it', async () => {
    let at = 0;
    let up = true;
    const route = createLocalPrivateRoute({
      firstMember: () => localMember,
      model: () => ({ model: fakeModel, modelId: 'big-local' }),
      reachable: async () => up,
      window: async () => ({ windowTokens: 32_768 }),
      builtInStandsIn: () => true,
      now: () => at,
    });
    expect(await route()).toMatchObject({ modelId: 'big-local' });
    up = false;
    at = 31_000;
    expect(await route()).toEqual({ unavailable: true, modelId: 'big-local' });
  });

  test('an unknown window still routes, within the default budget', async () => {
    const route = createLocalPrivateRoute({
      firstMember: () => localMember,
      model: () => ({ model: fakeModel, modelId: 'big-local' }),
      reachable: async () => true,
      window: async () => { throw new Error('no props'); },
    });
    expect(await route()).toMatchObject({ windowTokens: 0 });
  });
});
