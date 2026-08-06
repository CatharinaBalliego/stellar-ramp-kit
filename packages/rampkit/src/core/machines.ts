import { QUOTE_TTL_MS, REGENERATE_AFTER_MS } from './constants';
import {
    TERMINAL_OFFRAMP_STATUSES,
    TERMINAL_ONRAMP_STATUSES,
    type OrderStatus,
    type RampDirection,
} from './types';

/**
 * Onramp flow phases (§4.1 of the design). `claim_*` phases occur only on
 * the claimable-balance path (wallet lacked the account or trustline and the
 * quote carried `walletAddress`).
 */
export type OnrampPhase =
    | 'idle'
    | 'quoting'
    | 'quote_ready'
    | 'quote_expired'
    | 'creating_order'
    | 'awaiting_deposit'
    | 'delivering'
    | 'claim_required'
    | 'claim_signing'
    | 'claim_submitting'
    | 'claim_expired'
    | 'claim_regenerating'
    | 'completed'
    | 'failed'
    | 'refunded'
    | 'canceled';

/** Offramp flow phases (§4.2). Recovery is resume-only — there is no cancel. */
export type OfframpPhase =
    | 'idle'
    | 'preflight'
    | 'preflight_failed'
    | 'quoting'
    | 'quote_ready'
    | 'quote_expired'
    | 'creating_order'
    | 'awaiting_transaction'
    | 'transaction_ready'
    | 'transaction_expired'
    | 'signing'
    | 'submitting'
    | 'regenerating'
    | 'awaiting_regenerated_transaction'
    | 'funded'
    | 'completed'
    | 'finalized'
    | 'failed'
    | 'canceled';

/** Milliseconds until a quote expires (0 when already expired). */
export function quoteRemainingMs(quote: { expiresAt: string; createdAt: string }): number {
    const expires = Date.parse(quote.expiresAt);
    const deadline = Number.isNaN(expires) ? Date.parse(quote.createdAt) + QUOTE_TTL_MS : expires;
    return Math.max(0, deadline - Date.now());
}

/** True once a pre-built XDR should be proactively regenerated (~50s old). */
export function transactionIsStale(receivedAtMs: number, now: number = Date.now()): boolean {
    return now - receivedAtMs >= REGENERATE_AFTER_MS;
}

export function isTerminalStatus(direction: RampDirection, status: OrderStatus): boolean {
    return direction === 'onramp'
        ? TERMINAL_ONRAMP_STATUSES.includes(status)
        : TERMINAL_OFFRAMP_STATUSES.includes(status);
}

/** Map a terminal order status to its flow phase (identity, typed narrow). */
export function phaseForTerminalStatus(
    direction: RampDirection,
    status: OrderStatus,
): OnrampPhase | OfframpPhase | null {
    if (!isTerminalStatus(direction, status)) return null;
    return status as OnrampPhase | OfframpPhase;
}
