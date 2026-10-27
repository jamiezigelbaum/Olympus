// Every connector builds a child item's id through the one builder
// (src/core/child-item-id.ts): `<parent providerItemId>#child:<key>`. The shared
// readers find a child's parent from that id alone (parentIdentityOf), which is
// how a Secret attachment stays hidden once its parent's row is gone, so an id
// built any other way silently escapes that rule.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CHILD_ITEM_ID_SEPARATOR, childProviderItemId } from '../src/core/child-item-id.ts';
import { parentIdentityOf } from '../src/workers/connector-store/child-visibility.ts';

const ROOT = join(import.meta.dir, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('child item ids', () => {
  test('the builder writes the form the shared readers parse back to the parent', () => {
    const id = childProviderItemId('note-7', 'resource-0');
    expect(id).toBe(`note-7${CHILD_ITEM_ID_SEPARATOR}resource-0`);
    expect(parentIdentityOf({ provider: 'evernote', accountScope: 'a', providerItemId: id })?.providerItemId).toBe('note-7');
    expect(() => childProviderItemId('note-7', `x${CHILD_ITEM_ID_SEPARATOR}y`)).toThrow();
    expect(() => childProviderItemId('', 'resource-0')).toThrow();
  });

  test('every file that builds a child identity takes its id from the builder, and none writes the separator itself', () => {
    const offenders: string[] = [];
    for (const path of sources(join(ROOT, 'src'))) {
      const rel = relative(ROOT, path);
      if (rel === 'src/core/child-item-id.ts') continue;
      const text = readFileSync(path, 'utf8');
      // A child's identity names its parent's providerItemId.
      const buildsChild = /parent:\s*\{\s*providerItemId/.test(text);
      if (buildsChild && !/\bchildProviderItemId\(/.test(text)) offenders.push(`${rel}: builds a child without childProviderItemId`);
      if (text.includes("'#child:'") || text.includes('`#child:') || text.includes('"#child:"')) offenders.push(`${rel}: writes the child separator itself`);
    }
    expect(offenders).toEqual([]);
  });
});
