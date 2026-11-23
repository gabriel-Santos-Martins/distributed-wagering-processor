import { serve } from 'bun';
import index from './index.html';

const backend = new URL(process.env.WAGER_API_URL ?? 'http://127.0.0.1:3000');
const routes = [
  /^\/wallets(?:\/[^/]+(?:\/(?:ledger|reconciliation))?)?$/,
  /^\/wagering\/transactions(?:\/[^/]+)?$/,
  /^\/providers\/[^/]+\/wagering\/transactions\/[^/]+$/,
  /^\/health\/(?:live|ready)$/,
];

// With CONSOLE_TOKEN_URL, CONSOLE_CLIENT_ID and CONSOLE_CLIENT_SECRET, the proxy gets an access token from
// Keycloak through the client credentials grant and sends it to the API. The secret never reaches the browser.
const tokenUrl = process.env.CONSOLE_TOKEN_URL;
const clientId = process.env.CONSOLE_CLIENT_ID;
const clientSecret = process.env.CONSOLE_CLIENT_SECRET;
let cached: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string | undefined> {
  if (!tokenUrl || !clientId || !clientSecret) return undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`token endpoint responded ${response.status}`);
  const body = await response.json() as { access_token: string; expires_in: number };
  // Renew 30 seconds before expiry.
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 };
  return cached.token;
}

serve({
  hostname: '127.0.0.1',
  port: Number(process.env.FRONTEND_PORT ?? 3100),
  routes: {
    '/': index,
    '/api/*': async request => {
      const url = new URL(request.url);
      const path = url.pathname.slice(4);
      if (!routes.some(route => route.test(path))) return new Response(null, { status: 404 });
      if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 });
      const headers = new Headers();
      for (const name of ['content-type', 'idempotency-key']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      try {
        const token = await accessToken();
        if (token) headers.set('authorization', 'Bearer ' + token);
      } catch {
        return Response.json({ error: 'IDENTITY_PROVIDER_UNAVAILABLE' }, { status: 503 });
      }
      try {
        const response = await fetch(new URL(path + url.search, backend), {
          method: request.method, headers, body: request.body, redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
        return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ error: 'API_INDISPONIVEL' }, { status: 503 });
      }
    },
  },
});
console.log('Console GLTech disponível em http://127.0.0.1:' + (process.env.FRONTEND_PORT ?? 3100));
