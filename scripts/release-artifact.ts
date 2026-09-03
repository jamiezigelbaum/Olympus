import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { minify } from 'terser';
import { assertStagedEntrypointsAreSynchronouslyLoadable } from './top-level-await-scan.ts';
import { assertStagedManifestIsPublic } from './public-manifest-guard.ts';
import { OWNER_IDENTIFIER_PATTERNS, scannableText } from './owner-identifier-patterns.ts';
import { DEFAULT_GOOGLE_PILOT_CLIENT_ID } from '../src/core/google-pilot-client.ts';
import {
  V0_4_PUBLIC_PACKAGE_BUILD_READY,
  V0_4_PUBLIC_PACKAGE_FILES,
  V0_4_PUBLIC_PACKAGE_NAME,
  V0_4_SOURCE_CHECKOUT_PACKAGE_FILES,
  V0_4_SOURCE_CHECKOUT_PACKAGE_NAME,
} from '../src/core/public-surface.ts';
import {
  PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE,
  PUBLIC_RUNTIME_STRIPPED_MODULES,
  PUBLIC_RUNTIME_STRIPPED_MODULE_FILTER,
  replacePublicRuntimeCredentialHandles,
  stripPublicRuntimeExcludedBlocks,
} from './public-runtime-strip.ts';

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  openclaw?: {
    extensions?: string[];
    runtimeExtensions?: string[];
    install?: { clawhubSpec?: string; defaultChoice?: string; minHostVersion?: string };
    compat?: { pluginApi?: string };
    build?: { openclawVersion?: string };
  };
}

interface NpmPackResult {
  filename: string;
  integrity: string;
  shasum: string;
  size: number;
  files: Array<{ path: string }>;
}

interface OpenClawManifest {
  version: string;
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = readJson<PackageJson>('package.json');
const manifest = readJson<OpenClawManifest>('openclaw.plugin.json');
const googlePilotClientId = releaseGooglePilotClientId(process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID);

if (!V0_4_PUBLIC_PACKAGE_BUILD_READY) {
  throw new Error(
    'Public artifact creation is fail-closed until Slice 3D builds public-only runtime entrypoints and proves zero private bytes.',
  );
}

if (packageJson.name !== V0_4_SOURCE_CHECKOUT_PACKAGE_NAME || packageJson.private !== true) {
  throw new Error('The source checkout must retain its distinct private npm identity.');
}
if (JSON.stringify(packageJson.files)
  !== JSON.stringify(V0_4_SOURCE_CHECKOUT_PACKAGE_FILES)) {
  throw new Error('The source checkout npm files list must remain content-minimal.');
}
const openclaw = packageJson.openclaw;
if (!openclaw || JSON.stringify(openclaw.extensions) !== JSON.stringify(['./dist/index.js'])) {
  throw new Error('package.json must declare the source extension through openclaw.extensions.');
}
if (JSON.stringify(openclaw.runtimeExtensions) !== JSON.stringify(openclaw.extensions)) {
  throw new Error('package.json openclaw.runtimeExtensions must exactly match openclaw.extensions.');
}
// `parseClawHubPluginSpec` returns null unless the string starts with
// `clawhub:`, so a bare package name records `invalid-clawhub-spec` in the
// host registry and leaves the declared default install source unresolvable.
// The old truthiness-only guard is exactly why that shipped unnoticed.
if (openclaw.install?.clawhubSpec !== `clawhub:${V0_4_PUBLIC_PACKAGE_NAME}`
  || openclaw.install.defaultChoice !== 'clawhub') {
  throw new Error(`package.json must declare clawhub:${V0_4_PUBLIC_PACKAGE_NAME} as its default install source.`);
}
// The host links `node_modules/openclaw` into an installed plugin only when
// the package declares `openclaw` as a peer (or ordinary) dependency. Without
// it `openclaw/plugin-sdk/channel-outbound` never resolves, so every
// source_watch_* delivery fails 503 while the plugin still reports healthy.
// The floor is the version actually qualified; every compatibility claim in
// the package must state exactly it, or the artifact advertises support the
// qualification never proved.
const QUALIFIED_HOST_FLOOR = '>=2026.7.1';
if (packageJson.peerDependencies?.openclaw !== QUALIFIED_HOST_FLOOR) {
  throw new Error(`package.json peerDependencies.openclaw must be exactly "${QUALIFIED_HOST_FLOOR}" (the qualified host floor).`);
}
if (openclaw.install?.minHostVersion !== QUALIFIED_HOST_FLOOR) {
  throw new Error(`package.json openclaw.install.minHostVersion must be exactly "${QUALIFIED_HOST_FLOOR}" (the qualified host floor).`);
}
// The host reads peerDependencies by name and ignores this meta block, but a
// package manager does not: without the optional marker `bun install` resolves
// the peer for real and drags OpenClaw's whole dependency tree into the source
// checkout (107 packages -> 232) and its lockfile. The host supplies the real
// module by symlink, so the peer must never be installed from a registry.
if (packageJson.peerDependenciesMeta?.openclaw?.optional !== true) {
  throw new Error('package.json must mark the openclaw peer optional so package managers do not install the host from a registry.');
}
// `satisfiesSemverRange` in the host starts `if (range.includes("||")) return false;`
// — any OR in compat.pluginApi makes the plugin uninstallable on every host.
// Exact match doubles as the OR guard: the floor constant carries none.
if (openclaw.compat?.pluginApi !== QUALIFIED_HOST_FLOOR) {
  throw new Error(`package.json openclaw.compat.pluginApi must be exactly "${QUALIFIED_HOST_FLOOR}" — a single range with no "||".`);
}
if (!openclaw.build?.openclawVersion) {
  throw new Error('package.json must record openclaw.build.openclawVersion.');
}

const artifactName = `${V0_4_PUBLIC_PACKAGE_NAME}-${manifest.version}.tgz`;
const artifactDir = join(rootDir, 'release-artifacts');
const artifactPath = join(artifactDir, artifactName);
const releaseRoot = join(rootDir, '.release');
const stagingDir = join(releaseRoot, `${V0_4_PUBLIC_PACKAGE_NAME}-${manifest.version}`);
const npmCacheDir = join(releaseRoot, 'npm-cache');

run('bun', ['run', 'dist:check'], {
  failureMessage: 'dist/index.js or dist/cli.js changed after rebuild. Commit rebuilt dist artifacts before creating a release tarball.',
});

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
mkdirSync(artifactDir, { recursive: true });

for (const path of V0_4_PUBLIC_PACKAGE_FILES) {
  const source = join(rootDir, path);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Public package entry must be a regular non-symlink file: ${path}.`);
  }
  if (path === 'dist/index.js' || path === 'dist/cli.js') continue;
  mkdirSync(dirname(join(stagingDir, path)), { recursive: true });
  copyFileSync(source, join(stagingDir, path));
}
await buildPublicRuntime('src/native-plugin.ts', 'dist/index.js');
await buildPublicRuntime('src/cli.ts', 'dist/cli.js');
run('bun', [
  join(rootDir, 'scripts/strip-generated-trailing-whitespace.ts'),
  join(stagingDir, 'dist/index.js'),
  join(stagingDir, 'dist/cli.js'),
]);
assertStagedEntrypointsAreSynchronouslyLoadable(stagingDir);
assertStagedManifestIsPublic(stagingDir);
writePackagedPackageJson(stagingDir);
writePackagedReadme(stagingDir);
rewriteMissingRelativeMarkdownLinks(stagingDir);
assertExactStagedInventory(stagingDir);
assertNoOwnerIdentifiers(stagingDir);

rmSync(artifactPath, { force: true });
const npmOutput = runCapture('npm', ['pack', '--json', '--pack-destination', artifactDir], {
  cwd: stagingDir,
  env: { ...process.env, npm_config_cache: npmCacheDir },
});
const pack = (JSON.parse(npmOutput) as NpmPackResult[])[0];
if (!pack) throw new Error('npm pack returned no package result.');
if (pack.filename !== artifactName) {
  throw new Error(`npm pack wrote ${pack.filename}; expected ${artifactName}.`);
}
const packedFiles = pack.files.map((entry) => entry.path).sort();
const expectedFiles = [...V0_4_PUBLIC_PACKAGE_FILES].sort();
if (JSON.stringify(packedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`npm pack inventory drifted.\nExpected: ${expectedFiles.join(', ')}\nActual: ${packedFiles.join(', ')}`);
}
assertPackagedArchive(artifactPath);

console.log(`Wrote ${artifactPath}`);
console.log(`SHA-256 ${createHash('sha256').update(readFileSync(artifactPath)).digest('hex')}`);
console.log(`npm integrity ${pack.integrity}`);
console.log(`npm shasum ${pack.shasum}`);
console.log(`Managed proof: openclaw plugins install npm-pack:${artifactPath} --force --accept-capabilities`);
console.log(`ClawHub publication input: clawhub package publish ${artifactPath} --family code-plugin --dry-run`);
console.log(`Public install after publication: openclaw plugins install ${openclaw.install.clawhubSpec} --accept-capabilities`);
console.log('  --accept-capabilities is required by OpenClaw 2026.8.1+ for any non-TTY install; drop it on 2026.7.1, which does not define the flag.');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8')) as T;
}

async function buildPublicRuntime(entry: string, output: string): Promise<void> {
  const destination = join(stagingDir, output);
  const buildFlavorPath = join(rootDir, 'src/core/build-flavor.ts');
  const googlePilotClientPath = join(rootDir, 'src/core/google-pilot-client.ts');
  const strippedModulePaths = PUBLIC_RUNTIME_STRIPPED_MODULES.map((module) => join(rootDir, module));
  const credentialBrokerPath = join(rootDir, PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE);
  mkdirSync(dirname(destination), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(rootDir, entry)],
    target: 'node',
    format: 'esm',
    minify: true,
    outdir: dirname(destination),
    naming: basename(destination),
    plugins: [{
      name: 'olympus-public-build-flavor',
      setup(builder) {
        builder.onLoad({ filter: /build-flavor\.ts$/ }, ({ path }) => {
          if (path !== buildFlavorPath) {
            throw new Error(`Unexpected public build-flavor module: ${path}`);
          }
          return {
            contents: 'export const PUBLIC_RUNTIME_BUILD = true;\n',
            loader: 'ts',
          };
        });
        builder.onLoad({ filter: /google-pilot-client\.ts$/ }, ({ path }) => {
          if (path !== googlePilotClientPath) {
            throw new Error(`Unexpected Google pilot-client module: ${path}`);
          }
          return {
            contents: `export const DEFAULT_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(googlePilotClientId)};\nexport const PACKAGED_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(googlePilotClientId)};\nexport function resolveGooglePilotClientId(packaged, shipped) { return (packaged || '').trim() || (shipped || '').trim() || undefined; }\nexport function packagedGooglePilotClientId() { return PACKAGED_GOOGLE_PILOT_CLIENT_ID; }\n`,
            loader: 'ts',
          };
        });
        builder.onLoad({ filter: PUBLIC_RUNTIME_STRIPPED_MODULE_FILTER }, ({ path }) => {
          if (!strippedModulePaths.includes(path)) {
            throw new Error(`Unexpected public-runtime stripped module: ${path}`);
          }
          let contents = stripPublicRuntimeExcludedBlocks(readFileSync(path, 'utf8'), path);
          if (path === credentialBrokerPath) {
            contents = replacePublicRuntimeCredentialHandles(contents, path);
          }
          return {
            contents,
            loader: 'ts',
          };
        });
      },
    }],
  });
  if (!result.success) {
    throw new Error(`Public runtime build failed for ${entry}:\n${result.logs.join('\n')}`);
  }
  const built = result.outputs.find((candidate) => candidate.kind === 'entry-point');
  if (!built) throw new Error(`Public runtime build produced no entry point for ${entry}.`);
  if (built.path !== destination) {
    throw new Error(`Public runtime build wrote ${built.path}; expected ${destination}.`);
  }
  const optimized = await minify(readFileSync(destination, 'utf8'), {
    module: true,
    compress: {
      dead_code: true,
      evaluate: true,
      passes: 3,
      toplevel: true,
      unused: true,
    },
    mangle: true,
    format: { comments: false },
  });
  if (!optimized.code) {
    throw new Error(`Public runtime optimizer produced no output for ${entry}.`);
  }
  writeFileSync(destination, `${optimized.code}\n`);
}

/**
 * The env var still wins, so a release can pin a different client without a
 * source edit. It stays REQUIRED while `DEFAULT_GOOGLE_PILOT_CLIENT_ID` is
 * empty: a release artifact must never ship the shared-OAuth path unwired.
 */
function releaseGooglePilotClientId(value: string | undefined): string {
  const clientId = value?.trim() || DEFAULT_GOOGLE_PILOT_CLIENT_ID.trim();
  if (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('OLYMPUS_GOOGLE_PILOT_CLIENT_ID must name the publisher-owned Google Desktop OAuth client before building a release artifact, or DEFAULT_GOOGLE_PILOT_CLIENT_ID must carry it in src/core/google-pilot-client.ts.');
  }
  return clientId;
}

function assertExactStagedInventory(baseDir: string): void {
  const actual = stagedFiles(baseDir).map((path) => relative(baseDir, path)).sort();
  const expected = [...V0_4_PUBLIC_PACKAGE_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Release staging inventory drifted.\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`);
  }
}

function assertPackagedArchive(path: string): void {
  const inspectDir = join(releaseRoot, 'archive-inspect');
  rmSync(inspectDir, { recursive: true, force: true });
  mkdirSync(inspectDir, { recursive: true });
  run('tar', ['-xzf', path, '-C', inspectDir]);
  assertNoOwnerIdentifiers(join(inspectDir, 'package'));
}

/**
 * Owner-identity patterns that must not leave this machine inside the tarball.
 *
 * The package now copies only exact files from the positive release catalog.
 * This content scan remains a second, independent guard against a concrete
 * tenant identity entering one of those declared public files.
 *
 * Every staged file, not an opt-in list. An allowlisted scan would have missed
 * `skills/` for exactly the reason it was missed in the first place. The
 * patterns themselves live in `owner-identifier-patterns.ts` so this scan and
 * the whole-repository `public-flip-scan.ts` cannot drift apart.
 */
function assertNoOwnerIdentifiers(baseDir: string): void {
  const offenders: string[] = [];
  for (const path of stagedFiles(baseDir)) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // A binary or minified bundle read as utf8 is noise, not evidence.
    if (text.includes('\u0000')) continue;
    const relativePath = path.slice(baseDir.length + 1);
    const scannedText = scannableText(relativePath, text);
    for (const { label, pattern } of OWNER_IDENTIFIER_PATTERNS) {
      const match = pattern.exec(scannedText);
      if (match) {
        offenders.push(`${relativePath}: ${label} (${match[0]})`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      'Release staging contains owner-specific identifiers and was not packaged:\n'
      + offenders.map((entry) => `  - ${entry}`).join('\n')
      + '\nMove installation-specific values into an unpackaged docs/roles/ note and '
      + 'reference it by path from the shipped file.',
    );
  }
}

function stagedFiles(baseDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(baseDir)) {
    const child = join(baseDir, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) files.push(...stagedFiles(child));
    else if (stat.isFile()) files.push(child);
  }
  return files;
}

function writePackagedPackageJson(stagingDir: string): void {
  const path = join(stagingDir, 'package.json');
  const packaged = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  packaged.name = V0_4_PUBLIC_PACKAGE_NAME;
  packaged.version = manifest.version;
  delete packaged.private;
  delete packaged.scripts;
  delete packaged.devDependencies;
  packaged.files = V0_4_PUBLIC_PACKAGE_FILES.filter((entry) => entry !== 'package.json');
  writeFileSync(path, `${JSON.stringify(packaged, null, 2)}\n`);
}

function writePackagedReadme(stagingDir: string): void {
  const path = join(stagingDir, 'README.md');
  const readme = readFileSync(path, 'utf8')
    .replace('(docs/DEVELOPMENT.md)', '(#development)')
    .replace(
      '```bash\nbun install\nbun run test:focus -- test/example.test.ts\n```',
      'This release tarball contains the built plugin runtime. Development verification runs from the source repository, where the full `src/`, `scripts/`, `test/`, and `eval/` tree is present.',
    )
    .replace(
      'Deep-dive docs: [development notes](docs/DEVELOPMENT.md) ·\n[architecture]',
      'Deep-dive docs: [architecture]',
    );
  writeFileSync(path, readme);
}

function rewriteMissingRelativeMarkdownLinks(baseDir: string): void {
  for (const path of markdownFiles(baseDir)) {
    const markdown = readFileSync(path, 'utf8');
    const rewritten = markdown
      .replace(/\[(!\[[^\]]*\]\([^)]+\))\]\(([^)]+)\)/g, (full, image, href) => {
        if (!isMissingRelativeMarkdownTarget(path, href)) return full;
        return image;
      })
      .replace(/(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g, (full, label, href) => {
        if (!isMissingRelativeMarkdownTarget(path, href)) return full;
        return label;
      });
    if (rewritten !== markdown) writeFileSync(path, rewritten);
  }
}

function markdownFiles(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      paths.push(...markdownFiles(path));
    } else if (stat.isFile() && path.endsWith('.md')) {
      paths.push(path);
    }
  }
  return paths;
}

function isMissingRelativeMarkdownTarget(sourcePath: string, href: string): boolean {
  if (/^(https?:|mailto:|#)/i.test(href)) return false;
  const [target] = href.split('#');
  if (!target || target.startsWith('/')) return false;
  return !existsSync(join(dirname(sourcePath), target));
}

function run(command: string, args: string[], options: { failureMessage?: string } = {}): void {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(options.failureMessage ?? `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function runCapture(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
