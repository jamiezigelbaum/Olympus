import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const theme = readFileSync(new URL('../src/workers/dashboard/theme.ts', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/workers/dashboard/chatgpt/page.ts', import.meta.url), 'utf8');
test('non-wizard action rows stack below 480px while wizard footers keep Back first', () => {
  expect(theme).toContain('.rowform { display: flex; gap: 12px; align-items: center; flex-wrap: nowrap; }');
  expect(theme).toContain('.actionrow, .setupactions { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: 12px; }');
  expect(theme).toContain('.actionrow:not(.setupactions) > .primary { order: -1; }');
  expect(theme).toContain('@media (max-width: 480px) {');
  expect(theme).toContain('.actionrow:not(.setupactions), .rowform { flex-direction: column; align-items: stretch; }');
  expect(theme).toContain('.setupactions > .primary { margin-left: auto; }');
  expect(panel).toContain('.actions{display:flex;flex-direction:row;flex-wrap:nowrap;gap:12px;align-items:center;justify-content:flex-start}');
  expect(panel).toContain('@media(max-width:480px){.actions,.source-actions{flex-direction:column;align-items:stretch}}');
});
