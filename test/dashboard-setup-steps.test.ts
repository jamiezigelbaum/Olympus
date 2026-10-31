import { expect, test } from 'bun:test';
import { setupStepsSheet } from '../src/workers/dashboard/components.ts';

test('setup sheet renders one provider-neutral step at a time with a fallback link', () => {
  const html = setupStepsSheet({ id: 'sample', provider: 'Example', steps: [
    { text: 'Create an app', link: { label: 'Example', url: 'https://example.com/apps' } },
    { text: 'Paste the key' },
  ], finalForm: '<form>KEY</form>' });
  expect(html).toContain('Step 1 of 2');
  expect(html).toContain('Open this page in Example');
  expect(html).toContain('https://example.com/apps');
  expect(html).toContain("I've done this, next");
  expect(html).toContain('data-setup-next');
  expect(html).toContain('data-setup-open');
});
