import { createHash } from 'node:crypto';
import { DomainError, externalKinds, Money, type ExternalKind, type WagerInput } from '../domain';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_PAYLOAD');
  return value as Record<string, unknown>;
}

export function identifier(value: unknown, code = 'INVALID_IDENTIFIER'): string {
  if (typeof value !== 'string' || value.length > 200 || value.trim() !== value || !value ||
      /[\x00-\x1f\x7f]/.test(value)) throw new DomainError(code);
  return value;
}

export function uuid(value: unknown): string {
  const id = identifier(value);
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new DomainError('INVALID_UUID');
  return id.toLowerCase();
}

/** Contract amounts use a fixed scale of two decimals and no leading zeros: "25.00", "0.50". */
const contractAmount = /^(?:0|[1-9]\d{0,15})\.\d{2}$/;

export function moneyFrom(value: unknown): Money {
  const { amount, currency } = record(value);
  if (typeof amount !== 'string' || typeof currency !== 'string' || !contractAmount.test(amount)) {
    throw new DomainError('INVALID_MONEY');
  }
  return Money.from({ amount, currency });
}

export function wagerFrom(value: unknown): WagerInput {
  const body = record(value);
  const providerId = identifier(body.providerId, 'INVALID_PROVIDER');
  if (providerId === 'internal:opening') throw new DomainError('INVALID_PROVIDER');
  if (!externalKinds.includes(body.kind as ExternalKind)) throw new DomainError('INVALID_KIND');
  return {
    providerId, externalTransactionId: identifier(body.externalTransactionId),
    walletId: uuid(body.walletId), playerId: uuid(body.playerId),
    roundId: identifier(body.roundId), gameId: identifier(body.gameId),
    kind: body.kind as ExternalKind, money: moneyFrom(body.money),
    referenceExternalTransactionId: body.referenceExternalTransactionId === undefined
      ? undefined : identifier(body.referenceExternalTransactionId),
  };
}

export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  })).digest('hex');
}

export function wagerHash(input: WagerInput): string {
  const { providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind,
    money, referenceExternalTransactionId } = input;
  return hash({ providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind,
    money: money.toJSON(), referenceExternalTransactionId: referenceExternalTransactionId ?? null });
}
