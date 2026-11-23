// Authentication without Keycloak: tokens are signed here with RSA keys and validated against a JWKS served by
// this test, exactly as the API validates Keycloak tokens. The HTTP part starts the compiled API with
// AUTH_MODE=oidc and needs DATABASE_URL (a disposable database) and a prior `bun run build`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { authSettingsFromEnv } from '../src/infrastructure/http/auth';
import { IdentityProviderUnavailableError, InvalidTokenError, OidcTokenVerifier } from '../src/infrastructure/http/oidc';
import { dto } from './support';

const issuer = 'http://issuer.test/realms/wagering';
const audience = 'wagering-api';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const intruder = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'test-key';

const jwks = Bun.serve({
  port: 0,
  fetch: () => Response.json({ keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] }),
});
const jwksUri = `http://127.0.0.1:${jwks.port}/certs`;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims: Record<string, unknown> = {}, options: { key?: KeyObject; kid?: string; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: options.alg ?? 'RS256', typ: 'JWT', kid: options.kid ?? kid });
  const payload = encode({ iss: issuer, aud: audience, sub: randomUUID(), azp: 'client', iat: now, exp: now + 300,
    ...claims });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), options.key ?? signing.privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}
const provider = (providerId: string) => token({ provider_id: providerId, realm_access: { roles: ['provider'] } });
const operator = () => token({ realm_access: { roles: ['operator'] } });
const verifier = () => new OidcTokenVerifier({ issuer, audience, jwksUri, providerClaim: 'provider_id',
  clockToleranceSeconds: 5 });

afterAll(() => jwks.stop(true));

describe('OidcTokenVerifier', () => {
  test('accepts a valid token and maps subject, client, provider and realm roles', async () => {
    const principal = await verifier().verify(token({ sub: 'svc-1', azp: 'provider-a', provider_id: 'provider-a',
      aud: ['account', audience], realm_access: { roles: ['provider', 'offline_access'] } }));
    expect(principal).toMatchObject({ subject: 'svc-1', clientId: 'provider-a', providerId: 'provider-a' });
    expect([...principal.roles]).toEqual(['provider', 'offline_access']);
  });

  test.each([
    ['expired', () => token({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ['not yet valid', () => token({ nbf: Math.floor(Date.now() / 1000) + 60 })],
    ['another issuer', () => token({ iss: 'http://evil.test/realms/wagering' })],
    ['another audience', () => token({ aud: 'account' })],
    ['no subject', () => token({ sub: '' })],
    ['signed by another key', () => token({}, { key: intruder.privateKey })],
    ['unknown key id', () => token({}, { kid: 'other' })],
    ['alg none', () => `${encode({ alg: 'none', kid })}.${encode({ iss: issuer, aud: audience, sub: 'x', exp: 9e9 })}.`],
    ['HS256 with the public key as secret', () => {
      const header = encode({ alg: 'HS256', kid });
      const payload = encode({ iss: issuer, aud: audience, sub: 'x', exp: 9e9 });
      const secret = signing.publicKey.export({ format: 'pem', type: 'spki' });
      return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
    }],
    ['tampered payload', () => {
      const [header, , signature] = token().split('.');
      return `${header}.${encode({ iss: issuer, aud: audience, sub: 'x', exp: 9e9, realm_access: { roles: ['operator'] } })}.${signature}`;
    }],
    ['not a JWT', () => 'abc'],
  ])('rejects a token that is %s', async (_case, make) => {
    await expect(verifier().verify(make())).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('an unreachable JWKS is an identity provider outage, not an invalid token', async () => {
    const offline = new OidcTokenVerifier({ issuer, audience, jwksUri: 'http://127.0.0.1:9/certs',
      providerClaim: 'provider_id', clockToleranceSeconds: 5 });
    await expect(offline.verify(token())).rejects.toBeInstanceOf(IdentityProviderUnavailableError);
  });

  test('configuration: oidc is the default and needs issuer and audience', () => {
    expect(() => authSettingsFromEnv({})).toThrow('OIDC_ISSUER');
    expect(() => authSettingsFromEnv({ AUTH_MODE: 'off' })).toThrow('AUTH_MODE');
    expect(authSettingsFromEnv({ AUTH_MODE: 'disabled' }).mode).toBe('disabled');
    expect(authSettingsFromEnv({ OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience }).mode).toBe('oidc');
  });
});

const database = process.env.DATABASE_URL ? describe : describe.skip;
database('HTTP authorization with AUTH_MODE=oidc', () => {
  const port = 34301;
  const base = `http://127.0.0.1:${port}`;
  let child: ReturnType<typeof Bun.spawn>;

  const call = async (path: string, bearer?: string, body?: unknown, key?: string) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };

  beforeAll(async () => {
    child = Bun.spawn([process.execPath, 'dist/main.js'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DISABLE_WORKERS: '1', AUTH_MODE: 'oidc',
        OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience, OIDC_JWKS_URI: jwksUri },
      stdout: 'ignore', stderr: 'inherit',
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/health/live')).ok) return; } catch { /* starting */ }
      await Bun.sleep(100);
    }
    throw new Error('API did not start');
  }, 20000);
  afterAll(async () => { child?.kill(); await child?.exited; });

  test('health stays open; protected routes need a valid bearer token', async () => {
    expect((await call('/health/live')).status).toBe(200);
    const missing = await call('/wallets', undefined, {});
    expect(missing).toMatchObject({ status: 401, body: { error: 'UNAUTHENTICATED' } });
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await call('/wallets', 'not.a.token', {})).status).toBe(401);
    expect((await call('/wallets', token({ exp: 1 }), {})).status).toBe(401);
  });

  test('roles and provider binding decide what each caller can do', async () => {
    const playerId = randomUUID();
    const body = { playerId, initialBalance: dto('100') };
    expect(await call('/wallets', provider('provider-a'), body)).toMatchObject({ status: 403, body: { error: 'FORBIDDEN' } });
    const wallet = await call('/wallets', operator(), body);
    expect(wallet.status).toBe(201);
    const providerA = `provider-a-${randomUUID()}`;
    const wager = (providerId: string, externalTransactionId: string) => ({ providerId, externalTransactionId, playerId,
      walletId: wallet.body.id, roundId: 'round', gameId: 'game', kind: 'BET', money: dto('10') });

    const own = await call('/wagering/transactions', provider(providerA), wager(providerA, 'bet-1'), 'bet-1');
    expect(own).toMatchObject({ status: 200, body: { status: 'PROCESSED' } });
    expect(await call('/wagering/transactions', provider('provider-b'), wager(providerA, 'bet-2'), 'bet-2'))
      .toMatchObject({ status: 403, body: { error: 'PROVIDER_MISMATCH' } });
    expect(await call('/wagering/transactions', operator(), wager(providerA, 'bet-3'), 'bet-3'))
      .toMatchObject({ status: 403, body: { error: 'FORBIDDEN' } });

    const id = own.body.transactionId;
    expect((await call(`/wagering/transactions/${id}`, provider(providerA))).status).toBe(200);
    expect((await call(`/wagering/transactions/${id}`, provider('provider-b'))).status).toBe(404);
    expect((await call(`/wagering/transactions/${id}`, operator())).status).toBe(200);
    expect((await call(`/providers/${providerA}/wagering/transactions/bet-1`, provider(providerA))).status).toBe(200);
    expect(await call(`/providers/${providerA}/wagering/transactions/bet-1`, provider('provider-b')))
      .toMatchObject({ status: 403, body: { error: 'PROVIDER_MISMATCH' } });

    expect((await call(`/wallets/${wallet.body.id}`, provider(providerA))).status).toBe(403);
    expect(await call(`/wallets/${wallet.body.id}`, operator())).toMatchObject({ status: 200,
      body: { balance: dto('90.00') } });
    expect((await call(`/wallets/${wallet.body.id}/reconciliation`, operator(), {})).body.consistent).toBe(true);
  });
});
