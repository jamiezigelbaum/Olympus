import { writeResourceWikiProof } from '../src/core/resource-wiki.ts';
import { resolveResourceWikiVaultRoot } from './resource-wiki-vault-root.ts';

export interface ResourceWikiCompileProofCliOptions {
  resetVault: boolean;
}

export function parseResourceWikiCompileProofArgs(args: string[]): ResourceWikiCompileProofCliOptions {
  const allowed = new Set(['--reset-vault']);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`Unknown Resource Wiki proof flag: ${arg}`);
    }
  }

  return {
    resetVault: args.includes('--reset-vault'),
  };
}

export async function runResourceWikiCompileProofCli(args = Bun.argv.slice(2)): Promise<void> {
  const options = parseResourceWikiCompileProofArgs(args);
  const result = await writeResourceWikiProof({
    vaultRoot: resolveResourceWikiVaultRoot(),
    resetVault: options.resetVault,
  });

  console.log(JSON.stringify({
    proof_id: 'resource-wiki.compile-proof',
    vault_root: result.vaultRoot,
    reset_vault: options.resetVault,
    pages_written: result.pages.map((page) => page.path),
    log_written: result.log.path,
  }, null, 2));
}

if (import.meta.main) {
  runResourceWikiCompileProofCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
