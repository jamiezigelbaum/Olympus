import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Works from both source modules and the flattened published dist entry. */
export function olympusPackageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === 'olympus' || manifest.name === 'olympus-source-checkout') return directory;
    } catch { /* Continue toward the package, never use process.cwd(). */ }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('The Olympus package root could not be resolved.');
}
