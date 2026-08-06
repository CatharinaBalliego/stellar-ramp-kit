import {
    DuplicatePendingOrderError,
    EtherfuseApiError,
    HorizonError,
    OfframpPreflightError,
} from '../core/errors';
import type { CreatedCustomer, RampErrorEnvelope, RampOperation } from '../core/types';
import type { EtherfuseClient } from './client';
import {
    BadParamsError,
    NotOwnedError,
    RAMP_OPERATIONS,
    type OperationSpec,
    type RampSession,
} from './operations';

/**
 * Resolves the caller's identity for an incoming request. REQUIRED — this is
 * what stops one user from reading another's orders by editing a UUID.
 * Return `null` for unauthenticated requests.
 */
export type GetSession = (
    request: Request,
    params: Record<string, unknown>,
) => Promise<RampSession | null> | RampSession | null;

/**
 * DANGEROUS prototyping escape hatch: trusts the `customerId` / `publicKey`
 * the BROWSER sends. Anyone can act as any customer. Never ship this.
 */
export const unsafeTrustClient: GetSession = (_request, params) => {
    const customerId = params['customerId'];
    const publicKey = params['publicKey'];
    if (typeof customerId !== 'string' || typeof publicKey !== 'string') return null;
    return { customerId, publicKey };
};

export interface CreateRampHandlerOptions {
    client: EtherfuseClient;
    getSession: GetSession;
    /** Restrict which operations this route exposes. Default: all. */
    operations?: readonly RampOperation[];
    /**
     * Called after `customer.create` succeeds, BEFORE the response is sent —
     * persist `customer.customerId` on your user record here, so the browser
     * response is never the only copy. Throwing fails the request (the
     * Etherfuse customer already exists at that point; `createCustomer` is
     * idempotent per id, so the retry path is safe).
     */
    onCustomerCreated?: (args: {
        request: Request;
        session: RampSession;
        customer: CreatedCustomer;
    }) => void | Promise<void>;
}

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

const failure = (status: number, error: RampErrorEnvelope['error']): Response =>
    json(status, { error } satisfies RampErrorEnvelope);

/**
 * Web-standard route handler for the Rampkit operations. Mount it once on a
 * catch-all route; the operation name is the last path segment:
 *
 * ```ts
 * // app/api/ramp/[...op]/route.ts
 * export const POST = createRampHandler({ client, getSession });
 * export const GET = POST;
 * ```
 *
 * Dispatch goes through the frozen {@link RAMP_OPERATIONS} map — a browser
 * string can never become an Etherfuse path.
 */
export function createRampHandler(
    options: CreateRampHandlerOptions,
): (request: Request) => Promise<Response> {
    const { client, getSession } = options;
    const allowed = new Set<string>(
        options.operations ?? (Object.keys(RAMP_OPERATIONS) as RampOperation[]),
    );

    return async (request: Request): Promise<Response> => {
        // Operation = last non-empty path segment.
        const url = new URL(request.url);
        const segments = url.pathname.split('/').filter(Boolean);
        const op = decodeURIComponent(segments[segments.length - 1] ?? '');

        const spec: OperationSpec | undefined = Object.prototype.hasOwnProperty.call(
            RAMP_OPERATIONS,
            op,
        )
            ? RAMP_OPERATIONS[op as RampOperation]
            : undefined;
        if (!spec || !allowed.has(op)) {
            return failure(404, { kind: 'not_found', message: `Unknown operation: ${op}` });
        }
        if (spec.sandboxOnly && client.environment === 'production') {
            return failure(404, { kind: 'not_found', message: `Unknown operation: ${op}` });
        }
        if (request.method !== spec.method) {
            return failure(405, {
                kind: 'method_not_allowed',
                message: `${op} requires ${spec.method}`,
            });
        }

        let params: Record<string, unknown>;
        if (spec.method === 'GET') {
            params = Object.fromEntries(url.searchParams);
        } else {
            try {
                const body: unknown = await request.json();
                params =
                    typeof body === 'object' && body !== null
                        ? (body as Record<string, unknown>)
                        : {};
            } catch {
                return failure(400, { kind: 'bad_request', message: 'Invalid JSON body' });
            }
        }

        let session: RampSession | null = null;
        if (spec.scope !== 'public') {
            session = await getSession(request, params);
            if (!session) {
                return failure(401, { kind: 'unauthorized', message: 'No session' });
            }
            // `signup` runs before the Etherfuse identity exists; everything
            // else needs the full identity.
            if (spec.scope !== 'signup' && (!session.customerId || !session.publicKey)) {
                return failure(401, {
                    kind: 'unauthorized',
                    message:
                        'Session has no Etherfuse identity — create the customer first (customer.create)',
                });
            }
        }

        try {
            const result = await spec.execute(client, session, params);
            if (op === 'customer.create' && options.onCustomerCreated) {
                await options.onCustomerCreated({
                    request,
                    session: session!,
                    customer: result as CreatedCustomer,
                });
            }
            return json(200, result);
        } catch (error) {
            return mapError(error);
        }
    };
}

function mapError(error: unknown): Response {
    if (error instanceof BadParamsError) {
        return failure(400, { kind: 'bad_request', message: error.message });
    }
    if (error instanceof NotOwnedError) {
        return failure(404, { kind: 'not_found', message: error.message });
    }
    if (error instanceof OfframpPreflightError) {
        return failure(422, {
            kind: 'preflight_failed',
            message: error.message,
            issues: error.issues,
        });
    }
    if (error instanceof DuplicatePendingOrderError) {
        return failure(409, { kind: 'duplicate_pending', message: error.message });
    }
    if (error instanceof EtherfuseApiError) {
        // Etherfuse 401 means OUR key is bad — never confuse the browser's
        // session state with it; the envelope kind disambiguates.
        return failure(error.status, {
            kind: 'etherfuse_api',
            status: error.status,
            message: error.message,
        });
    }
    if (error instanceof HorizonError) {
        return failure(502, { kind: 'internal', message: error.message });
    }
    return failure(500, {
        kind: 'internal',
        message: error instanceof Error ? error.message : 'Internal error',
    });
}

// ---------------------------------------------------------------------------
// Node adapter (Express / Next Pages Router)
// ---------------------------------------------------------------------------

interface NodeRequestLike {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

interface NodeResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
}

/** Adapt the web-standard handler to Node's (req, res) callback style. */
export function toNodeHandler(
    handler: (request: Request) => Promise<Response>,
): (req: NodeRequestLike, res: NodeResponseLike) => Promise<void> {
    return async (req, res) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyText = Buffer.concat(chunks).toString('utf8');

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, value);
            else if (Array.isArray(value)) headers.set(name, value.join(', '));
        }

        const host = headers.get('host') ?? 'localhost';
        const method = req.method ?? 'GET';
        const request = new Request(`http://${host}${req.url ?? '/'}`, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' || bodyText === '' ? undefined : bodyText,
        });

        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.end(await response.text());
    };
}
