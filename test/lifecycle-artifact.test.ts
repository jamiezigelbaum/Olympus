import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { prepareWorkerUpgradeArtifact } from '../src/core/lifecycle-artifact.ts';

describe('worker upgrade artifact custody', () => {
  test('refuses a symlinked managed versions parent before reuse or extraction', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-artifact-parent-'));
    const outside = mkdtempSync(join(tmpdir(), 'olympus-artifact-outside-'));
    try {
      const artifact = packArtifact(home, '0.4.0');
      const versionsDir = join(home, '.local', 'share', 'olympus', 'versions');
      mkdirSync(dirname(versionsDir), { recursive: true });
      symlinkSync(outside, versionsDir);

      expect(() => prepareWorkerUpgradeArtifact({
        artifactPath: artifact.path,
        homeDir: home,
        bunBin: process.execPath,
        dryRun: false,
      })).toThrow('unsafe managed upgrade version parent path');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test('repairs a substituted existing digest directory from the requested archive bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-artifact-repair-'));
    try {
      const artifact = packArtifact(home, '0.4.1');
      const first = prepareWorkerUpgradeArtifact({
        artifactPath: artifact.path,
        homeDir: home,
        bunBin: process.execPath,
        dryRun: false,
      });
      const cliPath = join(first.workingDirectory, 'dist', 'cli.js');
      chmodSync(first.workingDirectory, 0o700);
      chmodSync(dirname(cliPath), 0o700);
      chmodSync(cliPath, 0o600);
      writeFileSync(cliPath, "console.log('olympus 0.4.1'); // substituted bytes\n", { mode: 0o600 });

      const repaired = prepareWorkerUpgradeArtifact({
        artifactPath: artifact.path,
        homeDir: home,
        bunBin: process.execPath,
        dryRun: false,
      });

      expect(repaired).toEqual(first);
      expect(readFileSync(cliPath, 'utf8')).toBe("console.log('olympus 0.4.1');\n");
      expect((lstatSync(cliPath).mode & 0o777)).toBe(0o444);
      expect(readdirSync(dirname(first.workingDirectory)).filter((name) => name.startsWith('.olympus-replaced-'))).toEqual([]);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('rejects a small compressed artifact whose declared expansion exceeds the bound', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-artifact-expansion-'));
    try {
      const artifact = packArtifact(home, '0.4.2', {
        mutatePackage: (packageRoot) => {
          const sparse = join(packageRoot, 'expanded.bin');
          writeFileSync(sparse, '');
          truncateSync(sparse, 65 * 1024 * 1024);
        },
      });
      expect(() => prepareWorkerUpgradeArtifact({
        artifactPath: artifact.path,
        homeDir: home,
        bunBin: process.execPath,
        dryRun: true,
      })).toThrow('unbounded regular file');
      expect(existsSync(join(home, '.local', 'share', 'olympus', 'versions'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('dry-run executes the same declared-version CLI preflight as a real upgrade', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-artifact-dry-run-'));
    try {
      const artifact = packArtifact(home, '0.4.3', {
        cli: "process.exit(17);\n",
      });
      expect(() => prepareWorkerUpgradeArtifact({
        artifactPath: artifact.path,
        homeDir: home,
        bunBin: process.execPath,
        dryRun: true,
      })).toThrow('CLI preflight did not report');
      expect(existsSync(join(home, '.local', 'share', 'olympus', 'versions'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('refuses to publish an extracted tree mutated by its executable preflight', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-artifact-preflight-mutation-'));
    try {
      const artifact = packArtifact(home, '0.4.4', {
        cli: [
          "import { writeFileSync } from 'node:fs';",
          "import { fileURLToPath } from 'node:url';",
          "writeFileSync(fileURLToPath(new URL('../post-preflight.js', import.meta.url)), 'injected\\n');",
          "console.log('olympus 0.4.4');",
          '',
        ].join('\n'),
      });

      expect(() => prepareWorkerUpgradeArtifact({
        artifactPath: artifact.path,
        homeDir: home,
        bunBin: process.execPath,
        dryRun: false,
      })).toThrow('CLI preflight mutated its extracted byte tree');
      expect(existsSync(join(home, '.local', 'share', 'olympus', 'versions', artifact.sha256))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

function packArtifact(
  home: string,
  version: string,
  options: {
    cli?: string;
    mutatePackage?: (packageRoot: string) => void;
  } = {},
): { path: string; sha256: string } {
  const fixture = mkdtempSync(join(tmpdir(), 'olympus-artifact-package-'));
  const packageRoot = join(fixture, 'package');
  const artifactPath = join(home, `olympus-${version}.tgz`);
  try {
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'olympus', version, type: 'module' })}\n`);
    writeFileSync(join(packageRoot, 'openclaw.plugin.json'), `${JSON.stringify({ id: 'olympus', version })}\n`);
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), options.cli ?? `console.log('olympus ${version}');\n`);
    options.mutatePackage?.(packageRoot);
    const packed = Bun.spawnSync(['tar', '-czf', artifactPath, '-C', fixture, 'package']);
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    return {
      path: artifactPath,
      sha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
}
