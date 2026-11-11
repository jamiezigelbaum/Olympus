// The Approve button on Needs you (privacy:classifier_approval): only the
// computer's own unlocked dashboard approves, and only a local model. The
// bearer (OpenClaw tab), a bearer-minted or launch-ticket session and a locked
// reader are refused and never reach the approval. Synthetic data only.
import { describe, expect, test } from 'bun:test';
import { CLASSIFIER_APPROVE_TOOL_NAME, DASHBOARD_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { createDashboardPanelTools } from '../src/workers/engine/dashboard/dashboard-panel-tools.ts';

const ORIGIN = 'http://127.0.0.1:8010';

function tools(answer: 'approved' | 'nothing_waiting' | 'not_local' | 'throws' = 'approved') {
  const calls: string[] = [];
  const view = buildDashboardPreviewView('partial');
  const panel = createDashboardPanelTools({
    surface: () => ({
      dashboardView: async () => view,
      privacy: () => ({ configured: true, pendingCount: 2, ruleCount: 0, classifierAwaitingApproval: true, classifierWaiting: { lane: 'local', modelId: 'synthetic-judge' } }),
    }) as never,
    setup: {} as never,
    workerFetch: async () => { throw new Error('Approve calls no worker route'); },
    makeContext: () => ({}) as never,
    indexFasterState: async () => undefined,
    approveWaitingClassifier: async () => {
      calls.push('approve');
      if (answer === 'throws') throw new Error('ledger unwritable');
      return answer;
    },
  });
  return { panel, calls };
}

const fixOf = (result: unknown) => ((result as { structuredContent?: { needsYou?: Array<{ id: string; fix: { tool?: string } }> } }).structuredContent?.needsYou ?? [])
  .find((item) => item.id === 'privacy:classifier_approval')?.fix;

describe('the Approve button', () => {
  test('is on the computer\'s list of panel tools', () => {
    expect(tools().panel.allows(CLASSIFIER_APPROVE_TOOL_NAME)).toBe(true);
  });

  test('only an unlocked local session approves; the bearer, other sessions and a locked reader are refused before the approval', async () => {
    for (const context of [{ origin: ORIGIN, opener: 'bearer' }, { origin: ORIGIN, opener: 'session:owner' }, { origin: ORIGIN }]) {
      const { panel, calls } = tools();
      const result = await panel.call(CLASSIFIER_APPROVE_TOOL_NAME, {}, context);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: 'mac_dashboard_only' });
      expect(calls).toEqual([]);
    }
    const { panel, calls } = tools();
    const result = await panel.call(CLASSIFIER_APPROVE_TOOL_NAME, {}, { origin: ORIGIN, opener: 'session:owner', localSession: true });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ status: 'saved' });
    expect(calls).toEqual(['approve']);
  });

  test('takes no arguments, and says plainly when nothing waits, the model is Venice, or the save failed', async () => {
    const local = { origin: ORIGIN, opener: 'session:owner', localSession: true };
    const withArgs = tools();
    expect((await withArgs.panel.call(CLASSIFIER_APPROVE_TOOL_NAME, { model: 'other' }, local)).structuredContent).toEqual({ error: 'invalid_params' });
    expect(withArgs.calls).toEqual([]);
    expect((await tools('nothing_waiting').panel.call(CLASSIFIER_APPROVE_TOOL_NAME, {}, local)).structuredContent).toEqual({ status: 'nothing_waiting' });
    expect((await tools('not_local').panel.call(CLASSIFIER_APPROVE_TOOL_NAME, {}, local)).structuredContent).toEqual({ error: 'not_local' });
    expect((await tools('throws').panel.call(CLASSIFIER_APPROVE_TOOL_NAME, {}, local)).structuredContent).toEqual({ error: 'internal' });
  });

  test('the dashboard shows Approve only to the local session; everyone else sees the row without it', async () => {
    const { panel } = tools();
    expect(fixOf(await panel.call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN, opener: 'session:owner', localSession: true }))?.tool).toBe(CLASSIFIER_APPROVE_TOOL_NAME);
    for (const context of [{ origin: ORIGIN, opener: 'bearer' }, { origin: ORIGIN, opener: 'session:owner' }, { origin: ORIGIN }]) {
      const fix = fixOf(await panel.call(DASHBOARD_TOOL_NAME, {}, context));
      expect(fix?.tool).toBe(DASHBOARD_TOOL_NAME);
    }
  });
});
