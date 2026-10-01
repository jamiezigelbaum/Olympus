// The sovereignty presets exactly as `olympus setup` wrote them before the
// built-in embedding model became the new-install default (2026-10-01). An
// install set up before then still holds this policy, and keeps embedding
// with Gemini, the local server, or Venice: tests of those lanes load it here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSovereigntyConfig,
  type SovereigntyConfig,
  type SovereigntyPresetName,
} from '../../src/core/sovereignty.ts';

export function loadPreBuiltInPreset(name: SovereigntyPresetName): SovereigntyConfig {
  const path = join(import.meta.dir, '..', 'fixtures', 'sovereignty-presets-before-built-in', `${name}.json`);
  return validateSovereigntyConfig(JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig);
}
