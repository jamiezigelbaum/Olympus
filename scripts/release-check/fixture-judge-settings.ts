import { updateSovereigntyConfigFile, loadSovereigntyPreset, type SovereigntyConfig } from '../../src/core/sovereignty.ts';
import { FIXTURE_JUDGE_MODEL, FIXTURE_JUDGE_PORT } from './fixture-judge.ts';

/** The documented owner policy-file route (docs/SOVEREIGNTY_CONFIG.md, privacy sniffer).
 * A separate classification profile leaves the real answer model intact. */
export function saveFixtureJudge(path: string, expected: SovereigntyConfig): void {
  const result = updateSovereigntyConfigFile({ path, expect: expected, patch: current => {
    const next = structuredClone(current);
    // prepare's historical no-sensitive choice has no private pool. Give the judge
    // a local eligible pool while keeping its retrieval/migration setting intact.
    if (next.routes.secure_local?.mode === 'disabled') {
      const preset = loadSovereigntyPreset('local-only');
      next.modelProfiles['local-source-answer'] ??= preset.modelProfiles['local-source-answer']!;
      next.routes.secure_local = structuredClone(preset.routes.secure_local!);
    }
    for (const profile of Object.values(next.modelProfiles)) {
      if (profile.purpose === 'classification') delete profile.purpose;
    }
    next.modelProfiles['release-check-judge'] = { provider: 'local-openai-compatible', trust: 'local',
      purpose: 'classification', baseUrl: `http://127.0.0.1:${FIXTURE_JUDGE_PORT}/v1`,
      model: FIXTURE_JUDGE_MODEL, snifferMode: 'full' };
    return next;
  } });
  if (!result.ok) throw new Error('Owner policy changed while configuring the fixture judge');
}
