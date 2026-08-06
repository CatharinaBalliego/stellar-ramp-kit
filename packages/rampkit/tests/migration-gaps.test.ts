/** The five gaps reported when migrating a real project off the copied
 *  starter-pack files (2026-08-06): PIX deposits, presigned hosted
 *  onboarding + "see org" recovery, wallet-scoped KYC enum, exchangeRate
 *  fallback, and sandboxApproveKyc. */

import { describe, expect, it } from 'vitest';
import { EtherfuseClient } from '../src/server/client';
import { RampkitError } from '../src/core/errors';
import { mockFetch, WIRE_ORDER, type Route } from './helpers';

const client = (routes: Route[]) =>
    new EtherfuseClient({ apiKey: 'api_sand_t', fetch: mockFetch(routes) });

describe('PIX deposits (Brazil)', () => {
    it('maps PIX wire fields to a pix-rail deposit', async () => {
        const c = client([
            {
                method: 'GET',
                path: '/ramp/order/o-br',
                respond: {
                    status: 200,
                    body: {
                        ...WIRE_ORDER,
                        orderId: 'o-br',
                        depositClabe: null,
                        depositBankName: null,
                        depositAccountHolder: 'Etherfuse BR',
                        depositPixCode: '00020126BR...',
                        depositPixKey: 'chave@etherfuse.com',
                        depositPixKeyType: 'email',
                        amountInFiat: 250.5,
                    },
                },
            },
        ]);
        const order = await c.getOrder('o-br');
        expect(order.deposit).toEqual({
            rail: 'pix',
            pixCode: '00020126BR...',
            pixKey: 'chave@etherfuse.com',
            pixKeyType: 'email',
            beneficiary: 'Etherfuse BR',
            amount: '250.5',
        });
    });

    it('still prefers SPEI when a CLABE is present', async () => {
        const c = client([
            { method: 'GET', path: '/ramp/order/o-1', respond: { status: 200, body: WIRE_ORDER } },
        ]);
        const order = await c.getOrder('o-1');
        expect(order.deposit?.rail).toBe('spei');
    });
});

describe('exchangeRate fallback when the sandbox omits it', () => {
    const quoteRoute = (body: Record<string, unknown>): Route => ({
        method: 'POST',
        path: '/ramp/quote',
        respond: (req) => ({
            status: 200,
            body: {
                quoteId: 'q-1',
                quoteAssets: (req as Record<string, unknown>)['quoteAssets'],
                createdAt: '2026-08-06T12:00:00Z',
                expiresAt: '2026-08-06T12:02:00Z',
                feeBps: null,
                feeAmount: null,
                destinationAmountAfterFee: null,
                ...body,
            },
        }),
    });

    it('derives fiat-per-token for onramp (source=fiat)', async () => {
        const c = client([
            quoteRoute({ sourceAmount: '500', destinationAmount: '49.75', exchangeRate: '' }),
        ]);
        const quote = await c.createQuote({
            customerId: 'c-1',
            publicKey: 'G1',
            direction: 'onramp',
            asset: 'CETES:GX',
            fiat: 'MXN',
            amount: '500',
        });
        expect(Number(quote.exchangeRate)).toBeCloseTo(500 / 49.75, 10);
    });

    it('derives fiat-per-token for offramp (destination=fiat)', async () => {
        const c = client([
            quoteRoute({ sourceAmount: '5', destinationAmount: '50.25', exchangeRate: null }),
        ]);
        const quote = await c.createQuote({
            customerId: 'c-1',
            publicKey: 'G1',
            direction: 'offramp',
            asset: 'CETES:GX',
            fiat: 'MXN',
            amount: '5',
        });
        expect(Number(quote.exchangeRate)).toBeCloseTo(50.25 / 5, 10);
    });

    it('keeps the wire value when present', async () => {
        const c = client([
            quoteRoute({ sourceAmount: '500', destinationAmount: '49.75', exchangeRate: '10.05' }),
        ]);
        const quote = await c.createQuote({
            customerId: 'c-1',
            publicKey: 'G1',
            direction: 'onramp',
            asset: 'CETES:GX',
            fiat: 'MXN',
            amount: '500',
        });
        expect(quote.exchangeRate).toBe('10.05');
    });
});

describe('createHostedOnboarding (deprecated presigned flow)', () => {
    it('returns the presigned URL for a fresh customer', async () => {
        const route: Route = {
            method: 'POST',
            path: '/ramp/onboarding-url',
            respond: { status: 200, body: { presigned_url: 'https://sandbox.etherfuse.com/x' } },
        };
        const c = client([route]);
        const result = await c.createHostedOnboarding({
            email: 'ana@example.com',
            publicKey: 'GANA',
        });
        expect(result.presignedUrl).toBe('https://sandbox.etherfuse.com/x');
        expect(result.recovered).toBe(false);
        const sent = route.calls![0]!.body as Record<string, unknown>;
        expect(sent['userInfo']).toEqual({
            email: 'ana@example.com',
            displayName: 'ana@example.com',
        });
        expect(sent['blockchain']).toBe('stellar');
    });

    it('recovers the existing customer from the documented "see org" 409 and retries', async () => {
        const existing = '123e4567-e89b-12d3-a456-426614174000';
        let calls = 0;
        const route: Route = {
            method: 'POST',
            path: '/ramp/onboarding-url',
            respond: () => {
                calls += 1;
                return calls === 1
                    ? {
                          status: 409,
                          body: `You have already added user with this address, see org: ${existing}`,
                      }
                    : { status: 200, body: { presigned_url: 'https://fresh.url' } };
            },
        };
        const c = client([route]);
        const result = await c.createHostedOnboarding({
            email: 'ana@example.com',
            publicKey: 'GANA',
        });
        expect(result.recovered).toBe(true);
        expect(result.customerId).toBe(existing);
        expect(result.presignedUrl).toBe('https://fresh.url');
        // The retry reused the EXISTING customer id.
        expect((route.calls![1]!.body as Record<string, unknown>)['customerId']).toBe(existing);
    });
});

describe('wallet-scoped KYC status (different enum than customer-level)', () => {
    it('passes through proposed / approved_chain_deploying / rejected', async () => {
        const c = client([
            {
                method: 'GET',
                path: '/ramp/customer/c-1/kyc/GANA',
                respond: {
                    status: 200,
                    body: {
                        customerId: 'c-1',
                        walletPublicKey: 'GANA',
                        status: 'approved_chain_deploying',
                    },
                },
            },
        ]);
        const kyc = await c.getWalletKyc('c-1', 'GANA');
        expect(kyc.status).toBe('approved_chain_deploying');
        expect(kyc.walletPublicKey).toBe('GANA');
    });
});

describe('sandboxApproveKyc', () => {
    it('submits identity then accepts the 3 agreements, each with a FRESH presigned URL', async () => {
        let presignedCount = 0;
        const kycRoute: Route = {
            method: 'POST',
            path: '/ramp/customer/c-1/kyc',
            respond: { status: 200, body: {} },
        };
        const onboardingRoute: Route = {
            method: 'POST',
            path: '/ramp/onboarding-url',
            respond: () => {
                presignedCount += 1;
                return { status: 200, body: { presigned_url: `https://p/${presignedCount}` } };
            },
        };
        const agreements: Route = {
            method: 'POST',
            path: (p) => p.startsWith('/ramp/agreements/'),
            respond: { status: 200, body: { success: true } },
        };
        const c = client([kycRoute, onboardingRoute, agreements]);

        await c.sandboxApproveKyc({ customerId: 'c-1', publicKey: 'GANA' });

        expect(kycRoute.calls).toHaveLength(1);
        expect(
            (kycRoute.calls![0]!.body as Record<string, unknown>)['pubkey'],
        ).toBe('GANA');
        expect(presignedCount).toBe(3); // one fresh URL per agreement
        expect(agreements.calls!.map((call) => call.path)).toEqual([
            '/ramp/agreements/electronic-signature',
            '/ramp/agreements/terms-and-conditions',
            '/ramp/agreements/customer-agreement',
        ]);
        // Each agreement got ITS OWN fresh presigned URL.
        expect(
            agreements.calls!.map(
                (call) => (call.body as Record<string, unknown>)['presignedUrl'],
            ),
        ).toEqual(['https://p/1', 'https://p/2', 'https://p/3']);
    });

    it('refuses to run outside sandbox', async () => {
        const c = new EtherfuseClient({ apiKey: 'api_prod_t', fetch: mockFetch([]) });
        await expect(
            c.sandboxApproveKyc({ customerId: 'c', publicKey: 'G' }),
        ).rejects.toBeInstanceOf(RampkitError);
    });
});
