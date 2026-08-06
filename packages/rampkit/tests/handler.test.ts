import { describe, expect, it } from 'vitest';
import { EtherfuseClient } from '../src/server/client';
import { createRampHandler, unsafeTrustClient } from '../src/server/handler';
import type { RampErrorEnvelope } from '../src/core/types';
import { mockFetch, WIRE_ORDER, type Route } from './helpers';

const SESSION = { customerId: 'c-1', publicKey: 'GWALLET' };

const makeHandler = (
    routes: Route[],
    opts: { session?: typeof SESSION | null; environment?: 'sandbox' | 'production' } = {},
) =>
    createRampHandler({
        client: new EtherfuseClient({
            apiKey: opts.environment === 'production' ? 'api_prod_t' : 'api_sand_t',
            fetch: mockFetch(routes),
        }),
        getSession: () => (opts.session !== undefined ? opts.session : SESSION),
    });

const get = (op: string, qs = '') =>
    new Request(`http://app.local/api/ramp/${op}${qs}`, { method: 'GET' });
const post = (op: string, body: unknown) =>
    new Request(`http://app.local/api/ramp/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

const envelope = async (res: Response) =>
    ((await res.json()) as RampErrorEnvelope).error;

describe('dispatch', () => {
    it('404s unknown operations — no arbitrary path proxying', async () => {
        const res = await makeHandler([])(get('customer%2Fc-2%2Fbank-accounts'));
        expect(res.status).toBe(404);
        expect((await envelope(res)).kind).toBe('not_found');
    });

    it('405s a method mismatch', async () => {
        const res = await makeHandler([])(get('quote.create'));
        expect(res.status).toBe(405);
    });

    it('hides sandbox-only operations in production', async () => {
        const res = await makeHandler([], { environment: 'production' })(
            post('sandbox.simulateDeposit', { orderId: 'o-1' }),
        );
        expect(res.status).toBe(404);
    });

    it('401s customer-scoped operations without a session', async () => {
        const res = await makeHandler([], { session: null })(get('bankAccounts.list'));
        expect(res.status).toBe(401);
    });

    it('serves public config without a session', async () => {
        const res = await makeHandler([], { session: null })(get('config.get'));
        expect(res.status).toBe(200);
        const config = (await res.json()) as { networkPassphrase: string };
        expect(config.networkPassphrase).toContain('Test SDF');
    });
});

describe('identity comes from the session, never the body', () => {
    it('ignores a browser-supplied customerId on customer-scoped ops', async () => {
        const route: Route = {
            method: 'POST',
            path: '/ramp/customer/c-1/bank-accounts', // session's c-1, not body's c-EVIL
            respond: { status: 200, body: { items: [] } },
        };
        const res = await makeHandler([route])(get('bankAccounts.list', '?customerId=c-EVIL'));
        expect(res.status).toBe(200);
        expect(route.calls).toHaveLength(1);
    });

    it("order scope: another customer's order reads as not_found", async () => {
        const res = await makeHandler([
            {
                method: 'GET',
                path: '/ramp/order/o-1',
                respond: { status: 200, body: { ...WIRE_ORDER, customerId: 'c-OTHER' } },
            },
        ])(get('order.get', '?orderId=o-1'));
        expect(res.status).toBe(404);
        expect((await envelope(res)).kind).toBe('not_found');
    });

    it('order scope: own order is returned', async () => {
        const res = await makeHandler([
            { method: 'GET', path: '/ramp/order/o-1', respond: { status: 200, body: WIRE_ORDER } },
        ])(get('order.get', '?orderId=o-1'));
        expect(res.status).toBe(200);
        const order = (await res.json()) as { orderId: string; amountInFiat: string };
        expect(order.orderId).toBe('o-1');
        expect(order.amountInFiat).toBe('500');
    });
});

describe('error envelopes', () => {
    it('maps preflight failure to 422 with issues', async () => {
        const res = await makeHandler([
            {
                method: 'GET',
                path: (p) => p.startsWith('/accounts/'),
                respond: { status: 404, body: {} },
            },
        ])(
            post('offramp.createOrder', {
                quote: { id: 'q-1', sourceAsset: 'CETES:GX', sourceAmount: '5' },
                bankAccountId: 'b-1',
            }),
        );
        expect(res.status).toBe(422);
        const err = await envelope(res);
        expect(err.kind).toBe('preflight_failed');
        expect(err.issues?.[0]?.code).toBe('account_not_found');
    });

    it('passes Etherfuse API errors through with kind etherfuse_api', async () => {
        const res = await makeHandler([
            {
                method: 'POST',
                path: '/ramp/quote',
                respond: { status: 424, body: { error: 'FailedToGetQuote' } },
            },
        ])(
            post('quote.create', {
                direction: 'onramp',
                asset: 'CETES:GX',
                fiat: 'MXN',
                amount: '100',
            }),
        );
        expect(res.status).toBe(424);
        const err = await envelope(res);
        expect(err.kind).toBe('etherfuse_api');
        expect(err.message).toBe('FailedToGetQuote');
    });

    it('400s missing params with bad_request', async () => {
        const res = await makeHandler([])(post('quote.create', { direction: 'onramp' }));
        expect(res.status).toBe(400);
        expect((await envelope(res)).kind).toBe('bad_request');
    });
});

describe('unsafeTrustClient', () => {
    it('reads identity from params (the documented unsafe prototyping path)', async () => {
        const route: Route = {
            method: 'POST',
            path: '/ramp/customer/c-proto/bank-accounts',
            respond: { status: 200, body: { items: [] } },
        };
        const handler = createRampHandler({
            client: new EtherfuseClient({ apiKey: 'api_sand_t', fetch: mockFetch([route]) }),
            getSession: unsafeTrustClient,
        });
        const res = await handler(
            get('bankAccounts.list', '?customerId=c-proto&publicKey=GPROTO'),
        );
        expect(res.status).toBe(200);
    });
});
