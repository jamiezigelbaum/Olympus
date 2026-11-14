// First run recommends by measured memory (plan thread, 14 Nov 2026): below
// 12 GB the local private model (about 3.5 GB on top of Olympus, test-mac
// split.memory) does not fit, so Venice is recommended and says why. Local
// stays a choice; nothing is chosen for the owner.
import { expect, test } from 'bun:test';
import { PRIVATE_ANSWER_OPTIONS, privateAnswerOptions } from '../src/core/privacy-language.ts';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';
import type { ModelSetupView } from '../src/core/model-setup.ts';

const GB = 1024 ** 3;

test('at 12 GB and above the approved default stands: local models with Venice fallback', () => {
  for (const memory of [12 * GB, 16 * GB, 64 * GB]) {
    const options = privateAnswerOptions(memory);
    expect(options.filter((option) => option.recommended).map((option) => option.id)).toEqual(['local-first']);
    expect(options.some((option) => option.reason)).toBe(false);
  }
});

test('below 12 GB Venice is recommended with the reason, and every local choice is still offered', () => {
  const options = privateAnswerOptions(8 * GB);
  expect(options.map((option) => option.id)).toEqual(PRIVATE_ANSWER_OPTIONS.map((option) => option.id));
  expect(options.filter((option) => option.recommended).map((option) => option.id)).toEqual(['private-cloud-only']);
  expect(options.find((option) => option.id === 'private-cloud-only')!.reason)
    .toBe('This computer has 8 GB of memory; the local private model needs about 3.5 GB on top of Olympus.');
  // The shared list itself is never changed.
  expect(PRIVATE_ANSWER_OPTIONS.find((option) => option.id === 'local-first')!.recommended).toBe(true);
});

test('an unknown memory size keeps the approved default', () => {
  expect(privateAnswerOptions(0).find((option) => option.recommended)!.id).toBe('local-first');
  expect(privateAnswerOptions(Number.NaN).find((option) => option.recommended)!.id).toBe('local-first');
});

test('the dashboard\'s first-run choice starts on the recommendation and shows why', () => {
  const view = { privacy_choice_pending: true, cards: [] } as unknown as ModelSetupView;
  const small = renderModelSetup(view, { totalMemoryBytes: 8 * GB });
  expect(small).toContain('value="private-cloud-only" checked');
  expect(small).toContain('Venice — Recommended');
  expect(small).toContain('data-memory-reason>This computer has 8 GB of memory');
  expect(small).toContain('value="local-first">');
  const large = renderModelSetup(view, { totalMemoryBytes: 32 * GB });
  expect(large).toContain('value="local-first" checked');
  expect(large).not.toContain('data-memory-reason');
});
