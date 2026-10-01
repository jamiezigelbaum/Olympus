/**
 * The routable credential grammar shared by the relay (which routes on it) and
 * the engine (which mints and verifies it). Every credential names the install
 * that minted it, so the relay can route a request without storing anything:
 *
 *   access token         oly2.<installId>.<secret>
 *   refresh token        oly2r.<installId>.<secret>
 *   authorization code   oly2c.<installId>.<secret>
 *
 * `<secret>` is 32 random bytes, base64url (43 characters). The relay never
 * validates the secret; the engine does, against its own database, so a token
 * minted by install B and presented to install A opens nothing at A.
 */
import { randomBytes } from 'node:crypto';

export type CredentialKind = 'access' | 'refresh' | 'code';

const PREFIX: Record<CredentialKind, string> = { access: 'oly2', refresh: 'oly2r', code: 'oly2c' };
const SECRET = '[A-Za-z0-9_-]{43}';
const INSTALL = '[a-z2-7]{32}';
const PATTERN: Record<CredentialKind, RegExp> = {
  access: new RegExp(`^oly2\\.(${INSTALL})\\.${SECRET}$`),
  refresh: new RegExp(`^oly2r\\.(${INSTALL})\\.${SECRET}$`),
  code: new RegExp(`^oly2c\\.(${INSTALL})\\.${SECRET}$`),
};

export function mintCredential(kind: CredentialKind, installId: string): string {
  return `${PREFIX[kind]}.${installId}.${randomBytes(32).toString('base64url')}`;
}

/** The install a well-formed credential of `kind` names, or undefined. */
export function credentialInstallId(kind: CredentialKind, value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  return PATTERN[kind].exec(value)?.[1];
}

export function isCredential(kind: CredentialKind, value: string): boolean {
  return credentialInstallId(kind, value) !== undefined;
}
