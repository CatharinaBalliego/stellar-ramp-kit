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

## v0 scope

Etherfuse only, Stellar only, default burn flow. Out of scope: onboarding/KYC
(see Requirements), anchor mode, embedded wallets, swaps, webhooks (polling
covers freshness; a WebSocket source is planned behind the same
`TransactionSource` interface).

## License & attribution

Apache-2.0. Derived from the Etherfuse integration in the
[Stellar Regional Starter Pack](https://github.com/ElliotFriend/regional-starter-pack)
by **Elliot Friend** — see [NOTICE](./NOTICE) and
[CHANGES-FROM-UPSTREAM.md](./CHANGES-FROM-UPSTREAM.md) for what changed.

Not affiliated with, or endorsed by, Etherfuse or the Stellar Development
Foundation.
