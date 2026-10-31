import { expect, test } from 'bun:test';
import { renderModelSetup, LOCAL_MODELS_SETUP_PROMPT } from '../src/workers/dashboard/model-setup.ts';

test('local-model sheet offers explicit discovery and synthetic checks while preserving the agent prompt', () => {
  const html = renderModelSetup({ ready: true, checked_at: '', cards: [] });
  expect(html).toContain('data-local-models-discover');
  expect(html).toContain('Detect local models');
  expect(html).toContain('name="base_url"');
  expect(html).toContain('name="answer_model"');
  expect(html).not.toContain('name="embedding_model"');
  expect(html).toContain('Test answer model');
  expect(html).toContain('Testing does not change your configured models');
  expect(html).toContain(LOCAL_MODELS_SETUP_PROMPT);
});
