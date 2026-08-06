/**
 * Sandbox bootstrap — creates everything the demo's .env.local needs:
 * a customer, a funded Stellar testnet wallet, and ONE hosted-onboarding
 * link where you click through the remaining KYC steps. On approval it
 * WRITES apps/demo/.env.local for you.
 *
 *   node scripts/bootstrap-sandbox.mjs you@email.com
 *
 * Why a browser step at all? Etherfuse removed the programmatic agreement
 * endpoints (410) and documents that email confirmation, the liveness
 * selfie, and the customer agreement have NO API — the customer completes
 * them in /idv, even in sandbox (where checks don't run and fake data
 * auto-approves): https://docs.etherfuse.com/guides/kyc-api
 * The script pre-pushes identity data over the KYC API so the click-through
 * only asks for what's left.
 *
 * Prerequisite: ETHERFUSE_API_KEY (api_sand:…) already in
 * apps/demo/.env.local (copy .env.local.example) or .env.sandbox.
 * Run from the repo ROOT.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Keypair } from '@stellar/stellar-sdk';
import { EtherfuseClient } from '@spacecathy/rampkit/server';

const ENV_PATH = 'apps/demo/.env.local';
const BASE = 'https://api.sand.etherfuse.com';

function parseEnvFile(path) {
    if (!existsSync(path)) return {};
    return Object.fromEntries(
        readFileSync(path, 'utf8')
            .replace(/^﻿/, '') // Notepad saves UTF-8 with a BOM
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

if (!API_KEY) {
    console.error(
        `ETHERFUSE_API_KEY not found.\n` +
            `  Looked in: ${ENV_PATH} (${existsSync(ENV_PATH) ? 'exists' : 'MISSING'}), ` +
            `.env.sandbox (${existsSync('.env.sandbox') ? 'exists' : 'missing'}), ` +
            `and the process env.\n` +
            `  Run from the repo ROOT (paths are relative to it) and check the exact\n` +
            `  variable name: ETHERFUSE_API_KEY=api_sand:...`,
    );
    process.exit(1);
}
if (!API_KEY.startsWith('api_sand')) {
    console.error(
        `The key found starts with "${API_KEY.slice(0, 9)}..." — expected the api_sand prefix.\n` +
            `  This script is sandbox-only (never use a production key here).\n` +
            `  Sandbox keys come from https://sandbox.etherfuse.com (API base api.sand.etherfuse.com).`,
    );
    process.exit(1);
}
if (!EMAIL || !EMAIL.includes('@')) {
    console.error('Usage: node scripts/bootstrap-sandbox.mjs you@email.com');
    console.error('(the email the customer confirms during KYC — use one you can read)');
    process.exit(1);
}

const log = (...a) => console.log('•', ...a);
const client = new EtherfuseClient({ apiKey: API_KEY });

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
const fb = await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`);
if (!fb.ok) log(`friendbot returned ${fb.status} (ok if the account already exists)`);

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

// 3 · Pre-push identity data over the KYC API so /idv asks for less.
//     Best-effort: the hosted flow collects anything this misses.
try {
    await client.submitVerificationData(customerId, {
        firstName: 'Sandbox',
        lastName: 'Tester',
        dateOfBirth: '1990-01-01',
        country: 'BRA',
        taxId: '52998224725', // fake but checksum-valid CPF
        address: {
            street: 'Av. Paulista 1000',
            city: 'Sao Paulo',
            region: 'SP',
            postalCode: '01310-100',
            country: 'BRA',
        },
    });
    log('Identity data pre-pushed via the KYC API (less to type in the browser)');
} catch (error) {
    log(`Identity pre-push skipped (${error.message}) — the hosted flow will collect it`);
}

console.log(`
================================================================================
OPEN THIS LINK and complete the remaining steps (valid for 15 minutes):

${presigned_url}

Sandbox accepts fake data and auto-approves — identity checks don't run.
What remains is only what has no API: email confirmation, the liveness
selfie, and the customer agreement. Details:
- Mexico asks for the Constancia de Situación Fiscal — use the Etherfuse example:
  https://stablebonds.s3.us-west-2.amazonaws.com/example-constancia-de-situacion-fiscal.pdf
- The bank account registered by the hosted flow becomes active immediately.
================================================================================
`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Done with the browser flow? [enter] ');
rl.close();

// 4 · Confirm approval (poll briefly — approval can lag a little)
let status = 'unknown';
for (let i = 0; i < 24; i++) {
    status = (await client.getCustomerKyc(customerId)).status;
    if (status === 'approved') break;
    log(`KYC: ${status} — waiting…`);
    await new Promise((r) => setTimeout(r, 5000));
}
if (status !== 'approved') {
    console.error(
        `KYC ended as "${status}". Finish the flow and run the script again\n` +
            `(customer ${customerId} already exists — the link is single-use, but a\n` +
            `re-run creates a fresh one).`,
    );
    process.exit(1);
}
log('KYC approved ✓');

// 5 · Write .env.local
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
log(`Wrote ${ENV_PATH}`);

console.log(`
Done. Now:
  npm run dev -w apps/demo    → http://localhost:3000
Run an onramp first ("Simulate deposit", then "Sign claim") so the wallet
holds the stablebond + trustline; only then does the offramp have anything
to sell.
`);
