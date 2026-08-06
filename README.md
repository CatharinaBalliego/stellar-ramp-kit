# Rampkit monorepo

**Rampkit** is an Etherfuse ramp kit for Stellar — fiat on/off-ramps
(SPEI ⇄ CETES and other stablebonds) as an installable npm package: server
route handler, browser client, React hooks, wallet-agnostic signer.

**→ The package (and its full README) lives in
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
npm run test        # 39 unit tests (vitest, mocked HTTP — no API key needed)
npm run build       # tsup: ESM+CJS+types for ., /server, /client, /react
```

## Running the demo (Etherfuse sandbox, Stellar testnet)

No real money is involved anywhere below.

### 1 · One-time sandbox setup

1. **Account + API key** — create an account at
   [sandbox.etherfuse.com](https://sandbox.etherfuse.com), open the KYB page
   and click **Approve KYB** (sandbox lets you approve yourself, no
   documents), then generate an API key (`api_sand_…`).
2. **Everything else is scripted** (same flow as
   `npx @spacecathy/rampkit setup-sandbox`, which package consumers use):

   ```bash
   cp apps/demo/.env.local.example apps/demo/.env.local
   # paste your ETHERFUSE_API_KEY into it, then:
   node scripts/bootstrap-sandbox.mjs you@email.com
   ```

   The script creates the customer and a funded testnet wallet, hands you
   the hosted-onboarding link (one browser click-through: KYC + bank
   account — sandbox auto-approves; **Mexico** requires
   [this example Constancia](https://stablebonds.s3.us-west-2.amazonaws.com/example-constancia-de-situacion-fiscal.pdf)
   at the tax step), verifies approval, and **writes `.env.local` for you**.

### 2 · Run

```bash
npm run dev -w apps/demo
# → http://localhost:3000  (home page shows an environment check)
```

To test the **offramp** the wallet must hold CETES — there is no faucet:
run an **onramp** first (≤ 500 MXN sandbox cap, "Simulate deposit", then
"Sign claim"); that also creates the trustline.

Onramp flow: quote → create order → SPEI CLABE → **Simulate deposit**
(sandbox button) → claim tokens (first-time wallets). Offramp flow: quote →
preflight → order → sign the burn transaction (auto-regenerated as it
expires) → payout tracked to `finalized`.

The probe reuses the same env file: `node scripts/regenerate-tx-probe.mjs`.

## License

Apache-2.0. Derived from the Etherfuse integration in the
[Stellar Regional Starter Pack](https://github.com/ElliotFriend/regional-starter-pack)
by Elliot Friend — see
[`packages/rampkit/NOTICE`](./packages/rampkit/NOTICE) and
[`CHANGES-FROM-UPSTREAM.md`](./packages/rampkit/CHANGES-FROM-UPSTREAM.md).
Not affiliated with Etherfuse or the Stellar Development Foundation.
