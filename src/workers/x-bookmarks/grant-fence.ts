import {
  requireBearerTokenCredentialSession,
  type CredentialBroker,
} from '../credential-broker/index.ts';

/**
 * The X credential was reconnected while this run held the previous grant's
 * token. The broker stops serving a replaced grant's token, but one already
 * handed out still works at X, so every X lane that takes a token checks the
 * grant after each provider answer and before anything reaches a store or a
 * report, as the Dropbox, Drive and Gmail lanes do (PR #254). Nothing read
 * under the old grant is kept; the next run starts under the new one.
 */
export class XBookmarksGrantChangedError extends Error {
  readonly code = 'x_bookmarks_grant_changed';

  constructor() {
    super('The X bookmarks credential was reconnected during this run; nothing from the previous grant was stored.');
    this.name = 'XBookmarksGrantChangedError';
  }
}

export interface GrantFencedXSession {
  token: string;
  /**
   * Throws XBookmarksGrantChangedError unless the grant the token came from
   * is still the connected one. A no-op for a broker that records no grant
   * generation.
   */
  assertGrantCurrent(): void;
}

/** Issue the X bookmarks token together with the fence for its grant. */
export async function issueGrantFencedXSession(input: {
  broker: CredentialBroker;
  credentialHandle: string;
  purpose: string;
}): Promise<GrantFencedXSession> {
  const { broker, credentialHandle } = input;
  // Read before and after the issue: unchanged across it means the token
  // belongs to that generation (the broker serves only the current grant's).
  const generation = broker.grantGeneration?.(credentialHandle);
  const session = requireBearerTokenCredentialSession(await broker.issueSession({
    handle: credentialHandle,
    provider: 'x',
    capability: 'x.bookmarks.sync',
    trustDomain: 'internal',
    purpose: input.purpose,
  }), credentialHandle);
  const assertGrantCurrent = (): void => {
    if (broker.grantGeneration && broker.grantGeneration(credentialHandle) !== generation) {
      throw new XBookmarksGrantChangedError();
    }
  };
  assertGrantCurrent();
  return { token: session.token, assertGrantCurrent };
}
