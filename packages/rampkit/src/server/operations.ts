import { RampkitError } from '../core/errors';
import type { RampOperation } from '../core/types';
import type { EtherfuseClient } from './client';

/** Caller identity, resolved by the consumer's `getSession`. */
export interface RampSession {
    customerId: string;
    publicKey: string;
    /** Used for KYC launches (`kyc.startSession`) when present. */
    email?: string;
    /** Display name for KYC launches. */
    name?: string;
}

/** Thrown by param validation → 400. */
export class BadParamsError extends RampkitError {}

/** Thrown when an order exists but belongs to another customer → 404. */
export class NotOwnedError extends RampkitError {
    constructor() {
        super('Order not found');
    }
}

export interface OperationSpec {
    method: 'GET' | 'POST';
    /**
     * - `public`: no session required; no identity used.
     * - `customer`: session required. `customerId`/`publicKey` ALWAYS come
     *   from the session — anything the browser sends is ignored.
     * - `order`: session required; the fetched order must belong to the
     *   session's customer or the operation reports not-found.
     */
    scope: 'public' | 'customer' | 'order';
    /** Hidden (404) when the client runs against production. */
    sandboxOnly?: boolean;
    execute: (
        client: EtherfuseClient,
        session: RampSession | null,
        params: Record<string, unknown>,
    ) => Promise<unknown>;
}

const need = (params: Record<string, unknown>, key: string): string => {
    const value = params[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new BadParamsError(`Missing required parameter: ${key}`);
    }
    return value;
};

const optional = (params: Record<string, unknown>, key: string): string | undefined => {
    const value = params[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new BadParamsError(`Invalid parameter: ${key}`);
    return value;
};

async function requireOwnedOrder(
    client: EtherfuseClient,
    session: RampSession,
    orderId: string,
) {
    const order = await client.getOrder(orderId);
    // Cross-customer reads report not-found — never leak existence.
    if (order.customerId !== session.customerId) throw new NotOwnedError();
    return order;
}

/**
 * The frozen operation map. The browser names an operation; it never names a
 * path — there is no code path from a browser-supplied string to an
 * Etherfuse URL.
 */
export const RAMP_OPERATIONS = {
    'config.get': {
        method: 'GET',
        scope: 'public',
        execute: async (client) => client.getPublicConfig(),
    },

    'assets.list': {
        method: 'GET',
        scope: 'customer',
        execute: async (client, session, params) =>
            client.listAssets({
                currency: need(params, 'currency'),
                wallet: session!.publicKey,
            }),
    },

    'quote.create': {
        method: 'POST',
        scope: 'customer',
        execute: async (client, session, params) => {
            const direction = need(params, 'direction');
            if (direction !== 'onramp' && direction !== 'offramp') {
                throw new BadParamsError('direction must be "onramp" or "offramp"');
            }
            return client.createQuote({
                customerId: session!.customerId,
                publicKey: session!.publicKey,
                direction,
                asset: need(params, 'asset'),
                fiat: need(params, 'fiat'),
                amount: need(params, 'amount'),
            });
        },
    },

    'bankAccounts.list': {
        method: 'GET',
        scope: 'customer',
        execute: async (client, session) => client.listBankAccounts(session!.customerId),
    },

    'kyc.status': {
        method: 'GET',
        scope: 'customer',
        execute: async (client, session, params) =>
            params['wallet'] === 'true'
                ? client.getWalletKyc(session!.customerId, session!.publicKey)
                : client.getCustomerKyc(session!.customerId, {
                      requirements: params['requirements'] === 'true',
                  }),
    },

    'kyc.startSession': {
        method: 'POST',
        scope: 'customer',
        execute: async (client, session, params) => {
            // Identity comes from the session when the app provides it there;
            // params only fill the gaps (they're not identity, just claims).
            const email = session!.email ?? optional(params, 'email');
            const name = session!.name ?? optional(params, 'name') ?? email;
            if (!email) {
                throw new BadParamsError(
                    'kyc.startSession needs the user email (via session or params)',
                );
            }
            return client.createKycLaunch({
                customerId: session!.customerId,
                email,
                name: name!,
                returnUrl: optional(params, 'returnUrl'),
                lang: optional(params, 'lang'),
            });
        },
    },

    'onramp.createOrder': {
        method: 'POST',
        scope: 'customer',
        execute: async (client, session, params) =>
            client.createOnrampOrder({
                customerId: session!.customerId,
                publicKey: session!.publicKey,
                quoteId: need(params, 'quoteId'),
                bankAccountId: need(params, 'bankAccountId'),
                memo: optional(params, 'memo'),
                orderId: optional(params, 'orderId'),
            }),
    },

    'offramp.createOrder': {
        method: 'POST',
        scope: 'customer',
        execute: async (client, session, params) => {
            const quote = params['quote'];
            if (typeof quote !== 'object' || quote === null) {
                throw new BadParamsError('Missing required parameter: quote');
            }
            const q = quote as Record<string, unknown>;
            return client.createOfframpOrder({
                customerId: session!.customerId,
                publicKey: session!.publicKey,
                quote: {
                    id: need(q, 'id'),
                    sourceAsset: need(q, 'sourceAsset'),
                    sourceAmount: need(q, 'sourceAmount'),
                },
                bankAccountId: need(params, 'bankAccountId'),
                memo: optional(params, 'memo'),
                orderId: optional(params, 'orderId'),
            });
        },
    },

    'offramp.preflight': {
        method: 'POST',
        scope: 'customer',
        execute: async (client, session, params) =>
            client.preflightOfframp({
                publicKey: session!.publicKey,
                sourceAsset: need(params, 'sourceAsset'),
                sourceAmount: need(params, 'sourceAmount'),
            }),
    },

    'order.get': {
        method: 'GET',
        scope: 'order',
        execute: async (client, session, params) =>
            requireOwnedOrder(client, session!, need(params, 'orderId')),
    },

    'order.refreshTx': {
        method: 'POST',
        scope: 'order',
        execute: async (client, session, params) => {
            const orderId = need(params, 'orderId');
            await requireOwnedOrder(client, session!, orderId);
            return client.regenerateTransaction(orderId);
        },
    },

    'sandbox.simulateDeposit': {
        method: 'POST',
        scope: 'order',
        sandboxOnly: true,
        execute: async (client, session, params) => {
            const orderId = need(params, 'orderId');
            await requireOwnedOrder(client, session!, orderId);
            await client.simulateFiatReceived(orderId);
            return { ok: true };
        },
    },
} as const satisfies Record<RampOperation, OperationSpec>;
