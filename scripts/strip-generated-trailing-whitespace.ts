import { readFileSync, writeFileSync } from 'node:fs';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  throw new Error('Usage: bun scripts/strip-generated-trailing-whitespace.ts <file>...');
}

for (const path of paths) {
  const text = readFileSync(path, 'utf8');
  const cleaned = text
    .replace(/^\/\/ .*?node_modules\//gm, '// node_modules/')
    .replace(/[ \t]+$/gm, '');
  if (cleaned !== text) writeFileSync(path, cleaned);
}
