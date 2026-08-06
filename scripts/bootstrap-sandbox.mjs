/**
 * Sandbox bootstrap — creates everything the demo's .env.local needs:
 * a customer, a Stellar testnet wallet (funded via friendbot), and the
 * hosted-onboarding link where you click through KYC + bank account.
 * On approval it WRITES apps/demo/.env.local for you.
 *
 *   node scripts/bootstrap-sandbox.mjs you@email.com
 *
 * Prerequisite: ETHERFUSE_API_KEY (api_sand_…) already in
 * apps/demo/.env.local (copy .env.local.example) or .env.sandbox.
 *
 * NOTE: uses POST /ramp/onboarding-url, deprecated with sunset 2026-08-16 —
 * fine as a dev-only convenience until then. The published package never
 * touches it. After the sunset, create customers via the Etherfuse
 * dashboard or the JWT /idv flow instead.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Keypair } from '@stellar/stellar-sdk';

const ENV_PATH = 'apps/demo/.env.local';
const BASE = 'https://api.sand.etherfuse.com';

function parseEnvFile(path) {
    if (!existsSync(path)) return {};
    return Object.fromEntries(
        readFileSync(path, 'utf8')
            .split('\n')
            .filter((l) => l.trim() && !l.trim().startsWith('#'))
            .map((l) => {
                const i = l.indexOf('=');
                return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
            }),
    );
}

const env = { ...parseEnvFile(ENV_PATH), ...parseEnvFile('.env.sandbox') };
const API_KEY = env.ETHERFUSE_API_KEY || process.env.ETHERFUSE_API_KEY;
const EMAIL = process.argv[2];

if (!API_KEY || !API_KEY.startsWith('api_sand_')) {
    console.error(`Missing sandbox key. Put ETHERFUSE_API_KEY=api_sand_... in ${ENV_PATH}`);
    process.exit(1);
}
if (!EMAIL || !EMAIL.includes('@')) {
    console.error('Usage: node scripts/bootstrap-sandbox.mjs you@email.com');
    console.error('(the email the customer confirms during KYC — use one you can read)');
    process.exit(1);
}

const log = (...a) => console.log('•', ...a);

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

// 1 · Wallet: generate + fund on testnet
const keypair = Keypair.random();
log(`Wallet: ${keypair.publicKey()}`);
log('Funding via friendbot…');
await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`);

// 2 · Customer + hosted onboarding link (KYC + bank account in one flow)
const customerId = randomUUID();
const bankAccountId = randomUUID();
log(`Customer: ${customerId}`);
const { presigned_url } = await api('POST', '/ramp/onboarding-url', {
    customerId,
    bankAccountId,
    publicKey: keypair.publicKey(),
    blockchain: 'stellar',
    userInfo: { email: EMAIL, displayName: EMAIL.split('@')[0] },
});

console.log(`
================================================================================
ABRA ESTE LINK e complete o onboarding (vale por 15 minutos):

${presigned_url}

Sandbox aceita dados falsos e auto-aprova. Detalhes:
- México pede a Constancia de Situación Fiscal — use o exemplo da Etherfuse:
  https://stablebonds.s3.us-west-2.amazonaws.com/example-constancia-de-situacion-fiscal.pdf
- A conta bancária registrada pelo fluxo hosted fica ativa na hora.
================================================================================
`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Terminou o fluxo no browser? [enter] ');
rl.close();

// 3 · Confirm approval
const kyc = await api('GET', `/ramp/customer/${customerId}/kyc`);
log(`KYC status: ${kyc?.status}`);
if (kyc?.status !== 'approved') {
    console.error(
        `Ainda "${kyc?.status}". Termine o fluxo e rode de novo com:\n` +
            `  CUSTOMER_ID=${customerId} (já criado — não repita o link)\n` +
            'ou aguarde um instante e reexecute o script.',
    );
    process.exit(1);
}

// 4 · Write .env.local (preserving the API key line)
const lines = [
    `ETHERFUSE_API_KEY="${API_KEY}"`,
    '',
    `DEMO_CUSTOMER_ID="${customerId}"`,
    `DEMO_PUBLIC_KEY="${keypair.publicKey()}"`,
    '',
    '# TESTNET only — never do this with a real key',
    `NEXT_PUBLIC_DEMO_WALLET_SECRET="${keypair.secret()}"`,
    '',
];
writeFileSync(ENV_PATH, lines.join('\n'));
log(`Gravado ${ENV_PATH}`);

console.log(`
Pronto. Agora:
  npm run dev -w apps/demo    → http://localhost:3000
Onramp primeiro (≤500 MXN, "Simulate deposit", depois "Sign claim") para a
carteira ganhar CETES + trustline; só então o offramp tem o que vender.
`);
