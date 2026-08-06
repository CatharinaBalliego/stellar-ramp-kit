import { RampkitError } from '../core/errors';
import type { RampOperation } from '../core/types';
import type { EtherfuseClient } from './client';

/**
 * Caller identity, resolved by the consumer's `getSession`.
 *
 * `customerId`/`publicKey` are optional ONLY for the signup window — an
 * authenticated app user who has no Etherfuse customer yet can still call
 * `customer.create`. Every other non-public operation requires both (the
 * handler enforces it with a 401).
 */
export interface RampSession {
    customerId?: string;
    publicKey?: string;
    /** Used for customer creation and KYC launches when present. */
    email?: string;
    /** Display name for customer creation and KYC launches. */
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
     * - `signup`: session required (the app authenticated the user), but the
     *   Etherfuse identity may not exist yet — this is how `customer.create`
     *   runs BEFORE there is a `customerId`.
     * - `customer`: session with full identity required. `customerId` /
     *   `publicKey` ALWAYS come from the session — anything the browser
     *   sends is ignored.
     * - `order`: like `customer`, and the fetched order must belong to the
     *   session's customer or the operation reports not-found.
     */
    scope: 'public' | 'signup' | 'customer' | 'order';
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

/**
 * Narrows a session to its full Etherfuse identity. The handler already
 * gates `customer`/`order` scopes on this, so ops can rely on it.
 */
const identity = (session: RampSession | null): { customerId: string; publicKey: string } => {
    if (!session?.customerId || !session.publicKey) {
        throw new BadParamsError(
            'Session has no Etherfuse identity — create the customer first (customer.create)',
        );
    }
    return { customerId: session.customerId, publicKey: session.publicKey };
};

async function requireOwnedOrder(
    client: EtherfuseClient,
    session: RampSession,
    orderId: string,
) {
    const order = await client.getOrder(orderId);
    // Cross-customer reads report not-found — never leak existence.
    if (order.customerId !== identity(session).customerId) throw new NotOwnedError();
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

    'customer.create': {
        method: 'POST',
        scope: 'signup',
        execute: async (client, session, params) => {
            // The browser can never choose the customerId — it comes from the
            // session (idempotent retry) or is generated server-side. Email
            // and wallet come from the session first; params fill the gaps.
            const email = session!.email ?? optional(params, 'email');
            if (!email) {
                throw new BadParamsError(
                    'customer.create needs the user email (via session or params)',
                );
            }
            return client.createCustomer({
                email,
                displayName: session!.name ?? optional(params, 'name'),
                customerId: session!.customerId,
                publicKey: session!.publicKey ?? optional(params, 'publicKey'),
            });
        },
    },

    'assets.list': {
        method: 'GET',
        scope: 'customer',
        execute: async (client, session, params) =>
            client.listAssets({
                currency: need(params, 'currency'),
                wallet: identity(session).publicKey,
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
                ...identity(session),
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
        execute: async (client, session) => client.listBankAccounts(identity(session).customerId),
    },

    'kyc.status': {
        method: 'GET',
        scope: 'customer',
        execute: async (client, session, params) => {
            const id = identity(session);
            return params['wallet'] === 'true'
                ? client.getWalletKyc(id.customerId, id.publicKey)
                : client.getCustomerKyc(id.customerId, {
                      requirements: params['requirements'] === 'true',
                  });
        },
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
                customerId: identity(session).customerId,
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
                ...identity(session),
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
                ...identity(session),
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
                publicKey: identity(session).publicKey,
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
