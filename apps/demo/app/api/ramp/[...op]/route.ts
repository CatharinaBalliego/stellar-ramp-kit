import {
    EtherfuseClient,
    createRampHandler,
    type GetSession,
} from '@spacecathy/rampkit/server';

/**
 * Demo session: a fixed customer from env. rampkit v0 starts from an
 * approved customerId (onboarding is out of scope) — create and approve one
 * in the Etherfuse sandbox dashboard, then set DEMO_CUSTOMER_ID /
 * DEMO_PUBLIC_KEY in .env.local. In a real app this reads YOUR auth session.
 */
const demoSession: GetSession = () => {
    const customerId = process.env.DEMO_CUSTOMER_ID;
    const publicKey = process.env.DEMO_PUBLIC_KEY;
    if (!customerId || !publicKey) return null;
    return { customerId, publicKey };
};

// Lazy so `next build` succeeds without env vars present.
let handler: ((request: Request) => Promise<Response>) | null = null;

const handle = (request: Request): Promise<Response> => {
    handler ??= createRampHandler({
        client: new EtherfuseClient({
            apiKey: process.env.ETHERFUSE_API_KEY ?? '',
        }),
        getSession: demoSession,
    });
    return handler(request);
};

export const GET = handle;
export const POST = handle;
