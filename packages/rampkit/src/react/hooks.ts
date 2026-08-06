import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { RampClientError } from '../client/index';
import { ORDER_POLL_MS, REGENERATE_AFTER_MS } from '../core/constants';
import { TransactionFailedError } from '../core/errors';
import { submitToHorizon } from '../core/horizon';
import { isTerminalStatus, quoteRemainingMs } from '../core/machines';
import type { OfframpPhase, OnrampPhase } from '../core/machines';
import { pollingSource } from '../core/polling';
import type {
    CustomerKyc,
    DepositInstructions,
    KycLaunch,
    PreflightIssue,
    RampAsset,
    RampOrder,
    RampQuote,
} from '../core/types';
import { useRampContext } from './provider';

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** A ref that always holds the latest value — for effects that shouldn't rebind. */
function useLatest<T>(value: T) {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

// ---------------------------------------------------------------------------
// useRampAssets
// ---------------------------------------------------------------------------

export interface UseRampAssetsResult {
    assets: RampAsset[];
    isLoading: boolean;
    error: Error | null;
    reload: () => void;
}

/** Rampable assets, discovered via `GET /ramp/assets` — never hardcoded. */
export function useRampAssets(args: { currency: string }): UseRampAssetsResult {
    const { client } = useRampContext();
    const [state, dispatch] = useReducer(
        (
            prev: { assets: RampAsset[]; isLoading: boolean; error: Error | null; nonce: number },
            action:
                | { type: 'start' }
                | { type: 'ok'; assets: RampAsset[] }
                | { type: 'fail'; error: Error }
                | { type: 'reload' },
        ) => {
            switch (action.type) {
                case 'start':
                    return { ...prev, isLoading: true, error: null };
                case 'ok':
                    return { ...prev, isLoading: false, assets: action.assets };
                case 'fail':
                    return { ...prev, isLoading: false, error: action.error };
                case 'reload':
                    return { ...prev, nonce: prev.nonce + 1 };
            }
        },
        { assets: [], isLoading: true, error: null, nonce: 0 },
    );

    useEffect(() => {
        let cancelled = false;
        dispatch({ type: 'start' });
        client.listAssets({ currency: args.currency }).then(
            (assets) => {
                if (!cancelled) dispatch({ type: 'ok', assets });
            },
            (error: unknown) => {
                if (!cancelled) dispatch({ type: 'fail', error: toError(error) });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [client, args.currency, state.nonce]);

    return {
        assets: state.assets,
        isLoading: state.isLoading,
        error: state.error,
        reload: useCallback(() => dispatch({ type: 'reload' }), []),
    };
}

// ---------------------------------------------------------------------------
// useKyc — verification gate + hosted-KYC launch
// ---------------------------------------------------------------------------

export interface UseKycResult {
    /** Current KYC state (null while first loading). */
    kyc: CustomerKyc | null;
    /** Convenience: kyc?.status === 'approved'. */
    isApproved: boolean;
    isLoading: boolean;
    error: Error | null;
    /** Re-read the status (e.g. after the user returns from the flow). */
    refresh: () => Promise<void>;
    /**
     * Launch the hosted KYC: fetches a signed launch from your server and
     * form-POSTs the user into Etherfuse's `/idv` flow.
     */
    launch: (opts?: { returnUrl?: string; lang?: string; newTab?: boolean }) => Promise<void>;
}

export function useKyc(options: { requirements?: boolean } = {}): UseKycResult {
    const { client } = useRampContext();
    const [state, dispatch] = useReducer(
        (
            prev: { kyc: CustomerKyc | null; isLoading: boolean; error: Error | null },
            action:
                | { type: 'start' }
                | { type: 'ok'; kyc: CustomerKyc }
                | { type: 'fail'; error: Error },
        ) => {
            switch (action.type) {
                case 'start':
                    return { ...prev, isLoading: true, error: null };
                case 'ok':
                    return { kyc: action.kyc, isLoading: false, error: null };
                case 'fail':
                    return { ...prev, isLoading: false, error: action.error };
            }
        },
        { kyc: null, isLoading: true, error: null },
    );

    const refresh = useCallback(async () => {
        dispatch({ type: 'start' });
        try {
            const kyc = await client.getKycStatus({ requirements: options.requirements });
            dispatch({ type: 'ok', kyc });
        } catch (error) {
            dispatch({ type: 'fail', error: toError(error) });
        }
    }, [client, options.requirements]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const launch = useCallback(
        async (opts: { returnUrl?: string; lang?: string; newTab?: boolean } = {}) => {
            const session: KycLaunch = await client.startKycSession({
                returnUrl: opts.returnUrl ?? window.location.href,
                lang: opts.lang,
            });
            // The launch is a plain HTML form POST to Etherfuse's app.
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = session.url;
            if (opts.newTab) form.target = '_blank';
            for (const [name, value] of Object.entries(session.fields)) {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = name;
                input.value = value;
                form.appendChild(input);
            }
            document.body.appendChild(form);
            form.submit();
            form.remove();
        },
        [client],
    );

    return {
        kyc: state.kyc,
        isApproved: state.kyc?.status === 'approved',
        isLoading: state.isLoading,
        error: state.error,
        refresh,
        launch,
    };
}

// ---------------------------------------------------------------------------
// useOnramp — fiat → tokens (§4.1)
// ---------------------------------------------------------------------------

interface OnrampState {
    phase: OnrampPhase;
    quote: RampQuote | null;
    order: RampOrder | null;
    deposit: DepositInstructions | null;
    error: Error | null;
}

type OnrampAction =
    | { type: 'reset' }
    | { type: 'phase'; phase: OnrampPhase }
    | { type: 'quote'; quote: RampQuote }
    | { type: 'order'; order: RampOrder; phase: OnrampPhase }
    | { type: 'error'; error: Error; phase?: OnrampPhase };

const ONRAMP_INITIAL: OnrampState = {
    phase: 'idle',
    quote: null,
    order: null,
    deposit: null,
    error: null,
};

function onrampReducer(state: OnrampState, action: OnrampAction): OnrampState {
    switch (action.type) {
        case 'reset':
            return ONRAMP_INITIAL;
        case 'phase':
            return { ...state, phase: action.phase, error: null };
        case 'quote':
            return { ...state, quote: action.quote, phase: 'quote_ready', error: null };
        case 'order':
            return {
                ...state,
                order: action.order,
                deposit: action.order.deposit ?? state.deposit,
                phase: action.phase,
                error: null,
            };
        case 'error':
            return { ...state, error: action.error, phase: action.phase ?? state.phase };
    }
}

/** Phase for an onramp order as read back from the API. */
function onrampPhaseFor(order: RampOrder): OnrampPhase {
    switch (order.status) {
        case 'created':
            return 'awaiting_deposit';
        case 'funded':
            return 'delivering';
        case 'completed':
            // Claimable-balance flow: user still has to sign the claim.
            return order.stellarClaimTransaction && !order.confirmedTxSignature
                ? 'claim_required'
                : 'completed';
        default:
            return order.status as OnrampPhase;
    }
}

export interface UseOnrampResult {
    phase: OnrampPhase;
    quote: RampQuote | null;
    order: RampOrder | null;
    /** SPEI instructions the user must follow to fund the order. */
    deposit: DepositInstructions | null;
    error: Error | null;
    actions: {
        /** Get a quote. Amount is fiat (e.g. MXN). */
        requestQuote(args: { asset: string; fiat: string; amount: string }): Promise<void>;
        /** Re-quote after expiry with the same args. */
        refreshQuote(): Promise<void>;
        /** Create the order — call as late as possible; quotes live 2 min. */
        start(args: { bankAccountId: string; memo?: string }): Promise<void>;
        /** Sandbox only: simulate the SPEI deposit. */
        simulateDeposit(): Promise<void>;
        /** Sign (and submit) the claim transaction — claimable-balance flow. */
        signClaim(): Promise<void>;
        /** Re-enter the flow for a persisted orderId. Resume, never recreate. */
        resume(orderId: string): Promise<void>;
        reset(): void;
    };
}

export function useOnramp(): UseOnrampResult {
    const { client, signer, ensureConfig } = useRampContext();
    const [state, dispatch] = useReducer(onrampReducer, ONRAMP_INITIAL);
    const latest = useLatest(state);
    /** Persisted across retries so create is idempotent (409 → recovered). */
    const orderIdRef = useRef<string | null>(null);
    const lastQuoteArgs = useRef<{ asset: string; fiat: string; amount: string } | null>(null);

    // Quote expiry countdown.
    useEffect(() => {
        if (state.phase !== 'quote_ready' || !state.quote) return;
        const timer = setTimeout(
            () => dispatch({ type: 'phase', phase: 'quote_expired' }),
            quoteRemainingMs(state.quote),
        );
        return () => clearTimeout(timer);
    }, [state.phase, state.quote]);

    // Order polling while waiting for deposit / delivery.
    useEffect(() => {
        const order = state.order;
        if (!order) return;
        if (state.phase !== 'awaiting_deposit' && state.phase !== 'delivering') return;

        let cancelled = false;
        const timer = setInterval(() => {
            client.getOrder(order.orderId).then(
                (fresh) => {
                    if (cancelled) return;
                    dispatch({ type: 'order', order: fresh, phase: onrampPhaseFor(fresh) });
                },
                () => undefined, // transient read failures: keep polling
            );
        }, ORDER_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [client, state.order, state.phase]);

    const requestQuote = useCallback(
        async (args: { asset: string; fiat: string; amount: string }) => {
            lastQuoteArgs.current = args;
            dispatch({ type: 'phase', phase: 'quoting' });
            try {
                const quote = await client.createQuote({ direction: 'onramp', ...args });
                dispatch({ type: 'quote', quote });
            } catch (error) {
                dispatch({ type: 'error', error: toError(error), phase: 'idle' });
                throw error;
            }
        },
        [client],
    );

    const refreshQuote = useCallback(async () => {
        const args = lastQuoteArgs.current;
        if (!args) throw new Error('No previous quote to refresh');
        await requestQuote(args);
    }, [requestQuote]);

    const start = useCallback(
        async (args: { bankAccountId: string; memo?: string }) => {
            const { quote, phase } = latest.current;
            if (!quote || phase !== 'quote_ready') {
                throw new Error(`Cannot start from phase "${phase}" — need a fresh quote`);
            }
            orderIdRef.current ??= crypto.randomUUID();
            dispatch({ type: 'phase', phase: 'creating_order' });
            try {
                const order = await client.createOnrampOrder({
                    quoteId: quote.id,
                    bankAccountId: args.bankAccountId,
                    memo: args.memo,
                    orderId: orderIdRef.current,
                });
                dispatch({ type: 'order', order, phase: onrampPhaseFor(order) });
            } catch (error) {
                // Quote died between quoting and creating (400): back to expired.
                const expired =
                    error instanceof RampClientError &&
                    error.kind === 'etherfuse_api' &&
                    error.status === 400;
                dispatch({
                    type: 'error',
                    error: toError(error),
                    phase: expired ? 'quote_expired' : 'quote_ready',
                });
                throw error;
            }
        },
        [client, latest],
    );

    const simulateDeposit = useCallback(async () => {
        const order = latest.current.order;
        if (!order) throw new Error('No order to simulate a deposit for');
        await client.simulateDeposit(order.orderId);
    }, [client, latest]);

    const signClaim = useCallback(async () => {
        const { order } = latest.current;
        if (!signer) throw new Error('No signer connected');
        if (!order?.stellarClaimTransaction) throw new Error('No claim transaction on the order');

        const config = await ensureConfig();
        dispatch({ type: 'phase', phase: 'claim_signing' });
        try {
            const result = await signer.signTransaction({
                xdr: order.stellarClaimTransaction,
                networkPassphrase: config.networkPassphrase,
                purpose: 'onramp_claim',
                orderId: order.orderId,
            });
            if ('signedXdr' in result) {
                dispatch({ type: 'phase', phase: 'claim_submitting' });
                await submitToHorizon({
                    horizonUrl: config.horizonUrl,
                    signedXdr: result.signedXdr,
                });
            }
            dispatch({ type: 'phase', phase: 'completed' });
        } catch (error) {
            if (error instanceof TransactionFailedError && error.expired) {
                // Stale sequence/expiry: regenerate (synchronous for onramp).
                dispatch({ type: 'phase', phase: 'claim_regenerating' });
                try {
                    const regen = await client.refreshTransaction(order.orderId);
                    const fresh = await client.getOrder(order.orderId);
                    if (regen.kind === 'onramp_sync') {
                        fresh.stellarClaimTransaction = regen.stellarClaimTransaction;
                    }
                    dispatch({ type: 'order', order: fresh, phase: 'claim_required' });
                } catch (regenError) {
                    dispatch({
                        type: 'error',
                        error: toError(regenError),
                        phase: 'claim_expired',
                    });
                }
                return;
            }
            dispatch({ type: 'error', error: toError(error), phase: 'claim_required' });
            throw error;
        }
    }, [client, signer, ensureConfig, latest]);

    const resume = useCallback(
        async (orderId: string) => {
            orderIdRef.current = orderId;
            const order = await client.getOrder(orderId);
            dispatch({ type: 'order', order, phase: onrampPhaseFor(order) });
        },
        [client],
    );

    const reset = useCallback(() => {
        orderIdRef.current = null;
        lastQuoteArgs.current = null;
        dispatch({ type: 'reset' });
    }, []);

    return {
        phase: state.phase,
        quote: state.quote,
        order: state.order,
        deposit: state.deposit,
        error: state.error,
        actions: useMemo(
            () => ({ requestQuote, refreshQuote, start, simulateDeposit, signClaim, resume, reset }),
            [requestQuote, refreshQuote, start, simulateDeposit, signClaim, resume, reset],
        ),
    };
}

// ---------------------------------------------------------------------------
// useOfframp — tokens → fiat (§4.2)
// ---------------------------------------------------------------------------

interface OfframpState {
    phase: OfframpPhase;
    quote: RampQuote | null;
    order: RampOrder | null;
    /** Current signable burn XDR + when we received it (for staleness). */
    burnXdr: string | null;
    burnReceivedAt: number | null;
    preflightIssues: readonly PreflightIssue[] | null;
    txHash: string | null;
    error: Error | null;
}

type OfframpAction =
    | { type: 'reset' }
    | { type: 'phase'; phase: OfframpPhase }
    | { type: 'quote'; quote: RampQuote }
    | { type: 'order'; order: RampOrder; phase: OfframpPhase }
    | { type: 'burn'; xdr: string }
    | { type: 'preflight_failed'; issues: readonly PreflightIssue[] }
    | { type: 'submitted'; hash: string | null }
    | { type: 'error'; error: Error; phase?: OfframpPhase };

const OFFRAMP_INITIAL: OfframpState = {
    phase: 'idle',
    quote: null,
    order: null,
    burnXdr: null,
    burnReceivedAt: null,
    preflightIssues: null,
    txHash: null,
    error: null,
};

function offrampReducer(state: OfframpState, action: OfframpAction): OfframpState {
    switch (action.type) {
        case 'reset':
            return OFFRAMP_INITIAL;
        case 'phase':
            return { ...state, phase: action.phase, error: null };
        case 'quote':
            return {
                ...state,
                quote: action.quote,
                phase: 'quote_ready',
                preflightIssues: null,
                error: null,
            };
        case 'order':
            return { ...state, order: action.order, phase: action.phase, error: null };
        case 'burn':
            return {
                ...state,
                burnXdr: action.xdr,
                burnReceivedAt: Date.now(),
                phase: 'transaction_ready',
                error: null,
            };
        case 'preflight_failed':
            return { ...state, preflightIssues: action.issues, phase: 'preflight_failed' };
        case 'submitted':
            return { ...state, txHash: action.hash, phase: 'submitting' };
        case 'error':
            return { ...state, error: action.error, phase: action.phase ?? state.phase };
    }
}

/** Phase for an offramp order as read back from the API (resume path). */
function offrampPhaseFor(order: RampOrder): OfframpPhase {
    switch (order.status) {
        case 'created':
            return order.burnTransaction ? 'transaction_ready' : 'awaiting_transaction';
        case 'funded':
            return 'funded';
        default:
            return order.status as OfframpPhase;
    }
}

export interface UseOfframpOptions {
    /**
     * Proactively regenerate the burn transaction as it approaches expiry
     * (~50s), so the user always holds a signable XDR. Default: true.
     */
    keepTransactionFresh?: boolean;
}

export interface UseOfframpResult {
    phase: OfframpPhase;
    quote: RampQuote | null;
    order: RampOrder | null;
    /** The signable burn transaction, when phase is `transaction_ready`. */
    burnXdr: string | null;
    /** Why preflight failed, when phase is `preflight_failed`. */
    preflightIssues: readonly PreflightIssue[] | null;
    /** Stellar tx hash after submission. */
    txHash: string | null;
    error: Error | null;
    actions: {
        /** Get a quote. Amount is in the token being sold. */
        requestQuote(args: { asset: string; fiat: string; amount: string }): Promise<void>;
        refreshQuote(): Promise<void>;
        /** Preflight + create the order, then wait for the burn transaction. */
        start(args: { bankAccountId: string; memo?: string }): Promise<void>;
        /** Sign (and submit) the burn transaction. */
        sign(): Promise<void>;
        /** Manually request a fresh burn transaction (202 → wait via source). */
        refreshTransaction(): Promise<void>;
        /** Re-enter the flow for a persisted orderId. Resume, never recreate. */
        resume(orderId: string): Promise<void>;
        reset(): void;
    };
}

export function useOfframp(options: UseOfframpOptions = {}): UseOfframpResult {
    const keepFresh = options.keepTransactionFresh ?? true;
    const { client, signer, ensureConfig } = useRampContext();
    const [state, dispatch] = useReducer(offrampReducer, OFFRAMP_INITIAL);
    const latest = useLatest(state);
    const orderIdRef = useRef<string | null>(null);
    const lastQuoteArgs = useRef<{ asset: string; fiat: string; amount: string } | null>(null);
    const waitAbort = useRef<AbortController | null>(null);

    const source = useMemo(
        () => pollingSource((orderId) => client.getOrder(orderId)),
        [client],
    );

    /** Wait for a burn XDR different from `previousXdr`, replacing any wait. */
    const waitForBurn = useCallback(
        async (orderId: string, previousXdr: string | null) => {
            waitAbort.current?.abort();
            const controller = new AbortController();
            waitAbort.current = controller;
            try {
                const xdr = await source.waitForFresh(orderId, { previousXdr }, controller.signal);
                dispatch({ type: 'burn', xdr });
            } catch (error) {
                if (!controller.signal.aborted) {
                    dispatch({ type: 'error', error: toError(error) });
                }
            }
        },
        [source],
    );

    useEffect(() => () => waitAbort.current?.abort(), []);

    // Quote expiry countdown.
    useEffect(() => {
        if (state.phase !== 'quote_ready' || !state.quote) return;
        const timer = setTimeout(
            () => dispatch({ type: 'phase', phase: 'quote_expired' }),
            quoteRemainingMs(state.quote),
        );
        return () => clearTimeout(timer);
    }, [state.phase, state.quote]);

    const refreshTransaction = useCallback(async () => {
        const { order, burnXdr } = latest.current;
        if (!order) throw new Error('No order to refresh');
        dispatch({ type: 'phase', phase: 'regenerating' });
        try {
            await client.refreshTransaction(order.orderId); // offramp: 202
            dispatch({ type: 'phase', phase: 'awaiting_regenerated_transaction' });
            void waitForBurn(order.orderId, burnXdr);
        } catch (error) {
            dispatch({ type: 'error', error: toError(error), phase: 'transaction_expired' });
            throw error;
        }
    }, [client, latest, waitForBurn]);
    const refreshRef = useLatest(refreshTransaction);

    // Staleness timer: regenerate before the XDR dies (~50s).
    useEffect(() => {
        if (!keepFresh) return;
        if (state.phase !== 'transaction_ready' || state.burnReceivedAt === null) return;
        const age = Date.now() - state.burnReceivedAt;
        const timer = setTimeout(
            () => void refreshRef.current().catch(() => undefined),
            Math.max(0, REGENERATE_AFTER_MS - age),
        );
        return () => clearTimeout(timer);
    }, [keepFresh, state.phase, state.burnReceivedAt, refreshRef]);

    // Post-submission polling until the order is terminal.
    useEffect(() => {
        const order = state.order;
        if (!order) return;
        if (state.phase !== 'submitting' && state.phase !== 'funded' && state.phase !== 'completed')
            return;

        let cancelled = false;
        const timer = setInterval(() => {
            client.getOrder(order.orderId).then(
                (fresh) => {
                    if (cancelled) return;
                    if (fresh.status === 'created') return; // burn not yet detected
                    dispatch({ type: 'order', order: fresh, phase: offrampPhaseFor(fresh) });
                    if (isTerminalStatus('offramp', fresh.status)) clearInterval(timer);
                },
                () => undefined,
            );
        }, ORDER_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [client, state.order, state.phase]);

    const requestQuote = useCallback(
        async (args: { asset: string; fiat: string; amount: string }) => {
            lastQuoteArgs.current = args;
            dispatch({ type: 'phase', phase: 'quoting' });
            try {
                const quote = await client.createQuote({ direction: 'offramp', ...args });
                dispatch({ type: 'quote', quote });
            } catch (error) {
                dispatch({ type: 'error', error: toError(error), phase: 'idle' });
                throw error;
            }
        },
        [client],
    );

    const refreshQuote = useCallback(async () => {
        const args = lastQuoteArgs.current;
        if (!args) throw new Error('No previous quote to refresh');
        await requestQuote(args);
    }, [requestQuote]);

    const start = useCallback(
        async (args: { bankAccountId: string; memo?: string }) => {
            const { quote, phase } = latest.current;
            if (!quote || phase !== 'quote_ready') {
                throw new Error(`Cannot start from phase "${phase}" — need a fresh quote`);
            }
            orderIdRef.current ??= crypto.randomUUID();
            dispatch({ type: 'phase', phase: 'creating_order' });
            try {
                const order = await client.createOfframpOrder({
                    quote: {
                        id: quote.id,
                        sourceAsset: quote.sourceAsset,
                        sourceAmount: quote.sourceAmount,
                    },
                    bankAccountId: args.bankAccountId,
                    memo: args.memo,
                    orderId: orderIdRef.current,
                });
                if (order.burnTransaction) {
                    dispatch({ type: 'order', order, phase: 'transaction_ready' });
                    dispatch({ type: 'burn', xdr: order.burnTransaction });
                } else {
                    dispatch({ type: 'order', order, phase: 'awaiting_transaction' });
                    void waitForBurn(order.orderId, null);
                }
            } catch (error) {
                if (error instanceof RampClientError && error.kind === 'preflight_failed') {
                    dispatch({ type: 'preflight_failed', issues: error.issues ?? [] });
                    return;
                }
                const expired =
                    error instanceof RampClientError &&
                    error.kind === 'etherfuse_api' &&
                    error.status === 400;
                dispatch({
                    type: 'error',
                    error: toError(error),
                    phase: expired ? 'quote_expired' : 'quote_ready',
                });
                throw error;
            }
        },
        [client, latest, waitForBurn],
    );

    const sign = useCallback(async () => {
        const { order, burnXdr, phase } = latest.current;
        if (!signer) throw new Error('No signer connected');
        if (!order || !burnXdr || phase !== 'transaction_ready') {
            throw new Error(`Cannot sign from phase "${phase}"`);
        }

        const config = await ensureConfig();
        dispatch({ type: 'phase', phase: 'signing' });
        try {
            const result = await signer.signTransaction({
                xdr: burnXdr,
                networkPassphrase: config.networkPassphrase,
                purpose: 'offramp_burn',
                orderId: order.orderId,
            });
            if ('signedXdr' in result) {
                dispatch({ type: 'submitted', hash: null });
                const { hash } = await submitToHorizon({
                    horizonUrl: config.horizonUrl,
                    signedXdr: result.signedXdr,
                });
                dispatch({ type: 'submitted', hash });
            } else {
                dispatch({ type: 'submitted', hash: result.hash });
            }
        } catch (error) {
            if (error instanceof TransactionFailedError && error.expired) {
                // XDR died between ready and submit: regenerate and re-sign.
                dispatch({ type: 'phase', phase: 'transaction_expired' });
                void refreshRef.current().catch(() => undefined);
                return;
            }
            dispatch({ type: 'error', error: toError(error), phase: 'transaction_ready' });
            throw error;
        }
    }, [signer, ensureConfig, latest, refreshRef]);

    const resume = useCallback(
        async (orderId: string) => {
            orderIdRef.current = orderId;
            const order = await client.getOrder(orderId);
            const phase = offrampPhaseFor(order);
            dispatch({ type: 'order', order, phase });
            if (phase === 'awaiting_transaction') {
                void waitForBurn(orderId, null);
            } else if (phase === 'transaction_ready' && order.burnTransaction) {
                // Age unknown after resume — treat as fresh now; the staleness
                // timer (or a failed submit) regenerates if it was stale.
                dispatch({ type: 'burn', xdr: order.burnTransaction });
            }
        },
        [client, waitForBurn],
    );

    const reset = useCallback(() => {
        waitAbort.current?.abort();
        orderIdRef.current = null;
        lastQuoteArgs.current = null;
        dispatch({ type: 'reset' });
    }, []);

    return {
        phase: state.phase,
        quote: state.quote,
        order: state.order,
        burnXdr: state.burnXdr,
        preflightIssues: state.preflightIssues,
        txHash: state.txHash,
        error: state.error,
        actions: useMemo(
            () => ({
                requestQuote,
                refreshQuote,
                start,
                sign,
                refreshTransaction,
                resume,
                reset,
            }),
            [requestQuote, refreshQuote, start, sign, refreshTransaction, resume, reset],
        ),
    };
}
