import { createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { EtherfuseClient } from '../src/server/client';
import { createJwks, createJwksHandler, signUserJwt } from '../src/server/onboarding';
import { mockFetch, type Route } from './helpers';

const sandboxClient = (routes: Route[]) =>
    new EtherfuseClient({ apiKey: 'api_sand_t', fetch: mockFetch(routes) });

let privateKey: string;
let publicKeyPem: string;

beforeAll(() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

const config = () => ({ issuer: 'https://minha-plataforma.com', privateKey, keyId: 'k1' });

const decode = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

describe('signUserJwt', () => {
    it('produces a valid RS256 JWT with the documented claims', () => {
        const { token, expiresAt } = signUserJwt({
            config: config(),
            audience: 'https://api.sand.etherfuse.com/auth/token',
            customerId: 'c-123',
            email: 'ana@example.com',
            name: 'Ana',
            scope: 'verification',
        });

        const [h, p, s] = token.split('.');
        const header = decode(h!);
        const payload = decode(p!);

        expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
        expect(payload['iss']).toBe('https://minha-plataforma.com');
        expect(payload['sub']).toBe('c-123'); // MUST be the customer's org id
        expect(payload['aud']).toBe('https://api.sand.etherfuse.com/auth/token');
        expect(payload['scope']).toBe('verification');
        expect(payload['email']).toBe('ana@example.com');
        expect(payload['name']).toBe('Ana');
        expect(typeof payload['jti']).toBe('string');
        expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(300);
        expect(new Date(expiresAt).getTime()).toBe((payload['exp'] as number) * 1000);

        // Signature verifies against the public key.
        const ok = createVerify('RSA-SHA256')
            .update(`${h}.${p}`)
            .verify(publicKeyPem, Buffer.from(s!, 'base64url'));
        expect(ok).toBe(true);
    });

    it('mints a fresh jti per token (replay protection)', () => {
        const args = {
            config: config(),
            audience: 'a',
            customerId: 'c',
            email: 'e@x.com',
            name: 'n',
            scope: 'verification' as const,
        };
        const a = decode(signUserJwt(args).token.split('.')[1]!);
        const b = decode(signUserJwt(args).token.split('.')[1]!);
        expect(a['jti']).not.toBe(b['jti']);
    });
});

describe('createJwks', () => {
    it('exports the RSA public key as a signed-use JWK set', () => {
        const jwks = createJwks({ privateKey, keyId: 'k1' });
        expect(jwks.keys).toHaveLength(1);
        const key = jwks.keys[0]!;
        expect(key['kty']).toBe('RSA');
        expect(key['kid']).toBe('k1');
        expect(key['use']).toBe('sig');
        expect(key['alg']).toBe('RS256');
        expect(typeof key['n']).toBe('string');
        expect(key['e']).toBe('AQAB');
        // Never leak private material.
        expect(key['d']).toBeUndefined();
        expect(key['p']).toBeUndefined();
    });

    it('handler serves the set as JSON', async () => {
        const handler = createJwksHandler({ privateKey, keyId: 'k1' });
        const res = await handler(new Request('http://x/.well-known/jwks.json'));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { keys: unknown[] };
        expect(body.keys).toHaveLength(1);
    });
});

describe('EtherfuseClient.createKycLaunch', () => {
    it('builds the /auth/launch form for the right environment', () => {
        const client = new EtherfuseClient({
            apiKey: 'api_sand_t',
            fetch: mockFetch([]),
            onboarding: config(),
        });
        const launch = client.createKycLaunch({
            customerId: 'c-9',
            email: 'ana@example.com',
            name: 'Ana',
            returnUrl: 'https://meu-app.com/volta',
            lang: 'es',
        });
        expect(launch.url).toBe('https://sandbox.etherfuse.com/auth/launch');
        expect(launch.fields.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(launch.fields.target).toBe('/idv?lang=es');
        expect(launch.fields.return_url).toBe('https://meu-app.com/volta');
        const payload = decode(launch.fields.assertion.split('.')[1]!);
        expect(payload['sub']).toBe('c-9');
        expect(payload['aud']).toBe('https://api.sand.etherfuse.com/auth/token');
    });

    it('fails loudly without the onboarding config', () => {
        const client = new EtherfuseClient({ apiKey: 'api_sand_t', fetch: mockFetch([]) });
        expect(() =>
            client.createKycLaunch({ customerId: 'c', email: 'e@x.com', name: 'n' }),
        ).toThrow(/onboarding/);
    });
});

describe('EtherfuseClient.createCustomer', () => {
    it('creates the org with required userInfo and registers the wallet', async () => {
        const orgRoute: Route = {
            method: 'POST',
            path: '/ramp/organization',
            respond: { status: 201, body: { organizationId: 'ignored' } },
        };
        const walletRoute: Route = {
            method: 'POST',
            path: (p) => /\/ramp\/customer\/[^/]+\/wallet$/.test(p),
            respond: { status: 200, body: { walletId: 'w-1' } },
        };
        const client = new EtherfuseClient({
            apiKey: 'api_sand_t',
            fetch: mockFetch([orgRoute, walletRoute]),
        });

        const created = await client.createCustomer({
            email: 'ana@example.com',
            publicKey: 'GANA',
            customerId: 'c-fixed',
        });

        const sentOrg = orgRoute.calls![0]!.body as Record<string, unknown>;
        expect(sentOrg['id']).toBe('c-fixed');
        expect(sentOrg['accountType']).toBe('personal');
        expect(sentOrg['userInfo']).toEqual({
            email: 'ana@example.com',
            displayName: 'ana@example.com',
        });
        const sentWallet = walletRoute.calls![0]!.body as Record<string, unknown>;
        expect(sentWallet).toEqual({ publicKey: 'GANA', blockchain: 'stellar' });
        expect(created).toEqual({ customerId: 'c-fixed', publicKey: 'GANA', recovered: false });
    });

    it('treats a 409 on the same id as an idempotent signup retry', async () => {
        const client = new EtherfuseClient({
            apiKey: 'api_sand_t',
            fetch: mockFetch([
                {
                    method: 'POST',
                    path: '/ramp/organization',
                    respond: { status: 409, body: 'already exists' },
                },
            ]),
        });
        const created = await client.createCustomer({
            email: 'ana@example.com',
            customerId: 'c-retry',
        });
        expect(created.recovered).toBe(true);
        expect(created.customerId).toBe('c-retry');
    });
});

describe('kyc operations via the handler', () => {
    it('kyc.status reads the session customer; kyc.startSession uses session identity', async () => {
        const { createRampHandler } = await import('../src/server/handler');
        const kycRoute: Route = {
            method: 'GET',
            path: '/ramp/customer/c-1/kyc?requirements=true',
            respond: {
                status: 200,
                body: {
                    customerId: 'c-1',
                    status: 'in_progress',
                    requirements: [
                        { type: 'selfie', status: 'pending', requiresLaunch: true },
                    ],
                },
            },
        };
        const handler = createRampHandler({
            client: new EtherfuseClient({
                apiKey: 'api_sand_t',
                fetch: mockFetch([kycRoute]),
                onboarding: config(),
            }),
            getSession: () => ({
                customerId: 'c-1',
                publicKey: 'G1',
                email: 'ana@example.com',
                name: 'Ana',
            }),
        });

        const status = await handler(
            new Request('http://x/api/ramp/kyc.status?requirements=true'),
        );
        expect(status.status).toBe(200);
        const kyc = (await status.json()) as { status: string; requirements: unknown[] };
        expect(kyc.status).toBe('in_progress');
        expect(kyc.requirements).toHaveLength(1);

        const launch = await handler(
            new Request('http://x/api/ramp/kyc.startSession', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}', // no email in body — must come from the session
            }),
        );
        expect(launch.status).toBe(200);
        const body = (await launch.json()) as {
            fields: { assertion: string };
        };
        const payload = decode(body.fields.assertion.split('.')[1]!);
        expect(payload['sub']).toBe('c-1');
        expect(payload['email']).toBe('ana@example.com');
    });
});

describe('wallet-scoped KYC status (different enum than customer-level)', () => {
    it('passes through proposed / approved_chain_deploying / rejected', async () => {
        const client = sandboxClient([
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
        const kyc = await client.getWalletKyc('c-1', 'GANA');
        expect(kyc.status).toBe('approved_chain_deploying');
        expect(kyc.walletPublicKey).toBe('GANA');
    });
});

describe('createHostedOnboarding (deprecated presigned flow)', () => {
    it('returns the presigned URL for a fresh customer', async () => {
        const route: Route = {
            method: 'POST',
            path: '/ramp/onboarding-url',
            respond: { status: 200, body: { presigned_url: 'https://sandbox.etherfuse.com/x' } },
        };
        const result = await sandboxClient([route]).createHostedOnboarding({
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

    const existing = '123e4567-e89b-12d3-a456-426614174000';
    const seeOrg = (onRetry: (body: Record<string, unknown>) => void): Route => {
        let calls = 0;
        return {
            method: 'POST',
            path: '/ramp/onboarding-url',
            respond: (req) => {
                calls += 1;
                if (calls === 1) {
                    return {
                        status: 409,
                        body: `You have already added user with this address, see org: ${existing}`,
                    };
                }
                onRetry(req as Record<string, unknown>);
                return { status: 200, body: { presigned_url: 'https://fresh.url' } };
            },
        };
    };

    it('recovers the existing customer from the documented "see org" 409 and retries', async () => {
        let retryBody: Record<string, unknown> = {};
        const result = await sandboxClient([
            seeOrg((body) => (retryBody = body)),
        ]).createHostedOnboarding({ email: 'ana@example.com', publicKey: 'GANA' });
        expect(result.recovered).toBe(true);
        expect(result.customerId).toBe(existing);
        expect(result.presignedUrl).toBe('https://fresh.url');
        // The retry reused the EXISTING customer id.
        expect(retryBody['customerId']).toBe(existing);
    });

    it('reuses the FIRST existing bank account on recovery when asked to', async () => {
        let retryBody: Record<string, unknown> = {};
        const accounts: Route = {
            method: 'POST',
            path: `/ramp/customer/${existing}/bank-accounts`,
            respond: {
                status: 200,
                body: {
                    items: [
                        {
                            bankAccountId: 'b-first',
                            createdAt: '2026-01-01T00:00:00Z',
                            abbrClabe: '****1234',
                            status: 'active',
                        },
                        {
                            bankAccountId: 'b-second',
                            createdAt: '2026-02-01T00:00:00Z',
                            abbrClabe: '****5678',
                            status: 'active',
                        },
                    ],
                },
            },
        };
        const result = await sandboxClient([
            seeOrg((body) => (retryBody = body)),
            accounts,
        ]).createHostedOnboarding({
            email: 'ana@example.com',
            publicKey: 'GANA',
            reuseExistingBankAccount: true,
        });
        expect(result.recovered).toBe(true);
        expect(result.bankAccountId).toBe('b-first');
        expect(retryBody['bankAccountId']).toBe('b-first');
    });

    it('falls back to a fresh id when the recovered customer has no accounts', async () => {
        let retryBody: Record<string, unknown> = {};
        const accounts: Route = {
            method: 'POST',
            path: `/ramp/customer/${existing}/bank-accounts`,
            respond: { status: 200, body: { items: [] } },
        };
        const result = await sandboxClient([
            seeOrg((body) => (retryBody = body)),
            accounts,
        ]).createHostedOnboarding({
            email: 'ana@example.com',
            publicKey: 'GANA',
            reuseExistingBankAccount: true,
        });
        expect(result.bankAccountId).toMatch(/^[0-9a-f-]{36}$/);
        expect(retryBody['bankAccountId']).toBe(result.bankAccountId);
    });

    it('keeps minting a fresh id by default (no reuse without opting in)', async () => {
        const accounts: Route = {
            method: 'POST',
            path: `/ramp/customer/${existing}/bank-accounts`,
            respond: { status: 200, body: { items: [{ bankAccountId: 'b-first' }] } },
        };
        const result = await sandboxClient([seeOrg(() => {}), accounts]).createHostedOnboarding({
            email: 'ana@example.com',
            publicKey: 'GANA',
        });
        expect(result.bankAccountId).toMatch(/^[0-9a-f-]{36}$/);
        expect(accounts.calls ?? []).toHaveLength(0);
    });
});

describe('submitVerificationData (KYC API step 1)', () => {
    it('POSTs the identity payload and returns the 202 receipt', async () => {
        const route: Route = {
            method: 'POST',
            path: '/ramp/customer/c-1/verification',
            respond: {
                status: 202,
                body: { customerId: 'c-1', status: 'not_started' },
            },
        };
        const client = sandboxClient([route]);
        const receipt = await client.submitVerificationData('c-1', {
            firstName: 'Ana',
            lastName: 'Souza',
            dateOfBirth: '1990-01-01',
            country: 'BRA',
            taxId: '52998224725',
            address: {
                street: 'Av. Paulista 1000',
                city: 'Sao Paulo',
                region: 'SP',
                postalCode: '01310-100',
                country: 'BRA',
            },
        });
        expect(receipt).toEqual({ customerId: 'c-1', status: 'not_started' });
        const sent = route.calls![0]!.body as Record<string, unknown>;
        expect(sent['country']).toBe('BRA');
        expect(sent['taxId']).toBe('52998224725');
    });

    it('propagates API errors (no silent best-effort — a 409 means wait and retry)', async () => {
        const client = sandboxClient([
            {
                method: 'POST',
                path: '/ramp/customer/c-1/verification',
                respond: { status: 409, body: 'already approved' },
            },
        ]);
        await expect(
            client.submitVerificationData('c-1', {
                firstName: 'A',
                lastName: 'B',
                dateOfBirth: '1990-01-01',
                country: 'BRA',
            }),
        ).rejects.toMatchObject({ status: 409 });
    });
});
