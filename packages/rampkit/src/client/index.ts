/**
 * Rampkit browser client — talks to YOUR mounted route (default
 * `/api/ramp`), never to Etherfuse directly. Carries no credentials; the
 * caller's identity comes from your server's `getSession`.
 */

import { RampkitError } from '../core/errors';
import type {
    PreflightIssue,
    PreflightResult,
    RampAsset,
    RampBankAccount,
    RampDirection,
    RampErrorEnvelope,
    RampOrder,
    RampPublicConfig,
    RampQuote,
    RegenerateResult,
} from '../core/types';

/** An error envelope returned by the Rampkit route handler. */
export class RampClientError extends RampkitError {
    readonly status: number;
    readonly kind: RampErrorEnvelope['error']['kind'];
    /** Present for kind 'preflight_failed'. */
    readonly issues: readonly PreflightIssue[] | undefined;

    constructor(status: number, envelope: RampErrorEnvelope['error']) {
        super(envelope.message);
        this.status = status;
        this.kind = envelope.kind;
        this.issues = envelope.issues;
    }
}

export interface CreateRampClientOptions {
    /** Where the route handler is mounted. Default: `/api/ramp`. */
    basePath?: string;
    fetch?: typeof globalThis.fetch;
    /** Extra headers per request (e.g. auth tokens for your `getSession`). */
    headers?: () => Record<string, string> | Promise<Record<string, string>>;
    /**
     * DANGEROUS prototyping aid, pairs with the server's `unsafeTrustClient`:
     * sends this identity with every call. Anyone can edit it in devtools —
     * never ship it.
     */
    unsafeIdentity?: { customerId: string; publicKey: string };
}

export interface RampClient {
    getConfig(): Promise<RampPublicConfig>;
    listAssets(args: { currency: string }): Promise<RampAsset[]>;
    createQuote(args: {
        direction: RampDirection;
        /** `CODE:ISSUER` or bare symbol (resolved server-side via /ramp/assets). */
        asset: string;
        fiat: string;
        amount: string;
    }): Promise<RampQuote>;
    listBankAccounts(): Promise<RampBankAccount[]>;
    createOnrampOrder(args: {
        quoteId: string;
        bankAccountId: string;
        memo?: string;
        orderId?: string;
    }): Promise<RampOrder>;
    createOfframpOrder(args: {
        quote: { id: string; sourceAsset: string; sourceAmount: string };
        bankAccountId: string;
        memo?: string;
        orderId?: string;
    }): Promise<RampOrder>;
    preflightOfframp(args: { sourceAsset: string; sourceAmount: string }): Promise<PreflightResult>;
    getOrder(orderId: string): Promise<RampOrder>;
    refreshTransaction(orderId: string): Promise<RegenerateResult>;
    /** Sandbox only — simulates the fiat deposit for an onramp order. */
    simulateDeposit(orderId: string): Promise<void>;
}

export function createRampClient(options: CreateRampClientOptions = {}): RampClient {
    const basePath = (options.basePath ?? '/api/ramp').replace(/\/$/, '');
    const fetchImpl = options.fetch ?? ((...args) => fetch(...args));

    const call = async <T>(
        op: string,
        method: 'GET' | 'POST',
        params: Record<string, unknown> = {},
    ): Promise<T> => {
        const merged = { ...params, ...(options.unsafeIdentity ?? {}) };
        const headers: Record<string, string> = {
            ...(options.headers ? await options.headers() : {}),
        };

        let response: Response;
        if (method === 'GET') {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(merged)) {
                if (value !== undefined && value !== null) query.set(key, String(value));
            }
            const qs = query.toString();
            response = await fetchImpl(`${basePath}/${op}${qs ? `?${qs}` : ''}`, { headers });
        } else {
            response = await fetchImpl(`${basePath}/${op}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(merged),
            });
        }

        const text = await response.text();
        const body: unknown = text ? JSON.parse(text) : null;
        if (!response.ok) {
            const envelope = (body as RampErrorEnvelope | null)?.error;
            throw new RampClientError(
                response.status,
                envelope ?? { kind: 'internal', message: `Request failed: ${response.status}` },
            );
        }
        return body as T;
    };

    return {
        getConfig: () => call('config.get', 'GET'),
        listAssets: (args) => call('assets.list', 'GET', args),
        createQuote: (args) => call('quote.create', 'POST', args),
        listBankAccounts: () => call('bankAccounts.list', 'GET'),
        createOnrampOrder: (args) => call('onramp.createOrder', 'POST', args),
        createOfframpOrder: (args) => call('offramp.createOrder', 'POST', args),
        preflightOfframp: (args) => call('offramp.preflight', 'POST', args),
        getOrder: (orderId) => call('order.get', 'GET', { orderId }),
        refreshTransaction: (orderId) => call('order.refreshTx', 'POST', { orderId }),
        simulateDeposit: async (orderId) => {
            await call('sandbox.simulateDeposit', 'POST', { orderId });
        },
    };
}
