# Rampkit — Etherfuse ramp kit for Stellar (community package, not official)

Fiat on/off-ramps on Stellar (SPEI ⇄ stablebonds like CETES) via the
[Etherfuse](https://etherfuse.com) ramp API — as an installable package
instead of files you copy: a server route handler, a browser client, React
hooks with full flow state machines, and a wallet-agnostic signer contract.

## What you get

- **Onramp** (fiat → tokens): quote → order → SPEI deposit instructions →
  delivery, including the claimable-balance flow for first-time wallets
  (sign one claim transaction to add the trustline and receive tokens).
- **Offramp** (tokens → fiat): quote → **wallet preflight** → order → sign
  the prebuilt burn transaction → payout tracking to `finalized`.
- **Expiry handled for you**: Etherfuse XDRs live ~1–2 minutes; the hooks
  proactively regenerate the burn transaction (~50s) while the user has it
  open, and recover from `tx_too_late` on submit.
- **Resume, never recreate**: order IDs are client-generated UUIDs; a 409
  is resolved structurally (the order exists → fetch it), and any flow can
  `resume(orderId)` after a refresh or crash.
- **Zero runtime dependencies.** No wallet SDK, no `@stellar/stellar-sdk`.

## Requirements

- Node **≥ 18.17** (server side).
- An Etherfuse account with an API key
  ([sandbox](https://sandbox.etherfuse.com) is self-serve and free).
- An **approved customer** (`customerId`) with a registered bank account.
  Customer onboarding/KYC is out of scope for v0 — do it via the Etherfuse
  dashboard or API ([docs](https://docs.etherfuse.com/guides/onboarding));
  Rampkit takes over from there.

## Try it in 2 minutes (sandbox bootstrap)

You don't need to touch the Etherfuse dashboard to get a testable identity.
With a sandbox API key in hand ([sandbox.etherfuse.com](https://sandbox.etherfuse.com):
create account → Approve KYB → API key):

```bash
export ETHERFUSE_API_KEY=api_sand_...        # PowerShell: $env:ETHERFUSE_API_KEY="..."
npx @spacecathy/rampkit setup-sandbox you@email.com
```

The CLI creates a customer, generates and funds a Stellar testnet wallet,
and hands you ONE hosted link where you click through KYC + bank
registration (sandbox auto-approves). It then prints the `customerId` /
`publicKey` / wallet secret your app's `getSession` needs — or writes them
with `--write .env.local`.

> The bootstrap rides an Etherfuse endpoint deprecated with sunset
> 2026-08-16; after that date use the dashboard/JWT onboarding instead. The
> runtime library never touches that endpoint.

## Quickstart

```bash
npm install @spacecathy/rampkit
```

**1 · Mount the server handler** (the only place the API key exists):

```ts
// app/api/ramp/[...op]/route.ts  (Next.js App Router — any Request/Response
// framework works; Express via toNodeHandler)
import { EtherfuseClient, createRampHandler } from '@spacecathy/rampkit/server';

const client = new EtherfuseClient({
    apiKey: process.env.ETHERFUSE_API_KEY!, // api_sand_… or api_prod_…
    // environment, baseUrl, horizonUrl are inferred from the key prefix
});

const handler = createRampHandler({
    client,
    // REQUIRED: map YOUR authenticated user to their Etherfuse identity.
    // Identity always comes from here — never from the browser request.
    getSession: async (request) => {
        const user = await yourAuth(request);
        if (!user) return null;
        return { customerId: user.etherfuseCustomerId, publicKey: user.stellarAddress };
    },
});

export const GET = handler;
export const POST = handler;
```

**2 · Wire the provider with your wallet** (any wallet — you own the signer):

```tsx
'use client';
import { createRampClient } from '@spacecathy/rampkit/client';
import { RampProvider, type RampSigner } from '@spacecathy/rampkit/react';

const client = createRampClient(); // talks to /api/ramp, carries no secrets

// Example: Freighter. Rampkit never imports a wallet SDK.
const signer: RampSigner = {
    address: userAddress,
    async signTransaction({ xdr, networkPassphrase }) {
        const { signedTxXdr } = await freighterApi.signTransaction(xdr, { networkPassphrase });
        return { signedXdr: signedTxXdr };
        // A wallet that signs AND submits returns { hash } instead — both
        // branches are first-class.
    },
};

export function App({ children }) {
    return <RampProvider client={client} signer={signer}>{children}</RampProvider>;
}
```

**3 · Use the flow hooks:**

```tsx
import { useOfframp, useOnramp, useRampAssets } from '@spacecathy/rampkit/react';

const { assets } = useRampAssets({ currency: 'MXN' }); // via GET /ramp/assets

const { phase, quote, burnXdr, preflightIssues, txHash, actions } = useOfframp();
// actions.requestQuote({ asset: 'CETES', fiat: 'MXN', amount: '5' });
// actions.start({ bankAccountId });   ← preflight runs first, order is
//                                       created as late as possible
// actions.sign();                     ← signer → Horizon submit
// actions.resume(orderId);            ← re-enter after refresh/crash

const onramp = useOnramp();
// requestQuote → start → deposit (SPEI CLABE) → [simulateDeposit in
// sandbox] → signClaim (first-time wallets) → completed
```

`phase` walks an explicit state machine (`quote_ready`, `awaiting_transaction`,
`transaction_ready`, `regenerating`, `preflight_failed`, …) so your UI can
render every step, including expiry and regeneration, without guessing.

## Onboarding users inside your app (v0.3)

The full lifecycle — *user signs up → app creates their customer → user
completes KYC in-app → user ramps* — without dashboards or CLIs:

```ts
// 1 · At signup, in YOUR backend (server-to-server; not a browser op):
const { customerId } = await client.createCustomer({
    email: user.email,
    publicKey: user.stellarAddress, // binds their wallet (idempotent)
});
await db.users.update(user.id, { etherfuseCustomerId: customerId });
```

```tsx
// 2 · In the app: gate on KYC and launch the hosted flow when needed
import { useKyc } from '@spacecathy/rampkit/react';

const { isApproved, kyc, launch } = useKyc();
// !isApproved → <button onClick={() => launch()}>Verify identity</button>
// The user completes document + liveness + agreements at Etherfuse and
// returns; sandbox auto-approves.
```

**Migrating from the starter-pack files / zero-setup alternative:** the
legacy presigned flow is kept as `createHostedOnboarding()` — no issuer
registration needed, with the documented "see org" 409 recovery built in —
but it is `@deprecated`: Etherfuse sunsets that endpoint on **2026-08-16**.
For tests, `sandboxApproveKyc()` (sandbox-only) approves a customer without
a browser. Wallet-scoped status (`getWalletKycStatus()`) is also available,
with its own enum (`proposed`, `approved_chain_deploying`, `rejected`).

**One-time platform setup** (per environment, required for `launch`):
Etherfuse verifies a JWT your server signs, against a JWKS you host.

1. Generate an RSA keypair:
   `openssl genrsa -out private.pem 2048`
2. Serve the JWKS — mount `createJwksHandler({ privateKey, keyId })` at a
   stable HTTPS URL (e.g. `/.well-known/jwks.json`).
3. Send your **issuer** and **JWKS URL** to your Etherfuse representative —
   registration is not self-serve on their side yet.
4. Configure the client:
   `new EtherfuseClient({ apiKey, onboarding: { issuer, privateKey, keyId } })`

Until step 3 is done (or for quick sandbox testing), the
`npx @spacecathy/rampkit setup-sandbox` bootstrap remains the shortcut.

## Where do `customerId`s live? (not in env vars!)

One `customerId` per **end user** of your platform — it's their verified
Etherfuse identity (fiat is regulated; each person KYCs once, exactly like a
`stripe_customer_id`). It lives **in your database**, next to your user
record, and flows per request through `getSession`:

```
user signs up      →  your backend creates their customer (one API call,
                      you generate the UUID) and stores it: users.etherfuse_customer_id
first ramp usage   →  the user completes Etherfuse's hosted KYC once
ever after         →  getSession(req) returns { customerId, publicKey }
                      from YOUR session/DB — fully automatic
```

The `DEMO_CUSTOMER_ID` env var you'll see in the demo app exists only
because the demo has no auth or database — it fakes a one-user platform.
Real integrations never configure customer ids by hand.

## Why the offramp preflight matters

If the selling wallet doesn't exist on-chain, lacks XLM for reserves, lacks
the asset's trustline, or holds less than the quoted amount, Etherfuse
**silently never produces a burn transaction** — no error, no webhook; the
order hangs in `created` forever. Rampkit checks all four against Horizon
*before* creating the order and reports machine-readable issues
(`preflightIssues`) your UI can turn into "send XLM first" instead of an
infinite spinner.

## Security model

- The API key lives only in `rampkit/server`, which is **Node-conditioned**:
  importing it from browser code fails at build time.
- The browser calls your route with **named operations** from a frozen map —
  there is no path from a browser string to an Etherfuse URL.
- `getSession` is **required**; `customerId`/`publicKey` always come from it
  and order reads verify ownership. For local prototyping only, there is a
  deliberately loud escape hatch: `unsafeTrustClient`.

## Etherfuse behaviors baked in

- Quotes expire in **2 minutes** → hooks track expiry; create orders late.
- Error bodies are strings (no machine codes) → errors are switched on HTTP
  status, never parsed from messages.
- Asset issuers **differ between sandbox and production** → always resolved
  at runtime via `GET /ramp/assets`, never hardcoded.
- Unfunded orders auto-cancel after 24h server-side → recovery is resume-only;
  there is no cancel operation.
- Sandbox: onramps are capped at 500 MXN and funded via
  `sandbox.simulateDeposit` (hidden in production).

## Scope

Etherfuse only, Stellar only, default burn flow. In since v0.3: in-app
onboarding (customer creation + hosted-KYC launch). Out of scope: anchor
mode, embedded wallets, swaps, webhooks (polling covers freshness; a
WebSocket source is planned behind the same `TransactionSource` interface).

## License & attribution

Apache-2.0. Derived from the Etherfuse integration in the
[Stellar Regional Starter Pack](https://github.com/ElliotFriend/regional-starter-pack)
by **Elliot Friend** — see [NOTICE](./NOTICE) and
[CHANGES-FROM-UPSTREAM.md](./CHANGES-FROM-UPSTREAM.md) for what changed.

Not affiliated with, or endorsed by, Etherfuse or the Stellar Development
Foundation.
