import { failureActionFor, type FailureAction, type FailureCode, type Money, type MoneyProps,
  type WagerTransaction, type WagerTransactionStatus } from '../domain';

/** Result returned to HTTP and SQS callers, identical on replay. */
export interface TransactionOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  failureAction?: FailureAction;
}

export function outcomeOf(transaction: WagerTransaction, balance: Money, idempotentReplay: boolean): TransactionOutcome {
  const code = transaction.failureCode;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    idempotentReplay,
    ...(code ? { failureCode: code, failureAction: failureActionFor(code) } : {}),
  };
}
