// Load test against running instances: bun run test:load
//
// Creates funded wallets, then keeps LOAD_CONCURRENCY clients submitting transactions for LOAD_DURATION_SECONDS.
// A share of the traffic targets one hot wallet and a share repeats an earlier request (idempotent replay).
// Reports throughput, latency percentiles, status mix, lock conflicts, outbox lag and final reconciliation.
import { randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const targets = env('LOAD_TARGETS', 'http://127.0.0.1:3000').split(',').map(url => url.trim().replace(/\/$/, ''));
const walletCount = Number(env('LOAD_WALLETS', '50'));
const concurrency = Number(env('LOAD_CONCURRENCY', '32'));
const durationSeconds = Number(env('LOAD_DURATION_SECONDS', '30'));
const hotWalletShare = Number(env('LOAD_HOT_WALLET_SHARE', '0.2'));
const duplicateShare = Number(env('LOAD_DUPLICATE_SHARE', '0.05'));
// With LOAD_TOKEN_URL (the realm token endpoint), requests carry Keycloak tokens from the client credentials grant:
// the operator client opens and reconciles wallets, the provider client submits transactions for its provider id.
const tokenUrl = process.env.LOAD_TOKEN_URL;
const operatorClient = env('LOAD_OPERATOR_CLIENT', 'back-office:back-office-local-secret');
const providerClient = env('LOAD_PROVIDER_CLIENT', 'provider-a:provider-a-local-secret');
const providerId = env('LOAD_PROVIDER_ID', tokenUrl ? 'provider-a' : 'load-provider');

type Wallet = { id: string; playerId: string };
type Sent = { body: Record<string, unknown>; key: string };

const latencies: number[] = [];
const statuses = new Map<number, number>();
const failureCodes = new Map<string, number>();
let transportErrors = 0;
let maxOutboxPending = 0;
let maxOutboxAgeSeconds = 0;

const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
const count = (map: Map<string | number, number>, key: string | number) => map.set(key, (map.get(key) ?? 0) + 1);

type Role = 'operator' | 'provider';
const tokens = new Map<Role, { token: string; expiresAt: number }>();

async function bearer(role: Role): Promise<Record<string, string>> {
  if (!tokenUrl) return {};
  const cached = tokens.get(role);
  if (cached && cached.expiresAt > Date.now()) return { Authorization: `Bearer ${cached.token}` };
  const [clientId, clientSecret] = (role === 'operator' ? operatorClient : providerClient).split(':');
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`${clientId}: token endpoint responded ${response.status}`);
  const body = await response.json() as { access_token: string; expires_in: number };
  // Renew 30 seconds before expiry; tokens last 5 minutes in the local realm.
  tokens.set(role, { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 });
  return { Authorization: `Bearer ${body.access_token}` };
}

async function post(path: string, body: unknown, role: Role, key?: string) {
  const response = await fetch(pick(targets) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}), ...await bearer(role) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function getJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return await response.json() as Record<string, any>;
}

async function openWallets(): Promise<Wallet[]> {
  return Promise.all(Array.from({ length: walletCount }, async () => {
    const playerId = randomUUID();
    const result = await post('/wallets', { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } },
      'operator');
    if (result.status !== 201) throw new Error(`Wallet creation failed with ${result.status}`);
    return { id: String(result.body.id), playerId };
  }));
}

function nextRequest(wallets: Wallet[], history: Sent[]): Sent {
  if (history.length && Math.random() < duplicateShare) return pick(history);
  const wallet = Math.random() < hotWalletShare ? wallets[0] : pick(wallets);
  const externalTransactionId = randomUUID();
  const kind = Math.random() < 0.8 ? 'BET' : Math.random() < 0.5 ? 'WIN' : 'LOSS';
  const body = { providerId, externalTransactionId, playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round-' + randomUUID().slice(0, 8), gameId: 'load-game', kind,
    money: { amount: kind === 'LOSS' ? '0.00' : '1.00', currency: 'BRL' } };
  return { body, key: `${providerId}:${externalTransactionId}` };
}

async function client(wallets: Wallet[], deadline: number) {
  const history: Sent[] = [];
  while (Date.now() < deadline) {
    const request = nextRequest(wallets, history);
    const started = performance.now();
    try {
      const result = await post('/wagering/transactions', request.body, 'provider', request.key);
      latencies.push(performance.now() - started);
      count(statuses, result.status);
      if (typeof result.body.failureCode === 'string') count(failureCodes, result.body.failureCode);
      if (result.status === 200 && history.length < 200) history.push(request);
    } catch {
      transportErrors++;
    }
  }
}

async function sampleOutbox(deadline: number) {
  while (Date.now() < deadline) {
    try {
      const { gauges } = await getJson(targets[0] + '/metrics');
      maxOutboxPending = Math.max(maxOutboxPending, Number(gauges.outbox_pending ?? 0));
      maxOutboxAgeSeconds = Math.max(maxOutboxAgeSeconds, Number(gauges.outbox_oldest_pending_seconds ?? 0));
    } catch { /* sampling is best effort */ }
    await Bun.sleep(1000);
  }
}

async function drainOutbox(): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const { gauges } = await getJson(targets[0] + '/metrics');
    if (Number(gauges.outbox_pending) === 0) return (Date.now() - started) / 1000;
    await Bun.sleep(500);
  }
  return Number.NaN;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : Number.NaN;

const lockConflicts = async () => (await Promise.all(targets.map(async url =>
  Number((await getJson(url + '/metrics')).counters.lock_conflicts_total ?? 0)))).reduce((a, b) => a + b, 0);

async function main() {
  const wallets = await openWallets();
  const conflictsBefore = await lockConflicts();
  const started = Date.now();
  const deadline = started + durationSeconds * 1000;
  await Promise.all([...Array.from({ length: concurrency }, () => client(wallets, deadline)), sampleOutbox(deadline)]);
  const elapsedSeconds = (Date.now() - started) / 1000;
  const drainSeconds = await drainOutbox();
  const conflicts = await lockConflicts() - conflictsBefore;
  const reconciliations = await Promise.all(wallets.map(wallet => post(`/wallets/${wallet.id}/reconciliation`, {}, 'operator')));
  const inconsistent = reconciliations.filter(result => result.body.consistent !== true).length;
  
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.length + transportErrors;
  const expected = new Set([200, 202, 422]);
  const unexpected = [...statuses].filter(([status]) => !expected.has(status)).reduce((sum, [, n]) => sum + n, 0);
  const report = {
    environment: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model,
      bun: Bun.version, targets },
    parameters: { wallets: walletCount, concurrency, durationSeconds, hotWalletShare, duplicateShare,
    authenticated: Boolean(tokenUrl) },
    requests: total,
    throughputPerSecond: Number((latencies.length / elapsedSeconds).toFixed(1)),
    latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? Number.NaN },
    statuses: Object.fromEntries(statuses),
    failureCodes: Object.fromEntries(failureCodes),
    errorRate: total ? Number(((unexpected + transportErrors) / total).toFixed(4)) : 0,
    transportErrors,
    lockConflicts: conflicts,
    outbox: { maxPending: maxOutboxPending, maxOldestPendingSeconds: Number(maxOutboxAgeSeconds.toFixed(2)),
      drainSecondsAfterLoad: Number(drainSeconds.toFixed(2)) },
    reconciliation: { wallets: wallets.length, inconsistent },
  };
  for (const key of ['p50', 'p95', 'p99', 'max'] as const) {
    report.latencyMs[key] = Number(report.latencyMs[key].toFixed(1));
}
console.log(JSON.stringify(report, null, 2));
if (inconsistent > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
