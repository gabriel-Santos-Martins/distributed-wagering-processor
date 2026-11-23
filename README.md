# Distributed Wagering Processor

Processador de transações de apostas da Jungle Gaming. HTTP e SQS compartilham o caso de uso. PostgreSQL mantém o saldo, o ledger e as garantias de deduplicação entre instâncias.

## Subir o ambiente

Requer Docker com Compose v2 e Bun 1.3.3 para executar os testes no host. Execute os comandos neste diretório.

```sh
bun install --frozen-lockfile
docker compose --profile cluster up --build -d
curl http://localhost:3000/health/ready
```

O serviço de migrations termina antes de iniciar as aplicações. O perfil `cluster` publica três processos nas portas 3000, 3001 e 3002. Sem o perfil, o Compose sobe apenas a aplicação na porta 3000. PostgreSQL e LocalStack ficam acessíveis nas portas 5432 e 4566.

Ao rodar a aplicação no host, configure `DATABASE_URL`, `SQS_ENDPOINT` e `PORT` se precisar alterar os padrões. Use `HOST=127.0.0.1` para restringir a API à máquina local. `SQS_QUEUE_BASE` permite sobrescrever a base dos URLs das filas, por exemplo `http://localhost:4566/000000000000` com MiniStack. Execute `bun run build` seguido de `bun run start`.

## Console web local

Com a API NestJS em execução, rode `bun run frontend` e acesse
`http://127.0.0.1:3100`. O console usa React, TanStack Query, TypeScript,
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
| `bun run test:concurrency` com MiniStack 1.1.10 | 9 cenários passaram com três processos, incluindo corrida HTTP/SQS, quedas da outbox, reentrega, rollback antes do commit, `FAILED` com replay e encaminhamento para DLQ. |
| Docker Compose | YAML e dependências entre serviços verificados estaticamente. A CLI Docker e uma distribuição WSL estavam indisponíveis, então a inicialização dos contêineres ficou sem execução. |

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
| GET | `/metrics` | Contadores e somas locais do processo |

Uma mensagem segue o envelope `{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}`. Use o mesmo corpo HTTP dentro de `data` e acrescente `idempotencyKey`. Para ordenação por wallet, use o UUID da wallet como `MessageGroupId`. O `MessageDeduplicationId` do SQS é independente da chave persistente de negócio.

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para as decisões de domínio e a matriz de falhas.
