import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repoRoot, 'openclaw.plugin.json'), 'utf8')) as { version: string };

export const VERSION = manifest.version;
