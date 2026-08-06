import { describe, expect, it } from 'vitest';
import { EtherfuseClient } from '../src/server/client';
import {
    DuplicatePendingOrderError,
    EtherfuseApiError,
    OfframpPreflightError,
} from '../src/core/errors';
import { mockFetch, WIRE_ORDER, type Route } from './helpers';

const makeClient = (routes: Route[], config: Partial<ConstructorParameters<typeof EtherfuseClient>[0]> = {}) =>
    new EtherfuseClient({
        apiKey: 'api_sand_test',
        fetch: mockFetch(routes),
        ...config,
    });

describe('environment inference', () => {
    it('infers sandbox from api_sand_ prefix', () => {
        expect(new EtherfuseClient({ apiKey: 'api_sand_x' }).environment).toBe('sandbox');
    });
    it('infers production from api_prod_ prefix', () => {
        expect(new EtherfuseClient({ apiKey: 'api_prod_x' }).environment).toBe('production');
    });
    it('defaults unknown prefixes to sandbox and emits an event', () => {
        const events: string[] = [];
        const client = new EtherfuseClient({
            apiKey: 'whatever',
            onEvent: (e) => events.push(e.type),
        });
        expect(client.environment).toBe('sandbox');
        expect(events).toContain('config:environment-defaulted');
    });
    it('explicit environment wins over the prefix', () => {
        expect(
            new EtherfuseClient({ apiKey: 'api_sand_x', environment: 'production' }).environment,
        ).toBe('production');
    });
});

describe('error handling matches the wire', () => {
    it('parses {"error": "<string>"} bodies (NOT {error:{code,message}})', async () => {
        const client = makeClient([
            {
                method: 'GET',
                path: '/ramp/order/o-404',
                respond: { status: 404, body: { error: 'Order not found' } },
            },
        ]);
        const error = await client.getOrder('o-404').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EtherfuseApiError);
        expect((error as EtherfuseApiError).status).toBe(404);
        expect((error as EtherfuseApiError).message).toBe('Order not found');
    });

    it('keeps plain-text error bodies as the message', async () => {
        const client = makeClient([
            {
                method: 'GET',
                path: '/ramp/order/o-401',
                respond: { status: 401, body: 'Unauthorized' },
            },
        ]);
        const error = await client.getOrder('o-401').catch((e: unknown) => e);
        expect((error as EtherfuseApiError).status).toBe(401);
        expect((error as EtherfuseApiError).message).toBe('Unauthorized');
    });

    it('sends the raw key — no Bearer prefix', async () => {
        const routes: Route[] = [
            { method: 'GET', path: '/ramp/order/o-1', respond: { status: 200, body: WIRE_ORDER } },
        ];
        await makeClient(routes).getOrder('o-1');
        expect(routes[0]!.calls![0]!.headers['authorization']).toBe('api_sand_test');
    });
});

describe('createQuote', () => {
    it('coerces amount to a JSON string and sends walletAddress for onramp only', async () => {
        const quoteRoute: Route = {
            method: 'POST',
            path: '/ramp/quote',
            respond: (body) => ({
                status: 200,
                body: {
                    quoteId: 'q-1',
                    quoteAssets: (body as Record<string, unknown>)['quoteAssets'],
                    sourceAmount: '500',
                    destinationAmount: '49.75',
                    destinationAmountAfterFee: '49.55',
                    exchangeRate: '10.05',
                    feeBps: '20',
                    feeAmount: '1',
                    expiresAt: '2026-08-04T12:02:00Z',
                    createdAt: '2026-08-04T12:00:00Z',
                },
            }),
        };
        const client = makeClient([quoteRoute]);

        const quote = await client.createQuote({
            customerId: 'c-1',
            publicKey: 'GWALLET',
            direction: 'onramp',
            asset: 'CETES:GTEST',
            fiat: 'MXN',
            amount: 500, // number leaks from <input type=number>
        });

        const sent = quoteRoute.calls![0]!.body as Record<string, unknown>;
        expect(sent['sourceAmount']).toBe('500');
        expect(typeof sent['sourceAmount']).toBe('string');
        expect(sent['walletAddress']).toBe('GWALLET');
        expect(sent['quoteAssets']).toEqual({
            type: 'onramp',
            sourceAsset: 'MXN',
            targetAsset: 'CETES:GTEST',
        });
        expect(quote.destinationAmount).toBe('49.55'); // after-fee wins

        // offramp: no walletAddress, assets flipped
        await client.createQuote({
            customerId: 'c-1',
            publicKey: 'GWALLET',
            direction: 'offramp',
            asset: 'CETES:GTEST',
            fiat: 'MXN',
            amount: '5',
        });
        const sent2 = quoteRoute.calls![1]!.body as Record<string, unknown>;
        expect(sent2['walletAddress']).toBeUndefined();
        expect(sent2['quoteAssets']).toEqual({
            type: 'offramp',
            sourceAsset: 'CETES:GTEST',
            targetAsset: 'MXN',
        });
    });

    it("resolves bare symbols via /ramp/assets using the quote's own fiat (not hardcoded MXN)", async () => {
        const assetsRoute: Route = {
            method: 'GET',
            path: (p) => p.startsWith('/ramp/assets'),
            respond: {
                status: 200,
                body: {
                    assets: [
                        {
                            symbol: 'TESOURO',
                            identifier: 'TESOURO:GBRL',
                            name: 'Tesouro',
                            currency: 'BRL',
                            balance: null,
                            image: null,
                        },
                    ],
                },
            },
        };
        const quoteRoute: Route = {
            method: 'POST',
            path: '/ramp/quote',
            respond: (body) => ({
                status: 200,
                body: {
                    quoteId: 'q-2',
                    quoteAssets: (body as Record<string, unknown>)['quoteAssets'],
                    sourceAmount: '100',
                    destinationAmount: '95',
                    destinationAmountAfterFee: null,
                    exchangeRate: '1.05',
                    feeBps: null,
                    feeAmount: null,
                    expiresAt: '2026-08-04T12:02:00Z',
                    createdAt: '2026-08-04T12:00:00Z',
                },
            }),
        };
        const client = makeClient([assetsRoute, quoteRoute]);

        await client.createQuote({
            customerId: 'c-1',
            publicKey: 'GWALLET',
            direction: 'offramp',
            asset: 'TESOURO',
            fiat: 'BRL',
            amount: '100',
        });

        // currency filter came from the quote's fiat, wallet was sent
        expect(assetsRoute.calls![0]!.path).toContain('currency=brl');
        expect(assetsRoute.calls![0]!.path).toContain('wallet=GWALLET');
        const sent = quoteRoute.calls![0]!.body as Record<string, unknown>;
        expect(sent['quoteAssets']).toEqual({
            type: 'offramp',
            sourceAsset: 'TESOURO:GBRL',
            targetAsset: 'BRL',
        });
    });
});

describe('createOnrampOrder 409 disambiguation (no message parsing)', () => {
    const conflict: Route = {
        method: 'POST',
        path: '/ramp/order',
        respond: { status: 409, body: 'An order with this transaction ID already exists' },
    };

    it('409 then GET 200 → idempotent success, marked recovered', async () => {
        const client = makeClient([
            conflict,
            {
                method: 'GET',
                path: (p) => p.startsWith('/ramp/order/'),
                respond: { status: 200, body: WIRE_ORDER },
            },
        ]);
        const order = await client.createOnrampOrder({
            customerId: 'c-1',
            publicKey: 'GW',
            quoteId: 'q-1',
            bankAccountId: 'b-1',
            orderId: 'o-1',
        });
        expect(order.recovered).toBe(true);
        expect(order.orderId).toBe('o-1');
    });

    it('409 then GET 404 → DuplicatePendingOrderError (order never created)', async () => {
        const client = makeClient([
            { ...conflict, respond: { status: 409, body: 'A pending onramp order already exists' } },
            {
                method: 'GET',
                path: (p) => p.startsWith('/ramp/order/'),
                respond: { status: 404, body: { error: 'Order not found' } },
            },
        ]);
        await expect(
            client.createOnrampOrder({
                customerId: 'c-1',
                publicKey: 'GW',
                quoteId: 'q-1',
                bankAccountId: 'b-1',
                orderId: 'o-x',
            }),
        ).rejects.toBeInstanceOf(DuplicatePendingOrderError);
    });
});

describe('order mapping — nothing fabricated', () => {
    it('normalizes wire numbers to strings and nulls what is absent', async () => {
        const client = makeClient([
            { method: 'GET', path: '/ramp/order/o-1', respond: { status: 200, body: WIRE_ORDER } },
        ]);
        const order = await client.getOrder('o-1');
        expect(order.amountInFiat).toBe('500'); // number → string
        expect(order.amountInTokens).toBeNull(); // absent → null, NOT ''
        expect(order.sourceAsset).toBe('MXN'); // passthrough, NOT ''
        expect(order.exchangeRate).toBe('10.05');
        expect(order.deposit).toEqual({
            rail: 'spei',
            clabe: '646180157000000004',
            bankName: 'STP',
            beneficiary: 'Etherfuse MX',
            amount: '500',
        });
    });
});

describe('createOfframpOrder preflight', () => {
    it('refuses to create the order when the wallet cannot fund the burn', async () => {
        const client = makeClient([
            {
                method: 'GET',
                path: (p) => p.startsWith('/accounts/'),
                respond: { status: 404, body: { status: 404 } },
            },
        ]);
        const error = await client
            .createOfframpOrder({
                customerId: 'c-1',
                publicKey: 'GEMPTY',
                quote: { id: 'q-1', sourceAsset: 'CETES:GTEST', sourceAmount: '5' },
                bankAccountId: 'b-1',
            })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OfframpPreflightError);
        expect((error as OfframpPreflightError).issues[0]!.code).toBe('account_not_found');
    });
});

describe('regenerateTransaction', () => {
    it('maps 200 with XDR to onramp_sync and 202 to offramp_async', async () => {
        const client = makeClient([
            {
                method: 'POST',
                path: '/ramp/order/on-1/regenerate_tx',
                respond: { status: 200, body: { stellarClaimTransaction: 'XDR_FRESH' } },
            },
            {
                method: 'POST',
                path: '/ramp/order/off-1/regenerate_tx',
                respond: { status: 202, body: '' },
            },
        ]);
        expect(await client.regenerateTransaction('on-1')).toEqual({
            kind: 'onramp_sync',
            stellarClaimTransaction: 'XDR_FRESH',
        });
        expect(await client.regenerateTransaction('off-1')).toEqual({ kind: 'offramp_async' });
    });
});

describe('simulateFiatReceived', () => {
    it('throws in production and on API errors (never swallows)', async () => {
        const prod = new EtherfuseClient({ apiKey: 'api_prod_x', fetch: mockFetch([]) });
        await expect(prod.simulateFiatReceived('o-1')).rejects.toThrow(/sandbox-only/);

        const sand = makeClient([
            {
                method: 'POST',
                path: '/ramp/order/fiat_received',
                respond: { status: 404, body: { error: 'Order not found' } },
            },
        ]);
        await expect(sand.simulateFiatReceived('o-1')).rejects.toBeInstanceOf(EtherfuseApiError);
    });
});

describe('listAssets', () => {
    it('requires wallet (the API rejects blank wallets)', async () => {
        const client = makeClient([]);
        await expect(client.listAssets({ currency: 'MXN', wallet: '' })).rejects.toThrow(
            /wallet is required/,
        );
    });
});

describe('deposit instructions mapping (SPEI and PIX)', () => {
    it('maps PIX wire fields to a pix-rail deposit', async () => {
        const client = makeClient([
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
        const order = await client.getOrder('o-br');
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
        const client = makeClient([
            { method: 'GET', path: '/ramp/order/o-1', respond: { status: 200, body: WIRE_ORDER } },
        ]);
        const order = await client.getOrder('o-1');
        expect(order.deposit?.rail).toBe('spei');
    });
});

describe('quote exchangeRate fallback when the sandbox omits it', () => {
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
        const client = makeClient([
            quoteRoute({ sourceAmount: '500', destinationAmount: '49.75', exchangeRate: '' }),
        ]);
        const quote = await client.createQuote({
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
        const client = makeClient([
            quoteRoute({ sourceAmount: '5', destinationAmount: '50.25', exchangeRate: null }),
        ]);
        const quote = await client.createQuote({
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
        const client = makeClient([
            quoteRoute({ sourceAmount: '500', destinationAmount: '49.75', exchangeRate: '10.05' }),
        ]);
        const quote = await client.createQuote({
            customerId: 'c-1',
            publicKey: 'G1',
            direction: 'onramp',
            asset: 'CETES:GX',
            fiat: 'MXN',
            amount: '500',
        });
        expect(quote.exchangeRate).toBe('10.05');
    });

    it('omits walletAddress on onramp when publicKey is empty', async () => {
        const route = quoteRoute({
            sourceAmount: '500',
            destinationAmount: '49.75',
            exchangeRate: '10.05',
        });
        await makeClient([route]).createQuote({
            customerId: 'c-1',
            publicKey: '',
            direction: 'onramp',
            asset: 'CETES:GX',
            fiat: 'MXN',
            amount: '500',
        });
        const sent = route.calls![0]!.body as Record<string, unknown>;
        expect('walletAddress' in sent).toBe(false);
    });

    it('still sends walletAddress on onramp when present', async () => {
        const route = quoteRoute({
            sourceAmount: '500',
            destinationAmount: '49.75',
            exchangeRate: '10.05',
        });
        await makeClient([route]).createQuote({
            customerId: 'c-1',
            publicKey: 'GANA',
            direction: 'onramp',
            asset: 'CETES:GX',
            fiat: 'MXN',
            amount: '500',
        });
        expect((route.calls![0]!.body as Record<string, unknown>)['walletAddress']).toBe('GANA');
    });
});
