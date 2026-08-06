/**
 * In-app onboarding: sign the short-lived RS256 user JWTs that launch a
 * customer into Etherfuse's hosted `/idv` KYC flow, and serve the JWKS the
 * platform registers with Etherfuse.
 *
 * One-time platform setup (per environment): generate an RSA keypair, host
 * the JWKS (see {@link createJwksHandler}), and send your issuer + JWKS URL
 * to your Etherfuse representative — there is no self-serve registration on
 * their side yet. After that, every user onboards inside YOUR app.
 *
 * Zero dependencies — plain node:crypto.
 */

import { createPublicKey, createSign, randomUUID, type KeyObject } from 'node:crypto';
import { RampkitError } from '../core/errors';

export interface OnboardingConfig {
    /** Your registered issuer (`iss`) — the value Etherfuse links to your org. */
    issuer: string;
    /** RSA private key (PEM, PKCS#8 or PKCS#1) that signs user JWTs. Server-side only. */
    privateKey: string;
    /** Key id (`kid`) published in your JWKS. */
    keyId: string;
}

const b64url = (data: Buffer | string): string =>
    Buffer.from(data).toString('base64url');

/**
 * Sign a user JWT per Etherfuse's contract: RS256, `sub` = the customer's
 * org id, `scope` naming the flow, fresh `jti`, ~5 minute lifetime, no
 * clock-skew allowance (keep server clocks synced).
 */
export function signUserJwt(args: {
    config: OnboardingConfig;
    /** Token endpoint of the environment: `${baseUrl}/auth/token`. */
    audience: string;
    /** MUST equal the customer's org id, or verification attaches to a stranger. */
    customerId: string;
    email: string;
    name: string;
    scope: 'verification' | 'kyb';
    lifetimeSeconds?: number;
}): { token: string; expiresAt: string } {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (args.lifetimeSeconds ?? 300);

    const header = { alg: 'RS256', typ: 'JWT', kid: args.config.keyId };
    const payload = {
        iss: args.config.issuer,
        sub: args.customerId,
        aud: args.audience,
        scope: args.scope,
        jti: randomUUID(),
        email: args.email,
        name: args.name,
        iat,
        exp,
    };

    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = createSign('RSA-SHA256')
        .update(signingInput)
        .sign(args.config.privateKey);

    return {
        token: `${signingInput}.${b64url(signature)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
    };
}

/** The JWKS document (public key only) to host at your JWKS URL. */
export function createJwks(config: Pick<OnboardingConfig, 'privateKey' | 'keyId'>): {
    keys: Record<string, unknown>[];
} {
    let publicKey: KeyObject;
    try {
        publicKey = createPublicKey(config.privateKey);
    } catch (cause) {
        throw new RampkitError(
            `onboarding.privateKey is not a valid PEM RSA key: ${(cause as Error).message}`,
        );
    }
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    return { keys: [{ ...jwk, kid: config.keyId, use: 'sig', alg: 'RS256' }] };
}

/**
 * Request handler serving the JWKS — mount at a stable HTTPS URL (e.g.
 * `/.well-known/jwks.json`) and register that URL with Etherfuse. Etherfuse
 * fetches it fresh on every verification, so key rotation is just updating
 * the served set.
 */
export function createJwksHandler(
    config: Pick<OnboardingConfig, 'privateKey' | 'keyId'>,
): (request: Request) => Promise<Response> {
    // Fail fast at mount time if the key is bad, not on Etherfuse's fetch.
    const jwks = createJwks(config);
    return async () =>
        new Response(JSON.stringify(jwks), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
}
