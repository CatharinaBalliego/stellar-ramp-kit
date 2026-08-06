import { HorizonError, TransactionFailedError } from './errors';
import type { PreflightIssue, PreflightResult } from './types';

interface HorizonBalanceLine {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
}

interface HorizonAccount {
    id: string;
    subentry_count: number;
    balances: HorizonBalanceLine[];
}

type Fetch = typeof globalThis.fetch;

/** Load a Stellar account from Horizon. Returns `null` when it doesn't exist. */
export async function fetchAccount(
    horizonUrl: string,
    publicKey: string,
    fetchImpl: Fetch = fetch,
): Promise<HorizonAccount | null> {
    let response: Response;
    try {
        response = await fetchImpl(`${horizonUrl}/accounts/${encodeURIComponent(publicKey)}`, {
            headers: { Accept: 'application/json' },
        });
    } catch (cause) {
        throw new HorizonError(`Horizon unreachable: ${(cause as Error).message}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new HorizonError(`Horizon error ${response.status}`, response.status);
    }
    return (await response.json()) as HorizonAccount;
}

/**
 * Offramp preflight: verify the wallet can actually fund a burn transaction
 * BEFORE creating the order. When it can't, Etherfuse silently produces no
 * `burnTransaction` and no webhook — the order would hang in `created`.
 *
 * Checks: account exists on-chain; XLM above the network minimum reserve
 * (`(2 + subentries) * 0.5` plus fee margin); trustline for the asset being
 * sold; asset balance covering the quoted amount.
 */
export async function offrampPreflight(args: {
    horizonUrl: string;
    publicKey: string;
    /** `CODE:ISSUER` identifier of the asset being sold. */
    assetIdentifier: string;
    /** Quoted source amount to sell. */
    amount: string;
    fetch?: Fetch;
}): Promise<PreflightResult> {
    const account = await fetchAccount(args.horizonUrl, args.publicKey, args.fetch);
    if (!account) {
        return { ok: false, issues: [{ code: 'account_not_found', publicKey: args.publicKey }] };
    }

    const issues: PreflightIssue[] = [];
    const [code, issuer] = args.assetIdentifier.split(':');

    const native = account.balances.find((b) => b.asset_type === 'native');
    const xlm = Number(native?.balance ?? '0');
    // Base reserve 0.5 XLM: minimum = (2 + subentries) * 0.5, plus fee margin.
    const required = (2 + account.subentry_count) * 0.5 + 0.01;
    if (xlm < required) {
        issues.push({
            code: 'insufficient_xlm',
            available: native?.balance ?? '0',
            required: required.toFixed(2),
        });
    }

    const line = account.balances.find(
        (b) => b.asset_code === code && b.asset_issuer === issuer,
    );
    if (!line) {
        issues.push({ code: 'missing_trustline', asset: args.assetIdentifier });
    } else if (Number(line.balance) < Number(args.amount)) {
        issues.push({
            code: 'insufficient_asset_balance',
            asset: args.assetIdentifier,
            available: line.balance,
            required: args.amount,
        });
    }

    if (issues.length > 0) return { ok: false, issues };
    return {
        ok: true,
        xlmBalance: native?.balance ?? '0',
        assetBalance: line?.balance ?? '0',
    };
}

/**
 * Submit a signed XDR to Horizon. Used when the signer returns `{ signedXdr }`;
 * signers that submit themselves return `{ hash }` and skip this.
 *
 * @throws {TransactionFailedError} when Horizon rejects the transaction —
 *   `.expired` is true for `tx_too_late` (stale XDR → regenerate).
 * @throws {HorizonError} on transport or non-transaction errors.
 */
export async function submitToHorizon(args: {
    horizonUrl: string;
    signedXdr: string;
    fetch?: Fetch;
}): Promise<{ hash: string }> {
    const fetchImpl = args.fetch ?? fetch;
    let response: Response;
    try {
        response = await fetchImpl(`${args.horizonUrl}/transactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `tx=${encodeURIComponent(args.signedXdr)}`,
        });
    } catch (cause) {
        throw new HorizonError(`Horizon unreachable: ${(cause as Error).message}`);
    }

    const body = (await response.json().catch(() => null)) as {
        hash?: string;
        extras?: { result_codes?: { transaction?: string; operations?: string[] } };
        detail?: string;
    } | null;

    if (response.ok && body?.hash) return { hash: body.hash };

    const codes = body?.extras?.result_codes;
    if (codes) throw new TransactionFailedError(codes);
    throw new HorizonError(body?.detail ?? `Horizon error ${response.status}`, response.status);
}
