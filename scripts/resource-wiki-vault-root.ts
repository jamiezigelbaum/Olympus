export const RESOURCE_WIKI_VAULT_ENV_VAR = 'OLYMPUS_RESOURCE_WIKI_VAULT';

/**
 * The Resource Wiki compiles into an operator-owned Obsidian vault. The path is
 * installation-specific, so it is read from the environment rather than carried
 * as a committed default.
 */
export function resolveResourceWikiVaultRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const vaultRoot = env[RESOURCE_WIKI_VAULT_ENV_VAR]?.trim();
  if (!vaultRoot) {
    throw new Error(
      `${RESOURCE_WIKI_VAULT_ENV_VAR} is not set. Set it to the absolute path of the Obsidian vault the Resource Wiki should compile into.`,
    );
  }
  return vaultRoot;
}
