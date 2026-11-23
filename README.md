# Distributed Wagering Processor

Processador de transações de apostas da Jungle Gaming. HTTP e SQS compartilham o caso de uso. PostgreSQL mantém o saldo, o ledger e as garantias de deduplicação entre instâncias.

## Subir o ambiente

Requer Docker com Compose v2 e Bun 1.3.3 para executar os testes no host. Execute os comandos neste diretório.

```sh
bun install --frozen-lockfile
docker compose --profile cluster up --build -d
curl http://localhost:3000/health/ready
```

O serviço de migrations termina antes de iniciar as aplicações. O perfil `cluster` publica três processos nas portas 3000, 3001 e 3002. Sem o perfil, o Compose sobe apenas a aplicação na porta 3000. PostgreSQL, LocalStack e Keycloak ficam acessíveis nas portas 5432, 4566 e 8080. O Keycloak importa o realm `wagering` na partida; o console de administração usa `admin`/`admin` (somente desenvolvimento).

Ao rodar a aplicação no host, configure `DATABASE_URL`, `SQS_ENDPOINT` e `PORT` se precisar alterar os padrões. Use `HOST=127.0.0.1` para restringir a API à máquina local. `SQS_QUEUE_BASE` permite sobrescrever a base dos URLs das filas, por exemplo `http://localhost:4566/000000000000` com MiniStack. Execute `bun run build` seguido de `bun run start`.

## Autenticação

Os endpoints, exceto health e métricas, exigem um access token do Keycloak. Provedores e back office são clients confidenciais e obtêm o token por client credentials:

```sh
TOKEN=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-local-secret | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/providers/provider-a/wagering/transactions/bet-1
```

| Client | Segredo (dev) | Uso |
|---|---|---|
| `provider-a`, `provider-b` | `provider-a-local-secret`, `provider-b-local-secret` | enviar e ler transações do próprio provider |
| `back-office` | `back-office-local-secret` | abrir wallets, ler ledger e transações, reconciliar |
| `wagering-console` | `wagering-console-local-secret` | console local |

Variáveis da API: `AUTH_MODE` (`oidc`, padrão, ou `disabled` apenas para testes locais), `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI` (opcional) e `OIDC_PROVIDER_CLAIM` (padrão `provider_id`). Sem `OIDC_ISSUER` e `OIDC_AUDIENCE`, com `AUTH_MODE=oidc`, a API não sobe. As suítes `test:integration` e `test:concurrency` usam `AUTH_MODE=disabled`. Decisões e limites estão no `ARCHITECTURE.md`.

Para o console usar o Keycloak, inicie-o com `CONSOLE_TOKEN_URL=<realm>/protocol/openid-connect/token`, `CONSOLE_CLIENT_ID=wagering-console` e `CONSOLE_CLIENT_SECRET=wagering-console-local-secret`. O proxy do console obtém o token no servidor e o segredo não chega ao navegador.

## Console web local

O console é opcional e não faz parte do desafio nem da imagem do backend. Ele
tem dependências próprias em `frontend/package.json`. Instale uma vez com
`bun run frontend:install`; depois, com a API NestJS em execução, rode
`bun run frontend` e acesse `http://127.0.0.1:3100`. O console usa React, TanStack Query, TypeScript,
Tailwind CSS 3, Radix e fontes Geist. O Bun serve o frontend e encaminha as
rotas da API na mesma origem. Os padrões são `FRONTEND_PORT=3100` e
`WAGER_API_URL=http://127.0.0.1:3000`.

Use **Nova carteira** para criar um saldo de teste, ou **Abrir carteira**
com um UUID existente. Para compartilhar um atalho, acrescente
`?wallet=UUID` à URL. Execute `bun run frontend:typecheck` e
`bun run frontend:build` para verificar o frontend separadamente.

## Migrations e testes

```sh
bun run build
bun run migration:up
bun run migration:down  # destrói as tabelas da aplicação; use apenas em banco descartável
```

No Compose, use `docker compose run --rm migrate bun dist/infrastructure/persistence/database.js down` para desfazer em um banco descartável. Para os testes, pare as aplicações antes e use filas e banco exclusivos para a suíte. A integração desfaz a migration e a aplica novamente.

```sh
docker compose --profile cluster stop app app2 app3
docker compose up --build -d --wait postgres localstack
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:concurrency
```

A suíte de concorrência cria três processos nas portas 34101–34103. Ela envia 50 pedidos HTTP competindo com uma mensagem SQS, disputa saldo de 100.00 com duas BETs de 80.00, mantém o lock de uma wallet enquanto outra avança, leva um REFUND de pendente a aplicado e provoca quedas antes do ack, antes da publicação e antes da marcação da outbox. Também testa DLQ, retry e reconstrução independente do saldo. A troca de visibilidade após a queda antes do ack pode demorar 60 segundos.

Para repetir apenas os cenários HTTP e PostgreSQL da suíte de concorrência, defina `TEST_POSTGRES_ONLY=1`. Esse modo preserva os três processos e desabilita os cenários que dependem da fila.

### Evidência local

| Comando ou requisito | Resultado no Windows |
|---|---|
| `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build` | Passaram com Bun 1.3.3. A suíte HTTP iniciou o Nest a partir do build compilado. |
| `bun run test:unit` | 22 passaram. Escala, precisão, regras de domínio, versões, ledger, conflito de hash, transições inválidas, eventos de integração, backoff da outbox, inbox e taxonomia de falhas. |
| `bun run test:integration` | 7 passaram com PostgreSQL 17.7 nativo, também em execução repetida no mesmo banco. Inclui rollback financeiro via savepoint, registro auditável de `FAILED` após falha permanente e rejeição auditada de moeda ou player divergente. |
| `bun run test:concurrency` com MiniStack 1.1.10 | 10 cenários passaram com três processos, incluindo corrida HTTP/SQS, 20 wallets com 120 BETs concorrentes, quedas da outbox, reentrega, rollback antes do commit, `FAILED` com replay e encaminhamento para DLQ. |
| `bun run test:auth` | 16 passaram. Verificador OIDC com chaves RSA e JWKS locais: token válido, expirado, de outro emissor ou audiência, assinatura trocada, `alg: none`, HS256 com chave pública, payload adulterado e JWKS fora do ar; e a API compilada com `AUTH_MODE=oidc` respondendo 401, 403, 404 e 200 conforme papel e provider. |
| `bun run test:keycloak` contra Keycloak 26.4.0 real | 12 checagens passaram com o realm `wagering` importado: tokens por client credentials de `provider-a`, `provider-b` e `back-office`, claims de emissor, audiência e `provider_id`, e a matriz de autorização. O Keycloak rodou sem Docker, a partir da distribuição oficial com JDK 21 (porta 8180). |
| Docker Compose | YAML e dependências entre serviços verificados estaticamente. A CLI Docker e uma distribuição WSL estavam indisponíveis, então a inicialização dos contêineres ficou sem execução. |

### Teste de carga

`bun run test:load` dispara contra instâncias já em execução. Parâmetros por variável de ambiente: `LOAD_TARGETS` (URLs separadas por vírgula), `LOAD_WALLETS`, `LOAD_CONCURRENCY`, `LOAD_DURATION_SECONDS`, `LOAD_HOT_WALLET_SHARE` e `LOAD_DUPLICATE_SHARE`.

**Metodologia.** O script abre as wallets com saldo alto. Depois, N clientes fecham laços de requisição por D segundos, distribuídos entre as instâncias: 80% BET de 1.00, 10% WIN e 10% LOSS. 20% do tráfego vai para uma única wallet quente, e 5% repete um pedido anterior com a mesma chave (replay). O script amostra os gauges da outbox a cada segundo, mede quanto tempo a outbox leva para esvaziar depois da carga, soma `lock_conflicts_total` das instâncias e reconcilia todas as wallets no fim.

**Resultado de referência** (23/11/2026; Windows 11, Intel i5-8500 com 6 núcleos; Bun 1.3.3, PostgreSQL 17.7 embarcado, MiniStack 1.1.10; três instâncias, banco, broker e gerador de carga na mesma máquina; 50 wallets, 32 clientes, 30 s):

| Métrica | Valor |
|---|---|
| Requisições | 10.531, todas 200 |
| Throughput | 349 req/s |
| Latência p50 / p95 / p99 / máx | 43 / 384 / 888 / 2.523 ms |
| Taxa de erro | 0% (sem erros de transporte, 5xx ou 409) |
| Conflitos de lock (timeout ou deadlock) | 0 |
| Outbox | pico de 11.946 eventos pendentes, mais antigo com 18,3 s; esvaziou 16,6 s após a carga |
| Reconciliação | 50 de 50 wallets consistentes |

**Leitura honesta.** A cauda de latência vem principalmente da wallet quente: 20% das requisições disputam o mesmo lock de linha e são serializadas, como o desenho exige. Nenhuma espera chegou ao `lock_timeout` de 5 s. A outbox é o gargalo: cada transação gera dois eventos, e cada publisher envia um evento por transação SQL, então o atraso de publicação cresceu durante o teste. Envio em lote (`SendMessageBatch`) e mais publishers reduziriam esse atraso. Os números valem só como ordem de grandeza: tudo dividiu os mesmos 6 núcleos, e o MiniStack é um emulador.

## Exemplos

Crie uma wallet e use o `id` retornado como `walletId` na transação.

```sh
curl -s -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

```sh
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_UUID","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

A primeira BET devolve saldo `20.00`. O mesmo pedido repetido preserva o ID, status e saldo observado e devolve `idempotentReplay: true`. Outra BET de 80.00, com identificadores próprios, devolve 422 com `INSUFFICIENT_FUNDS`.

| Método | Rota | Resultado |
|---|---|---|
| GET | `/wallets/:walletId` | Saldo materializado e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Entradas e `nextCursor` |
| GET | `/wagering/transactions/:transactionId` | Estado atual por ID interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Estado por identidade externa |
| POST | `/wallets/:walletId/reconciliation` | Saldo gravado, saldo calculado e diferença |
| GET | `/health/live`, `/health/ready` | Processo e dependências |
| GET | `/metrics` | `counters` do processo e `gauges` de outbox, referências pendentes e DLQ |

Uma mensagem segue o envelope `{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}`. Use o mesmo corpo HTTP dentro de `data` e acrescente `idempotencyKey`. Para ordenação por wallet, use o UUID da wallet como `MessageGroupId`. O `MessageDeduplicationId` do SQS é independente da chave persistente de negócio.

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para as decisões de domínio e a matriz de falhas.
