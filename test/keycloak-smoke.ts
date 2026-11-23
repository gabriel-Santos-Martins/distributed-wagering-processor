// End-to-end check against a real Keycloak with the "wagering" realm: bun run test:keycloak
// Needs the API running with AUTH_MODE=oidc and OIDC_ISSUER pointing at the same realm.
//   KEYCLOAK_REALM_URL  default http://localhost:8080/realms/wagering
//   API_URL             default http://127.0.0.1:3000
import { randomUUID } from 'node:crypto';

const realm = process.env.KEYCLOAK_REALM_URL ?? 'http://localhost:8080/realms/wagering';
const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
// Development-only secrets from docker/keycloak/wagering-realm.json.
const clients = {
  providerA: ['provider-a', 'provider-a-local-secret'],
  providerB: ['provider-b', 'provider-b-local-secret'],
  backOffice: ['back-office', 'back-office-local-secret'],
} as const;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function clientToken([clientId, clientSecret]: readonly [string, string]): Promise<string> {
  const response = await fetch(`${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`${clientId}: token endpoint responded ${response.status}`);
  return (await response.json() as { access_token: string }).access_token;
}

async function call(path: string, token?: string, body?: unknown, key?: string) {
  const response = await fetch(api + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function main() {
  const [providerA, providerB, backOffice] = await Promise.all(
    [clients.providerA, clients.providerB, clients.backOffice].map(clientToken));
  const claims = JSON.parse(Buffer.from(providerA.split('.')[1], 'base64url').toString());
  check('provider-a token carries issuer, audience, provider_id and the provider role',
    claims.iss === realm && [claims.aud].flat().includes('wagering-api') && claims.provider_id === 'provider-a' &&
    claims.realm_access?.roles?.includes('provider'), claims);

  check('health is open', (await call('/health/live')).status === 200);
  check('no token: 401', (await call('/wallets', undefined, {})).status === 401);

  const playerId = randomUUID();
  const walletBody = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };
  check('provider cannot open wallets: 403', (await call('/wallets', providerA, walletBody)).status === 403);
  const wallet = await call('/wallets', backOffice, walletBody);
  check('back office opens a wallet: 201', wallet.status === 201, wallet);

  const externalTransactionId = `kc-${randomUUID()}`;
  const wager = { providerId: 'provider-a', externalTransactionId, playerId, walletId: wallet.body.id,
    roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } };
  const key = `provider-a:${externalTransactionId}`;
  const own = await call('/wagering/transactions', providerA, wager, key);
  check('provider-a submits for provider-a: 200', own.status === 200 && own.body.status === 'PROCESSED', own);
  const foreign = await call('/wagering/transactions', providerB, { ...wager, externalTransactionId: `${externalTransactionId}-b` }, `${key}-b`);
  check('provider-b submits for provider-a: 403 PROVIDER_MISMATCH', foreign.status === 403 &&
    foreign.body.error === 'PROVIDER_MISMATCH', foreign);
  check('back office cannot submit: 403', (await call('/wagering/transactions', backOffice,
    { ...wager, externalTransactionId: `${externalTransactionId}-o` }, `${key}-o`)).status === 403);

  const id = own.body.transactionId;
  check('provider-a reads its transaction: 200', (await call(`/wagering/transactions/${id}`, providerA)).status === 200);
  check('provider-b reads it: 404', (await call(`/wagering/transactions/${id}`, providerB)).status === 404);
  check('back office reads the wallet: 90.00', (await call(`/wallets/${wallet.body.id}`, backOffice)).body.balance?.amount === '90.00');
  check('reconciliation is consistent', (await call(`/wallets/${wallet.body.id}/reconciliation`, backOffice, {})).body.consistent === true);

  console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
