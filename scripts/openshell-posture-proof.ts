import {
  assertOpenShellPosturePass,
  createReferenceOpenShellPostureProof,
} from '../src/core/openshell-posture.ts';

export async function runOpenShellPostureProof(): Promise<ReturnType<typeof createReferenceOpenShellPostureProof>> {
  const proof = createReferenceOpenShellPostureProof();
  assertOpenShellPosturePass(proof);
  return proof;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun scripts/openshell-posture-proof.ts');
    console.log('');
    console.log('Prints the Olympus OpenShell posture contract proof for normal agent sessions.');
    return;
  }

  const result = await runOpenShellPostureProof();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
