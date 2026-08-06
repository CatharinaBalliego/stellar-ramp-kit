/**
 * EtherfuseClient — server-side client for the Etherfuse ramp API.
 *
 * Derived from the Etherfuse client in the Stellar Regional Starter Pack by
 * Elliot Friend (Apache-2.0) — see NOTICE and CHANGES-FROM-UPSTREAM.md.
 * Substantially rewritten: error handling matches the wire (no error-message
 * parsing), 409s are disambiguated structurally, offramp creation preflights
 * the wallet against Horizon, and no field is ever fabricated.
 */

// Explicit import — the `crypto` GLOBAL only exists on Node 19+, and this
// package supports Node >=18.17. This module is node-conditioned, so the
// node: import is safe.
import { randomUUID } from 'node:crypto';
import { NETWORKS } from '../core/constants';
import {
    DuplicatePendingOrderError,
    EtherfuseApiError,
    OfframpPreflightError,
    RampkitError,
} from '../core/errors';
import { offrampPreflight } from '../core/horizon';
import type {
    DepositInstructions,
    PreflightResult,
    RampAsset,
    RampBankAccount,
    RampDirection,
    RampEnvironment,
    RampEvent,
    RampOrder,
    RampPublicConfig,
    RampQuote,
    RegenerateResult,
} from '../core/types';

export interface EtherfuseClientConfig {
    /** Etherfuse API key (`api_sand_…` or `api_prod_…`). Server-side only. */
    apiKey: string;
    /**
     * Defaults from the key prefix: `api_sand_…` → sandbox, `api_prod_…` →
     * production. Unknown prefixes default to sandbox (with an event).
     */
    environment?: RampEnvironment;
    /** Override the Etherfuse base URL (defaults from environment). */
    baseUrl?: string;
    /** Override the Horizon URL (defaults from environment). */
    horizonUrl?: string;
    /** Structured observability events. Never carries the key or PII. */
    onEvent?: (event: RampEvent) => void;
    /** Injectable for tests/proxies. Defaults to global fetch. */
    fetch?: typeof globalThis.fetch;
}

// --- Raw wire shapes (internal) --------------------------------------------

interface WireQuoteResponse {
    quoteId: string;
    quoteAssets: { type: string; sourceAsset: string; targetAsset: string };
    sourceAmount: string;
    destinationAmount: string;
    destinationAmountAfterFee: string | null;
    exchangeRate: string;
    feeBps: string | null;
    feeAmount: string | null;
    expiresAt: string;
    createdAt: string;
}

interface WireOrderResponse {
    orderId: string;
    customerId: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string | null;
    amountInFiat?: number | string | null;
    amountInTokens?: number | string | null;
    confirmedTxSignature?: string | null;
    walletId?: string | null;
    bankAccountId?: string | null;
    burnTransaction?: string | null;
    memo?: string | null;
    depositClabe?: string | null;
    depositBankName?: string | null;
    depositAccountHolder?: string | null;
    orderType: RampDirection;
    status: RampOrder['status'];
    statusPage?: string | null;
    feeBps?: number | null;
    feeAmountInFiat?: number | string | null;
    exchangeRate?: string | null;
    etherfuseMidMarketRate?: string | null;
    sourceAsset?: string | null;
    targetAsset?: string | null;
    stellarClaimableBalanceId?: string | null;
    stellarClaimTransaction?: string | null;
}

interface WireBankAccount {
    bankAccountId: string;
    createdAt: string;
    abbrClabe?: string | null;
    pixKey?: string | null;
    label?: string | null;
    accountHolderName?: string | null;
    compliant?: boolean | null;
    status: string;
}

const str = (v: number | string | null | undefined): string | null =>
    v === null || v === undefined ? null : String(v);

export class EtherfuseClient {
    readonly environment: RampEnvironment;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly horizonUrl: string;
    private readonly networkPassphrase: string;
    private readonly network: 'testnet' | 'public';
    private readonly fetchImpl: typeof globalThis.fetch;
    private readonly onEvent: ((event: RampEvent) => void) | undefined;

    constructor(config: EtherfuseClientConfig) {
        if (!config.apiKey) throw new RampkitError('EtherfuseClient: apiKey is required');
        this.apiKey = config.apiKey;
        this.onEvent = config.onEvent;

        let environment = config.environment;
        if (!environment) {
            environment = config.apiKey.startsWith('api_prod_')
                ? 'production'
                : 'sandbox';
            if (!config.apiKey.startsWith('api_sand_') && !config.apiKey.startsWith('api_prod_')) {
                this.emit({ type: 'config:environment-defaulted', environment });
            }
        }
        this.environment = environment;

        const net = NETWORKS[environment];
        this.baseUrl = config.baseUrl ?? net.baseUrl;
        this.horizonUrl = config.horizonUrl ?? net.horizonUrl;
        this.networkPassphrase = net.networkPassphrase;
        this.network = net.network;
        this.fetchImpl = config.fetch ?? fetch;
    }

    private emit(event: RampEvent): void {
        this.onEvent?.(event);
    }

    /** Public (non-secret) runtime config for the browser. */
    getPublicConfig(): RampPublicConfig {
        return {
            environment: this.environment,
            network: this.network,
            networkPassphrase: this.networkPassphrase,
            horizonUrl: this.horizonUrl,
        };
    }

    // -----------------------------------------------------------------------
    // HTTP
    // -----------------------------------------------------------------------

    private async request<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
    ): Promise<{ status: number; data: T }> {
        this.emit({ type: 'etherfuse:request', method, path });
        const started = Date.now();

        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers: {
                // Raw key — a `Bearer` prefix is a documented cause of 401s.
                Authorization: this.apiKey,
                'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const text = await response.text();
        this.emit({
            type: 'etherfuse:response',
            method,
            path,
            status: response.status,
            ms: Date.now() - started,
        });

        if (!response.ok) {
            // Error bodies are plain text or {"error": "<message>"} — a string.
            // There is no machine-readable code; callers switch on status.
            let message = text;
            try {
                const parsed = JSON.parse(text) as { error?: unknown };
                if (typeof parsed.error === 'string') message = parsed.error;
            } catch {
                // plain text — keep as is
            }
            this.emit({
                type: 'etherfuse:error',
                method,
                path,
                status: response.status,
                message,
            });
            throw new EtherfuseApiError(response.status, message, `${method} ${path}`);
        }

        return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
    }

    // -----------------------------------------------------------------------
    // Assets & quotes
    // -----------------------------------------------------------------------

    /**
     * Rampable assets for Stellar. `wallet` is required by the API (it
     * resolves balances); `currency` controls sort priority.
     */
    async listAssets(args: { currency: string; wallet: string }): Promise<RampAsset[]> {
        if (!args.wallet) throw new RampkitError('listAssets: wallet is required by the API');
        const params = new URLSearchParams({
            blockchain: 'stellar',
            currency: args.currency.toLowerCase(),
            wallet: args.wallet,
        });
        const { data } = await this.request<{ assets: RampAsset[] }>(
            'GET',
            `/ramp/assets?${params}`,
        );
        return data.assets.map((a) => ({
            symbol: a.symbol,
            identifier: a.identifier,
            name: a.name,
            currency: a.currency ?? null,
            balance: a.balance ?? null,
            image: a.image ?? null,
        }));
    }

    /**
     * Create a quote. Direction is explicit — never inferred from identifier
     * shape. Symbols (e.g. `"CETES"`) resolve to `CODE:ISSUER` via
     * `/ramp/assets` using the quote's own fiat currency as the sort filter.
     */
    async createQuote(args: {
        customerId: string;
        publicKey: string;
        direction: RampDirection;
        /** Token as `CODE:ISSUER` or bare symbol. */
        asset: string;
        /** Fiat code, e.g. `"MXN"`. */
        fiat: string;
        /** Amount in the source asset (fiat for onramp, token for offramp). */
        amount: string | number;
    }): Promise<RampQuote> {
        let identifier = args.asset;
        if (!identifier.includes(':')) {
            const assets = await this.listAssets({ currency: args.fiat, wallet: args.publicKey });
            const match = assets.find((a) => a.symbol === identifier);
            if (!match) {
                throw new RampkitError(
                    `Unknown asset symbol "${identifier}" — not in GET /ramp/assets for ${this.environment}`,
                );
            }
            identifier = match.identifier;
        }

        const [sourceAsset, targetAsset] =
            args.direction === 'onramp' ? [args.fiat, identifier] : [identifier, args.fiat];

        const { data } = await this.request<WireQuoteResponse>('POST', '/ramp/quote', {
            quoteId: randomUUID(),
            customerId: args.customerId,
            blockchain: 'stellar',
            quoteAssets: { type: args.direction, sourceAsset, targetAsset },
            // The API expects a JSON string; number inputs leak from UIs.
            sourceAmount: String(args.amount),
            // Onramp only: lets the quote price one-time account/trustline
            // onboarding for new wallets (claimable-balance flow).
            ...(args.direction === 'onramp' ? { walletAddress: args.publicKey } : {}),
        });

        return {
            id: data.quoteId,
            direction: args.direction,
            sourceAsset: data.quoteAssets.sourceAsset,
            targetAsset: data.quoteAssets.targetAsset,
            sourceAmount: data.sourceAmount,
            destinationAmount: data.destinationAmountAfterFee ?? data.destinationAmount,
            exchangeRate: data.exchangeRate,
            feeAmount: data.feeAmount ?? null,
            feeBps: data.feeBps ?? null,
            expiresAt: data.expiresAt,
            createdAt: data.createdAt,
        };
    }

    // -----------------------------------------------------------------------
    // Bank accounts
    // -----------------------------------------------------------------------

    /**
     * Bank accounts registered to the customer. A 404 propagates — it means
     * the customer doesn't exist, which is not the same as "no accounts".
     */
    async listBankAccounts(customerId: string): Promise<RampBankAccount[]> {
        const { data } = await this.request<{ items: WireBankAccount[] }>(
            'POST',
            `/ramp/customer/${encodeURIComponent(customerId)}/bank-accounts`,
            { pageSize: 100, pageNumber: 0 },
        );
        return data.items.map((account) => {
            const isPix = Boolean(account.pixKey);
            return {
                id: account.bankAccountId,
                rail: isPix ? ('pix' as const) : ('spei' as const),
                accountIdentifier: (isPix ? account.pixKey : account.abbrClabe) ?? '',
                holderLabel: account.label ?? account.accountHolderName ?? null,
                status: account.status,
                compliant: account.compliant ?? null,
                createdAt: account.createdAt,
            };
        });
    }

    // -----------------------------------------------------------------------
    // Orders
    // -----------------------------------------------------------------------

    /**
     * Create an onramp order (fiat → tokens). Returns the created order with
     * SPEI deposit instructions.
     *
     * 409 handling is structural: GET our own orderId — found means the order
     * already exists (idempotent success, marked `recovered`); 404 means the
     * conflict was the pending-(bankAccount, amount) rule and nothing was
     * created ({@link DuplicatePendingOrderError}). No message parsing.
     */
    async createOnrampOrder(args: {
        customerId: string;
        publicKey: string;
        quoteId: string;
        bankAccountId: string;
        memo?: string;
        /** Persist and reuse across retries; defaults to a fresh UUID. */
        orderId?: string;
    }): Promise<RampOrder> {
        const orderId = args.orderId ?? randomUUID();
        try {
            const { data } = await this.request<{
                onramp: {
                    orderId: string;
                    depositAmount: string;
                    depositClabe?: string;
                    depositBankName?: string;
                    depositAccountHolder?: string;
                };
            }>('POST', '/ramp/order', {
                orderId,
                bankAccountId: args.bankAccountId,
                publicKey: args.publicKey,
                quoteId: args.quoteId,
                ...(args.memo ? { memo: args.memo } : {}),
            });
            // The create response is a thin receipt; read the full order back.
            const order = await this.getOrder(data.onramp.orderId);
            // Deposit instructions can lag on the read model — merge the
            // receipt's copy when the read misses them.
            if (!order.deposit && data.onramp.depositClabe) {
                order.deposit = {
                    rail: 'spei',
                    clabe: data.onramp.depositClabe,
                    bankName: data.onramp.depositBankName ?? null,
                    beneficiary: data.onramp.depositAccountHolder ?? null,
                    amount: data.onramp.depositAmount ?? null,
                };
            }
            return order;
        } catch (error) {
            if (error instanceof EtherfuseApiError && error.status === 409) {
                return this.recoverConflict(orderId);
            }
            throw error;
        }
    }

    /**
     * Create an offramp order (tokens → fiat). Runs the Horizon preflight
     * first — an unfunded or trustline-less wallet would otherwise hang
     * forever with no `burnTransaction` and no webhook.
     *
     * The full quote (not just its id) is required so the preflight knows the
     * asset and amount. `burnTransaction` arrives asynchronously: wait on it
     * via a TransactionSource / order polling.
     *
     * @throws {OfframpPreflightError} when the wallet cannot fund the burn.
     */
    async createOfframpOrder(args: {
        customerId: string;
        publicKey: string;
        quote: { id: string; sourceAsset: string; sourceAmount: string };
        bankAccountId: string;
        memo?: string;
        orderId?: string;
    }): Promise<RampOrder> {
        const preflight = await this.preflightOfframp({
            publicKey: args.publicKey,
            sourceAsset: args.quote.sourceAsset,
            sourceAmount: args.quote.sourceAmount,
        });
        if (!preflight.ok) {
            this.emit({
                type: 'preflight:failed',
                publicKey: args.publicKey,
                issues: preflight.issues,
            });
            throw new OfframpPreflightError(preflight.issues);
        }

        const orderId = args.orderId ?? randomUUID();
        try {
            const { data } = await this.request<{ offramp: { orderId: string } }>(
                'POST',
                '/ramp/order',
                {
                    orderId,
                    bankAccountId: args.bankAccountId,
                    publicKey: args.publicKey,
                    quoteId: args.quote.id,
                    ...(args.memo ? { memo: args.memo } : {}),
                },
            );
            return await this.getOrder(data.offramp.orderId);
        } catch (error) {
            if (error instanceof EtherfuseApiError && error.status === 409) {
                return this.recoverConflict(orderId);
            }
            throw error;
        }
    }

    /** Offramp wallet preflight against Horizon (read-only). */
    async preflightOfframp(args: {
        publicKey: string;
        sourceAsset: string;
        sourceAmount: string;
    }): Promise<PreflightResult> {
        return offrampPreflight({
            horizonUrl: this.horizonUrl,
            publicKey: args.publicKey,
            assetIdentifier: args.sourceAsset,
            amount: args.sourceAmount,
            fetch: this.fetchImpl,
        });
    }

    private async recoverConflict(orderId: string): Promise<RampOrder> {
        let existing: RampOrder;
        try {
            existing = await this.getOrder(orderId);
        } catch (error) {
            if (error instanceof EtherfuseApiError && error.status === 404) {
                // The 409 wasn't our orderId — it was the one-pending-order-
                // per-(bankAccount, amount) rule. Nothing was created.
                throw new DuplicatePendingOrderError(orderId);
            }
            throw error;
        }
        this.emit({ type: 'order:recovered', orderId });
        return { ...existing, recovered: true };
    }

    /** Read an order — the authoritative state, same object the webhook carries. */
    async getOrder(orderId: string): Promise<RampOrder> {
        const { data } = await this.request<WireOrderResponse>(
            'GET',
            `/ramp/order/${encodeURIComponent(orderId)}`,
        );
        return mapOrder(data);
    }

    /**
     * Regenerate an expired pre-built transaction.
     * Onramp claim: synchronous — 200 with a fresh XDR.
     * Offramp burn: asynchronous — 202; the fresh XDR lands on the order.
     */
    async regenerateTransaction(orderId: string): Promise<RegenerateResult> {
        const { status, data } = await this.request<{
            stellarClaimTransaction?: string;
        } | null>('POST', `/ramp/order/${encodeURIComponent(orderId)}/regenerate_tx`);
        if (status === 200 && data?.stellarClaimTransaction) {
            return { kind: 'onramp_sync', stellarClaimTransaction: data.stellarClaimTransaction };
        }
        return { kind: 'offramp_async' };
    }

    // -----------------------------------------------------------------------
    // Sandbox
    // -----------------------------------------------------------------------

    /** Simulate the customer's fiat deposit for an onramp. Sandbox only. */
    async simulateFiatReceived(orderId: string): Promise<void> {
        if (this.environment !== 'sandbox') {
            throw new RampkitError('simulateFiatReceived is sandbox-only');
        }
        await this.request('POST', '/ramp/order/fiat_received', { orderId });
    }
}

// ---------------------------------------------------------------------------
// Mapping — no fabricated fields: what the wire didn't send is null.
// ---------------------------------------------------------------------------

function mapOrder(w: WireOrderResponse): RampOrder {
    const deposit: DepositInstructions | null = w.depositClabe
        ? {
              rail: 'spei',
              clabe: w.depositClabe,
              bankName: w.depositBankName ?? null,
              beneficiary: w.depositAccountHolder ?? null,
              amount: str(w.amountInFiat),
          }
        : null;

    return {
        orderId: w.orderId,
        customerId: w.customerId,
        orderType: w.orderType,
        status: w.status,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        completedAt: w.completedAt ?? null,
        amountInFiat: str(w.amountInFiat),
        amountInTokens: str(w.amountInTokens),
        feeBps: w.feeBps ?? null,
        feeAmountInFiat: str(w.feeAmountInFiat),
        exchangeRate: w.exchangeRate ?? null,
        etherfuseMidMarketRate: w.etherfuseMidMarketRate ?? null,
        sourceAsset: w.sourceAsset ?? null,
        targetAsset: w.targetAsset ?? null,
        bankAccountId: w.bankAccountId ?? null,
        walletId: w.walletId ?? null,
        memo: w.memo ?? null,
        deposit,
        burnTransaction: w.burnTransaction ?? null,
        stellarClaimableBalanceId: w.stellarClaimableBalanceId ?? null,
        stellarClaimTransaction: w.stellarClaimTransaction ?? null,
        confirmedTxSignature: w.confirmedTxSignature ?? null,
        statusPage: w.statusPage ?? null,
    };
}
