// Oathweave resource authentication through the shared suite verifier; Apache-2.0.
import {
  createOathweaveVerifier,
  OathweaveError,
  type OathweaveVerifierOptions,
} from '@hivemagnus/hive-common/oathweave';

export const OATHWEAVE_AUDIENCE = 'hiveskills';

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience: string;
}
export interface OathweaveIdentity {
  subject: string;
  issuer: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  displayName: string;
  /** Epoch seconds of the last interactive sign-in, when the token carries `auth_time`. */
  authTime?: number;
}

/**
 * Resource JWT validation plus online session revocation. Failure is closed.
 *
 * The shared verifier is configured to keep this registry's historical rules: no clock
 * tolerance, a userinfo check on every request (no session cache), user principals only,
 * and a mandatory `roles` array and camel-case `clientId` claim.
 */
export function createIdentityVerifier(
  options: OathweaveOptions,
  overrides: Pick<OathweaveVerifierOptions, 'keys' | 'fetch' | 'now'> = {},
) {
  const verifier = createOathweaveVerifier({
    issuer: options.issuer,
    audience: options.audience,
    jwksUrl: options.jwksUrl,
    userinfoUrl: options.userinfoUrl,
    accept: 'user',
    clockToleranceSec: 0,
    sessionCacheTtlMs: 0,
    ...overrides,
  });
  return async (token: string): Promise<OathweaveIdentity> => {
    const principal = await verifier.verifyUser(token);
    // The shared verifier treats an absent `roles` claim as no roles and also accepts
    // RFC 9068 `client_id`; this registry has always required both claims as issued.
    if (!Array.isArray(principal.claims.roles) || typeof principal.claims.clientId !== 'string')
      throw new OathweaveError('invalid_claims');
    return {
      subject: principal.subject,
      issuer: principal.issuer,
      sessionId: principal.sessionId,
      permissions: [...principal.permissions],
      roles: [...principal.roles],
      displayName: principal.displayName,
      ...(principal.authTime === undefined ? {} : { authTime: principal.authTime }),
    };
  };
}

let verifier: ReturnType<typeof createIdentityVerifier> | undefined;
export function configuredOathweaveVerifier() {
  if (
    !process.env.OATHWEAVE_ISSUER &&
    !process.env.OATHWEAVE_JWKS_URL &&
    !process.env.OATHWEAVE_USERINFO_URL
  )
    return undefined;
  if (!verifier) {
    if (
      !process.env.OATHWEAVE_ISSUER ||
      !process.env.OATHWEAVE_JWKS_URL ||
      !process.env.OATHWEAVE_USERINFO_URL
    )
      throw new Error('Oathweave configuration is incomplete');
    verifier = createIdentityVerifier({
      issuer: process.env.OATHWEAVE_ISSUER,
      jwksUrl: process.env.OATHWEAVE_JWKS_URL,
      userinfoUrl: process.env.OATHWEAVE_USERINFO_URL,
      audience: OATHWEAVE_AUDIENCE,
    });
  }
  return verifier;
}
