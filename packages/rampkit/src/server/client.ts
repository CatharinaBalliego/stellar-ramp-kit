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
    CreatedCustomer,
    CustomerKyc,
    DepositInstructions,
    HostedOnboarding,
    KycLaunch,
    KycRequirement,
    PreflightResult,
    WalletKyc,
    WalletKycStatus,
    RampAsset,
    RampBankAccount,
    RampDirection,
    RampEnvironment,
    RampEvent,
    RampOrder,
    RampPublicConfig,
    RampQuote,
    RegenerateResult,
    SandboxKycApproval,
} from '../core/types';
import { signUserJwt, type OnboardingConfig } from './onboarding';

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
    /**
     * Enables in-app KYC launches ({@link EtherfuseClient.createKycLaunch}).
     * Requires the one-time issuer + JWKS registration with Etherfuse.
     */
    onboarding?: OnboardingConfig;
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
    depositPixKey?: string | null;
    depositPixKeyType?: string | null;
    depositPixCode?: string | null;
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
    private readonly statusHost: string;
    private readonly onboarding: OnboardingConfig | undefined;

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
        this.statusHost = net.statusHost;
        this.fetchImpl = config.fetch ?? fetch;
        this.onboarding = config.onboarding;
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
            // onboarding for new wallets (claimable-balance flow). Omitted
            // when empty — an empty string is not a wallet.
            ...(args.direction === 'onramp' && args.publicKey
                ? { walletAddress: args.publicKey }
                : {}),
        });

        const destinationAmount = data.destinationAmountAfterFee ?? data.destinationAmount;
        return {
            id: data.quoteId,
            direction: args.direction,
            sourceAsset: data.quoteAssets.sourceAsset,
            targetAsset: data.quoteAssets.targetAsset,
            sourceAmount: data.sourceAmount,
            destinationAmount,
            // Sandbox sometimes omits exchangeRate — derive the fiat-per-token
            // rate (the wire's convention) from the amounts as a fallback.
            exchangeRate:
                data.exchangeRate ||
                deriveExchangeRate(args.direction, data.sourceAmount, destinationAmount),
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
    // Customers & KYC (in-app onboarding)
    // -----------------------------------------------------------------------

    /**
     * Create a customer — call this from YOUR signup flow. Creates a
     * `personal` organization (the id doubles as the `customerId` everywhere
     * else; generate it once and persist it in your user record) and
     * optionally registers the user's Stellar wallet.
     *
     * Idempotent for retries: a 409 on the same id means the customer
     * already exists and is returned as `recovered`.
     *
     * `email` is required by Etherfuse — it's the address the customer
     * confirms during verification and the only place it comes from.
     */
    async createCustomer(args: {
        email: string;
        displayName?: string;
        /** Persist and reuse across retries; defaults to a fresh UUID. */
        customerId?: string;
        /** Stellar wallet to bind to the customer (registration is idempotent). */
        publicKey?: string;
    }): Promise<CreatedCustomer> {
        const customerId = args.customerId ?? randomUUID();
        const displayName = args.displayName ?? args.email;

        let recovered = false;
        try {
            await this.request('POST', '/ramp/organization', {
                id: customerId,
                accountType: 'personal',
                displayName,
                userInfo: { email: args.email, displayName },
            });
        } catch (error) {
            if (error instanceof EtherfuseApiError && error.status === 409) {
                // The id already exists — a safe signup retry.
                recovered = true;
                this.emit({ type: 'customer:recovered', customerId });
            } else {
                throw error;
            }
        }

        if (args.publicKey) {
            await this.request(
                'POST',
                `/ramp/customer/${encodeURIComponent(customerId)}/wallet`,
                { publicKey: args.publicKey, blockchain: 'stellar' },
            );
        }

        return { customerId, publicKey: args.publicKey ?? null, recovered };
    }

    /** Current KYC state for a customer; `requirements` adds the step-by-step breakdown. */
    async getCustomerKyc(
        customerId: string,
        opts: { requirements?: boolean } = {},
    ): Promise<CustomerKyc> {
        const query = opts.requirements ? '?requirements=true' : '';
        const { data } = await this.request<{
            customerId: string;
            status: CustomerKyc['status'];
            currentRejectionReason?: string | null;
            approvedAt?: string | null;
            requirements?: KycRequirement[];
        }>('GET', `/ramp/customer/${encodeURIComponent(customerId)}/kyc${query}`);
        return {
            customerId: data.customerId,
            status: data.status,
            currentRejectionReason: data.currentRejectionReason ?? null,
            approvedAt: data.approvedAt ?? null,
            requirements: data.requirements ?? null,
        };
    }

    /**
     * Mint a hosted-KYC launch for a customer: the browser form-POSTs the
     * returned fields to `url` and the user lands in Etherfuse's `/idv`
     * flow (identity document, liveness, agreements — auto-approved in
     * sandbox). Requires the `onboarding` config (registered issuer + JWKS).
     */
    createKycLaunch(args: {
        customerId: string;
        email: string;
        name: string;
        /** Send the user back to your app afterwards. */
        returnUrl?: string;
        /**
         * `/idv` UI language. Etherfuse documents exactly two values:
         * `'es'` (Spanish — all UI text, scan prompts, errors, status
         * screens) and `'en'` (English, also the default when omitted) —
         * https://docs.etherfuse.com/guides/user-launch-flows. `'pt'` is
         * NOT documented; other values are passed through untested.
         */
        lang?: 'es' | 'en' | (string & {});
    }): KycLaunch {
        if (!this.onboarding) {
            throw new RampkitError(
                'createKycLaunch requires the `onboarding` config (issuer, privateKey, keyId). ' +
                    'Generate an RSA keypair, host the JWKS (createJwksHandler), and register ' +
                    'issuer + JWKS URL with your Etherfuse representative.',
            );
        }
        const { token, expiresAt } = signUserJwt({
            config: this.onboarding,
            audience: `${this.baseUrl}/auth/token`,
            customerId: args.customerId,
            email: args.email,
            name: args.name,
            scope: 'verification',
        });
        return {
            url: `${this.statusHost}/auth/launch`,
            fields: {
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: token,
                target: args.lang ? `/idv?lang=${encodeURIComponent(args.lang)}` : '/idv',
                ...(args.returnUrl ? { return_url: args.returnUrl } : {}),
            },
            expiresAt,
        };
    }

    /**
     * Wallet-scoped KYC status (`/kyc/{pubkey}`). NOTE: this endpoint speaks
     * a different enum than {@link getCustomerKyc} — including `proposed`,
     * `rejected`, and `approved_chain_deploying`.
     */
    async getWalletKyc(customerId: string, publicKey: string): Promise<WalletKyc> {
        const { data } = await this.request<{
            customerId: string;
            walletPublicKey: string;
            status: WalletKycStatus;
            currentRejectionReason?: string | null;
            approvedAt?: string | null;
        }>(
            'GET',
            `/ramp/customer/${encodeURIComponent(customerId)}/kyc/${encodeURIComponent(publicKey)}`,
        );
        return {
            customerId: data.customerId,
            walletPublicKey: data.walletPublicKey,
            status: data.status,
            currentRejectionReason: data.currentRejectionReason ?? null,
            approvedAt: data.approvedAt ?? null,
        };
    }

    /**
     * Hosted onboarding via presigned URL — the zero-setup alternative to
     * {@link createKycLaunch}: no issuer/JWKS registration needed; the
     * customer completes KYC + bank registration at the returned URL
     * (valid 15 minutes).
     *
     * @deprecated Upstream sunset **2026-08-16**
     * (https://docs.etherfuse.com/changelog/deprecations). Kept for
     * drop-in migration from the starter-pack client; move to
     * {@link createCustomer} + {@link createKycLaunch} before the sunset.
     *
     * The publicKey-already-registered 409 is recovered exactly as the
     * Etherfuse docs prescribe for this endpoint: reuse the customer id the
     * response names, and retry — returning a fresh URL for the EXISTING
     * customer with `recovered: true`.
     */
    async createHostedOnboarding(args: {
        email: string;
        publicKey: string;
        displayName?: string;
        /** Reuse a known id (idempotent); defaults to a fresh UUID. */
        customerId?: string;
        bankAccountId?: string;
        /**
         * On the "see org" recovery, reuse the recovered customer's FIRST
         * registered bank account instead of minting a new `bankAccountId`
         * — parity with upstream's behavior. Falls back to a fresh id when
         * the customer has no accounts yet.
         */
        reuseExistingBankAccount?: boolean;
    }): Promise<HostedOnboarding> {
        const request = (customerId: string, bankAccountId: string) =>
            this.request<{ presigned_url: string }>('POST', '/ramp/onboarding-url', {
                customerId,
                bankAccountId,
                publicKey: args.publicKey,
                blockchain: 'stellar',
                userInfo: {
                    email: args.email,
                    displayName: args.displayName ?? args.email,
                },
            });

        const customerId = args.customerId ?? randomUUID();
        const bankAccountId = args.bankAccountId ?? randomUUID();
        try {
            const { data } = await request(customerId, bankAccountId);
            return {
                customerId,
                bankAccountId,
                presignedUrl: data.presigned_url,
                recovered: false,
            };
        } catch (error) {
            if (!(error instanceof EtherfuseApiError) || error.status !== 409) throw error;
            // "You have already added user with this address, see org: <id>" —
            // this deprecated endpoint offers no structural recovery; parsing
            // the id out of the message is the documented procedure for it.
            const match = /see org:\s*([0-9a-f-]{36})/i.exec(error.message);
            if (!match) throw error;
            const existingId = match[1]!;
            this.emit({ type: 'customer:recovered', customerId: existingId });
            let retryBankAccountId: string | undefined;
            if (args.reuseExistingBankAccount) {
                const accounts = await this.listBankAccounts(existingId);
                retryBankAccountId = accounts[0]?.id;
            }
            retryBankAccountId ??= randomUUID();
            const { data } = await request(existingId, retryBankAccountId);
            return {
                customerId: existingId,
                bankAccountId: retryBankAccountId,
                presignedUrl: data.presigned_url,
                recovered: true,
            };
        }
    }

    /**
     * Approve a customer's KYC without a browser. **Sandbox only.**
     *
     * Internally: submits programmatic KYC identity data, then accepts the
     * three legal agreements — each with a FRESH presigned URL (they are
     * single-use for agreement acceptance). Rides deprecated endpoints
     * (sunset 2026-08-16); meant for tests and dev automation, never UI.
     *
     * The identity submit is best-effort: when Etherfuse rejects it (the
     * customer is already approved — the retry-the-agreements case), the
     * three agreements still run. Read the returned `status` instead of an
     * immediate `GET /kyc/{pubkey}`, which can lag behind the approval.
     */
    async sandboxApproveKyc(args: {
        customerId: string;
        publicKey: string;
        email?: string;
        identity?: Record<string, unknown>;
    }): Promise<SandboxKycApproval> {
        if (this.environment !== 'sandbox') {
            throw new RampkitError('sandboxApproveKyc is sandbox-only');
        }
        const email = args.email ?? `sandbox+${args.customerId.slice(0, 8)}@example.com`;

        let submitted = false;
        let status: WalletKycStatus | null = null;
        try {
            const { data } = await this.request<{ status?: WalletKycStatus } | null>(
                'POST',
                `/ramp/customer/${encodeURIComponent(args.customerId)}/kyc`,
                {
                    pubkey: args.publicKey,
                    identity: args.identity ?? {
                        name: { givenName: 'Sandbox', familyName: 'Tester' },
                        dateOfBirth: '1990-01-01',
                        address: {
                            street: 'Av. Reforma 1',
                            city: 'CDMX',
                            region: 'CDMX',
                            postalCode: '06600',
                            country: 'MX',
                        },
                        idNumbers: [{ type: 'curp', value: 'XEXX010101HNEXXXA4' }],
                    },
                },
            );
            submitted = true;
            status = data?.status ?? null;
        } catch (error) {
            // Best-effort: an API rejection (already approved) must not stop
            // the agreements. Anything else (network, bad key…) still throws.
            if (!(error instanceof EtherfuseApiError)) throw error;
        }

        for (const agreement of [
            'electronic-signature',
            'terms-and-conditions',
            'customer-agreement',
        ]) {
            const { data } = await this.request<{ presigned_url: string }>(
                'POST',
                '/ramp/onboarding-url',
                {
                    customerId: args.customerId,
                    bankAccountId: randomUUID(),
                    publicKey: args.publicKey,
                    blockchain: 'stellar',
                    userInfo: { email, displayName: email },
                },
            );
            await this.request('POST', `/ramp/agreements/${agreement}`, {
                presignedUrl: data.presigned_url,
            });
        }

        return { submitted, status };
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
                    depositPixKey?: string;
                    depositPixKeyType?: string;
                    depositPixCode?: string;
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
            } else if (
                !order.deposit &&
                (data.onramp.depositPixCode || data.onramp.depositPixKey)
            ) {
                order.deposit = {
                    rail: 'pix',
                    pixCode: data.onramp.depositPixCode ?? null,
                    pixKey: data.onramp.depositPixKey ?? null,
                    pixKeyType: data.onramp.depositPixKeyType ?? null,
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

/** Fiat per token — the wire's exchangeRate convention for both directions. */
function deriveExchangeRate(
    direction: RampDirection,
    sourceAmount: string,
    destinationAmount: string,
): string {
    const source = Number(sourceAmount);
    const destination = Number(destinationAmount);
    const [fiat, token] =
        direction === 'onramp' ? [source, destination] : [destination, source];
    if (!Number.isFinite(fiat) || !Number.isFinite(token) || token === 0) return '';
    return String(fiat / token);
}

function mapDeposit(w: WireOrderResponse): DepositInstructions | null {
    if (w.depositClabe) {
        return {
            rail: 'spei',
            clabe: w.depositClabe,
            bankName: w.depositBankName ?? null,
            beneficiary: w.depositAccountHolder ?? null,
            amount: str(w.amountInFiat),
        };
    }
    if (w.depositPixCode || w.depositPixKey) {
        return {
            rail: 'pix',
            pixCode: w.depositPixCode ?? null,
            pixKey: w.depositPixKey ?? null,
            pixKeyType: w.depositPixKeyType ?? null,
            beneficiary: w.depositAccountHolder ?? null,
            amount: str(w.amountInFiat),
        };
    }
    return null;
}

function mapOrder(w: WireOrderResponse): RampOrder {
    const deposit = mapDeposit(w);

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
