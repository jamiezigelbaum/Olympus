// Agent-proposed settings (#1050): an agent proposes, the owner applies with
// one click. Proposals are checked against what this computer offers, nothing
// changes until Apply, and Apply runs the dashboard's own writers in order.

import { describe, expect, test } from 'bun:test';
import { parseSettingsProposalInput, SettingsProposalError } from '../src/core/settings-proposal.ts';
import { renderDashboardSettingsPage } from '../src/workers/dashboard/pages/local.ts';
import { createSettingsProposalHolder, type SettingsProposalTargets } from '../src/workers/settings-proposal-holder.ts';

function targets(overrides: Partial<SettingsProposalTargets> = {}) {
  const calls: string[] = [];
  const base: SettingsProposalTargets = {
    answerMode: () => ({ id: 'no-sensitive', label: 'Private answers only in Olympus' }),
    saveAnswerMode: (choice) => { calls.push(`mode:${choice}`); return { ok: true }; },
    judge: () => ({ choice: 'local', capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudModel: 'qwen3-235b', cloudAvailable: true }),
    saveJudge: async (choice, cap) => { calls.push(`judge:${choice}:${cap}`); return { ok: true }; },
    modelChoices: async () => ({
      venice: { provider: 'venice', current: 'qwen3-235b', options: [{ value: 'strongest', label: 'Always the strongest' }, { value: 'qwen3-235b', label: 'Qwen 3 235B' }] },
    }),
    saveModel: async (provider, value) => { calls.push(`model:${provider}:${value}`); return { ok: true }; },
    ...overrides,
  };
  return { calls, targets: base };
}

describe('parseSettingsProposalInput', () => {
  test('accepts the documented keys', () => {
    expect(parseSettingsProposalInput({ private_answer_mode: 'local-first', privacy_judge: { choice: 'venice', spending_limit_dollars: 5 }, models: { venice: 'strongest' } }))
      .toEqual({ private_answer_mode: 'local-first', privacy_judge: { choice: 'venice', spending_limit_dollars: 5 }, models: { venice: 'strongest' } });
  });

  test('refuses what it cannot set, with a reason', () => {
    for (const bad of [
      [],
      {},
      { remote_access: true },
      { private_answer_mode: 'everything-public' },
      { privacy_judge: { choice: 'venice' } },
      { privacy_judge: { choice: 'venice', spending_limit_dollars: -1 } },
      { models: { openai: 'gpt' } },
      { models: { venice: '' } },
    ]) {
      expect(() => parseSettingsProposalInput(bad), JSON.stringify(bad)).toThrow(SettingsProposalError);
    }
  });
});

describe('the proposal holder', () => {
  test('a proposal lists each change and changes nothing until Apply', async () => {
    const { calls, targets: t } = targets();
    const holder = createSettingsProposalHolder(t);
    const proposal = await holder.propose({ private_answer_mode: 'local-first', models: { venice: 'strongest' } }, 'Claude Code');
    expect(proposal.from).toBe('Claude Code');
    expect(proposal.rows).toEqual([
      { key: 'private_answer_mode', label: 'Private-answer mode', current: 'Private answers only in Olympus', proposed: 'Local models with Venice fallback' },
      { key: 'models.venice', label: 'Venice model', current: 'Qwen 3 235B', proposed: 'Always the strongest' },
    ]);
    expect(calls).toEqual([]);
    expect(holder.current()?.id).toBe(proposal.id);
  });

  test('Apply runs models and the judge before the Private-answer mode, and only for the proposal shown', async () => {
    const { calls, targets: t } = targets();
    const holder = createSettingsProposalHolder(t);
    const first = await holder.propose({ models: { venice: 'strongest' } });
    const second = await holder.propose({ private_answer_mode: 'local-first', models: { venice: 'strongest' } });
    // The owner was looking at the first; the agent replaced it since.
    expect(await holder.apply(first.id)).toBeUndefined();
    expect(calls).toEqual([]);
    const result = await holder.apply(second.id);
    expect(result?.ok).toBe(true);
    expect(calls).toEqual(['model:venice:strongest', 'mode:local-first']);
    expect(holder.current()).toBeUndefined();
    expect(holder.lastApplied()?.rows.every((row) => row.applied)).toBe(true);
    // A second click applies nothing again.
    expect(await holder.apply(second.id)).toBeUndefined();
  });

  test('every write runs inside one deferred-reload batch', async () => {
    const order: string[] = [];
    const { targets: t } = targets({
      saveModel: async () => { order.push('model'); return { ok: true }; },
      saveAnswerMode: () => { order.push('mode'); return { ok: true }; },
      deferReloads: async (writes) => { order.push('hold'); try { return await writes(); } finally { order.push('release'); } },
    });
    const holder = createSettingsProposalHolder(t);
    const proposal = await holder.propose({ private_answer_mode: 'local-first', models: { venice: 'strongest' } });
    await holder.apply(proposal.id);
    expect(order).toEqual(['hold', 'model', 'mode', 'release']);
  });

  test('one failing write is reported and the rest still apply', async () => {
    const { calls, targets: t } = targets({ saveModel: async () => { throw new Error('That model is gone.'); } });
    const holder = createSettingsProposalHolder(t);
    const proposal = await holder.propose({ private_answer_mode: 'local-first', models: { venice: 'strongest' } });
    const result = await holder.apply(proposal.id);
    expect(result?.ok).toBe(false);
    expect(result?.rows.find((row) => row.key === 'models.venice')).toMatchObject({ applied: false, message: 'That model is gone.' });
    expect(calls).toEqual(['mode:local-first']);
  });

  test('Discard drops it without writing', async () => {
    const { calls, targets: t } = targets();
    const holder = createSettingsProposalHolder(t);
    const proposal = await holder.propose({ models: { venice: 'strongest' } });
    expect(holder.discard('another-id')).toBe(false);
    expect(holder.discard(proposal.id)).toBe(true);
    expect(holder.current()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('the privacy judge goes in a proposal of its own', async () => {
    const { targets: t } = targets();
    const holder = createSettingsProposalHolder(t);
    await expect(holder.propose({ privacy_judge: { choice: 'venice', spending_limit_dollars: 5 }, models: { venice: 'strongest' } })).rejects.toThrow('two proposals');
    await expect(holder.propose({ privacy_judge: { choice: 'local', spending_limit_dollars: 0 }, models: { local: 'builtin:4b' } })).rejects.toThrow('two proposals');
    await expect(holder.propose({ private_answer_mode: 'local-only', privacy_judge: { choice: 'venice', spending_limit_dollars: 5 } })).rejects.toThrow('two proposals');
    await expect(holder.propose({ private_answer_mode: 'local-only', privacy_judge: { choice: 'local', spending_limit_dollars: 0 } })).rejects.toThrow('two proposals');
    await expect(holder.propose({ models: { zkapi: 'strongest' }, privacy_judge: { choice: 'local', spending_limit_dollars: 0 } })).rejects.toThrow('two proposals');
  });

  test('values this computer does not offer are refused when proposed', async () => {
    const { targets: t } = targets({ judge: () => ({ choice: 'local', capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudModel: null, cloudAvailable: false }) });
    const holder = createSettingsProposalHolder(t);
    await expect(holder.propose({ models: { venice: 'not-a-model' } })).rejects.toThrow('models.venice must be one of: strongest, qwen3-235b.');
    await expect(holder.propose({ models: { zkapi: 'strongest' } })).rejects.toThrow('There is no zkAPI model picker');
    await expect(holder.propose({ privacy_judge: { choice: 'venice', spending_limit_dollars: 5 } })).rejects.toThrow('Venice judging needs a Venice key');
    await expect(holder.propose({ computer_use: 'server' })).rejects.toThrow('standalone Olympus app on a Mac');
    expect(holder.current()).toBeUndefined();
  });

  test('a computer still choosing how it runs needs that choice first, applied before the mode', async () => {
    const calls: string[] = [];
    const { targets: t } = targets({
      computerSetup: () => ({ computer_use_pending: true, engine_server_mode: { enabled: false, pending: false } }),
      saveComputerUse: (choice) => { calls.push(`computer:${choice}`); return { ok: true }; },
      saveAnswerMode: (choice) => { calls.push(`mode:${choice}`); return { ok: true }; },
    });
    const holder = createSettingsProposalHolder(t);
    await expect(holder.propose({ private_answer_mode: 'local-first' })).rejects.toThrow('add computer_use');
    const proposal = await holder.propose({ private_answer_mode: 'local-first', computer_use: 'server' });
    await holder.apply(proposal.id);
    expect(calls).toEqual(['computer:server', 'mode:local-first']);
  });
});

describe('the Settings page card', () => {
  test('shows each change with Apply all and Discard for the proposal it shows', async () => {
    const { targets: t } = targets();
    const holder = createSettingsProposalHolder(t);
    const proposal = await holder.propose({ models: { venice: 'strongest' } }, 'Claude <script>');
    const html = renderDashboardSettingsPage({ settingsProposal: { current: holder.current(), lastApplied: undefined } });
    expect(html).toContain('Proposed settings');
    expect(html).toContain('Claude &lt;script&gt; proposed this change');
    expect(html).toContain('data-settings-proposal="apply"');
    expect(html).toContain('data-settings-proposal="discard"');
    expect(html).toContain(`value="${proposal.id}"`);
    expect(html).toContain('Always the strongest');
    expect(html).not.toContain('Before you apply');
  });

  test('a proposal that turns on Venice judging says Venice reads Private items before Apply', async () => {
    const { targets: t } = targets();
    const holder = createSettingsProposalHolder(t);
    await holder.propose({ privacy_judge: { choice: 'venice', spending_limit_dollars: 5 } });
    const html = renderDashboardSettingsPage({ settingsProposal: { current: holder.current(), lastApplied: undefined } });
    const note = html.indexOf('Venice will read each item it sorts, including items it marks Private');
    expect(note).toBeGreaterThan(-1);
    expect(html).toContain('up to the $5 limit');
    expect(note).toBeLessThan(html.indexOf('data-settings-proposal="apply"'));
  });

  test('says what was applied after Apply, and shows nothing when there is nothing', async () => {
    expect(renderDashboardSettingsPage({})).not.toContain('proposed-settings');
    const { targets: t } = targets({ saveModel: async () => ({ ok: false, message: 'That model is gone.' }) });
    const holder = createSettingsProposalHolder(t);
    const proposal = await holder.propose({ models: { venice: 'strongest' } });
    await holder.apply(proposal.id);
    const html = renderDashboardSettingsPage({ settingsProposal: { current: undefined, lastApplied: holder.lastApplied() } });
    expect(html).toContain('Some settings were not applied');
    expect(html).toContain('Not applied: That model is gone.');
  });
});

describe('through the worker', () => {
  test('the CLI route proposes; only a local dashboard session applies, and only the proposal it names', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createEmailSourceWorker } = await import('../src/workers/email-source/index.ts');
    const { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER } = await import('../src/workers/http.ts');
    const { createSovereigntyEngine, loadSovereigntyPreset } = await import('../src/core/sovereignty.ts');
    const { lifecycleDataRoot } = await import('../src/data-lifecycle.ts');
    const home = mkdtempSync(join(tmpdir(), 'olympus-proposal-'));
    const writes: string[] = [];
    const worker = createEmailSourceWorker({ sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')),
      registryPath: join(home, 'handles.json'),
      savePrivateAnswerMode: (choice) => { writes.push(`mode:${choice}`); return { ok: true }; },
    } });
    const post = (path: string, body: unknown, grade?: 'local' | 'bearer') => worker.fetch(new Request('http://worker.test' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(grade ? { [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: 'test', [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: grade } : {}) },
      body: JSON.stringify(body),
    }));
    try {
      const proposed = await post('/v1/cli/settings-propose', { proposal: { private_answer_mode: 'local-first' }, from: 'Claude Code', data_root: lifecycleDataRoot({ env: process.env }) });
      expect(proposed.status).toBe(200);
      const { id, changes } = await proposed.json() as { id: string; changes: unknown[] };
      expect(changes).toHaveLength(1);
      const refused = await post('/v1/cli/settings-propose', { proposal: { remote_access: true }, data_root: lifecycleDataRoot({ env: process.env }) });
      expect(refused.status).toBe(400);
      expect(writes).toEqual([]);
      for (const grade of [undefined, 'bearer'] as const) {
        expect((await post('/dashboard/settings/proposal/apply', { id }, grade)).status).toBe(403);
      }
      expect((await post('/dashboard/settings/proposal/apply', { id: 'stale' }, 'local')).status).toBe(409);
      expect(writes).toEqual([]);
      const applied = await post('/dashboard/settings/proposal/apply', { id }, 'local');
      expect(applied.status).toBe(200);
      expect(writes).toEqual(['mode:local-first']);
    } finally {
      worker.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
