import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  V0_4_PUBLIC_MCP_TOOLS,
  V0_4_PUBLIC_NATIVE_TOOLS,
} from '../src/core/public-surface.ts';

interface InspectResult {
  plugin?: {
    id?: string;
    version?: string;
    rootDir?: string;
    source?: string;
    status?: string;
    activated?: boolean;
    toolNames?: string[];
    contracts?: { tools?: string[] };
  };
  install?: {
    artifactKind?: string;
    artifactFormat?: string;
    installPath?: string;
    version?: string;
  };
}

interface ManagedProofReceipt {
  kind: 'olympus_managed_package_proof';
  schema_version: 1;
  package: { name: 'olympus'; version: string };
  artifact: { sha256: string; bytes: number };
  openclaw: { version: string };
  checks: {
    managed_install: true;
    runtime_loaded: true;
    public_contract_exact: true;
    runtime_tools_exact: true;
    cli_version: true;
    cli_help: true;
    lifecycle_dry_run: true;
    clean_uninstall: true;
  };
  policy: {
    content_free: true;
    credential_contents_returned: false;
    file_paths_returned: false;
    host_names_returned: false;
    provider_ids_returned: false;
  };
}

const options = parseArgs(process.argv.slice(2));
const artifactPath = resolve(options.artifact);
assertRegularFile(artifactPath, 'artifact');
const artifactBytes = statSync(artifactPath).size;
const artifactSha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
const proofRoot = mkdtempSync(join(tmpdir(), 'olympus-managed-package-proof-'));
const isolatedHome = join(proofRoot, 'home');
const stateDir = join(proofRoot, 'state');
const configPath = join(stateDir, 'openclaw.json');
mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const isolatedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: isolatedHome,
  XDG_CACHE_HOME: join(isolatedHome, '.cache'),
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
  XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  NO_COLOR: '1',
};

let installedRoot: string | undefined;
try {
  const openclawVersion = firstVersion(run(options.openclawBin, ['--version'], { env: isolatedEnv }).stdout, 'OpenClaw');
  run(options.openclawBin, [
    'plugins',
    'install',
    `npm-pack:${artifactPath}`,
    '--force',
    ...acceptCapabilitiesFlag(options.openclawBin, isolatedEnv),
  ], { env: isolatedEnv });

  const inspect = parseJson<InspectResult>(
    run(options.openclawBin, ['plugins', 'inspect', 'olympus', '--runtime', '--json'], { env: isolatedEnv }).stdout,
    'OpenClaw runtime inspection',
  );
  const plugin = inspect.plugin;
  if (!plugin || plugin.id !== 'olympus' || plugin.status !== 'loaded' || plugin.activated !== true) {
    throw new Error('Managed OpenClaw inspection did not report an activated loaded Olympus plugin.');
  }
  if (!plugin.version || inspect.install?.version !== plugin.version) {
    throw new Error('Managed OpenClaw inspection did not bind one package version.');
  }
  if (inspect.install.artifactKind !== 'npm-pack' || inspect.install.artifactFormat !== 'tgz') {
    throw new Error('Managed OpenClaw inspection did not preserve npm-pack tarball provenance.');
  }
  expectExact(plugin.contracts?.tools, V0_4_PUBLIC_NATIVE_TOOLS, 'native public tool contract');
  expectExact(plugin.toolNames, V0_4_PUBLIC_MCP_TOOLS, 'runtime materialized public tools');

  installedRoot = requiredContainedPath(plugin.rootDir, stateDir, 'installed plugin root');
  const inspectedInstallPath = requiredContainedPath(inspect.install.installPath, stateDir, 'managed install path');
  if (installedRoot !== inspectedInstallPath) {
    throw new Error('Managed install path and runtime plugin root do not match.');
  }
  const runtimeEntry = requiredContainedPath(plugin.source, installedRoot, 'runtime entrypoint');
  if (runtimeEntry !== join(installedRoot, 'dist', 'index.js')) {
    throw new Error('Managed runtime did not load the packaged dist/index.js entrypoint.');
  }
  const cliPath = join(installedRoot, 'bin', 'olympus');
  assertRegularFile(cliPath, 'installed CLI');

  const cliVersionOutput = run(cliPath, ['--version'], { cwd: installedRoot, env: isolatedEnv }).stdout.trim();
  if (cliVersionOutput !== `olympus ${plugin.version}`) {
    throw new Error('Installed CLI version does not match the inspected plugin version.');
  }
  const help = run(cliPath, ['--help'], { cwd: installedRoot, env: isolatedEnv }).stdout;
  if (!help.includes('olympus source answer <question>') || !help.includes('olympus worker install')) {
    throw new Error('Installed CLI help is missing required public commands.');
  }
  const privateCommands = [
    ['domain', 'ask'].join(' '),
    'xanthos',
    'email answer',
    'source index sync',
  ];
  for (const privateCommand of privateCommands) {
    if (help.includes(privateCommand)) throw new Error(`Installed CLI help exposes private command: ${privateCommand}.`);
  }

  const lifecycle = parseJson<Record<string, unknown>>(
    run(cliPath, ['worker', 'install', '--platform', process.platform === 'linux' ? 'linux' : 'darwin', '--home', isolatedHome, '--dry-run'], {
      cwd: installedRoot,
      env: isolatedEnv,
    }).stdout,
    'installed lifecycle dry run',
  );
  if (lifecycle.schema_version !== 1 || lifecycle.action !== 'install' || lifecycle.ok !== true || lifecycle.changed !== false) {
    throw new Error('Installed lifecycle dry run did not return the stable non-mutating install receipt.');
  }

  run(options.openclawBin, ['plugins', 'uninstall', 'olympus', '--force'], { env: isolatedEnv });
  if (existsSync(installedRoot)) throw new Error('Managed uninstall left the installed plugin directory behind.');

  const receipt: ManagedProofReceipt = {
    kind: 'olympus_managed_package_proof',
    schema_version: 1,
    package: { name: 'olympus', version: plugin.version },
    artifact: { sha256: artifactSha256, bytes: artifactBytes },
    openclaw: { version: openclawVersion },
    checks: {
      managed_install: true,
      runtime_loaded: true,
      public_contract_exact: true,
      runtime_tools_exact: true,
      cli_version: true,
      cli_help: true,
      lifecycle_dry_run: true,
      clean_uninstall: true,
    },
    policy: {
      content_free: true,
      credential_contents_returned: false,
      file_paths_returned: false,
      host_names_returned: false,
      provider_ids_returned: false,
    },
  };
  if (options.output) {
    const outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (!options.keepTemp) rmSync(proofRoot, { recursive: true, force: true });
}

function parseArgs(args: string[]): { artifact: string; openclawBin: string; output?: string; keepTemp: boolean } {
  let artifact: string | undefined;
  let openclawBin = process.env.OPENCLAW_BIN?.trim() || 'openclaw';
  let output: string | undefined;
  let keepTemp = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--artifact') artifact = requiredNext(args, ++index, arg);
    else if (arg === '--openclaw-bin') openclawBin = requiredNext(args, ++index, arg);
    else if (arg === '--output') output = requiredNext(args, ++index, arg);
    else if (arg === '--keep-temp') keepTemp = true;
    else throw new Error(`Unknown managed-package-proof option: ${arg}.`);
  }
  if (!artifact) throw new Error('Managed package proof requires --artifact <path>.');
  return { artifact, openclawBin, ...(output ? { output } : {}), keepTemp };
}

function requiredNext(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * OpenClaw 2026.8.1 refuses every non-TTY `plugins install` without capability
 * consent, and 2026.7.1 rejects `--accept-capabilities` as an unknown option.
 * Probing the host's own help output keeps one proof script correct on both
 * without hardcoding a version boundary that the host may move again.
 */
function acceptCapabilitiesFlag(openclawBin: string, env: NodeJS.ProcessEnv): string[] {
  const help = run(openclawBin, ['plugins', 'install', '--help'], { env });
  return `${help.stdout}${help.stderr}`.includes('--accept-capabilities')
    ? ['--accept-capabilities']
    : [];
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
}

function firstVersion(text: string, label: string): string {
  const match = text.match(/\b(\d{4}\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)\b/i);
  if (!match?.[1]) throw new Error(`${label} version output was not recognized.`);
  return match[1];
}

function expectExact(actual: string[] | undefined, expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} drifted from the positive allowlist.`);
  }
}

function requiredContainedPath(value: string | undefined, parent: string, label: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${label} is missing or not absolute.`);
  // macOS may spell the same temporary directory as /var/... to this process
  // and /private/var/... to a child process. Compare real filesystem identities
  // so that path aliases neither create a false escape nor bypass containment.
  const child = realpathSync(resolve(value));
  const root = realpathSync(resolve(parent));
  if (child !== root && !child.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escaped the isolated OpenClaw state directory.`);
  }
  return child;
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist.`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
}
