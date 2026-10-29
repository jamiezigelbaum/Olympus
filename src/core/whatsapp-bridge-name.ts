// The WhatsApp bridge's file name, from a fingerprint of the source it is
// built from. Pairing builds into (or runs) a bridge of this name, and a
// prebuilt release bridge (.github/workflows/whatsapp-bridge-build.yml,
// scripts/publish-release-to-site.ts) carries it, so a package only ever runs
// a bridge built from its own source.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function whatsappBridgeFileName(sourceDir: string): string {
  const hash = createHash('sha256');
  for (const name of ['main.go', 'go.mod', 'go.sum']) {
    const path = join(sourceDir, name);
    if (!existsSync(path)) throw new Error(`The packaged WhatsApp bridge source is incomplete: missing ${name}.`);
    hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  // Every other source file the bridge is built from: a change to any of them is a new bridge.
  const others = readdirSync(sourceDir)
    .filter((name) => name.endsWith('.go') && !name.endsWith('_test.go') && name !== 'main.go')
    .sort();
  for (const name of others) hash.update(name).update('\0').update(readFileSync(join(sourceDir, name))).update('\0');
  return `olympus-whatsapp-bridge-${hash.digest('hex').slice(0, 16)}`;
}

if (import.meta.main) console.log(whatsappBridgeFileName(process.argv[2] ?? 'tools/whatsapp-bridge'));
