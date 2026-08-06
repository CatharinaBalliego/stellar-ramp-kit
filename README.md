# Rampkit monorepo

**Rampkit** is an Etherfuse ramp kit for Stellar — fiat on/off-ramps in
**MXN (SPEI)** and **BRL (PIX)** ⇄ stablebonds like CETES, as an
installable npm package: server route handler, browser client, React hooks,
wallet-agnostic signer. Assets are discovered at runtime via
`GET /ramp/assets` — never hardcoded.

```bash
npm install @spacecathy/rampkit
```

**→ Published on npm as
[`@spacecathy/rampkit`](https://www.npmjs.com/package/@spacecathy/rampkit);
the package source (and its full README) lives in
[`packages/rampkit`](./packages/rampkit/README.md).** This file covers the
repo itself: layout, development, and how to run the demo against the
Etherfuse sandbox.

## Layout

| Path | What it is |
| --- | --- |
| [`packages/rampkit/`](./packages/rampkit) | The published package |
| [`apps/demo/`](./apps/demo) | Next.js demo app consuming the package (workspace link) |
| [`scripts/regenerate-tx-probe.mjs`](./scripts/regenerate-tx-probe.mjs) | One-off sandbox experiment: does `GET /ramp/order` reflect a regenerated `burnTransaction`? (undocumented by Etherfuse) |
| [`DESIGN.md`](./DESIGN.md) | Design document: architecture, API findings, decisions |

## Development

```bash
npm install         # workspace root
npm run typecheck
npm run test        # 70 unit tests (vitest, mocked HTTP — no API key needed)
npm run build       # tsup: ESM+CJS+types for ., /server, /client, /react
```

## Running the demo (Etherfuse sandbox, Stellar testnet)

No real money is involved anywhere below.

### 1 · One-time sandbox setup

1. **Account + API key** — create an account at
   [sandbox.etherfuse.com](https://sandbox.etherfuse.com), open the KYB page
   and click **Approve KYB** (sandbox lets you approve yourself, no
   documents), then generate an API key (`api_sand:…` — Etherfuse keys are
   colon-separated: `api_{env}:{key_id}:{org_id}`).
2. **Everything else is scripted**, with one short browser click-through
   (Etherfuse offers no API for email confirmation, the liveness selfie, or
   the customer agreement — even in sandbox they happen inside the hosted
   flow, which auto-approves fake data):

   ```bash
   cp apps/demo/.env.local.example apps/demo/.env.local
   # paste your ETHERFUSE_API_KEY into it, then:
   node scripts/bootstrap-sandbox.mjs you@email.com
   ```

   The script funds a testnet wallet (friendbot), creates the customer,
   pre-pushes identity data over the KYC API (`submitVerificationData`) so
   the browser step is minimal, hands you the hosted link (KYC + bank
   account in one), verifies approval, and **writes `.env.local` for you**.

   > The hosted link rides an Etherfuse endpoint deprecated with sunset
   > **2026-08-16**; after that date, onboard via the in-app JWT flow
   > (`rampkit keygen` + `createKycLaunch`) or the dashboard instead.

### 2 · Run

```bash
npm run dev -w apps/demo
# → http://localhost:3000  (home page shows an environment check)
```

The demo runs in **BRL** (assets discovered at runtime — no symbols
hardcoded). To test the **offramp** the wallet must hold the stablebond —
there is no faucet: run an **onramp** first ("Simulate deposit", then
"Sign claim"); that also creates the trustline.

Onramp flow: quote → create order → deposit instructions (PIX code/key for
BRL, SPEI CLABE for MXN — the demo renders whichever rail the order
carries) → **Simulate deposit** (sandbox button) → claim tokens (first-time
wallets). Offramp flow: quote → preflight → order → sign the burn
transaction (auto-regenerated as it expires) → payout tracked to
`finalized`.

The probe reuses the same env file: `node scripts/regenerate-tx-probe.mjs`.

## License

Apache-2.0. Derived from the Etherfuse integration in the
[Stellar Regional Starter Pack](https://github.com/ElliotFriend/regional-starter-pack)
by Elliot Friend — see
[`packages/rampkit/NOTICE`](./packages/rampkit/NOTICE) and
[`CHANGES-FROM-UPSTREAM.md`](./packages/rampkit/CHANGES-FROM-UPSTREAM.md).
Not affiliated with Etherfuse or the Stellar Development Foundation.
