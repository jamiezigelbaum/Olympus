import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePrivateDirectoryTreeSync,
  isUnsupportedDirectorySyncError,
  removeFileDurablySync,
} from '../src/core/atomic-file.ts';

describe('atomic private-file durability', () => {
  test('directory fsync suppresses only documented unsupported shapes and surfaces EIO', () => {
    for (const code of ['EINVAL', 'EBADF', 'ENOTSUP']) {
      expect(isUnsupportedDirectorySyncError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isUnsupportedDirectorySyncError(Object.assign(new Error('I/O failure'), { code: 'EIO' }))).toBe(false);
    expect(isUnsupportedDirectorySyncError(Object.assign(new Error('permission failure'), { code: 'EACCES' }))).toBe(false);
    expect(isUnsupportedDirectorySyncError(new Error('untyped failure'))).toBe(false);
  });

  test('durable removal is idempotent and removes only the named file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-durable-remove-'));
    const target = join(dir, 'target');
    const sibling = join(dir, 'sibling');
    try {
      writeFileSync(target, 'remove me');
      writeFileSync(sibling, 'preserve me');
      expect(removeFileDurablySync(target)).toBe(true);
      expect(removeFileDurablySync(target)).toBe(false);
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(sibling, 'utf8')).toBe('preserve me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('durably creates each private ancestor and refuses a parent symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-durable-tree-'));
    const outside = mkdtempSync(join(tmpdir(), 'olympus-durable-tree-outside-'));
    try {
      const target = join(root, 'one', 'two', 'three');
      ensurePrivateDirectoryTreeSync(root, target);
      for (const path of [join(root, 'one'), join(root, 'one', 'two'), target]) {
        expect(lstatSync(path).isDirectory()).toBe(true);
        expect(lstatSync(path).isSymbolicLink()).toBe(false);
      }
      const linked = join(root, 'linked');
      symlinkSync(outside, linked);
      expect(() => ensurePrivateDirectoryTreeSync(root, join(linked, 'escaped')))
        .toThrow('Refusing non-directory or symlink managed path component');
      expect(existsSync(join(outside, 'escaped'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
