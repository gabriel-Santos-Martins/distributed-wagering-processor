import type { InboxMessage, MoneyProps, Money, OutboxMessage, Wallet, WalletLedgerEntry,
  WagerTransaction } from '../domain';

/** A transaction as persisted, with the balance observed when it reached its current state. */
export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  /** In the wallet's currency. */
  observedBalance: Money;
  attempts: number;
  causationId?: string;
  nextAttemptAt?: Date;
}

export interface WalletRepository {
  /** False when the player already has a wallet in this currency. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  /** `lock` takes the row lock that serializes every financial decision on the wallet. */
  findById(id: string, options?: { lock?: boolean }): Promise<Wallet | undefined>;
  saveBalance(wallet: Wallet): Promise<void>;
}

export interface TransactionOutcomeUpdate {
  attempts: number;
  /** Written only when the state changed; a rescheduled pending reference keeps its first observation. */
  observedBalance?: Money;
  nextAttemptAt?: Date;
}

export interface WagerTransactionRepository {
  /** False when the provider identity or idempotency key already exists. */
  insertIfAbsent(transaction: WagerTransaction, causationId?: string): Promise<boolean>;
  /** Rows of the provider that share the idempotency key or the external id. */
  findByProviderKeys(providerId: string, idempotencyKey: string, externalTransactionId: string):
    Promise<StoredWagerTransaction[]>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<StoredWagerTransaction | undefined>;
  findById(id: string): Promise<StoredWagerTransaction | undefined>;
  saveOutcome(transaction: WagerTransaction, update: TransactionOutcomeUpdate): Promise<void>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Locks an unlocked wallet that has a due PENDING_REFERENCE transaction, then that transaction. */
  claimDuePendingReference(): Promise<{ wallet: Wallet; pending: StoredWagerTransaction } | undefined>;
  /** Moves the due time only if nobody changed the schedule meanwhile. */
  deferPendingReference(id: string, expectedNextAttemptAt: Date, delaySeconds: number): Promise<void>;
}

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries after a sequence position, in order; `nextSequence` is set when more entries exist. */
  page(walletId: string, afterSequence: string, limit: number):
    Promise<{ entries: LedgerEntryView[]; nextSequence?: string }>;
  /** Stored balance against the ledger sum, in one snapshot. */
  reconcile(walletId: string): Promise<ReconciliationView | undefined>;
}

export interface InboxRepository {
  /** Registers the message if new, locks its row and returns the stored version. */
  receive(message: InboxMessage): Promise<InboxMessage>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /** Locks the next due message, skipping messages other publishers hold. */
  claimNextDue(): Promise<{ message: OutboxMessage; lagSeconds: number } | undefined>;
  save(message: OutboxMessage): Promise<void>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  /** Runs work in a savepoint: a failure undoes only the work, and the outer transaction keeps its locks. */
  savepoint<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface UnitOfWork {
  /** One atomic SQL transaction: everything written through the scope commits or rolls back together. */
  transaction<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
  /** Reads outside an explicit transaction. */
  read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
  /** Deterministic value or integrity failure: retrying the same write cannot succeed. */
  isPermanentWriteError(error: unknown): boolean;
  isLockConflict(error: unknown): boolean;
}

export interface Telemetry {
  increment(metric: string, value?: number): void;
  log(event: string, fields?: Record<string, unknown>): void;
}
