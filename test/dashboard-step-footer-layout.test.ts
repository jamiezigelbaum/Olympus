import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { setupStepsSheet } from '../src/workers/dashboard/components.ts';

test('every step footer keeps Back first and primary at the right edge, even on narrow screens', () => {
  const window = new Window();
  window.document.body.innerHTML = setupStepsSheet({ id: 'footer', provider: 'Example', steps: [{ text: 'First' }, { text: 'Last' }], finalForm: id => `<form id="${id}"></form>` });
  const footer = window.document.querySelector('.setupactions')!;
  expect(footer.firstElementChild?.textContent).toBe('Back');
  const css = readFileSync(new URL('../src/workers/dashboard/theme.ts', import.meta.url), 'utf8');
  expect(css).toContain('.setupactions > .primary { margin-left: auto; }');
  expect(css).not.toMatch(/\.setupactions > \.primary[^}]*order:/);
  expect(css).not.toMatch(/\.actionrow, \.setupactions, \.rowform/);
  expect(css).toContain('.actionrow:not(.setupactions) > .primary { order: -1; }');
  window.happyDOM.abort();
});
