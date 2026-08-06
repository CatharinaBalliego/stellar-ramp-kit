import type { PreflightIssue } from './types';

/** Base class for every error Rampkit throws. */
export class RampkitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * An error response from the Etherfuse API.
 *
 * Etherfuse error bodies are a human-readable string — either plain text or
 * `{"error": "<message>"}`. There is no stable machine-readable code, so
 * switch on {@link status}; treat {@link message} as display detail only.
 */
export class EtherfuseApiError extends RampkitError {
    /** HTTP status returned by Etherfuse. */
    readonly status: number;
    /** Operation or path that produced the error, for logs. */
    readonly operation: string | undefined;

    constructor(status: number, message: string, operation?: string) {
        super(message || `Etherfuse API error ${status}`);
        this.status = status;
        this.operation = operation;
    }
}

/**
 * `POST /ramp/order` returned 409, and `GET /ramp/order/{orderId}` then
 * returned 404: the conflict was NOT our own orderId (that would be an
 * idempotent success) but the business rule that only one *pending* onramp
 * order may exist per (bank account, amount). The order was never created.
 */
export class DuplicatePendingOrderError extends RampkitError {
    readonly orderId: string;

    constructor(orderId: string) {
        super(
            'A pending onramp order already exists for this bank account and amount. ' +
                'Wait for it to settle, or change the amount.',
        );
        this.orderId = orderId;
    }
}

/**
 * Offramp preflight failed: the wallet cannot fund a burn transaction.
 * Without this check, Etherfuse silently never produces a `burnTransaction`
 * and the order hangs in `created` forever.
 */
export class OfframpPreflightError extends RampkitError {
    readonly issues: readonly PreflightIssue[];

    constructor(issues: readonly PreflightIssue[]) {
        super(`Offramp preflight failed: ${issues.map((i) => i.code).join(', ')}`);
        this.issues = issues;
    }
}

/** An error talking to Horizon (network failure or non-transaction error). */
export class HorizonError extends RampkitError {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

/**
 * Horizon rejected a submitted transaction. `resultCodes.transaction` of
 * `"tx_too_late"` means the pre-built XDR expired — regenerate and re-sign.
 */
export class TransactionFailedError extends HorizonError {
    readonly resultCodes: { transaction?: string; operations?: string[] };

    constructor(resultCodes: { transaction?: string; operations?: string[] }) {
        super(`Stellar transaction failed: ${resultCodes.transaction ?? 'unknown'}`);
        this.resultCodes = resultCodes;
    }

    /** True when the failure was an expired XDR (`tx_too_late`). */
    get expired(): boolean {
        return this.resultCodes.transaction === 'tx_too_late';
    }
}
