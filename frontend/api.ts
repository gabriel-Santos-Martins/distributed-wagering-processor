export type Money = { amount: string; currency: string };
export type Wallet = { id: string; playerId: string; balance: Money; version: number };
export type Entry = { id: string; transactionId: string; direction: 'CREDIT' | 'DEBIT'; money: Money; balanceBefore: Money; balanceAfter: Money; createdAt: string };
export type Ledger = { entries: Entry[]; nextCursor: string | null };
export type Reconciliation = { consistent: boolean; storedBalance: Money; calculatedBalance: Money; difference: Money; checkedEntries: number };
export type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Transaction = { transactionId: string; status: string; balance: Money; idempotentReplay: boolean; failureCode?: string; kind?: Kind };
export type Wager = { providerId: string; externalTransactionId: string; walletId: string; playerId: string; gameId: string; roundId: string; kind: Kind; money: Money; referenceExternalTransactionId?: string };

const descriptions: Record<string, string> = {
  WALLET_NOT_FOUND: 'Carteira não encontrada.',
  WALLET_EXISTS: 'Já existe uma carteira para este jogador e moeda.',
  INVALID_MONEY: 'Informe um valor decimal com até duas casas.',
  API_INDISPONIVEL: 'A API local está indisponível.',
  DEPENDENCY_UNAVAILABLE: 'A API está em execução, mas uma dependência está indisponível.',
  IDEMPOTENCY_CONFLICT: 'Esta chave de idempotência já pertence a outro pedido.',
  EXTERNAL_ID_CONFLICT: 'Este ID externo já foi usado com outra chave.',
  TRANSACTION_NOT_FOUND: 'Transação não encontrada.',
};

export async function api<T>(path: string, options?: { body: unknown; key?: string; allowTerminalOutcome?: boolean }): Promise<T> {
  const response = await fetch('/api' + path, options && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
    body: JSON.stringify(options.body),
  });
  const result = await response.json();
  const terminalOutcome = (response.status === 422 && result.status === 'REJECTED') ||
    (response.status === 500 && result.status === 'FAILED');
  if (!response.ok && !(options?.allowTerminalOutcome && terminalOutcome && result.transactionId)) {
    throw new Error(descriptions[result.error] ?? result.error ?? 'Falha na comunicação com a API.');
  }
  return result;
}

export function formatMoney({ amount, currency }: Money) {
  const negative = amount.startsWith('-');
  const [integer, fraction] = amount.replace(/^-/, '').split('.');
  const grouped = new Intl.NumberFormat('pt-BR').format(BigInt(integer));
  return (negative ? '−' : '') + (currency === 'BRL' ? 'R$' : currency) + ' ' + grouped + ',' + fraction;
}

export const statusLabels: Record<string, string> = {
  PROCESSED: 'Processada', REJECTED: 'Rejeitada', PENDING_REFERENCE: 'Aguardando referência',
  PENDING: 'Pendente', FAILED: 'Falhou',
};

export const failureLabels: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente para a aposta.',
  REVERSAL_INSUFFICIENT_FUNDS: 'Saldo insuficiente para a reversão.',
  ALREADY_REVERSED: 'A transação já foi revertida por esse tipo.',
  REFERENCE_EXPIRED: 'O prazo de espera pela referência expirou.',
  REFERENCE_NOT_PROCESSED: 'A transação de referência não foi processada.',
  PERMANENT_PERSISTENCE_ERROR: 'Uma falha permanente de persistência impediu a movimentação.',
};
