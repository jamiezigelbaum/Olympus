import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync, linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScopeRoot, ScopeSafeError, resetScopeSafeNativeForTests, scopeSafeFsAvailable,
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
