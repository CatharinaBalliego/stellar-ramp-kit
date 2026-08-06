/** Tiny mock-fetch router for tests: match by method + path, respond JSON. */

export interface Route {
    method: 'GET' | 'POST';
    /** Exact pathname (+search) match, or a predicate. */
    path: string | ((path: string) => boolean);
    /** Status + body; body may be a string for plain-text error bodies. */
    respond:
        | { status: number; body: unknown }
        | ((body: unknown) => { status: number; body: unknown });
    /** Filled after each hit. */
    calls?: { path: string; body: unknown; headers: Record<string, string> }[];
}

export function mockFetch(routes: Route[]): typeof fetch & { routes: Route[] } {
    const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://mock.local');
        const pathWithSearch = url.pathname + url.search;
        const method = (init?.method ?? 'GET') as 'GET' | 'POST';
        const contentType = new Headers(init?.headers).get('content-type') ?? '';
        const rawBody = init?.body
            ? contentType.includes('json')
              ? (JSON.parse(String(init.body)) as unknown)
              : String(init.body)
            : undefined;

        const route = routes.find(
            (r) =>
                r.method === method &&
                (typeof r.path === 'string' ? r.path === pathWithSearch : r.path(pathWithSearch)),
        );
        if (!route) {
            throw new Error(`mockFetch: unmatched ${method} ${pathWithSearch}`);
        }
        (route.calls ??= []).push({
            path: pathWithSearch,
            body: rawBody,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });

        const result =
            typeof route.respond === 'function' ? route.respond(rawBody) : route.respond;
        const text =
            typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
        return new Response(text, {
            status: result.status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch & { routes: Route[] };
    impl.routes = routes;
    return impl;
}

export const WIRE_ORDER = {
    orderId: 'o-1',
    customerId: 'c-1',
    createdAt: '2026-08-04T12:00:00Z',
    updatedAt: '2026-08-04T12:00:00Z',
    orderType: 'onramp' as const,
    status: 'created' as const,
    statusPage: 'https://sandbox.etherfuse.com/ramp/order/o-1',
    // wire sends NUMBERS for amounts:
    amountInFiat: 500.0,
    walletId: 'w-1',
    bankAccountId: 'b-1',
    depositClabe: '646180157000000004',
    depositBankName: 'STP',
    depositAccountHolder: 'Etherfuse MX',
    sourceAsset: 'MXN',
    targetAsset: 'CETES:GTEST',
    exchangeRate: '10.05',
};
