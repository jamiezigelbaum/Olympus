import { PUBLIC_RUNTIME_BUILD } from './build-flavor.ts';
import type { ConnectedCredentialHandle } from '../workers/credential-broker/connected-handles.ts';

/** Private delegated grants have no issuer in the public package. OAuth/token-backed grants still work. */
export function isRetiredGoogleHandle(handle: ConnectedCredentialHandle, publicBuild = PUBLIC_RUNTIME_BUILD): boolean {
  return publicBuild
    && ((handle.provider === 'gmail' && handle.handle === 'gmail.personal.delegated')
      || (handle.provider === 'google_drive' && handle.handle === 'google_drive.personal.delegated'))
    && handle.oauth2Refresh === undefined
    && (handle.tokenSecretRefs?.length ?? 0) === 0;
}
