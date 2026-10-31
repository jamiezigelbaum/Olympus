import { expect, test } from 'bun:test';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';

test('new install presents the Private-answer choices with local-first recommended', () => {
  const html = renderModelSetup({ ready: false, checked_at: '', cards: [], privacy_choice_pending: true });
  expect(html).toContain('How should Olympus answer with Private items?');
  expect(html).toContain('value="local-first" checked');
  expect(html).toContain('Recommended');
  for (const choice of ['local-first', 'local-only', 'private-cloud-only', 'no-sensitive']) expect(html).toContain(`value="${choice}"`);
});


test('local model setup never offers an embedding model', () => {
  const html = renderModelSetup({ ready: true, checked_at: '', cards: [] });
  expect(html).not.toContain('name="embedding_model"');
});
