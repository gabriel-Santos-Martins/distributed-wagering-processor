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
  INVALID_MONEY: 'Informe um valor decimal com duas casas, por exemplo 10.00.',
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

/** Brings typed input to the contract scale: "10" or "10,5" becomes "10.00" or "10.50". Invalid input passes through. */
export function contractAmount(input: string): string {
  const value = input.trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value);
  if (!match) return value;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  return whole + '.' + (match[2] ?? '').padEnd(2, '0');
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
  ALREADY_REVERSED: 'A transação de referência já foi revertida.',
  REFERENCE_EXPIRED: 'O prazo de espera pela referência expirou.',
  REFERENCE_NOT_PROCESSED: 'A transação de referência não foi processada.',
  REFERENCE_SCOPE_MISMATCH: 'A referência pertence a outro provedor, jogador, carteira, moeda ou rodada.',
  INVALID_REFERENCE_KIND: 'Este tipo de operação não pode referenciar essa transação.',
  REFERENCE_AMOUNT_MISMATCH: 'O valor da reversão difere do valor da referência.',
  CURRENCY_MISMATCH: 'A moeda da operação difere da moeda da carteira.',
  PLAYER_WALLET_MISMATCH: 'A carteira pertence a outro jogador.',
  AMOUNT_LIMIT: 'O saldo resultante excederia o limite permitido.',
  PERMANENT_PERSISTENCE_ERROR: 'Uma falha permanente de persistência impediu a movimentação.',
};
