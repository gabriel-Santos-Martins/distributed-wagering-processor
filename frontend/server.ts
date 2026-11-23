import { serve } from 'bun';
import index from './index.html';

const backend = new URL(process.env.WAGER_API_URL ?? 'http://127.0.0.1:3000');
const routes = [
  /^\/wallets(?:\/[^/]+(?:\/(?:ledger|reconciliation))?)?$/,
  /^\/wagering\/transactions(?:\/[^/]+)?$/,
  /^\/providers\/[^/]+\/wagering\/transactions\/[^/]+$/,
  /^\/health\/(?:live|ready)$/,
];

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
