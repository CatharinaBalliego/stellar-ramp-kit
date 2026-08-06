import { describe, expect, it } from 'vitest';
import { offrampPreflight, submitToHorizon } from '../src/core/horizon';
import { HorizonError, TransactionFailedError } from '../src/core/errors';
import { mockFetch } from './helpers';

const HORIZON = 'https://horizon-testnet.stellar.org';

const account = (overrides: Record<string, unknown> = {}) => ({
    id: 'GWALLET',
    subentry_count: 1, // one trustline → min reserve (2+1)*0.5 = 1.5 XLM
    balances: [
        { asset_type: 'native', balance: '5.0000000' },
        {
            asset_type: 'credit_alphanum4',
            asset_code: 'CETES',
            asset_issuer: 'GISSUER',
            balance: '10.00',
        },
    ],
    ...overrides,
});

describe('offrampPreflight', () => {
    const args = {
        horizonUrl: HORIZON,
        publicKey: 'GWALLET',
        assetIdentifier: 'CETES:GISSUER',
        amount: '5',
    };

    it('passes a funded wallet with the trustline and balance', async () => {
        const result = await offrampPreflight({
            ...args,
            fetch: mockFetch([
                { method: 'GET', path: '/accounts/GWALLET', respond: { status: 200, body: account() } },
            ]),
        });
        expect(result).toEqual({ ok: true, xlmBalance: '5.0000000', assetBalance: '10.00' });
    });

    it('flags a missing account', async () => {
        const result = await offrampPreflight({
            ...args,
            fetch: mockFetch([
                { method: 'GET', path: '/accounts/GWALLET', respond: { status: 404, body: {} } },
            ]),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues[0]!.code).toBe('account_not_found');
    });

    it('flags XLM below the subentry-aware reserve', async () => {
        const result = await offrampPreflight({
            ...args,
            fetch: mockFetch([
                {
                    method: 'GET',
                    path: '/accounts/GWALLET',
                    respond: {
                        status: 200,
                        body: account({
                            balances: [
                                { asset_type: 'native', balance: '1.4000000' }, // < 1.51
                                {
                                    asset_type: 'credit_alphanum4',
                                    asset_code: 'CETES',
                                    asset_issuer: 'GISSUER',
                                    balance: '10.00',
                                },
                            ],
                        }),
                    },
                },
            ]),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues).toEqual([
                { code: 'insufficient_xlm', available: '1.4000000', required: '1.51' },
            ]);
        }
    });

    it('flags a missing trustline and insufficient asset balance separately', async () => {
        const noLine = await offrampPreflight({
            ...args,
            fetch: mockFetch([
                {
                    method: 'GET',
                    path: '/accounts/GWALLET',
                    respond: {
                        status: 200,
                        body: account({
                            balances: [{ asset_type: 'native', balance: '5.0' }],
                        }),
                    },
                },
            ]),
        });
        expect(!noLine.ok && noLine.issues[0]!.code).toBe('missing_trustline');

        const lowBalance = await offrampPreflight({
            ...args,
            amount: '50',
            fetch: mockFetch([
                { method: 'GET', path: '/accounts/GWALLET', respond: { status: 200, body: account() } },
            ]),
        });
        expect(!lowBalance.ok && lowBalance.issues[0]!.code).toBe('insufficient_asset_balance');
    });
});

describe('submitToHorizon', () => {
    it('returns the hash on success', async () => {
        const result = await submitToHorizon({
            horizonUrl: HORIZON,
            signedXdr: 'SIGNED',
            fetch: mockFetch([
                {
                    method: 'POST',
                    path: '/transactions',
                    respond: { status: 200, body: { hash: 'abc123' } },
                },
            ]),
        });
        expect(result.hash).toBe('abc123');
    });

    it('detects tx_too_late as an expired transaction', async () => {
        const error = await submitToHorizon({
            horizonUrl: HORIZON,
            signedXdr: 'STALE',
            fetch: mockFetch([
                {
                    method: 'POST',
                    path: '/transactions',
                    respond: {
                        status: 400,
                        body: { extras: { result_codes: { transaction: 'tx_too_late' } } },
                    },
                },
            ]),
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TransactionFailedError);
        expect((error as TransactionFailedError).expired).toBe(true);
    });

    it('wraps transport failures as HorizonError', async () => {
        const failing = (() => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;
        const error = await submitToHorizon({
            horizonUrl: HORIZON,
            signedXdr: 'X',
            fetch: failing,
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HorizonError);
    });
});
