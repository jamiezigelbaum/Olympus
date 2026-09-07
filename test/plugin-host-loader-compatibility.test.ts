/**
 * The built plugin must load through the real OpenClaw plugin loader.
 *
 * OpenClaw resolves a plugin entry synchronously, on two legs:
 *   1. a native `require()` of the entry file, and
 *   2. when that throws, a jiti source transform of the same file.
 * Neither leg can represent top-level `await`, so an async entry graph fails
 * both and the plugin never reaches `register`. The repository's other tests
 * all load `src/` through `import()`, where top-level await is legal, so none
 * of them can see this class of break. This one drives the actual mechanisms
 * against the built public bundle.
 *
 * Requires a real OpenClaw install. It skips on a developer box without one and
 * FAILS wherever OLYMPUS_REQUIRE_HOST_LOADER=1 says the lane must run it — a
 * silent skip in the only lane that exercises the host is indistinguishable
 * from deleting the test. The always-on half of the same guard, needing no
 * install, is `test/plugin-bundle-no-top-level-await.test.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { V0_4_PUBLIC_NATIVE_TOOLS } from '../src/core/public-surface.ts';

const ROOT = join(import.meta.dir, '..');
const BUNDLE = join(ROOT, 'dist/index.js');
const REQUIRE_ENV = 'OLYMPUS_REQUIRE_HOST_LOADER';

const openClawRoot = resolveOpenClawRoot();
const nodeBinary = resolveNodeBinary(openClawRoot);
const jitiEntry = openClawRoot ? resolveJiti(openClawRoot) : undefined;
const available = Boolean(openClawRoot && nodeBinary && jitiEntry);
const required = process.env[REQUIRE_ENV]?.trim() === '1';

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function resolveOpenClawRoot(): string | undefined {
  const candidates = [
    process.env.OLYMPUS_OPENCLAW_INSTALL_DIR?.trim(),
    join(process.env.HOME ?? '', '.openclaw/tools/node/lib/node_modules/openclaw'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
}

function resolveNodeBinary(root: string | undefined): string | undefined {
  const candidates = [
    process.env.OLYMPUS_NODE_BINARY?.trim(),
    // <install>/lib/node_modules/openclaw -> <install>/bin/node
    root ? join(root, '../../../bin/node') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? Bun.which('node') ?? undefined;
}

function resolveJiti(root: string): string | undefined {
  // npm hoists, so jiti may sit beside the package rather than under it.
  const candidates = [
    join(root, 'node_modules/jiti/lib/jiti.cjs'),
    join(root, '../jiti/lib/jiti.cjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** A public package layout with the manifest beside the built runtime. */
function stageInstall(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-host-loader-'));
  temporaryDirs.push(root);
  mkdirSync(join(root, 'dist'));
  copyFileSync(BUNDLE, join(root, 'dist/index.js'));
  copyFileSync(join(ROOT, 'openclaw.plugin.json'), join(root, 'openclaw.plugin.json'));
  return root;
}

interface LoadResult {
  ok: boolean;
  names?: string[];
  code?: string | null;
  message?: string;
}

/**
 * Runs one leg of the host loader in the OpenClaw-bundled Node and reports what
 * the plugin registered, or how the load failed.
 */
function loadThroughHost(installRoot: string, leg: 'require' | 'jiti'): LoadResult {
  const runner = join(installRoot, 'run-host-load.cjs');
  writeFileSync(runner, [
    'const entry = process.argv[2];',
    'const leg = process.argv[3];',
    'const jitiEntry = process.argv[4];',
    'let loaded;',
    'try {',
    "  if (leg === 'require') loaded = require(entry);",
    '  else {',
    '    const { createJiti } = require(jitiEntry);',
    '    loaded = createJiti(entry)(entry);',
    '  }',
    '} catch (error) {',
    '  const message = error && error.message ? String(error.message).split("\\n")[0] : String(error);',
    '  console.log(JSON.stringify({ ok: false, code: (error && error.code) || null, message }));',
    '  process.exit(0);',
    '}',
    'const plugin = (loaded && loaded.default) || loaded;',
    'const names = [];',
    'plugin.register({',
    '  pluginConfig: {},',
    '  config: {},',
    '  registerTool(tool) {',
    "    const materialized = typeof tool === 'function' ? tool({ senderIsOwner: true }) : tool;",
    '    names.push(materialized.name);',
    '  },',
    '  registerHttpRoute() {},',
    '});',
    'console.log(JSON.stringify({ ok: true, names }));',
    '',
  ].join('\n'));

  const result = Bun.spawnSync([
    nodeBinary!,
    runner,
    join(installRoot, 'dist/index.js'),
    leg,
    jitiEntry!,
  ], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  const lastLine = stdout.split('\n').at(-1) ?? '';
  try {
    return JSON.parse(lastLine) as LoadResult;
  } catch {
    throw new Error(`Host ${leg} leg produced no result.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

if (required && !available) {
  // Not a skip: this is the one lane that is supposed to exercise the host, and
  // a skip there reports a pass for a check that never ran.
  test(`the OpenClaw install ${REQUIRE_ENV}=1 requires is present`, () => {
    throw new Error(
      `${REQUIRE_ENV}=1 says this environment must run the host plugin-loader test, but `
      + `openclawRoot=${openClawRoot ?? 'missing'} node=${nodeBinary ?? 'missing'} `
      + `jiti=${jitiEntry ?? 'missing'}. Install openclaw in the workflow, or unset ${REQUIRE_ENV} `
      + 'if this lane is genuinely allowed to skip it.',
    );
  });
}

describe.skipIf(!available)('OpenClaw host plugin loader', () => {
  const legs = ['require', 'jiti'] as const;

  test('the installed loader still uses the two legs this test drives', () => {
    const loaderDir = join(openClawRoot!, 'dist');
    const loaderFile = readdirSync(loaderDir)
      .find((entry) => entry.startsWith('plugin-module-loader-cache-') && entry.endsWith('.js'));
    expect(loaderFile, 'OpenClaw plugin module loader cache not found').toBeDefined();
    const source = readFileSync(join(loaderDir, loaderFile!), 'utf8');
    // A synchronous native require, then a jiti source transform. If either
    // disappears this test is measuring the wrong thing and must be updated.
    expect(source).toContain('nodeRequire(modulePath)');
    expect(source).toContain('createJiti');
    expect(source).not.toContain('await import(');
    const version = (JSON.parse(readFileSync(join(openClawRoot!, 'package.json'), 'utf8')) as {
      version: string;
    }).version;
    expect(version.length).toBeGreaterThan(0);
  });

  for (const leg of legs) {
    test(`${leg}: the public bundle registers exactly the public tools`, () => {
      const result = loadThroughHost(stageInstall(), leg);
      expect(result.message ?? '').toBe('');
      expect(result.ok).toBe(true);
      expect(result.names).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    }, 60_000);

  }
});
