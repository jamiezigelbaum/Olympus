const CANONICAL_PROVIDER = /^[a-z0-9][a-z0-9_-]*$/;
const CANONICAL_ACCOUNT_SCOPE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;

export function isCanonicalConnectorStoreProvider(provider: string): boolean {
  return provider === provider.trim() && CANONICAL_PROVIDER.test(provider);
}

export function isCanonicalConnectorStoreAccountScope(accountScope: string): boolean {
  return accountScope === accountScope.trim() && CANONICAL_ACCOUNT_SCOPE.test(accountScope);
}

export function canonicalConnectorStoreChatPrincipal(
  provider: unknown,
  accountScope: unknown,
): { provider: string; accountScope: string } {
  if (typeof provider !== 'string' || typeof accountScope !== 'string' || !provider || !accountScope) {
    throw new Error('Connector store principalProvider and principalAccountScope must be non-empty strings.');
  }
  if (!isCanonicalConnectorStoreProvider(provider)) {
    throw new Error(
      'Connector store principalProvider must be a canonical lowercase provider id with no whitespace.',
    );
  }
  if (!isCanonicalConnectorStoreAccountScope(accountScope)) {
    throw new Error(
      'Connector store principalAccountScope must be a canonical lowercase account scope with no whitespace.',
    );
  }
  const providerPrefix = accountScope.includes('.') ? accountScope.split('.', 1)[0] : undefined;
  if (providerPrefix !== undefined && providerPrefix !== provider) {
    throw new Error(
      'Connector store principalAccountScope provider prefix must match principalProvider.',
    );
  }
  return { provider, accountScope };
}
