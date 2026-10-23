import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, fstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync, linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScopeRoot, ScopeSafeError, resetScopeSafeNativeForTests, scopeSafeFsAvailable, scopeSafeNativeForTests,
} from '../src/core/scope-safe-fs.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  resetScopeSafeNativeForTests(undefined);
  while (cleanups.length) cleanups.pop()!();
});

function tree(): { base: string; root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-safe-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'a.txt'), 'alpha');
  writeFileSync(join(root, 'sub', 'b.txt'), 'bravo');
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  return { base, root, outside };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof ScopeSafeError ? error.code : `other:${String(error)}`;
  }
  return 'none';
}

describe('scope-safe reader', () => {
  test('the libc binding loads on this platform', () => {
    expect(scopeSafeFsAvailable()).toBe(true);
  });

  test('lists and reads files below the root', () => {
    const { root } = tree();
    const scope = ScopeRoot.open(root);
    try {
      expect(scope.list('').map((e) => `${e.name}:${e.kind}`).sort()).toEqual(['a.txt:file', 'sub:directory']);
      expect(Buffer.from(scope.readFile('a.txt')).toString()).toBe('alpha');
      expect(Buffer.from(scope.readFile('sub/b.txt')).toString()).toBe('bravo');
    } finally {
      scope.close();
    }
  });

  test('a symlink file is listed as a link and never read through', () => {
    const { root, outside } = tree();
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const scope = ScopeRoot.open(root);
    try {
      expect(scope.list('').find((e) => e.name === 'link.txt')?.kind).toBe('symlink');
      expect(codeOf(() => scope.readFile('link.txt'))).toBe('escape');
    } finally {
      scope.close();
    }
  });

  test('a folder swapped for a symlink to outside is refused, also after the root was opened', () => {
    const { root, outside } = tree();
    const scope = ScopeRoot.open(root);
    try {
      expect(Buffer.from(scope.readFile('sub/b.txt')).toString()).toBe('bravo');
      // Ancestor swap between listing and reading.
      renameSync(join(root, 'sub'), join(root, 'sub-moved'));
      symlinkSync(outside, join(root, 'sub'));
      writeFileSync(join(outside, 'b.txt'), 'OUTSIDE');
      expect(codeOf(() => scope.readFile('sub/b.txt'))).toBe('escape');
      expect(codeOf(() => scope.list('sub'))).toBe('escape');
    } finally {
      scope.close();
    }
  });

  test('a dot-dot component is refused', () => {
    const { root } = tree();
    const scope = ScopeRoot.open(root);
    try {
      expect(codeOf(() => scope.readFile('../outside/secret.txt'))).toBe('escape');
      expect(codeOf(() => scope.readFile('/etc/hosts'))).toBe('escape');
    } finally {
      scope.close();
    }
  });

  test('a different file at the listed name is changed, not read', () => {
    const { root } = tree();
    const scope = ScopeRoot.open(root);
    try {
      const listed = scope.statRelative('a.txt');
      // Replace by rename: a new inode at the same name.
      writeFileSync(join(root, 'a.new'), 'replaced');
      renameSync(join(root, 'a.new'), join(root, 'a.txt'));
      expect(codeOf(() => scope.readFile('a.txt', { expected: listed }))).toBe('changed');
      const fresh = scope.statRelative('a.txt');
      expect(Buffer.from(scope.readFile('a.txt', { expected: fresh })).toString()).toBe('replaced');
    } finally {
      scope.close();
    }
  });

  test('a hard link to an outside file is a normal file of the root (same device)', () => {
    const { root, outside } = tree();
    linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'));
    const scope = ScopeRoot.open(root);
    try {
      // A hard link is indistinguishable from a file owned by the folder; the
      // reader stays within the approved folder's names, which is the contract.
      expect(Buffer.from(scope.readFile('hard.txt')).toString()).toBe('SECRET');
    } finally {
      scope.close();
    }
  });

  test('too-large files are refused before reading', () => {
    const { root } = tree();
    const scope = ScopeRoot.open(root);
    try {
      expect(codeOf(() => scope.readFile('a.txt', { maxBytes: 2 }))).toBe('too_large');
    } finally {
      scope.close();
    }
  });

  test('a root that is itself a link is refused', () => {
    const { base, root } = tree();
    symlinkSync(root, join(base, 'rootlink'));
    expect(codeOf(() => ScopeRoot.open(join(base, 'rootlink')))).toBe('changed');
  });

  test('fails closed when the native binding is unavailable', () => {
    const { root } = tree();
    resetScopeSafeNativeForTests(null);
    expect(codeOf(() => ScopeRoot.open(root))).toBe('unsupported');
  });

  test('crossing a mount point is refused (device change between components)', () => {
    // Real mount crossings cannot be created without privileges; /dev inside
    // a root on the system volume is the nearest real case on a developer
    // machine. The root /private/var on macOS and / on Linux contain mount
    // points; open "/" and try to walk into /dev, which is a different device.
    const scope = ScopeRoot.open('/');
    try {
      const devCode = codeOf(() => scope.statRelative('dev'));
      expect(devCode === 'escape' || devCode === 'none').toBe(true);
      // On every supported platform /dev is its own filesystem.
      expect(devCode).toBe('escape');
    } finally {
      scope.close();
    }
  });
});

describe('statEntry is relative to a verified directory, never by path', () => {
  // The branch every Linux stat takes (and macOS takes for a file whose open
  // is refused): the descriptor-relative lstat. `placeholders: false` sends
  // this platform down it directly.
  function withoutPlaceholders(extra: Record<string, unknown> = {}): void {
    resetScopeSafeNativeForTests({ ...scopeSafeNativeForTests()!, placeholders: false, ...extra } as never);
  }

  test('reports files, folders and links without following the link', () => {
    const { root, outside } = tree();
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    withoutPlaceholders();
    const scope = ScopeRoot.open(root);
    try {
      expect(scope.statEntry('a.txt')).toMatchObject({ kind: 'file', size: 5, dataless: false });
      expect(scope.statEntry('sub/b.txt')).toMatchObject({ kind: 'file', size: 5 });
      expect(scope.statEntry('sub').kind).toBe('directory');
      expect(scope.statEntry('link.txt').kind).toBe('symlink');
      expect(scope.statEntry('a.txt').mtimeMs).toBeGreaterThan(1_500_000_000_000);
      expect(codeOf(() => scope.statEntry('missing.txt'))).toBe('not_found');
    } finally {
      scope.close();
    }
  });

  test('a file whose open is refused still has metadata (macOS fallback)', () => {
    if (process.getuid?.() === 0) return;
    const { root } = tree();
    chmodSync(join(root, 'a.txt'), 0o000);
    const scope = ScopeRoot.open(root);
    try {
      expect(scope.statEntry('a.txt')).toMatchObject({ kind: 'file', size: 5 });
    } finally {
      chmodSync(join(root, 'a.txt'), 0o644);
      scope.close();
    }
  });

  test('an ancestor swapped for a link after the listing does not leak outside metadata', () => {
    const { root, outside } = tree();
    writeFileSync(join(outside, 'b.txt'), 'OUTSIDE-LONGER-CONTENT');
    for (const placeholders of [false, true]) {
      resetScopeSafeNativeForTests({ ...scopeSafeNativeForTests()!, placeholders } as never);
      const scope = ScopeRoot.open(root);
      try {
        expect(scope.statEntry('sub/b.txt').size).toBe(5);
        renameSync(join(root, 'sub'), join(root, 'sub-moved'));
        symlinkSync(outside, join(root, 'sub'));
        expect(codeOf(() => scope.statEntry('sub/b.txt'))).toBe('escape');
      } finally {
        scope.close();
        rmSync(join(root, 'sub'));
        renameSync(join(root, 'sub-moved'), join(root, 'sub'));
      }
    }
  });

  test('the entry is stat\'ed against a descriptor on its verified parent directory', () => {
    const { root } = tree();
    const real = scopeSafeNativeForTests()!;
    const seen: Array<{ name: string; parentIno: string }> = [];
    withoutPlaceholders({
      lstatChild: (dirfd: number, name: string) => {
        seen.push({ name, parentIno: String(fstatSync(dirfd, { bigint: true }).ino) });
        return real.lstatChild!(dirfd, name);
      },
    });
    const scope = ScopeRoot.open(root);
    try {
      scope.statEntry('sub/b.txt');
      expect(seen).toEqual([{ name: 'b.txt', parentIno: scope.statRelative('sub').ino }]);
    } finally {
      scope.close();
    }
  });

  test('fails closed when the platform has no descriptor-relative stat', () => {
    const { root } = tree();
    withoutPlaceholders({ lstatChild: undefined });
    const scope = ScopeRoot.open(root);
    try {
      expect(codeOf(() => scope.statEntry('a.txt'))).toBe('unsupported');
    } finally {
      scope.close();
    }
  });
});

describe('a refused folder says which refusal it was', () => {
  test('a mode refusal is EACCES', () => {
    if (process.getuid?.() === 0) return;
    const { root } = tree();
    const scope = ScopeRoot.open(root);
    chmodSync(join(root, 'sub'), 0o000);
    try {
      let caught: unknown;
      try { scope.list('sub'); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ScopeSafeError);
      expect((caught as ScopeSafeError).code).toBe('permission');
      expect((caught as ScopeSafeError).errno).toBe('EACCES');
    } finally {
      chmodSync(join(root, 'sub'), 0o755);
      scope.close();
    }
  });
});
