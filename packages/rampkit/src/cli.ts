/**
 * rampkit CLI — `npx @spacecathy/rampkit setup-sandbox you@email.com`
 *
 * Bootstraps everything a rampkit consumer needs to try the package against
 * the Etherfuse sandbox, without touching the dashboard: a customer, a
 * funded Stellar TESTNET wallet, and one hosted-onboarding link where the
 * person clicks through KYC + bank registration (sandbox auto-approves).
 *
 * Uses POST /ramp/onboarding-url — deprecated upstream with sunset
 * 2026-08-16 (https://docs.etherfuse.com/changelog/deprecations). Fine as a
 * dev-only bootstrap until then; the runtime library never touches it.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createJwks } from './server/onboarding';
import { generateStellarKeypair } from './cli/strkey';

const SANDBOX = 'https://api.sand.etherfuse.com';
const FRIENDBOT = 'https://friendbot.stellar.org';
const SUNSET_UTC = Date.UTC(2026, 7, 16);

const USAGE = `rampkit — Etherfuse ramp kit for Stellar (community package)

Usage:
  npx @spacecathy/rampkit setup-sandbox <email> [--key api_sand_...] [--write <file>]
  npx @spacecathy/rampkit keygen [--out <private.pem>] [--kid <key-id>]

setup-sandbox: creates a sandbox customer + funded testnet wallet and walks
you through the hosted KYC once, then prints (or --write's) the env values a
rampkit app needs. <email> is the address the customer confirms during
verification. The API key comes from --key or the ETHERFUSE_API_KEY env var.
Get one free: https://sandbox.etherfuse.com (create account → Approve KYB →
API key).

keygen: generates the RSA keypair for the in-app KYC launch (/idv), writes
the private key to a file, and prints the JWKS + the registration checklist.
`;

const log = (...a: unknown[]) => console.log('•', ...a);
const fail = (msg: string): never => {
    console.error(`\nERRO: ${msg}`);
    process.exit(1);
};

async function api<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${SANDBOX}${path}`, {
        method,
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
}

async function setupSandbox(args: string[]): Promise<void> {
    const email = args.find((a) => a.includes('@'));
    const keyFlag = args.indexOf('--key');
    const writeFlag = args.indexOf('--write');
    const apiKey =
        (keyFlag >= 0 ? args[keyFlag + 1] : undefined) ?? process.env['ETHERFUSE_API_KEY'];
    const writePath = writeFlag >= 0 ? args[writeFlag + 1] : undefined;

    if (!email) fail(`falta o e-mail.\n\n${USAGE}`);
    if (!apiKey) fail('falta a API key: passe --key api_sand_... ou defina ETHERFUSE_API_KEY.');
    if (!apiKey!.startsWith('api_sand_')) {
        fail('essa key não é de sandbox (esperado prefixo api_sand_). Nunca use produção aqui.');
    }
    if (Date.now() > SUNSET_UTC) {
        console.warn(
            '\nAVISO: o endpoint de onboarding usado por este bootstrap tinha sunset em\n' +
                '2026-08-16 e pode ter sido removido pela Etherfuse. Se falhar, crie o\n' +
                'customer via dashboard/fluxo JWT: https://docs.etherfuse.com/guides/kyc-websdk\n',
        );
    }

    // 1 · wallet
    const wallet = generateStellarKeypair();
    log(`Carteira testnet: ${wallet.publicKey}`);
    log('Fundando via friendbot…');
    const fb = await fetch(`${FRIENDBOT}?addr=${wallet.publicKey}`);
    if (!fb.ok) log(`friendbot retornou ${fb.status} (se a conta já existe, ok)`);

    // 2 · customer + hosted onboarding
    const customerId = randomUUID();
    const bankAccountId = randomUUID();
    log(`Customer: ${customerId}`);
    const { presigned_url } = await api<{ presigned_url: string }>(
        apiKey!,
        'POST',
        '/ramp/onboarding-url',
        {
            customerId,
            bankAccountId,
            publicKey: wallet.publicKey,
            blockchain: 'stellar',
            userInfo: { email, displayName: email!.split('@')[0] },
        },
    );

    console.log(`
================================================================================
ABRA ESTE LINK e complete o onboarding (vale 15 minutos):

${presigned_url}

Sandbox aceita dados falsos e auto-aprova. México pede a Constancia — use o
exemplo da Etherfuse:
https://stablebonds.s3.us-west-2.amazonaws.com/example-constancia-de-situacion-fiscal.pdf
================================================================================
`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('Terminou o fluxo no browser? [enter] ');
    rl.close();

    // 3 · wait for approval (sandbox is fast; poll up to ~2 min)
    let status = 'unknown';
    for (let i = 0; i < 24; i++) {
        const kyc = await api<{ status?: string }>(
            apiKey!,
            'GET',
            `/ramp/customer/${customerId}/kyc`,
        );
        status = kyc?.status ?? 'unknown';
        if (status === 'approved') break;
        log(`KYC: ${status} — aguardando…`);
        await new Promise((r) => setTimeout(r, 5000));
    }
    if (status !== 'approved') {
        fail(`KYC terminou como "${status}". Complete o fluxo e rode o comando de novo.`);
    }
    log('KYC aprovado ✓');

    // 4 · output
    const envBlock = [
        '# rampkit sandbox identity — Stellar TESTNET only, no real money',
        `ETHERFUSE_API_KEY="${apiKey}"`,
        `DEMO_CUSTOMER_ID="${customerId}"`,
        `DEMO_PUBLIC_KEY="${wallet.publicKey}"`,
        '# secret key in an env var is for LOCAL SANDBOX TESTING ONLY',
        `NEXT_PUBLIC_DEMO_WALLET_SECRET="${wallet.secret}"`,
        '',
    ].join('\n');

    if (writePath) {
        writeFileSync(writePath, envBlock);
        log(`Gravado ${writePath}`);
    } else {
        console.log(`\n${envBlock}`);
    }

    console.log(`No seu app, a sessão desse usuário fica:

  getSession: async () => ({
      customerId: '${customerId}',
      publicKey: '${wallet.publicKey}',
  })

Para o offramp ter o que vender, rode um onramp primeiro (≤500 MXN no
sandbox, simule o depósito via a operação sandbox.simulateDeposit e assine o
claim) — isso também cria a trustline. Docs: https://www.npmjs.com/package/@spacecathy/rampkit
`);
}

/**
 * One-time platform setup for the in-app KYC launch: RSA keypair + JWKS.
 * The private key goes to a FILE (never stdout — terminals get logged);
 * the JWKS is public by design and is printed for hosting/registration.
 */
function keygen(args: string[]): void {
    const outFlag = args.indexOf('--out');
    const kidFlag = args.indexOf('--kid');
    const outPath = (outFlag >= 0 ? args[outFlag + 1] : undefined) ?? 'rampkit-private.pem';
    const keyId = (kidFlag >= 0 ? args[kidFlag + 1] : undefined) ?? `rampkit-${randomUUID().slice(0, 8)}`;

    if (existsSync(outPath)) {
        fail(`${outPath} já existe — não vou sobrescrever uma chave privada. Use --out <outro-arquivo>.`);
    }

    log('Gerando chave RSA 2048…');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(outPath, pem, { mode: 0o600 });
    log(`Chave privada gravada em ${outPath} (NUNCA commite este arquivo)`);

    const jwks = createJwks({ privateKey: pem, keyId });

    console.log(`
JWKS (público — é isso que a Etherfuse busca para verificar seus JWTs):

${JSON.stringify(jwks, null, 2)}

================================================================================
CHECKLIST — registro do /idv (uma vez por ambiente):

1. Guarde ${outPath} como segredo do servidor (env/secret manager; fora do git).
2. Sirva o JWKS acima numa URL HTTPS estável — no seu app:
     import { createJwksHandler } from '@spacecathy/rampkit/server';
     // ex.: app/.well-known/jwks.json/route.ts
     export const GET = createJwksHandler({ privateKey, keyId: '${keyId}' });
3. Envie ao seu contato na Etherfuse: seu ISSUER (ex.: https://seuapp.com)
   e a URL do JWKS. O registro ainda não é self-serve do lado deles.
4. Configure o client:
     new EtherfuseClient({ apiKey, onboarding: {
         issuer: '<seu issuer>', privateKey, keyId: '${keyId}' } })

Depois disso, kyc.startSession / useKyc().launch funcionam para todo usuário.
================================================================================
`);
}

const [, , command, ...rest] = process.argv;
if (command === 'setup-sandbox') {
    setupSandbox(rest).catch((error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
    });
} else if (command === 'keygen') {
    try {
        keygen(rest);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
} else {
    console.log(USAGE);
    process.exit(command === undefined || command === '--help' ? 0 : 1);
}
