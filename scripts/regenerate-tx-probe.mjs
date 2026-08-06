/**
 * regenerate_tx probe — does GET /ramp/order/{id} return a fresh burnTransaction
 * after POST /ramp/order/{id}/regenerate_tx, the way it does for onramp?
 *
 * The docs never say. This measures it. Throwaway harness, not package code.
 *
 *   npm i @stellar/stellar-sdk
 *   node scripts/regenerate-tx-probe.mjs
 *
 * Reads apps/demo/.env.local (the same file the demo app uses) — no separate
 * env file needed. An optional .env.sandbox in the repo root overrides it.
 *
 * Used keys (demo names in parentheses):
 *   ETHERFUSE_API_KEY                            required, api_sand:...
 *   CUSTOMER_ID     (DEMO_CUSTOMER_ID)           approved personal org
 *   STELLAR_SECRET  (NEXT_PUBLIC_DEMO_WALLET_SECRET)  testnet key w/ CETES
 *   BANK_ACCOUNT_ID                              optional; otherwise reuses
 *                                                the first active account or
 *                                                creates one
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
    Keypair,
    TransactionBuilder,
    Networks,
    Horizon,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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

// One env file for everything: the demo's. .env.sandbox (optional) overrides.
const env = { ...parseEnvFile('apps/demo/.env.local'), ...parseEnvFile('.env.sandbox') };
env.CUSTOMER_ID ||= env.DEMO_CUSTOMER_ID;
env.STELLAR_SECRET ||= env.NEXT_PUBLIC_DEMO_WALLET_SECRET;

const API_KEY = env.ETHERFUSE_API_KEY || process.env.ETHERFUSE_API_KEY;
if (!API_KEY) {
    console.error('Missing ETHERFUSE_API_KEY. Fill in apps/demo/.env.local (see .env.local.example).');
    process.exit(1);
}
if (!API_KEY.startsWith('api_sand')) {
    console.error(`Refusing to run: key is not a sandbox key (${API_KEY.slice(0, 9)}...).`);
    process.exit(1);
}

const BASE = 'https://api.sand.etherfuse.com';
const HORIZON = 'https://horizon-testnet.stellar.org';
const NETWORK = Networks.TESTNET;
const horizon = new Horizon.Server(HORIZON);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(q);
    rl.close();
    return a;
};

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = text;
    }
    if (!res.ok) {
        const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return { status: res.status, body: json };
}

const findings = {};
const record = (k, v) => {
    findings[k] = v;
    log(`  >> ${k}:`, typeof v === 'string' ? v : JSON.stringify(v));
};

// ---------------------------------------------------------------------------
// Phase 1 — customer (skippable via CUSTOMER_ID)
// ---------------------------------------------------------------------------

async function ensureCustomer() {
    if (env.CUSTOMER_ID) {
        log(`Reusing CUSTOMER_ID ${env.CUSTOMER_ID}`);
        return env.CUSTOMER_ID;
    }
    const customerId = randomUUID();
    log(`Creating personal org ${customerId}`);
    await api('POST', '/ramp/organization', {
        id: customerId,
        accountType: 'personal',
        displayName: 'Probe Customer',
        userInfo: { email: `probe+${customerId.slice(0, 8)}@example.com`, displayName: 'Probe Customer' },
    });

    console.log(`
  MANUAL STEP — complete KYC once for this customer.
  Launching /idv needs a partner JWT (see DESIGN.md §0.1). Easiest path in sandbox:
  open https://sandbox.etherfuse.com, sign in, and verify the customer from the
  dashboard. Sandbox auto-approves; if it asks for Mexico, use the sample constancia:
  https://stablebonds.s3.us-west-2.amazonaws.com/example-constancia-de-situacion-fiscal.pdf

  customerId: ${customerId}
`);
    await ask('Press enter once KYC shows approved... ');

    const { body } = await api('GET', `/ramp/customer/${customerId}/kyc`);
    log('KYC status:', body?.status);
    if (body?.status !== 'approved') {
        console.error(`KYC is "${body?.status}", not approved. Re-run with CUSTOMER_ID once it is.`);
        process.exit(1);
    }
    console.log(`\n  Add to .env.sandbox to skip this next time:\n  CUSTOMER_ID=${customerId}\n`);
    return customerId;
}

async function ensureBankAccount(customerId) {
    if (env.BANK_ACCOUNT_ID) {
        log(`Reusing BANK_ACCOUNT_ID ${env.BANK_ACCOUNT_ID}`);
        return env.BANK_ACCOUNT_ID;
    }
    // Reuse an existing account before registering a new one.
    try {
        const { body } = await api('POST', `/ramp/customer/${customerId}/bank-accounts`, {
            pageSize: 100,
            pageNumber: 0,
        });
        const items = body?.items ?? [];
        const existing = items.find((a) => a.status === 'active') ?? items[0];
        if (existing) {
            log(`Reusing existing bank account ${existing.bankAccountId} (${existing.status})`);
            return existing.bankAccountId;
        }
    } catch {
        // fall through to creation
    }
    const bankAccountId = randomUUID();
    log('Registering bank account with sandbox placeholder RFC');
    await api('POST', `/ramp/customer/${customerId}/bank-account`, {
        bankAccountId,
        rfc: 'XEXX010101000', // sandbox: skips SPEI registration, marks active immediately
        clabe: '646180157000000004',
        beneficiary: 'Probe Customer',
        curp: 'XEXX010101HNEXXXA4',
    });
    console.log(`\n  BANK_ACCOUNT_ID=${bankAccountId}\n`);
    return bankAccountId;
}

// ---------------------------------------------------------------------------
// Phase 2 — a wallet holding CETES (no faucet: must onramp)
// ---------------------------------------------------------------------------

async function resolveAsset(wallet) {
    const { body } = await api(
        'GET',
        `/ramp/assets?blockchain=stellar&currency=mxn&wallet=${wallet}`,
    );
    const cetes = body.assets.find((a) => a.symbol === 'CETES' || a.identifier?.startsWith('CETES:'));
    if (!cetes) throw new Error('No CETES in /ramp/assets');
    log(`Resolved CETES -> ${cetes.identifier}`);
    return cetes.identifier;
}

async function signAndSubmit(xdr, keypair, label) {
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK);
    tx.sign(keypair);
    try {
        const res = await horizon.submitTransaction(tx);
        log(`  ${label} submitted: ${res.hash}`);
        return res.hash;
    } catch (e) {
        const codes = e?.response?.data?.extras?.result_codes;
        throw new Error(`${label} failed: ${JSON.stringify(codes || e.message)}`);
    }
}

async function ensureFundedWallet(customerId, bankAccountId) {
    if (env.STELLAR_SECRET) {
        const kp = Keypair.fromSecret(env.STELLAR_SECRET);
        log(`Reusing wallet ${kp.publicKey()}`);
        return kp;
    }

    const kp = Keypair.random();
    log(`Generated wallet ${kp.publicKey()}`);
    log('Funding via friendbot');
    await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
    await sleep(3000);

    const asset = await resolveAsset(kp.publicKey());

    // Onramp 500 MXN (sandbox cap) to acquire CETES + trustline.
    const quoteId = randomUUID();
    log('Creating onramp quote (500 MXN)');
    await api('POST', '/ramp/quote', {
        quoteId,
        customerId,
        blockchain: 'stellar',
        quoteAssets: { type: 'onramp', sourceAsset: 'MXN', targetAsset: asset },
        sourceAmount: '500',
        walletAddress: kp.publicKey(), // funds account + trustline via claimable balance
    });

    const orderId = randomUUID();
    log('Creating onramp order');
    await api('POST', '/ramp/order', {
        orderId,
        bankAccountId,
        publicKey: kp.publicKey(),
        quoteId,
    });

    log('Simulating fiat received');
    await api('POST', '/ramp/order/fiat_received', { orderId });

    log('Waiting for onramp to complete...');
    let claimXdr = null;
    for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const { body } = await api('GET', `/ramp/order/${orderId}`);
        if (i % 4 === 0) log(`  onramp status: ${body.status}`);
        if (body.stellarClaimTransaction) {
            claimXdr = body.stellarClaimTransaction;
            break;
        }
        if (body.status === 'completed') break;
        if (['failed', 'refunded', 'canceled'].includes(body.status)) {
            throw new Error(`Onramp ended as ${body.status}`);
        }
    }

    if (claimXdr) {
        log('Claiming (ChangeTrust + ClaimClaimableBalance)');
        await signAndSubmit(claimXdr, kp, 'claim');
    } else {
        log('No claim transaction — tokens delivered directly');
    }

    console.log(`\n  STELLAR_SECRET=${kp.secret()}\n`);
    return kp;
}

// ---------------------------------------------------------------------------
// Phase 3 — the measurement
// ---------------------------------------------------------------------------

async function probe(customerId, bankAccountId, keypair) {
    const wallet = keypair.publicKey();
    const asset = await resolveAsset(wallet);

    // Preflight — an unfunded/trustline-less wallet yields NO burnTransaction and
    // NO webhook, silently. Assert before we blame the API for a hang.
    const account = await horizon.loadAccount(wallet);
    const [code, issuer] = asset.split(':');
    const xlm = account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    const line = account.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer);
    log(`Preflight: XLM=${xlm}, ${code} trustline=${line ? `yes (${line.balance})` : 'NO'}`);
    if (!line || Number(line.balance) <= 0) {
        throw new Error(`Wallet holds no ${code}. Cannot create an offramp order.`);
    }

    const quoteId = randomUUID();
    const amount = Math.min(1, Number(line.balance)).toString();
    log(`Creating offramp quote (${amount} ${code} -> MXN)`);
    await api('POST', '/ramp/quote', {
        quoteId,
        customerId,
        blockchain: 'stellar',
        quoteAssets: { type: 'offramp', sourceAsset: asset, targetAsset: 'MXN' },
        sourceAmount: amount,
    });

    const orderId = randomUUID();
    log(`Creating offramp order ${orderId}`);
    const created = await api('POST', '/ramp/order', {
        orderId,
        bankAccountId,
        publicKey: wallet,
        quoteId,
    });
    record('createResponseHadBurnTx', Boolean(created.body?.offramp?.burnTransaction));

    // Q0: does the initial burnTransaction show up on GET at all?
    log('Polling GET for initial burnTransaction...');
    let original = null;
    const t0 = Date.now();
    for (let i = 0; i < 45; i++) {
        await sleep(2000);
        const { body } = await api('GET', `/ramp/order/${orderId}`);
        if (body.burnTransaction) {
            original = body.burnTransaction;
            record('initialBurnTxViaGetAfterMs', Date.now() - t0);
            break;
        }
    }
    if (!original) {
        record('initialBurnTxViaGet', false);
        throw new Error('burnTransaction never appeared on GET. Cannot proceed.');
    }
    record('initialBurnTxViaGet', true);
    record('originalTxLength', original.length);

    // Q1: does GET refresh on its own, without regenerate_tx?
    log('Waiting 150s past expiry (XDRs live ~1-2 min)...');
    await sleep(150_000);
    const afterWait = await api('GET', `/ramp/order/${orderId}`);
    record('getSelfRefreshesWithoutRegenerate', afterWait.body.burnTransaction !== original);

    // Q2: the actual question.
    log('POST regenerate_tx');
    const regen = await api('POST', `/ramp/order/${orderId}/regenerate_tx`);
    record('regenerateStatusCode', regen.status);
    record('regenerateReturnedBody', regen.body ? JSON.stringify(regen.body).slice(0, 200) : null);

    const baseline = afterWait.body.burnTransaction;
    const timeline = [];
    let changedAt = null;
    for (const delay of [2, 3, 5, 10, 10, 20, 30, 30]) {
        await sleep(delay * 1000);
        const elapsed = timeline.reduce((a, t) => a + t.delay, 0) + delay;
        const { body } = await api('GET', `/ramp/order/${orderId}`);
        const changed = body.burnTransaction !== baseline;
        timeline.push({ delay, elapsedSec: elapsed, changed });
        log(`  +${elapsed}s: burnTransaction ${changed ? 'CHANGED' : 'unchanged'}`);
        if (changed && changedAt === null) {
            changedAt = elapsed;
            break;
        }
    }

    record('getReflectsRegeneration', changedAt !== null);
    record('propagationSeconds', changedAt);
    findings.timeline = timeline;
    findings.orderId = orderId;

    // Leave the order resumable — never cancel (unfunded orders auto-cancel at 24h).
    log(`Order ${orderId} left open; it will auto-cancel in 24h.`);
}

// ---------------------------------------------------------------------------

(async () => {
    try {
        const customerId = await ensureCustomer();
        const bankAccountId = await ensureBankAccount(customerId);
        const keypair = await ensureFundedWallet(customerId, bankAccountId);
        await probe(customerId, bankAccountId, keypair);
    } catch (e) {
        console.error('\nFAILED:', e.message);
        findings.error = e.message;
    } finally {
        writeFileSync('regenerate-tx-findings.json', JSON.stringify(findings, null, 2));
        console.log('\n=== FINDINGS ===');
        console.log(JSON.stringify(findings, null, 2));
        console.log('\nWritten to regenerate-tx-findings.json');

        if (findings.getReflectsRegeneration === true) {
            console.log(
                '\nVERDICT: GET reflects the regenerated burnTransaction.\n' +
                '  Webhooks are a fast path, not an install requirement. Polling is a valid default.',
            );
        } else if (findings.getReflectsRegeneration === false) {
            console.log(
                '\nVERDICT: GET does NOT reflect it within the observed window.\n' +
                '  Default the freshness channel to the WebSocket (no public URL needed);\n' +
                '  document polling as unsupported for offramp regeneration.',
            );
        }
    }
})();
