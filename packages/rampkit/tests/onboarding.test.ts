import { createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { EtherfuseClient } from '../src/server/client';
import { createJwks, createJwksHandler, signUserJwt } from '../src/server/onboarding';
import { mockFetch, type Route } from './helpers';

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
