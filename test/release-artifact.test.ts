import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  V0_4_PUBLIC_PACKAGE_BUILD_READY,
  V0_4_PUBLIC_PACKAGE_FILES,
  V0_4_PUBLIC_PACKAGE_NAME,
  V0_4_SOURCE_CHECKOUT_PACKAGE_NAME,
} from '../src/core/public-surface.ts';
import manifest from '../openclaw.plugin.json';

const ROOT = join(import.meta.dir, '..');
const GOOGLE_PILOT_CLIENT_ID_FIXTURE = '123456789012-olympusreleasefixture.apps.googleusercontent.com';

describe('release artifact packaging', () => {
  test('standard npm pack cannot bypass the canonical release builder', async () => {
    await expect(run(['npm', 'pack', '--dry-run'])).rejects.toThrow(
      'Standard npm pack is disabled for Olympus source checkouts',
    );

    const inventory = await run(['npm', 'pack', '--dry-run', '--ignore-scripts', '--json']);
    const reports = JSON.parse(inventory.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.filename).toBe(`${V0_4_SOURCE_CHECKOUT_PACKAGE_NAME}-${manifest.version}.tgz`);
    expect(reports[0]!.filename).not.toBe(`${V0_4_PUBLIC_PACKAGE_NAME}-${manifest.version}.tgz`);
    const bypassedPaths = reports[0]!.files.map((file) => file.path).sort();
    expect(bypassedPaths).not.toContain('dist/index.js');
    expect(bypassedPaths).not.toContain('dist/cli.js');
    expect(bypassedPaths.every((path) => ['LICENSE', 'README.md', 'bin/olympus', 'package.json'].includes(path))).toBe(true);
  }, 30_000);

  test('bin wrapper reports an actionable error when Bun is absent', async () => {
    const shell = Bun.which('sh') ?? Bun.which('bash');
    if (!shell) return;
    const tempRoot = mkdtempSync(join(tmpdir(), 'olympus-bin-no-bun-test-'));
    try {
      const binDir = join(tempRoot, 'bin');
      const distDir = join(tempRoot, 'dist');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      const wrapper = readFileSync(join(ROOT, 'bin', 'olympus'), 'utf8');
      writeFileSync(join(binDir, 'olympus'), wrapper, { mode: 0o755 });
      writeFileSync(join(distDir, 'cli.js'), 'console.log("should not run");\n');

      const proc = Bun.spawn([shell, join(binDir, 'olympus'), '--help'], {
        cwd: tempRoot,
        env: { PATH: tempRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(127);
      expect(stdout).toBe('');
      expect(stderr).toContain('olympus requires Bun 1.2+');
      expect(stderr).toContain('https://bun.sh/docs/installation');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test('packages the bundled CLI and public config allowlist without local or owner-review config files', async () => {
    const localConfigPath = join(ROOT, 'config', 'olympus.local.json');
    const artifactPath = join(ROOT, 'release-artifacts', `${V0_4_PUBLIC_PACKAGE_NAME}-${manifest.version}.tgz`);
    const extractDir = mkdtempSync(join(tmpdir(), 'olympus-release-artifact-'));
    let createdLocalConfig = false;
    try {
      if (!V0_4_PUBLIC_PACKAGE_BUILD_READY) {
        await expect(run(['bun', 'scripts/release-artifact.ts'])).rejects.toThrow(
          'Public artifact creation is fail-closed until Slice 3D',
        );
        expect(existsSync(artifactPath)).toBe(false);
        return;
      }
      if (!existsSync(localConfigPath)) {
        writeFileSync(localConfigPath, '{"do_not_package":true}\n');
        createdLocalConfig = true;
      }

      const release = await run(['bun', 'scripts/release-artifact.ts']);
      expect(release.stdout).toContain(`Wrote ${artifactPath}`);
      expect(existsSync(artifactPath)).toBe(true);

      const listing = await run(['tar', '-tzf', artifactPath]);
      expect(listing.stdout).toContain('package/bin/olympus');
      expect(listing.stdout).toContain('package/INSTALL_FOR_AGENTS.md');
      expect(listing.stdout).toContain('package/dist/cli.js');
      expect(listing.stdout).toContain('package/docs/QUICKSTART.md');
      expect(listing.stdout).not.toContain('package/docs/ARCHITECTURE.md');
      expect(listing.stdout).toContain('package/docs/TRUST_MODEL.md');
      expect(listing.stdout).toContain('package/docs/SOVEREIGNTY_CONFIG.md');
      expect(listing.stdout).toContain('package/docs/CONTRACTS.md');
      expect(listing.stdout).not.toContain('package/docs/ops/OPENCLAW_CHANGE_PROTOCOL.md');
      expect(listing.stdout).toContain('package/docs/UNINSTALL.md');
      expect(listing.stdout).not.toContain('package/docs/DEVELOPMENT.md');
      expect(listing.stdout).toContain('package/config/sovereignty/presets/local-first.json');
      expect(listing.stdout).toContain('package/config/sovereignty/presets/local-only.json');
      expect(listing.stdout).toContain('package/config/sovereignty/presets/private-cloud-only.json');
      expect(listing.stdout).toContain('package/config/sovereignty/presets/no-sensitive.json');
      expect(listing.stdout).not.toContain(`package/config/sovereignty/presets/${'private'}-${'cloud'}.json`);
      expect(listing.stdout).not.toContain('olympus.local.json');
      expect(listing.stdout).not.toContain('source-classification-owner-review-labels.json');
      expect(listing.stdout).not.toContain('source-ocr-pdf-owner-review-labels.json');

      await run(['tar', '-xzf', artifactPath, '-C', extractDir]);
      const packageDir = join(extractDir, 'package');
      expect(allFiles(packageDir).map((path) => relative(packageDir, path)).sort())
        .toEqual([...V0_4_PUBLIC_PACKAGE_FILES].sort());
      const packagedReadme = readFileSync(join(packageDir, 'README.md'), 'utf8');
      expect(packagedReadme).not.toContain('docs/DEVELOPMENT.md');
      expect(packagedReadme).not.toContain('bun run verify');
      expect(packagedReadme).not.toContain('bun run test:focus');
      expect(packagedReadme).not.toContain('bun install &&');
      expect(packagedReadme).not.toContain('0.3.0-alpha.1');
      expect(packagedReadme).not.toContain('~/.openclaw/git/');
      const packagedRuntime = readFileSync(join(packageDir, 'dist', 'cli.js'), 'utf8');
      expect(packagedRuntime).toContain(GOOGLE_PILOT_CLIENT_ID_FIXTURE);
      expect(packagedRuntime).not.toContain('__OLYMPUS_GOOGLE_PILOT_CLIENT_ID__');
      expect(packagedReadme).not.toContain('olympus x reconcile recover');
      expect(packagedReadme).not.toContain('olympus x content recover');
      expect(readFileSync(join(packageDir, 'INSTALL_FOR_AGENTS.md'), 'utf8'))
        .not.toContain('olympus connect google-bootstrap');
      expect(readFileSync(join(packageDir, 'INSTALL_FOR_AGENTS.md'), 'utf8'))
        .not.toContain('`gcloud` bootstrap');
      // The trust docs' normative pointer must still be a link in the artifact:
      // the staging rewriter degrades links whose target was not packaged.
      expect(readFileSync(join(packageDir, 'docs', 'TRUST_MODEL.md'), 'utf8'))
        .toContain('[canonical Venice S4 policy](CONTRACTS.md#venice-s4-policy-normative)');
      expect(readFileSync(join(packageDir, 'docs', 'SOVEREIGNTY_CONFIG.md'), 'utf8'))
        .toContain('[canonical Venice S4 policy](CONTRACTS.md#venice-s4-policy-normative)');
      const packagedPackageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
        private?: boolean;
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(packagedPackageJson).toMatchObject({ name: V0_4_PUBLIC_PACKAGE_NAME, version: manifest.version });
      expect('private' in packagedPackageJson).toBe(false);
      expect(packagedPackageJson.scripts).toBeUndefined();
      expect(packagedPackageJson.devDependencies).toBeUndefined();
      const unresolvedLinks: string[] = [];
      for (const markdownPath of markdownFiles(packageDir)) {
        const markdown = readFileSync(markdownPath, 'utf8');
        for (const link of relativeMarkdownLinks(markdown)) {
          const target = join(dirname(markdownPath), link.path);
          if (!existsSync(target)) {
            unresolvedLinks.push(`${relative(packageDir, markdownPath)} -> ${link.href}`);
          }
        }
      }
      expect(unresolvedLinks).toEqual([]);

      const help = await run([join(packageDir, 'bin', 'olympus'), '--help'], { cwd: packageDir });
      expect(help.stdout).toContain('olympus setup --preset');

      const sovereigntyPath = join(extractDir, 'sovereignty.json');
      const init = await run([
        join(packageDir, 'bin', 'olympus'),
        'sovereignty',
        'init',
        '--preset',
        'no-sensitive',
        '--path',
        sovereigntyPath,
      ], { cwd: packageDir });
      expect(JSON.parse(init.stdout)).toMatchObject({ ok: true, preset: 'no-sensitive' });
      expect(JSON.parse(readFileSync(sovereigntyPath, 'utf8')).routes.secure_local.mode).toBe('disabled');

      const packagedBin = join(packageDir, 'bin', 'olympus');
      const workerInstall = await run([
        packagedBin,
        'worker',
        'install',
        '--dry-run',
        '--platform',
        'linux',
        '--home',
        join(extractDir, 'worker-home'),
      ], { cwd: packageDir });
      const workerInstallOutput = JSON.parse(workerInstall.stdout);
      expect(workerInstallOutput).toMatchObject({
        schema_version: 1,
        action: 'install',
        ok: true,
        platform: 'linux',
        changed: false,
        install: {
          wrote_unit: false,
          wrote_env: false,
        },
      });
      expect(workerInstallOutput.install.unit).toContain(`ExecStart=${process.execPath} ${join(realpathSync(packageDir), 'dist', 'cli.js')} __worker-service-run`);
      expect(workerInstallOutput.install.unit).not.toContain(`${process.execPath} ${packagedBin}`);
      expect(workerInstallOutput.install.unit).not.toContain('bin/olympus worker run');

      const packagedConfig = readDirectoryText(join(packageDir, 'config'));
      expect(packagedConfig).not.toContain('path_display');
      expect(packagedConfig).not.toContain('Zigelbaum');
      expect(packagedConfig).not.toContain('Family Trust');
      expect(packagedConfig).not.toContain('Banco Sabadell');
      expect(packagedConfig).not.toContain('Labs - STIs');

      const packagedSkills = readDirectoryText(join(packageDir, 'skills'));
      for (const packaged of [packagedSkills, readDirectoryText(join(packageDir, 'docs'))]) {
        expect(packaged).not.toContain('gserviceaccount.com');
        expect(packaged).not.toContain('olympus-491816');
        expect(packaged).not.toContain('castor-493710');
        expect(packaged).not.toContain('gs://castor-governance-rag');
        expect(packaged).not.toContain('8463231270061604864');
        expect(packaged).not.toContain('/Users/zig');
      }
      expect(existsSync(join(packageDir, 'docs', 'roles'))).toBe(false);
    } finally {
      if (createdLocalConfig) rmSync(localConfigPath, { force: true });
      rmSync(join(ROOT, '.release'), { recursive: true, force: true });
      rmSync(artifactPath, { force: true });
      rmSync(extractDir, { recursive: true, force: true });
    }
  }, 60_000);
});

async function run(
  command: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      npm_config_cache: join(tmpdir(), 'olympus-release-artifact-npm-cache'),
      OLYMPUS_GOOGLE_PILOT_CLIENT_ID: GOOGLE_PILOT_CLIENT_ID_FIXTURE,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(' ')} failed: ${stderr || stdout}`);
  return { stdout, stderr };
}

function markdownFiles(path: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) {
      paths.push(...markdownFiles(child));
    } else if (stat.isFile() && child.endsWith('.md')) {
      paths.push(child);
    }
  }
  return paths;
}

function allFiles(path: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) paths.push(...allFiles(child));
    else if (stat.isFile()) paths.push(child);
  }
  return paths;
}

function readDirectoryText(path: string): string {
  let text = '';
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) {
      text += readDirectoryText(child);
    } else if (stat.isFile()) {
      text += readFileSync(child, 'utf8');
    }
  }
  return text;
}

function relativeMarkdownLinks(markdown: string): Array<{ href: string; path: string }> {
  const links: Array<{ href: string; path: string }> = [];
  for (const match of markdown.matchAll(/\[!\[[^\]]*\]\([^)]+\)\]\(([^)]+)\)/g)) {
    addRelativeMarkdownLink(links, match[1]!);
  }
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    addRelativeMarkdownLink(links, match[1]!);
  }
  return links;
}

function addRelativeMarkdownLink(links: Array<{ href: string; path: string }>, href: string): void {
  if (/^(https?:|mailto:|#)/i.test(href)) return;
  const [path] = href.split('#');
  if (path && !path.startsWith('/')) links.push({ href, path });
}
