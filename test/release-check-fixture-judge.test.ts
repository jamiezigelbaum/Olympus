import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureJudgeVerdicts, fixtureText, FIXTURE_JUDGE_MODEL, startFixtureJudge } from '../scripts/release-check/fixture-judge.ts';
import { saveFixtureJudge } from '../scripts/release-check/fixture-judge-settings.ts';
import { liveChecks, publishFailedCheck } from '../scripts/release-check/live-checks.ts';
import { buildSnifferBatchPrompt, parseSnifferBatchResponse, snifferTierKey, SNIFFER_SYSTEM_PROMPT } from '../src/workers/classification/sniffer.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, writeSovereigntyConfigFile } from '../src/core/sovereignty.ts';
import { resolveTierSnifferRuntime } from '../src/workers/classification/built-in-sniffer.ts';
import { fixtureDocuments } from '../scripts/release-check/fixture.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import { createDelphiAnalystModel } from '../src/core/analyst-delphi.ts';
import type { CheckResult } from '../scripts/release-check/report.ts';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
const judge = (material: string) => {
  const messages = [{ role: 'user', content: buildSnifferBatchPrompt('content', [{ i: 1, material }]) }];
  return parseSnifferBatchResponse(fixtureJudgeVerdicts(messages), new Set([1])).get(1)!;
};

test('the real parser accepts fixture verdicts; unknown and conflicting items stay Private', () => {
  expect(judge(fixtureText('a ferry plan')).tier).toBe('personal');
  expect(judge(fixtureText('a medical record', 'private')).tier).toBe('private');
  expect(judge(fixtureText('a password', 'secrets')).tier).toBe('private');
  // Public is at most Personal from the judge; the owner rule alone can publish it.
  expect(judge(fixtureText('a published page', 'public')).tier).toBe('personal');
  for (const text of ['unmarked item', fixtureText(fixtureText('conflict'), 'private')]) {
    const verdict = judge(text);
    expect(verdict.confidence).toBe(0);
    expect(snifferTierKey(verdict)).toBe('secure');
  }
  expect(judge(`unmarked child\nParent names (context only): ${fixtureText('parent')}`).tier).toBe('private');
  expect(fixtureJudgeVerdicts([{ role: 'system', content: fixtureText('anything') }])).toBe('{"verdicts":[]}');
  expect(fixtureText('')).toBe('');
  expect(fixtureText(fixtureText('once'))).toBe(fixtureText('once'));
  for (const doc of fixtureDocuments()) expect(doc.html_content).toContain('RC_ITEM_TIER_');
});

test('loopback chat server returns completions and content-free timing counters', async () => {
  const server = startFixtureJudge(0);
  cleanup.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const models = await (await fetch(`${base}/v1/models`)).json() as any;
  expect(models.data[0].id).toBe(FIXTURE_JUDGE_MODEL);
  const config = defaultConfig();
  config.argus.modelProfiles.source_answer = { ...config.argus.modelProfiles.source_answer,
    baseUrl: `${base}/v1`, model: FIXTURE_JUDGE_MODEL, purpose: 'text_reasoning' };
  const model = createDelphiAnalystModel(new DelphiClient(config), { profile: 'source_answer' });
  const completion = await model.complete({ system: SNIFFER_SYSTEM_PROMPT, localOnly: true,
    prompt: buildSnifferBatchPrompt('content', [{ i: 1, material: fixtureText('plan') }]) });
  expect(completion.modelId).toBe(FIXTURE_JUDGE_MODEL);
  expect(parseSnifferBatchResponse(completion.text, new Set([1])).get(1)?.tier).toBe('personal');
  const stats = await (await fetch(`${base}/stats`)).json() as any;
  expect(stats.calls).toBe(1);
  expect(stats.ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(stats)).not.toContain('plan');
});

test('owner settings select a dedicated full-mode judge and preserve retrieval and real answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-judge-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const preset of ['local-only', 'no-sensitive'] as const) {
    const config = loadSovereigntyPreset(preset);
    const path = join(dir, `${preset}.json`);
    writeSovereigntyConfigFile({ path, config });
    saveFixtureJudge(path, config);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.retrieval).toEqual(config.retrieval);
    if (config.modelProfiles['local-source-answer']) expect(saved.modelProfiles['local-source-answer']).toEqual(config.modelProfiles['local-source-answer']);
    const runtime = resolveTierSnifferRuntime({ engine: createSovereigntyEngine(saved), standaloneEngine: true });
    expect(runtime.source).toBe('configured');
    if (runtime.source === 'off') throw new Error('judge refused');
    expect(runtime.lane.modelId).toBe(FIXTURE_JUDGE_MODEL);
    expect(runtime.lane.profile.snifferMode).toBe('full');
  }
});

test('a gating check reaches the summary as soon as inserted, before later work completes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-check-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary');
  const checks = liveChecks(check => publishFailedCheck(check, summary));
  checks.push({ id: 'first.gate', title: 'gate', status: 'fail', detail: '<failure>' });
  expect(readFileSync(summary, 'utf8')).toContain('first.gate');
  expect(readFileSync(summary, 'utf8')).toContain('&lt;failure&gt;');
  checks.push({ id: 'independent', title: 'continues', status: 'pass' });
  expect(checks).toHaveLength(2);
  expect(JSON.parse(JSON.stringify(checks)) as CheckResult[]).toHaveLength(2);
});

import { answerModelTiming } from '../scripts/release-check/model-timing.ts';
test('answer timing counts product traces once, including rotated dual-write records', () => {
  const v1 = { kind: 'source_answer_latency', logged_at: 'one', phase_timings: { analyst_ms: 100 }, analyst_backend: 'local' };
  const trace = { kind: 'source_answer_latency_trace', correlation_id: 'request', compat_v1_logged_at: 'one',
    phase_ms: { analyst_ms: 120 }, analyst_legs: [{ backend: 'local', elapsed_ms: 110 }] };
  expect(answerModelTiming([v1, trace, trace].map(record => JSON.stringify(record)))).toEqual({ recordedCalls: 1, analystMs: 120, localMs: 110 });
  expect(answerModelTiming(['broken', JSON.stringify(v1)])).toEqual({ recordedCalls: 1, analystMs: 100, localMs: 100 });
});
