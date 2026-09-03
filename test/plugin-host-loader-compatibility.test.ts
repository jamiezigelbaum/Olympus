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
 * against the committed bundle.
 *
 * It also drives the fail-closed half of the private extension point. A private
 * manifest accepts the private config keys, so an install that carries it but
 * loses the overlay would otherwise come up with the public surface while the
 * operator's config validated cleanly. The staged installs below include that
 * exact shape, and a missing or misnamed overlay must fail the load.
 *
 * Requires a real OpenClaw install. It skips on a developer box without one and
 * FAILS wherever OLYMPUS_REQUIRE_HOST_LOADER=1 says the lane must run it — a
 * silent skip in the only lane that exercises the host is indistinguishable
 * from deleting the test. The always-on half of the same guard, needing no
 * install, is `test/plugin-bundle-no-top-level-await.test.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { V0_4_PUBLIC_NATIVE_TOOLS } from '../src/core/public-surface.ts';
import {
  OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
  PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
  PRIVATE_EXTENSION_MANIFEST_BASENAME,
  PRIVATE_EXTENSION_MANIFEST_KEY,
  PRIVATE_EXTENSION_MANIFEST_NAMESPACE,
  PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME,
} from '../src/private-extension-contract.ts';

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

/** Written by the overlay the moment it is evaluated, one byte per evaluation. */
const EVALUATION_SENTINEL = 'overlay-evaluated.log';

/**
 * How many times the staged overlay actually ran.
 *
 * Refusing an install AFTER evaluating its overlay still executes module-scope
 * private code, so "did it refuse" is only half the question. This is the other
 * half, measured from outside the process.
 */
function evaluationCount(installRoot: string): number {
  const path = join(installRoot, EVALUATION_SENTINEL);
  return existsSync(path) ? statSync(path).size : 0;
}

function overlayModule(contractVersion: number, sentinelPath: string): string {
  return [
    `require('node:fs').appendFileSync(${JSON.stringify(sentinelPath)}, 'x');`,
    'module.exports = {',
    `  contractVersion: ${contractVersion},`,
    "  id: 'host-loader-fixture',",
    '  configFragments: () => [],',
    '  runtimeExpectations: () => ({ env: [], services: [] }),',
    '  register(input) {',
    '    const target = input.operations.find((operation) =>',
    '      !input.isPublicNativeOperation(operation.name)',
    '      && !input.registeredToolNames.includes(operation.name));',
    '    if (target) input.registerOperationTool(target);',
    '  },',
    '};',
    '',
  ].join('\n');
}

function publicManifest(): string {
  return `${JSON.stringify({
    id: 'olympus',
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }, null, 2)}\n`;
}

function privateManifest(
  contractVersion: number = OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
): string {
  return `${JSON.stringify({
    id: 'olympus',
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
    [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: {
      [PRIVATE_EXTENSION_MANIFEST_KEY]: {
        required: true,
        contractVersion,
        module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      },
    },
  }, null, 2)}\n`;
}

/**
 * A plugin root shaped like an installed one: the manifest at the root and the
 * bundle in `dist/`, which is where the loader resolves both from.
 */
function stageInstall(options: {
  /** Defaults to the public manifest. `null` stages no manifest at all. */
  manifest?: string | null;
  overlayName?: string;
  overlayContractVersion?: number;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-host-loader-'));
  temporaryDirs.push(root);
  mkdirSync(join(root, 'dist'));
  copyFileSync(BUNDLE, join(root, 'dist/index.js'));
  const manifest = options.manifest === undefined ? publicManifest() : options.manifest;
  if (manifest !== null) {
    writeFileSync(join(root, PRIVATE_EXTENSION_MANIFEST_BASENAME), manifest);
  }
  if (options.overlayName !== undefined) {
    writeFileSync(
      join(root, 'dist', options.overlayName),
      overlayModule(
        options.overlayContractVersion ?? OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
        join(root, EVALUATION_SENTINEL),
      ),
    );
  }
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
    test(`${leg}: no overlay beside the bundle registers exactly the public tools`, () => {
      const result = loadThroughHost(stageInstall(), leg);
      expect(result.message ?? '').toBe('');
      expect(result.ok).toBe(true);
      expect(result.names).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    }, 60_000);

    test(`${leg}: a valid overlay registers its lane on top of the public tools`, () => {
      const install = stageInstall({
        manifest: privateManifest(),
        overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      });
      const result = loadThroughHost(install, leg);
      expect(result.message ?? '').toBe('');
      expect(result.ok).toBe(true);
      expect(evaluationCount(install), 'the overlay must run exactly once').toBe(1);
      const names = result.names ?? [];
      expect(names.slice(0, V0_4_PUBLIC_NATIVE_TOOLS.length)).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
      expect(names.length).toBe(V0_4_PUBLIC_NATIVE_TOOLS.length + 1);
      expect(V0_4_PUBLIC_NATIVE_TOOLS as readonly string[]).not.toContain(names.at(-1)!);
    }, 60_000);

    test(`${leg}: an overlay on a different contract version fails the load`, () => {
      const install = stageInstall({
        manifest: privateManifest(),
        overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
        overlayContractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION + 4_242,
      });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('contract mismatch');
      expect(result.message).toContain(`implements ${OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION}`);
    }, 60_000);

    test(`${leg}: a private manifest with the overlay missing fails the load`, () => {
      const install = stageInstall({ manifest: privateManifest() });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('declares required private extensions');
      expect(result.message).toContain(PRIVATE_EXTENSION_BUILT_MODULE_BASENAME);
    }, 60_000);

    test(`${leg}: a private manifest with the overlay misnamed .js fails the load`, () => {
      const install = stageInstall({
        manifest: privateManifest(),
        overlayName: 'private-extensions.js',
      });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('declares required private extensions');
    }, 60_000);

    test(`${leg}: a TypeScript overlay beside an installed bundle fails the load`, () => {
      // The shipped artifact never contains one, and the refusal must not
      // depend on what the manifest happens to say.
      const install = stageInstall({ overlayName: PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('may only load private-extensions.cjs');
      expect(evaluationCount(install)).toBe(0);
    }, 60_000);

    test(`${leg}: an installed bundle with no manifest above it fails the load`, () => {
      const result = loadThroughHost(stageInstall({ manifest: null }), leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('No openclaw.plugin.json was found');
    }, 60_000);

    test(`${leg}: an overlay with no manifest above it fails before it runs`, () => {
      // The rollback / half-install shape: the overlay is still on disk, the
      // manifest is gone. Module-scope private code must not run.
      const install = stageInstall({
        manifest: null,
        overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('No openclaw.plugin.json was found');
      expect(evaluationCount(install), 'refusal must precede evaluation').toBe(0);
    }, 60_000);

    test(`${leg}: an overlay under an opted-out manifest fails before it runs`, () => {
      const optedOut = `${JSON.stringify({
        id: 'olympus',
        configSchema: { type: 'object', additionalProperties: false, properties: {} },
        [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: {
          [PRIVATE_EXTENSION_MANIFEST_KEY]: { required: false },
        },
      }, null, 2)}\n`;
      const install = stageInstall({
        manifest: optedOut,
        overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('does not require private extensions');
      expect(evaluationCount(install), 'refusal must precede evaluation').toBe(0);
    }, 60_000);

    test(`${leg}: an overlay under a public manifest fails the load`, () => {
      const install = stageInstall({ overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('does not require private extensions');
      expect(evaluationCount(install), 'refusal must precede evaluation').toBe(0);
    }, 60_000);

    test(`${leg}: a manifest on an unsupported contract version fails before the overlay runs`, () => {
      // Decidable from two static facts — what the manifest asks for and what
      // this build implements — so no overlay code may run to discover it.
      const install = stageInstall({
        manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION + 1),
        overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      });
      const result = loadThroughHost(install, leg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('this build implements');
      expect(evaluationCount(install), 'refusal must precede evaluation').toBe(0);
    }, 60_000);

    test(`${leg}: a private manifest with the overlay present loads the private lane`, () => {
      const install = stageInstall({
        manifest: privateManifest(),
        overlayName: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      });
      const result = loadThroughHost(install, leg);
      expect(result.message ?? '').toBe('');
      expect(result.ok).toBe(true);
      expect((result.names ?? []).length).toBe(V0_4_PUBLIC_NATIVE_TOOLS.length + 1);
    }, 60_000);
  }
});
