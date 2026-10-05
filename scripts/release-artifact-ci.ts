import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_GOOGLE_PILOT_CLIENT_ID } from '../src/core/google-pilot-client.ts';
import { GOOGLE_PILOT_CLIENT_MISSING_MESSAGE, releaseGooglePilotChoice } from './release-google-pilot-choice.ts';
import { V0_4_PUBLIC_PACKAGE_BUILD_READY } from '../src/core/public-surface.ts';

const rootDir = join(import.meta.dir, '..');
const notReadyMessage = 'Public artifact creation is fail-closed until Slice 3D builds public-only runtime entrypoints and proves zero private bytes.';
const publisherClientMissingMessage = GOOGLE_PILOT_CLIENT_MISSING_MESSAGE;
// The builder's own resolution, so this gate and the builder agree on what
// counts as a decision: a Desktop client id (env or source), or an explicit
// OLYMPUS_GOOGLE_PILOT_CLIENT_ID=none. Anything else must refuse.
const publisherClientPresent = releaseGooglePilotChoice(
  process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID,
  DEFAULT_GOOGLE_PILOT_CLIENT_ID,
) !== undefined;

if (V0_4_PUBLIC_PACKAGE_BUILD_READY && publisherClientPresent) {
  runReleaseArtifact('inherit');
  publishReady(true);
  console.log('Public release artifact is ready and was built successfully.');
} else {
  const result = runReleaseArtifact('pipe');
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const expectedRefusal = V0_4_PUBLIC_PACKAGE_BUILD_READY
    ? publisherClientMissingMessage
    : notReadyMessage;
  if (result.status === 0 || !output.includes(expectedRefusal)) {
    throw new Error('The not-ready release gate did not fail with its exact fail-closed refusal.');
  }
  const artifactDir = join(rootDir, 'release-artifacts');
  const tarballs = existsSync(artifactDir)
    ? readdirSync(artifactDir).filter((name) => name.endsWith('.tgz'))
    : [];
  if (tarballs.length > 0) {
    throw new Error(`The not-ready release gate left package tarballs behind: ${tarballs.join(', ')}.`);
  }
  publishReady(false);
  console.log(V0_4_PUBLIC_PACKAGE_BUILD_READY
    ? 'Public release artifact awaits a Google Desktop client decision (an id, or none); exact fail-closed refusal proved.'
    : 'Public release artifact remains intentionally not ready; exact fail-closed refusal proved.');
}

function runReleaseArtifact(stdio: 'inherit' | 'pipe') {
  const result = spawnSync('bun', ['run', 'release:artifact'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (stdio === 'inherit' && result.status !== 0) {
    throw new Error(`Release artifact build failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return result;
}

function publishReady(ready: boolean): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) appendFileSync(outputPath, `ready=${ready}\n`);
}
