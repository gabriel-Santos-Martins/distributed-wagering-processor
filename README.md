# Distributed Wagering Processor

[![CI](https://github.com/gabriel-Santos-Martins/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/gabriel-Santos-Martins/distributed-wagering-processor/actions/workflows/ci.yml)

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de vários provedores de jogos, por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem ou processadas ao mesmo tempo por várias instâncias.

Desenvolvido por **Gabriel dos Santos Martins** ([@gabriel-Santos-Martins](https://github.com/gabriel-Santos-Martins)) como desafio técnico para a vaga de Backend Developer na Jungle Gaming.

- [Garantias](#garantias)
- [Stack](#stack)
- [Arquitetura](#arquitetura)
- [Como rodar](#como-rodar)
- [Autenticação](#autenticação)
- [API](#api)
- [Mensageria](#mensageria)
- [Testes](#testes)
- [Teste de carga](#teste-de-carga)
- [Observabilidade](#observabilidade)
- [Console web (opcional)](#console-web-opcional)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Autoria](#autoria)

Decisões, trade-offs e limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Garantias

| Garantia | Como é garantida |
|---|---|
| Dinheiro exato | `Money` em centavos `bigint`; domínio SQL `money_amount` (`numeric` com checks de faixa e escala); contratos com duas casas fixas (`"25.00"`) |
| Saldo nunca negativo | `CHECK` no banco e regra no agregado `Wallet` |
| Sem lost update | `SELECT ... FOR UPDATE` por wallet; nenhum lock global |
| Sem débito ou crédito duplicado | Idempotência persistente por `(provider, idempotency_key)` e `(provider, external_id)`; uma reversão aplicada por transação (índice único parcial) |
| Ledger auditável e imutável | Trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE`; trigger só aceita lançamento de transação `PROCESSED` com aritmética conferida |
| Saldo igual ao ledger | Saldo, ledger, transação, inbox e outbox na mesma transação SQL; reconciliação sob demanda |
| Nenhum evento antes do commit | Transactional outbox, publicado por workers com `FOR UPDATE SKIP LOCKED` |
| Entrega at-least-once segura | Inbox persistente por `(consumer, messageId)`; ack só depois do commit; retry com backoff e DLQ |
| Referência fora de ordem | `PENDING_REFERENCE` reprocessada com backoff exponencial até expirar com `REFERENCE_EXPIRED` |
| Várias instâncias | Correção garantida pelo banco; testada com três processos |

## Stack

Bun 1.3.3 · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 17 · AWS SQS via LocalStack (Compose) ou MiniStack · Keycloak 26 · Docker Compose · GitHub Actions

## Arquitetura

```
src/
  domain/           entidades e value objects puros: Money, Wallet, WagerTransaction,
                    WalletLedgerEntry, InboxMessage, OutboxMessage, eventos de integração
  application/      casos de uso (OpenWallet, SubmitWagerTransaction, RetryPendingReference,
                    WalletQueries), TransactionProcessor e as portas (UnitOfWork, repositórios)
  infrastructure/   adaptadores: repositórios SQL e unidade de trabalho MikroORM, consumidor e
                    publisher SQS, controller NestJS com autenticação OIDC, telemetria
  main.ts           raiz de composição
```

O domínio não depende de NestJS, ORM nem transporte. HTTP e SQS chamam o mesmo caso de uso. O fluxo de uma transação:

1. Validação do contrato e cálculo do `payloadHash` (JSON canônico, SHA-256).
2. Na fila: registro no inbox, que deduplica por `messageId`.
3. Replay se a chave de idempotência já existe; conflito se o payload difere.
4. Lock da wallet, gravação da transação e aplicação das regras num savepoint.
5. Saldo, lançamento no ledger, estado final e eventos na outbox, num único commit.
6. Um worker publica a outbox; outro reprocessa referências pendentes.

## Como rodar

Requisitos: Docker com Compose v2. Bun 1.3.3 é necessário apenas para rodar os testes no host.

```sh
bun install --frozen-lockfile
docker compose --profile cluster up --build -d
curl http://localhost:3000/health/ready
```

| Serviço | Porta | Observação |
|---|---|---|
| API | 3000, 3001, 3002 | três instâncias com o perfil `cluster`; sem o perfil, só a 3000 |
| PostgreSQL | 5432 | `wager` / `wager` |
| LocalStack (SQS) | 4566 | filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events` |
| Keycloak | 8080 | realm `wagering` importado na partida; admin `admin` / `admin` |

O serviço `migrate` aplica as migrations antes das aplicações subirem. As migrations são versionadas e reversíveis (`bun run migration:up` e `bun run migration:down`; o `down` apaga as tabelas e é só para banco descartável).

Ao rodar a API fora do Compose, configure `DATABASE_URL`, `SQS_ENDPOINT`, `SQS_QUEUE_BASE` (por exemplo `http://localhost:4566/000000000000` com MiniStack), `PORT`, `HOST` e as variáveis de autenticação abaixo; depois `bun run build` e `bun run start`.

## Autenticação

Os endpoints exigem um access token do **Keycloak**, exceto health e métricas. Cada sistema chamador é um client confidencial que obtém o token por **client credentials**:

```sh
TOKEN=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-local-secret \
  | jq -r .access_token)
```

| Client | Papel | Pode | Segredo (desenvolvimento) |
|---|---|---|---|
| `provider-a`, `provider-b` | `provider` | enviar e ler transações do próprio provider (`provider_id` no token) | `provider-a-local-secret`, `provider-b-local-secret` |
| `back-office` | `operator` | abrir e ler wallets, ledger e transações, reconciliar | `back-office-local-secret` |
| `wagering-console` | `operator` e `provider` | console local (provider `console-local`) | `wagering-console-local-secret` |

A API valida assinatura RS256 pelo JWKS, emissor, audiência (`wagering-api`), `exp` e `nbf`, usando só `node:crypto`. Um provider só envia transações em nome do próprio `provider_id` (403 `PROVIDER_MISMATCH`).

Variáveis: `AUTH_MODE` (`oidc`, padrão, ou `disabled`, só para testes locais), `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI` (opcional) e `OIDC_PROVIDER_CLAIM` (padrão `provider_id`). Com `AUTH_MODE=oidc` e sem emissor ou audiência, a API não sobe.

## API

```sh
OPERATOR=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=back-office -d client_secret=back-office-local-secret \
  | jq -r .access_token)

curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $OPERATOR" \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -X POST http://localhost:3000/wagering/transactions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_UUID","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

A primeira BET devolve saldo `20.00`. O mesmo pedido repetido devolve o resultado original com `idempotentReplay: true`. Outra BET de 80.00 devolve 422 com `INSUFFICIENT_FUNDS` e `failureAction: DO_NOT_RETRY`.

| Método | Rota | Papel |
|---|---|---|
| POST | `/wallets` | operator |
| GET | `/wallets/:walletId` | operator |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | operator; cursor opaco e estável |
| POST | `/wallets/:walletId/reconciliation` | operator |
| POST | `/wagering/transactions` (header `Idempotency-Key`) | provider |
| GET | `/wagering/transactions/:transactionId` | operator, ou o provider dono |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | operator, ou o mesmo provider |
| GET | `/health/live`, `/health/ready` | aberto |
| GET | `/metrics` | aberto |

| HTTP | Significado |
|---|---|
| 200 / 201 | aplicada / wallet criada |
| 202 | aceita, aguardando a referência (`PENDING_REFERENCE`) |
| 400 | payload inválido (nada é gravado) |
| 401 / 403 | token ausente ou inválido / papel ou provider sem permissão |
| 404 | entidade inexistente |
| 409 | conflito de idempotência ou de identidade externa |
| 422 | rejeitada por regra de negócio, auditada, com `failureCode` e `failureAction` |
| 500 | `FAILED`: falha permanente de persistência, auditada |
| 503 | dependência indisponível; pode reenviar com a mesma chave |

A taxonomia completa de `failureCode` está no [ARCHITECTURE.md](./ARCHITECTURE.md#taxonomia-de-falhas).

## Mensageria

O consumidor lê `wager-transactions.fifo` com o envelope:

```json
{ "messageId": "msg-123", "type": "WagerTransactionRequested", "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123",
            "idempotencyKey": "provider-a:transaction-123", "...": "mesmos campos do corpo HTTP" } }
```

Use o UUID da wallet como `MessageGroupId`. Regras de negócio terminam como `REJECTED` com ack; entrada inválida, wallet inexistente, conflitos e `FAILED` vão para a DLQ com o código no atributo `failureCode`; falhas transitórias voltam à fila com backoff. Em `SIGTERM`, o worker conclui o item em andamento ou devolve a visibilidade. Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) saem em `wager-events` com `eventId` estável para deduplicação no consumidor.

## Testes

Com o Compose no ar, pare as aplicações (as suítes usam as filas e desfazem as migrations) e rode:

```sh
docker compose --profile cluster stop app app2 app3
bun run typecheck && bun run build
bun run test:unit
bun run test:integration
bun run test:auth
bun run test:concurrency
```

| Suíte | Cobertura |
|---|---|
| `test:unit` (22) | `Money` (escala, entradas inválidas, precisão), invariantes da `Wallet`, regras de cada tipo de operação, transições de estado, conflito de moeda e de payload, eventos, outbox e inbox |
| `test:integration` (7) | migrations e constraints direto no SQL, atomicidade entre wallet, ledger, inbox e outbox, redelivery, reversões, expiração de referência, rollback via savepoint e `FAILED` auditável |
| `test:auth` (16) | verificador OIDC com chaves e JWKS locais (expirado, outro emissor, assinatura trocada, `alg: none`, HS256, payload adulterado, JWKS fora do ar) e a API compilada respondendo 401, 403, 404 e 200 |
| `test:concurrency` (10) | três processos reais: 50 envios paralelos da mesma aposta, duas BETs de 80.00 sobre 100.00, 20 wallets com 120 BETs concorrentes, REFUND antes da BET, queda depois do commit e antes do ack, dois publishers sobre a mesma outbox, quedas do publisher, retry e DLQ, reinício com consistência final |
| `test:keycloak` (12) | ponta a ponta contra um Keycloak real com o realm `wagering` |

Todos os testes verificam a invariante `wallet.balance == saldo reconstruído pelo ledger`.

**Integração contínua.** O workflow `.github/workflows/ci.yml` roda a cada push: sobe o Compose completo (três instâncias, PostgreSQL, LocalStack e Keycloak), confere a readiness das instâncias, roda `test:keycloak`, envia BETs por cada instância e reconcilia, e depois roda todas as suítes contra o PostgreSQL e o LocalStack dos containers.

**Evidência.**
- No CI, em containers do Docker Compose ([execução de referência](https://github.com/gabriel-Santos-Martins/distributed-wagering-processor/actions/runs/45399622833)): três instâncias prontas, `test:keycloak` 12/12, reconciliação consistente após BETs por cada instância, `test:unit` 22, `test:integration` 7, `test:auth` 16 e `test:concurrency` 10, sem falhas.
- Local (Windows 11, sem Docker): as mesmas suítes passaram com PostgreSQL 17.7 nativo, MiniStack 1.1.10 e Keycloak 26.4.0 a partir da distribuição oficial.

## Teste de carga

`bun run test:load` dispara contra instâncias em execução. Parâmetros: `LOAD_TARGETS`, `LOAD_WALLETS`, `LOAD_CONCURRENCY`, `LOAD_DURATION_SECONDS`, `LOAD_HOT_WALLET_SHARE`, `LOAD_DUPLICATE_SHARE` e, com autenticação, `LOAD_TOKEN_URL` (os clients `back-office` e `provider-a` são o padrão).

**Metodologia.** Abre wallets com saldo alto e mantém N clientes enviando por D segundos, distribuídos entre as instâncias: 80% BET, 10% WIN, 10% LOSS. 20% do tráfego vai para uma única wallet quente, e 5% repete um pedido anterior (replay). Amostra os gauges da outbox a cada segundo, mede o tempo para a outbox esvaziar, soma os conflitos de lock e reconcilia todas as wallets no fim.

**Resultados** (Windows 11, Intel i5-8500 com 6 núcleos; três instâncias, PostgreSQL, MiniStack, Keycloak e o gerador de carga na mesma máquina; 50 wallets, 32 clientes, 30 s):

| Métrica | Sem autenticação | Com Keycloak (OIDC) |
|---|---|---|
| Requisições | 10.531, todas 200 | 6.970, todas 200 |
| Throughput | 349 req/s | 228 req/s |
| Latência p50 / p95 / p99 | 43 / 384 / 888 ms | 51 / 629 / 1.303 ms |
| Taxa de erro | 0% | 0% |
| Conflitos de lock (timeout ou deadlock) | 0 | 0 |
| Outbox: pico pendente / mais antigo / esvaziamento | 11.946 / 18,3 s / 16,6 s | 7.169 / 14,5 s / 12,1 s |
| Reconciliação | 50 de 50 consistentes | 50 de 50 consistentes |

**Leitura.** A cauda de latência vem da wallet quente: 20% das requisições disputam o mesmo lock e são serializadas, como o desenho exige, sem nenhuma espera chegar ao `lock_timeout` de 5 s. A outbox é o gargalo de publicação: cada transação gera dois eventos e cada publisher envia um por vez; envio em lote (`SendMessageBatch`) e mais publishers reduziriam o atraso. Com autenticação, a verificação RSA por requisição e o Keycloak (JVM) dividindo os mesmos 6 núcleos explicam a queda de throughput. Os números valem como ordem de grandeza, não como meta.

## Observabilidade

- **Logs JSON** com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem payload financeiro.
- **`GET /metrics`**: `counters` por processo (transações por status, replays, duplicatas de inbox, retries, DLQ, conflitos de lock, latência, divergências de reconciliação) e `gauges` lidos na coleta (`outbox_pending`, `outbox_oldest_pending_seconds`, `pending_references`, `dlq_messages`).
- **Health**: `/health/live` (processo) e `/health/ready` (PostgreSQL e SQS).

## Console web (opcional)

Um console React para testes manuais: criar wallets, enviar transações, ver extrato e reconciliar. Não faz parte do desafio nem da imagem do backend e tem dependências próprias em `frontend/`.

```sh
bun run frontend:install
CONSOLE_TOKEN_URL=http://localhost:8080/realms/wagering/protocol/openid-connect/token \
CONSOLE_CLIENT_ID=wagering-console CONSOLE_CLIENT_SECRET=wagering-console-local-secret \
bun run frontend   # http://127.0.0.1:3100
```

O proxy do console obtém o token no servidor; o segredo não chega ao navegador.

## Estrutura do repositório

```
src/                  backend (domain, application, infrastructure)
test/                 unit, integration, auth, concurrency, load e keycloak smoke
docker/               imagem do LocalStack com as filas e realm do Keycloak
frontend/             console web opcional
compose.yaml          stack local completa
.github/workflows/    CI
ARCHITECTURE.md       decisões, trade-offs, taxonomia de falhas e limitações
```

## Autoria

**Gabriel dos Santos Martins** — concepção, implementação, testes e documentação.
GitHub: [@gabriel-Santos-Martins](https://github.com/gabriel-Santos-Martins)

Assistentes de IA foram usados como apoio durante o desenvolvimento; as decisões técnicas, a revisão e a responsabilidade pelo código são do autor.
