// ---------------------------------------------------------------------------
// Environment & config
// ---------------------------------------------------------------------------

export type RampEnvironment = 'sandbox' | 'production';

/** Structured event emitted via `onEvent` — never contains the API key or PII. */
export type RampEvent =
    | { type: 'etherfuse:request'; method: string; path: string }
    | { type: 'etherfuse:response'; method: string; path: string; status: number; ms: number }
    | { type: 'etherfuse:error'; method: string; path: string; status: number; message: string }
    | { type: 'order:recovered'; orderId: string }
    | { type: 'customer:recovered'; customerId: string }
    | { type: 'preflight:failed'; publicKey: string; issues: readonly PreflightIssue[] }
    | { type: 'horizon:submitted'; hash: string }
    | { type: 'config:environment-defaulted'; environment: RampEnvironment };

// ---------------------------------------------------------------------------
// Signer contract — the wallet-agnostic boundary
// ---------------------------------------------------------------------------

/**
 * What a signer may return:
 * - `{ signedXdr }` — the wallet signed; Rampkit submits it to Horizon.
 * - `{ hash }` — the wallet signed AND submitted; Rampkit skips submission.
 */
export type SignerResult = { signedXdr: string } | { hash: string };

export interface SignRequest {
    /** Unsigned base64 XDR, built by Etherfuse. Rampkit never builds its own. */
    xdr: string;
    /** Stellar network passphrase for the active environment. */
    networkPassphrase: string;
    /** What is being signed, so wallet UIs can explain it. */
    purpose: 'offramp_burn' | 'onramp_claim';
    /** Order the transaction belongs to. */
    orderId: string;
}

/** The consumer-provided signer. Rampkit never imports a wallet SDK. */
export interface RampSigner {
    /** Stellar G-address that signs. */
    readonly address: string;
    signTransaction(request: SignRequest): Promise<SignerResult>;
}

// ---------------------------------------------------------------------------
// Assets & quotes
// ---------------------------------------------------------------------------

/** A rampable asset from `GET /ramp/assets` — never hardcode identifiers. */
export interface RampAsset {
    symbol: string;
    /** Chain identifier — `CODE:ISSUER` on Stellar. Use verbatim in quotes. */
    identifier: string;
    name: string;
    /** Fiat currency the asset is denominated in, when reported. */
    currency: string | null;
    /** Wallet balance, when the API resolved it for the queried wallet. */
    balance: string | null;
    image: string | null;
}

export type RampDirection = 'onramp' | 'offramp';

export interface RampQuote {
    id: string;
    direction: RampDirection;
    /** Fiat code for onramp; `CODE:ISSUER` for offramp. */
    sourceAsset: string;
    /** `CODE:ISSUER` for onramp; fiat code for offramp. */
    targetAsset: string;
    sourceAmount: string;
    /** Amount the user receives, after fees when the API reports it. */
    destinationAmount: string;
    /** Fee-inclusive exchange rate. */
    exchangeRate: string;
    feeAmount: string | null;
    feeBps: string | null;
    /** ISO 8601 — quotes expire 2 minutes after creation. */
    expiresAt: string;
    createdAt: string;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus =
    | 'created'
    | 'funded'
    | 'completed'
    /** Offramp only: reversal window passed, funds can no longer return. */
    | 'finalized'
    | 'failed'
    | 'refunded'
    | 'canceled';

export const TERMINAL_ONRAMP_STATUSES: readonly OrderStatus[] = [
    'completed',
    'failed',
    'refunded',
    'canceled',
];

export const TERMINAL_OFFRAMP_STATUSES: readonly OrderStatus[] = [
    'finalized',
    'failed',
    'canceled',
];

/** SPEI deposit instructions for funding an onramp (Mexico). */
export interface SpeiDeposit {
    rail: 'spei';
    clabe: string;
    bankName: string | null;
    beneficiary: string | null;
    /** Exact fiat amount to transfer. */
    amount: string | null;
}

/**
 * PIX deposit instructions (Brazil). The PIX fields ride the same order
 * object; whichever the wire sends is passed through untouched.
 */
export interface PixDeposit {
    rail: 'pix';
    /** BR-Code / EMV copy-paste string (QR or paste into a banking app). */
    pixCode: string | null;
    pixKey: string | null;
    pixKeyType: string | null;
    beneficiary: string | null;
    amount: string | null;
}

export type DepositInstructions = SpeiDeposit | PixDeposit;

/**
 * Unified order shape for `GET /ramp/order/{id}` (the same object the
 * `order_updated` webhook carries). Fields the wire does not send are
 * `null` — Rampkit never fabricates values.
 */
export interface RampOrder {
    orderId: string;
    customerId: string;
    orderType: RampDirection;
    status: OrderStatus;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    /** Normalized to string (the wire sends JSON numbers). */
    amountInFiat: string | null;
    amountInTokens: string | null;
    feeBps: number | null;
    feeAmountInFiat: string | null;
    exchangeRate: string | null;
    etherfuseMidMarketRate: string | null;
    sourceAsset: string | null;
    targetAsset: string | null;
    bankAccountId: string | null;
    walletId: string | null;
    memo: string | null;
    /** Onramp: SPEI funding instructions, when present on the order. */
    deposit: DepositInstructions | null;
    /** Offramp: unsigned burn XDR to sign. Arrives asynchronously. */
    burnTransaction: string | null;
    /** Onramp claimable-balance flow: id + unsigned claim XDR. */
    stellarClaimableBalanceId: string | null;
    stellarClaimTransaction: string | null;
    /** On-chain tx hash once the transfer confirmed. */
    confirmedTxSignature: string | null;
    /** Etherfuse-hosted status page for this order. */
    statusPage: string | null;
    /** True when creation hit 409 and the existing order was fetched instead. */
    recovered?: boolean;
}

/** Result of `POST /ramp/order/{id}/regenerate_tx` — asymmetric by direction. */
export type RegenerateResult =
    | { kind: 'onramp_sync'; stellarClaimTransaction: string }
    | { kind: 'offramp_async' };

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export interface RampBankAccount {
    id: string;
    /** Abbreviated CLABE (SPEI) or PIX key, for display. */
    accountIdentifier: string;
    rail: 'spei' | 'pix';
    holderLabel: string | null;
    /** Must be `active` before the account can take orders. */
    status: string;
    compliant: boolean | null;
    createdAt: string;
}

// ---------------------------------------------------------------------------
// Offramp preflight
// ---------------------------------------------------------------------------

export type PreflightIssue =
    | { code: 'account_not_found'; publicKey: string }
    | { code: 'insufficient_xlm'; available: string; required: string }
    | { code: 'missing_trustline'; asset: string }
    | { code: 'insufficient_asset_balance'; asset: string; available: string; required: string };

export type PreflightResult =
    | { ok: true; xlmBalance: string; assetBalance: string }
    | { ok: false; issues: readonly PreflightIssue[] };

// ---------------------------------------------------------------------------
// Customers & KYC (in-app onboarding)
// ---------------------------------------------------------------------------

/** Documented KYC lifecycle statuses. */
export type KycStatus = 'not_started' | 'in_progress' | 'submitted' | 'approved' | 'denied';

export interface KycRequirement {
    /** e.g. `personal_data`, `identity_document`, `selfie`, `tax_document`. */
    type: string;
    status: 'satisfied' | 'pending' | 'awaiting_review' | 'action_required';
    /** True when only the hosted `/idv` flow can satisfy it. */
    requiresLaunch: boolean;
}

export interface CustomerKyc {
    customerId: string;
    status: KycStatus;
    currentRejectionReason: string | null;
    approvedAt: string | null;
    /**
     * Per-requirement breakdown (only when requested with `requirements`).
     * Absent until the customer is routed to their country's requirements,
     * and it can GROW later (e.g. `proof_of_address`).
     */
    requirements: KycRequirement[] | null;
}

/** Result of creating (or idempotently recovering) a customer. */
export interface CreatedCustomer {
    customerId: string;
    /** Wallet registered for the customer, when one was provided. */
    publicKey: string | null;
    /** True when the id already existed (safe signup retry). */
    recovered: boolean;
}

/**
 * Wallet-scoped KYC status (`GET /ramp/customer/{id}/kyc/{pubkey}`). This
 * endpoint speaks a DIFFERENT enum than the customer-level one:
 * `approved_chain_deploying` = approved, awaiting on-chain marking (Solana).
 */
export type WalletKycStatus =
    | 'not_started'
    | 'proposed'
    | 'approved'
    | 'approved_chain_deploying'
    | 'rejected';

export interface WalletKyc {
    customerId: string;
    walletPublicKey: string;
    status: WalletKycStatus;
    currentRejectionReason: string | null;
    approvedAt: string | null;
}

/**
 * Result of `sandboxApproveKyc`. Read `status` from here — an immediate
 * `GET /kyc/{pubkey}` after approval can lag behind and still report the
 * previous value.
 */
export interface SandboxKycApproval {
    /**
     * False when the identity submit was rejected (typically: the customer
     * is already approved) and only the agreement acceptances ran — the
     * retroactive-recovery case.
     */
    submitted: boolean;
    /** Status straight from the submit response; null when not submitted. */
    status: WalletKycStatus | null;
}

/**
 * Result of the legacy hosted onboarding (`POST /ramp/onboarding-url`).
 * DEPRECATED upstream — sunset 2026-08-16. Zero-setup alternative to the
 * JWT/`/idv` launch until then.
 */
export interface HostedOnboarding {
    customerId: string;
    bankAccountId: string | null;
    /** Open in a browser; the customer has 15 minutes to complete it. */
    presignedUrl: string;
    /** True when the publicKey was already registered and the documented
     * "see org" recovery re-used the existing customer. */
    recovered: boolean;
}

/**
 * A hosted-KYC launch: the browser submits these fields as a normal HTML
 * form POST to `url`, landing the user in Etherfuse's `/idv` flow. The
 * assertion is a short-lived RS256 JWT signed server-side.
 */
export interface KycLaunch {
    /** `{host}/auth/launch` for the active environment. */
    url: string;
    fields: {
        grant_type: string;
        assertion: string;
        target: string;
        return_url?: string;
    };
    /** ISO 8601 — the assertion expires ~5 minutes after minting. */
    expiresAt: string;
}

// ---------------------------------------------------------------------------
// Transaction freshness
// ---------------------------------------------------------------------------

/**
 * Strategy for waiting on a fresh offramp `burnTransaction` — after order
 * creation (previousXdr: null) and after `regenerate_tx` (previousXdr: the
 * stale one). v0 ships {@link pollingSource}; websocket/webhook variants are
 * reserved for later.
 */
export interface TransactionSource {
    waitForFresh(
        orderId: string,
        opts: { previousXdr: string | null },
        signal: AbortSignal,
    ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Server operation map (names shared with the browser client)
// ---------------------------------------------------------------------------

export type RampOperation =
    | 'config.get'
    | 'customer.create'
    | 'assets.list'
    | 'quote.create'
    | 'bankAccounts.list'
    | 'kyc.status'
    | 'kyc.startSession'
    | 'onramp.createOrder'
    | 'offramp.createOrder'
    | 'offramp.preflight'
    | 'order.get'
    | 'order.refreshTx'
    | 'sandbox.simulateDeposit';

/** Public runtime config the browser may know (no secrets). */
export interface RampPublicConfig {
    environment: RampEnvironment;
    network: 'testnet' | 'public';
    networkPassphrase: string;
    horizonUrl: string;
}

/** Error envelope returned by the route handler. */
export interface RampErrorEnvelope {
    error: {
        kind:
            | 'bad_request'
            | 'unauthorized'
            | 'not_found'
            | 'method_not_allowed'
            | 'duplicate_pending'
            | 'preflight_failed'
            | 'etherfuse_api'
            | 'internal';
        message: string;
        /** Etherfuse HTTP status, for kind 'etherfuse_api'. */
        status?: number;
        /** Preflight issues, for kind 'preflight_failed'. */
        issues?: readonly PreflightIssue[];
    };
}
