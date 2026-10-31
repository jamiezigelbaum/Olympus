import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** All inputs that determine the helper's compiled, signed bundle. */
export function macosHelperFileName(root: string): string {
  const hash = createHash('sha256');
  for (const path of ['native/macos-engine-host/main.c', 'native/macos-engine-host/Info.plist.in', 'scripts/build-macos-helper.sh']) {
    hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  }
  return `olympus-engine-helper-${hash.digest('hex').slice(0, 16)}.zip`;
}
if (import.meta.main) console.log(macosHelperFileName(process.argv[2] ?? '.'));
