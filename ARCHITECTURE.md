# Arquitetura

## Fluxo e escopo

O módulo Nest compõe o adaptador HTTP, a identidade do provedor e o caso de uso. O consumidor SQS usa as mesmas validações de contrato e invoca o mesmo caso de uso. As classes de domínio, descritas na seção seguinte, usam TypeScript puro e factories de criação e reidratação. A aplicação coordena as operações com o `EntityManager.transactional()` do MikroORM. Consultas SQL explícitas no adaptador deixam visíveis a ordem de locks, os casts, as condições de idempotência e a seleção concorrente da outbox.

O Bun executa o JavaScript gerado pelo `tsc`. O compilador emite os metadados de decorators que o Nest usa para injeção. A migration registra a classe diretamente, evitando descoberta de arquivos TypeScript no contêiner.

Autenticação foi adiada conforme o timebox. `ProviderIdentity.verify` é o ponto de extensão HTTP. A integração usaria um guard OIDC com validação de emissor, audiência, validade, assinatura e rotação via JWKS. O principal teria um vínculo com `providerId`, e a autorização de leitura/escrita também verificaria o vínculo com o player. Health permanece aberto. O consumidor confia no canal interno e aplica validações de ID, wallet, player, moeda e escopo das referências.

## Modelo de domínio

O domínio fica em `src/domain/`, sem dependência de NestJS, MikroORM ou SQS. Toda classe tem construtor privado, factory de criação (`create`, `open`, `from`, `receive` ou `enqueue`) e `rehydrate`, que reconstrói o estado persistido sem revalidar transições.

| Classe | Responsabilidade |
|---|---|
| `Money` | Centavos em `bigint`, imutável. `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`. Operar moedas diferentes lança `CURRENCY_MISMATCH` |
| `Wallet` | Agregado com `currency`, `version`, `createdAt` e `updatedAt`. `debit` e `credit` devolvem o `WalletLedgerEntry` da movimentação, ou nada para valor zero. O lançamento é montado antes de alterar o saldo, então saldo e ledger não divergem. `openingEntry` gera o crédito de abertura. `assertAccepts` recusa outro player ou outra moeda |
| `WagerTransaction` | Campos do esqueleto, incluindo `idempotencyKey`, `payloadHash` e `createdAt`. Consultas `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`, `assertReference` e `ledgerDirectionFor`. Transições `markProcessed(ref, at)`, `markPendingReference`, `reject(code)` e `fail(code)` |
| `WalletLedgerEntry` | Campos somente leitura e congelados, sem métodos de transição. `create` valida valor positivo, saldos não negativos e `balanceBefore ± money = balanceAfter` |
| `InboxMessage` | `receivedAt`, `isProcessed`, `matchesPayload` e `markProcessed(at)`, que só pode ocorrer uma vez |
| `OutboxMessage` | `attempts`, `nextAttemptAt` e `publishedAt`. `isPending`, `isDue(now)`, `markPublished(at)` e `scheduleRetry(now)` com backoff de 1, 2, 4 segundos até 256 segundos. O id é o `eventId` |
| `IntegrationEvent<T>` | Classe abstrata com construtor protegido e `eventType`/`version` abstratos. Cada subclasse tem construtor privado e `static from(...)`, e `data` carrega `MoneyProps` |

`FailureCode` é um conjunto fechado de códigos. Uma regra de negócio violada lança `BusinessRuleViolation(code)`, e o caso de uso só converte esse tipo em `REJECTED`. Erros de entrada (`DomainError`) viram 400 sem persistência. Tentar mudar uma transação terminal lança `InvalidTransactionStateError`, que é erro de programação e não vira rejeição.

Os casos de uso continuam em `src/wagering.ts` e escrevem SQL explícito. O domínio decide, e o adaptador persiste exatamente o estado que as entidades expõem.

## Dinheiro e saldo

`Money` usa centavos em `bigint`, suporta diferenças internas negativas e serializa uma string de duas casas. A faixa por valor persistido é de 0.00 a 9999999999999999.99. Na entrada, são aceitos até 16 dígitos inteiros e até duas casas. O domínio SQL `money_amount` usa `numeric` sem arredondamento automático, com checks de faixa e escala. Leituras monetárias usam `::text`, incluindo saldos observados e colunas do ledger. O código valida o valor antes de gravar e mantém a moeda junto ao saldo. São aceitos códigos de três letras maiúsculas. A aplicação não embute o catálogo completo ISO-4217.

| Relação | Garantias |
|---|---|
| `wallet` | Chave primária, unicidade por player e moeda, saldo não negativo |
| `wager` | Identidade externa e idempotência únicas por provedor, FKs de escopo, índice parcial de reversões aplicadas |
| `ledger` | Uma entrada por wallet e transação, valor positivo, aritmética validada, bloqueio de update, delete e truncate, validação da aposta processada no INSERT |
| `inbox` | Identidade única por consumer e ID do envelope, hash e timestamp de processamento |
| `outbox` | Envelope e ID estáveis, tentativas, agendamento, instante de publicação |

Uma wallet abre na versão 1. Abertura positiva gera OPENING interno e crédito na mesma transação. Para movimentos posteriores, só um valor diferente de zero incrementa a versão, grava ledger e emite `WalletBalanceChanged`. LOSS e movimentos de valor zero geram apenas o evento da transação. A reconciliação usa uma instrução SQL e, portanto, um único snapshot MVCC. A diferença é saldo materializado menos soma de créditos e débitos, incluindo OPENING. Divergências aparecem na resposta, no log e na métrica. O cursor do ledger codifica o par wallet e sequência crescente, com escopo validado no servidor.

## Concorrência e regras

A ordem de locks é inbox, quando aplicável, depois wallet, depois a linha de wager que será modificada. O lock por wallet serializa as decisões financeiras. Uma referência da mesma wallet é consultada sob o lock da wallet. Uma referência de outro escopo é recusada sem adquirir o lock daquela wallet. O worker seleciona uma wallet desbloqueada com `SKIP LOCKED` e relê o status e o prazo da transação sob lock. Se uma tentativa abortar após a seleção, o worker tenta adiar apenas a mesma pendência em cinco segundos, desde que seu agendamento permaneça igual. O índice parcial reforça que cada transação recebe no máximo uma reversão aplicada. Em uma corrida de identidade entre wallets, o INSERT espera a decisão da unicidade, e o processo derrotado relê a linha confirmada.

BET debita, WIN credita e LOSS mantém o saldo. Um WIN com referência exige BET aplicada no mesmo escopo, mas seu prêmio pode ter valor diferente. REFUND credita o valor de uma BET. ROLLBACK credita uma BET ou debita um WIN ou REFUND, com igualdade exata do valor. Uma transação referenciada é revertida no máximo uma vez, qualquer que seja o tipo da reversão: uma BET já reembolsada recusa um ROLLBACK com `ALREADY_REVERSED`, porque creditaria o mesmo valor duas vezes. Essa regra é mais estrita que a unicidade por tipo da regra 4 e atende ao "uma única vez" da tabela e à invariante de não duplicar créditos. Desfazer o próprio REFUND continua possível com um ROLLBACK que o referencia, também uma única vez; depois disso a BET não recebe um novo REFUND. O índice único parcial `wager_single_reversal` sobre `reference_id` aplica a regra no schema, e um teste de integração cobre os dois caminhos. Partidas dobradas e regras sobre a sessão do jogo ficaram fora do escopo.

## Idempotência e estados

A chave fornecida é obrigatória e pertence ao namespace do provedor. `providerId:externalTransactionId` é uma convenção para o cliente. A identidade externa também é única por provedor. Reutilizar uma identidade externa com outra chave retorna `EXTERNAL_ID_CONFLICT`. A mesma chave com outro hash retorna `IDEMPOTENCY_CONFLICT`.

O hash SHA-256 da transação cobre `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. Ordenamos chaves recursivamente, convertemos UUIDs para minúsculas, normalizamos dinheiro para duas casas e representamos a referência ausente como `null`. Cabeçalhos, metadados de transporte e campos extras ficam fora do hash. O inbox usa separadamente o hash canônico do envelope inteiro para detectar divergências sob o mesmo `messageId`.

`PENDING` nasce dentro da unidade de trabalho e pode ir a `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` ou `FAILED`. `PENDING_REFERENCE` pode continuar pendente com novo prazo ou chegar a um estado terminal. Estados terminais não admitem transição. Uma referência ausente ou compatível e ainda pendente reentra com backoff de 1, 2, 4 segundos, até 60 segundos entre tentativas. A décima tentativa agendada sem uma referência processada grava `REFERENCE_EXPIRED` e evento de rejeição. Uma referência terminal sem sucesso gera `REFERENCE_NOT_PROCESSED`. Escopo, tipo e valor incompatíveis geram `REFERENCE_SCOPE_MISMATCH`, `INVALID_REFERENCE_KIND` e `REFERENCE_AMOUNT_MISMATCH`. As demais rejeições financeiras usam `ALREADY_REVERSED`, `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS` e `AMOUNT_LIMIT`.

Replay retorna o estado atual da transação original e o saldo observado na entrada nesse estado. Uma nova tentativa que permanece pendente mantém o saldo observado anteriormente. Quando uma pendência chega ao terminal, o replay acompanha o novo estado e congela o resultado final mesmo após outras transações.

O caso de uso registra `FAILED` com `PERMANENT_PERSISTENCE_ERROR` quando a aplicação de uma transação identificada falha dentro de um savepoint com SQLSTATE `22001`, `22003`, `23502` ou `23514`. Isso cobre a primeira tentativa financeira e o reprocessamento de referência. O savepoint desfaz saldo, ledger e outbox da tentativa. A transação externa mantém o lock da wallet e registra o estado final e o saldo observado. A submissão HTTP retorna 500 com o resultado histórico. O consumidor envia o envelope com o código para a DLQ após o commit e antes do ack. Em reentrega, o inbox recupera o resultado `FAILED` para retomar esse encaminhamento.

Falhas de conexão, locks, erros desconhecidos e erros externos ao savepoint retornam 503 em HTTP ou seguem para retry/DLQ em SQS, com proteção idempotente para commits ambíguos. Se uma falha impedir persistir o estado final, uma referência segue pendente.

## Contratos e mensageria

HTTP retorna 201 para abertura, 200 para consulta, reconciliação e apostas aplicadas, 202 para pendências, 400 para entrada inválida, 404 para entidade ausente, 409 para conflitos, 422 para rejeições auditadas e 503 para dependência indisponível. Erros de entrada usam `{"error":"CODIGO"}`. Respostas de transação seguem o contrato com `failureCode` quando aplicável.

SQS recebe de `wager-transactions.fifo` e envia mensagens inválidas ou esgotadas a `wager-transactions-dlq.fifo`. O consumidor só faz ack após o commit e grava o inbox dentro da mesma transação com wager, saldo, ledger e outbox. As rejeições auditadas também fazem commit e ack.

O publisher usa `FOR UPDATE SKIP LOCKED` para dividir trabalho. Mantém o lock apenas sobre uma linha da outbox durante um envio com prazo curto e grava o sucesso depois. Uma queda encerra a transação e libera o lock. Falhas de envio mantêm o evento e adiam a próxima tentativa com backoff. A fila de saída `wager-events` é standard e permite entregas repetidas e fora de ordem. O consumidor de eventos deve deduplicar por `eventId` e confirmar o ID junto ao próprio efeito. Os eventos têm versão, aggregateId, correlationId, causationId quando aplicável, data ISO e valores monetários em DTO.

| Situação | Resultado |
|---|---|
| Falha SQL antes do commit | Tudo sofre rollback, inclusive inbox e outbox |
| Commit sucedido com cliente sem resposta | Replay com a mesma chave consulta o estado confirmado |
| Queda depois do commit e antes do ack | SQS reentrega, inbox encontra o processamento e o consumidor confirma |
| SQS indisponível ao confirmar | Visibilidade expira; replay não repete o efeito |
| Envelope inválido ou colisão de hash | Envio à DLQ antes de confirmar a mensagem de origem |
| Falha transitória de consumo | Visibilidade cresce após cada tentativa. Na quinta entrega, o consumidor tenta DLQ. Redrive do broker no sexto recebimento protege contra falhas na movimentação manual |
| Queda antes de enviar evento | Outra instância recupera a linha não confirmada |
| Queda depois de enviar e antes de marcar publicado | A mesma linha pode ser enviada outra vez com o mesmo eventId |
| SIGTERM | Para novas consultas à fila e aguarda a consulta ou o item em andamento. Em erro, tenta devolver a visibilidade. O Compose concede até 75 segundos |

## Operação e limitações

Os logs JSON carregam os identificadores disponíveis, sem registrar payload ou valor. As métricas locais cobrem estados, replays, duplicatas de inbox, retries, DLQ, conflitos de lock, atraso de publicação, latência e divergência. A métrica explícita de DLQ conta encaminhamentos no consumidor. O redrive autônomo deve ser monitorado no broker. Readiness consulta PostgreSQL e as filas e liveness responde sem dependências.

O usuário do banco neste Compose também administra o schema. Em produção, as migrations e a aplicação teriam roles separadas e as permissões da aplicação sobre o ledger seriam limitadas a SELECT e INSERT. A reconciliação detecta alterações manuais de saldo. Os constraints de linha e o caminho transacional da aplicação são responsáveis pelas garantias. A outbox não expira eventos pendentes e o projeto não inclui operações de retenção ou redrive de DLQ. A aplicação usa credenciais locais do LocalStack.
