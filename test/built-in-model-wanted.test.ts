// Below 12 GB first run recommends Venice and leaves the local private model
// off (plan ruling, 14 Nov). The 8 GB release leg on private-cloud-only still
// ran the built-in Qwen3.5 4B; nothing in that choice uses it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { builtInModelWanted } from '../src/workers/engine/runtime/judging-models.ts';

const preset = (name: string) => createSovereigntyEngine(JSON.parse(readFileSync(join(import.meta.dir, '..', 'config/sovereignty/presets', `${name}.json`), 'utf8')));

test('Venice for Private answers and privacy checks never starts the built-in model', () => {
  expect(builtInModelWanted(preset('private-cloud-only'), {})).toBe(false);
});

test('a local answer model, or no private lane for the privacy check, keeps it', () => {
  expect(builtInModelWanted(preset('local-first'), {})).toBe(true);
  expect(builtInModelWanted(preset('local-only'), {})).toBe(true);
  expect(builtInModelWanted(preset('no-sensitive'), {})).toBe(true);
});

test('an operator who turns it on keeps it', () => {
  expect(builtInModelWanted(preset('private-cloud-only'), { OLYMPUS_BUILT_IN_ANALYST: 'on' })).toBe(true);
});
