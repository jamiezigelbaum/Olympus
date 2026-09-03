import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

export interface CiArtifactReceipt {
  kind: 'olympus_ci_artifact_receipt';
  schemaVersion: 1;
  sourceCommit: string;
  sourceTree: string;
  dependencyLockSha256: string;
  workflowSha256: string;
  artifact: {
    name: string;
    sha256: string;
    bytes: number;
  };
  build: {
    repository: string;
    runId: string;
    runAttempt: string;
    workflowRef: string;
  };
  createdAt: string;
}

export function createArtifactReceipt(root: string, artifactPath: string): CiArtifactReceipt {
  const absoluteArtifact = resolve(root, artifactPath);
  return {
    kind: 'olympus_ci_artifact_receipt',
    schemaVersion: 1,
    sourceCommit: git(root, ['rev-parse', 'HEAD']),
    sourceTree: git(root, ['rev-parse', 'HEAD^{tree}']),
    dependencyLockSha256: sha256(join(root, 'bun.lock')),
    workflowSha256: sha256(join(root, '.github/workflows/verify.yml')),
    artifact: {
      name: basename(absoluteArtifact),
      sha256: sha256(absoluteArtifact),
      bytes: statSync(absoluteArtifact).size,
    },
    build: {
      repository: process.env.GITHUB_REPOSITORY ?? 'local',
      runId: process.env.GITHUB_RUN_ID ?? 'local',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? 'local',
      workflowRef: process.env.GITHUB_WORKFLOW_REF ?? 'local',
    },
    createdAt: new Date().toISOString(),
  };
}

export function verifyArtifactReceipt(
  root: string,
  artifactPath: string,
  receipt: CiArtifactReceipt,
  options: { requireCurrentTree?: boolean } = {},
): void {
  if (receipt.kind !== 'olympus_ci_artifact_receipt' || receipt.schemaVersion !== 1) {
    throw new Error('Unsupported CI artifact receipt.');
  }
  const absoluteArtifact = resolve(root, artifactPath);
  if (receipt.artifact.name !== basename(absoluteArtifact)) throw new Error('Artifact name mismatch.');
  if (receipt.artifact.bytes !== statSync(absoluteArtifact).size) throw new Error('Artifact size mismatch.');
  if (receipt.artifact.sha256 !== sha256(absoluteArtifact)) throw new Error('Artifact digest mismatch.');
  if (options.requireCurrentTree && receipt.sourceTree !== git(root, ['rev-parse', 'HEAD^{tree}'])) {
    throw new Error('Source tree mismatch.');
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const root = join(fileURLToPath(new URL('..', import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8')) as { version: string };
  const artifact = argument('--artifact') ?? `release-artifacts/olympus-${manifest.version}.tgz`;
  const output = argument('--output');
  const verify = argument('--verify');
  if (verify) {
    const receipt = JSON.parse(readFileSync(resolve(root, verify), 'utf8')) as CiArtifactReceipt;
    verifyArtifactReceipt(root, artifact, receipt, {
      requireCurrentTree: process.argv.includes('--require-current-tree'),
    });
    console.log(`Verified ${receipt.artifact.name} against ${verify}.`);
  } else {
    if (!output) throw new Error('--output is required when creating a receipt.');
    const receipt = createArtifactReceipt(root, artifact);
    const outputPath = resolve(root, output);
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Wrote ${outputPath}`);
  }
}
