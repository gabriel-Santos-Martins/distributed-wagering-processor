import { createPublicKey, verify, type KeyObject } from 'node:crypto';

type Jwk = { kty?: string; kid?: string; use?: string; n?: string; e?: string };

/** Authenticated caller, built from a verified access token. */
export interface Principal {
  subject: string;
  clientId?: string;
  /** Provider the caller may act for; absent for callers that are not bound to a provider. */
  providerId?: string;
  roles: ReadonlySet<string>;
}

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Token claim that binds the caller to one provider. */
  providerClaim: string;
  /** Tolerated clock difference for exp and nbf. */
  clockToleranceSeconds: number;
}

/** The token is missing, malformed, expired, for another issuer or audience, or its signature does not verify. */
export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}

/** The signing keys could not be fetched. A token cannot be judged, so the caller may retry. */
export class IdentityProviderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Identity provider keys are unavailable', { cause });
    this.name = 'IdentityProviderUnavailableError';
  }
}

const jwksTtlMs = 10 * 60_000;
const unknownKidRefreshMs = 30_000;

/** Signing keys from the JWKS endpoint, cached and refreshed when an unknown key id appears (key rotation). */
class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private pending?: Promise<void>;

  constructor(private readonly uri: string) {}

  async key(kid: string): Promise<KeyObject | undefined> {
    const now = Date.now();
    if (now - this.fetchedAt > jwksTtlMs) await this.refresh();
    else if (!this.keys.has(kid) && now - this.fetchedAt > unknownKidRefreshMs) await this.refresh();
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.pending ??= this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(): Promise<void> {
    let body: { keys?: Jwk[] };
    try {
      const response = await fetch(this.uri, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`JWKS responded ${response.status}`);
      body = await response.json() as typeof body;
    } catch (error) {
      throw new IdentityProviderUnavailableError(error);
    }
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e || (jwk.use && jwk.use !== 'sig')) continue;
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
    }
    this.keys = keys;
    this.fetchedAt = Date.now();
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new InvalidTokenError('malformed token');
  }
}

/**
 * Verifies RS256 access tokens issued by an OIDC provider such as Keycloak: signature against the JWKS,
 * issuer, audience, expiry and not-before. Uses node:crypto only.
 */
export class OidcTokenVerifier {
  private readonly jwks: JwksCache;

  constructor(private readonly config: OidcConfig) {
    this.jwks = new JwksCache(config.jwksUri);
  }

  async verify(token: string): Promise<Principal> {
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some(segment => !/^[\w-]+$/.test(segment))) {
      throw new InvalidTokenError('malformed token');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const header = decodeSegment(encodedHeader);
    // Only RS256: rejects "none" and HMAC algorithms that would accept the public key as a secret.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new InvalidTokenError('unsupported algorithm');
    const key = await this.jwks.key(header.kid);
    if (!key) throw new InvalidTokenError('unknown signing key');
    const signed = verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key, Buffer.from(encodedSignature, 'base64url'));
    if (!signed) throw new InvalidTokenError('invalid signature');

    const claims = decodeSegment(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    const tolerance = this.config.clockToleranceSeconds;
    if (claims.iss !== this.config.issuer) throw new InvalidTokenError('unexpected issuer');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.config.audience)) throw new InvalidTokenError('unexpected audience');
    if (typeof claims.exp !== 'number' || claims.exp + tolerance <= now) throw new InvalidTokenError('expired token');
    if (typeof claims.nbf === 'number' && claims.nbf - tolerance > now) throw new InvalidTokenError('token not yet valid');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new InvalidTokenError('missing subject');

    const realmAccess = claims.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realmAccess?.roles)
      ? realmAccess.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const providerId = claims[this.config.providerClaim];
    return {
      subject: claims.sub,
      clientId: typeof claims.azp === 'string' ? claims.azp : undefined,
      providerId: typeof providerId === 'string' && providerId ? providerId : undefined,
      roles: new Set(roles),
    };
  }
}
