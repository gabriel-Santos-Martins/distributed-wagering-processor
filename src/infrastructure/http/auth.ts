import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../../domain';
import { IdentityProviderUnavailableError, InvalidTokenError, OidcTokenVerifier, type Principal } from './oidc';

export const Role = { Provider: 'provider', Operator: 'operator' } as const;
export type Role = typeof Role[keyof typeof Role];

const publicKey = 'auth:public';
const rolesKey = 'auth:roles';
/** Health checks stay open, as the challenge requires. */
export const Public = () => SetMetadata(publicKey, true);
/** The caller needs at least one of these realm roles. */
export const Roles = (...roles: Role[]) => SetMetadata(rolesKey, roles);

export type AuthSettings =
  | { mode: 'oidc'; verifier: OidcTokenVerifier }
  | { mode: 'disabled' };

/**
 * AUTH_MODE=oidc (default) validates Keycloak access tokens; it needs OIDC_ISSUER and OIDC_AUDIENCE, and takes
 * OIDC_JWKS_URI (default: Keycloak's certs endpoint under the issuer) and OIDC_PROVIDER_CLAIM (default provider_id).
 * AUTH_MODE=disabled is for local tests only: every request runs as an unrestricted operator.
 */
export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const mode = env.AUTH_MODE ?? 'oidc';
  if (mode === 'disabled') return { mode };
  if (mode !== 'oidc') throw new Error(`AUTH_MODE must be oidc or disabled, got ${mode}`);
  const issuer = env.OIDC_ISSUER;
  const audience = env.OIDC_AUDIENCE;
  if (!issuer || !audience) throw new Error('AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_AUDIENCE');
  return {
    mode,
    verifier: new OidcTokenVerifier({
      issuer,
      audience,
      jwksUri: env.OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
      providerClaim: env.OIDC_PROVIDER_CLAIM ?? 'provider_id',
      clockToleranceSeconds: 5,
    }),
  };
}

/** Principal used when authentication is disabled: no provider binding, every role. */
const unrestricted: Principal = { subject: 'auth-disabled', roles: new Set(Object.values(Role)) };

type AuthenticatedRequest = { headers: Record<string, string | string[] | undefined>; principal?: Principal };

export function principalOf(request: AuthenticatedRequest): Principal {
  if (!request.principal) throw new Error('Route reached without authentication');
  return request.principal;
}

/** Global guard: authenticates the bearer token, then checks the route's roles. */
export const AUTH_SETTINGS = Symbol('AuthSettings');

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(publicKey, targets)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.principal = this.settings.mode === 'disabled' ? unrestricted : await this.authenticate(request);
    const required = this.reflector.getAllAndOverride<Role[]>(rolesKey, targets) ?? [];
    if (required.length && !required.some(role => request.principal!.roles.has(role))) {
      throw new DomainError('FORBIDDEN', 403);
    }
    return true;
  }

  private async authenticate(request: AuthenticatedRequest): Promise<Principal> {
    if (this.settings.mode !== 'oidc') throw new Error('OIDC is not configured');
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([\w.-]+)$/i.exec(header) : null;
    if (!match) throw new DomainError('UNAUTHENTICATED', 401);
    try {
      return await this.settings.verifier.verify(match[1]);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw new DomainError('UNAUTHENTICATED', 401);
      if (error instanceof IdentityProviderUnavailableError) throw new DomainError('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      throw error;
    }
  }
}

/**
 * A provider acts only for the provider in its token. An operator, or any caller when authentication is
 * disabled, is not bound to a provider.
 */
export function canActForProvider(principal: Principal, providerId: string): boolean {
  if (principal.roles.has(Role.Operator)) return true;
  return principal.roles.has(Role.Provider) && principal.providerId === providerId;
}

/** Submitting is a provider action: the token's provider claim must name the provider in the payload. */
export function assertCanSubmitFor(principal: Principal, providerId: string): void {
  if (principal === unrestricted) return;
  if (!principal.roles.has(Role.Provider) || principal.providerId !== providerId) {
    throw new DomainError('PROVIDER_MISMATCH', 403);
  }
}
