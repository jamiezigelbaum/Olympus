import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../../src/core/public-surface.ts';

export interface VerifiedQualificationArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export function verifyQualificationArtifact(pathValue: string, expected: { artifact_sha256: string; artifact_bytes: number }): VerifiedQualificationArtifact {
  const path = resolve(pathValue);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Qualification artifact must be a regular file.');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const bytes = statSync(path).size;
  if (sha256 !== expected.artifact_sha256 || bytes !== expected.artifact_bytes) throw new Error('Qualification artifact does not match the exact plan identity.');
  const inventory = capture(['tar', '-tzf', path]).trim().split('\n').filter((line) => line && !line.endsWith('/')).map((line) => line.replace(/^package\//, '')).sort();
  if (JSON.stringify(inventory) !== JSON.stringify([...V0_4_PUBLIC_PACKAGE_FILES].sort())) throw new Error('Qualification artifact inventory is not the exact public allowlist.');
  const packageJson = JSON.parse(capture(['tar', '-xOf', path, 'package/package.json'])) as { name?: string; version?: string; private?: boolean };
  if (packageJson.name !== 'olympus' || packageJson.version !== '0.4.0' || packageJson.private === true) throw new Error('Qualification artifact package identity is invalid.');
  return { path, sha256, bytes };
}

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed.`);
  return result.stdout.toString();
}
