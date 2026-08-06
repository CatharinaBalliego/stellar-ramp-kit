# Changes from upstream

This file satisfies Apache-2.0 §4(b): prominent notice of what was changed
relative to the work this package derives from.

**Upstream:** [`ElliotFriend/regional-starter-pack`](https://github.com/ElliotFriend/regional-starter-pack)
at commit `ae9d8f4`, files `src/lib/anchors/etherfuse/{client,types,index}.ts`
(a SvelteKit-embedded, copy-into-your-project Etherfuse client).

**Status: v0 implemented** (server, core, browser client, React hooks; 39
unit tests). The changes below are landed unless marked otherwise.

## Structural changes

- Repackaged from copy-three-files into an installable npm package with
  subpath exports (`.`, `./server`, `./client`, `./react`); `./server` is
  Node-conditioned so browser bundles cannot resolve the API-key holder
  (`src/server/*`, `package.json#exports`).
- Wallet-agnostic signer contract replaces direct Freighter usage: the
  consumer passes `{ address, signTransaction }`; both signed-XDR and
  submitted-hash returns are supported (`src/core/types.ts`). No wallet SDK
  is imported.
- `@stellar/stellar-sdk` dependency removed (upstream used it only for
  address validation, which is delegated to the API). Horizon interactions
  (offramp preflight, transaction submit) are plain HTTP
  (`src/core/horizon.ts`).
- Server route handler with a frozen operation map replaces per-endpoint
  SvelteKit proxy routes; no arbitrary path proxying. Caller identity comes
  from a required `getSession`, not from the request body
  (`src/server/handler.ts`, `src/server/operations.ts`).
- Onboarding/KYC endpoints are out of scope for v0: upstream is built on
  `POST /ramp/onboarding-url`, deprecated with sunset 2026-08-16
  (https://docs.etherfuse.com/changelog/deprecations).
- React hooks (`useOnramp` / `useOfframp`) own the flow state machines,
  including expired-transaction and waiting-for-regeneration states, and
  proactively regenerate the burn XDR (~50s) while it is open for signing
  (`src/react/hooks.ts`) — upstream left flow logic to per-page Svelte code.

## Behavioral fixes relative to upstream

- Error handling matches the wire: Etherfuse error bodies are plain text or
  `{"error": "<string>"}` — upstream typed `{error: {code, message}}` and
  parsed IDs out of message strings with regex. Errors are switched on HTTP
  status only (`src/server/client.ts#request`, pinned in
  `tests/client.test.ts`).
- 409 on order creation is disambiguated structurally (GET own orderId:
  200 ⇒ idempotent success marked `recovered`; 404 ⇒ duplicate-pending-
  amount rule, order never created → `DuplicatePendingOrderError`) instead
  of being treated as one case (`src/server/client.ts#recoverConflict`).
- Offramp preflight added (account exists / XLM reserve incl. subentries /
  trustline / asset balance, via Horizon) — upstream polls forever when
  Etherfuse silently declines to build a `burnTransaction` for an unfunded
  wallet (`src/core/horizon.ts#offrampPreflight`).
- Order mapping no longer fabricates values: upstream hardcoded empty
  strings for fields present on the wire (`sourceAsset`, `targetAsset`,
  `exchangeRate`) and fabricated `kycStatus: 'not_started'` on lookups.
  Wire numbers normalize to strings; absent fields are `null`
  (`src/server/client.ts#mapOrder`).
- Quote direction is explicit (upstream inferred it from a `:` in the asset
  identifier); symbol→identifier resolution uses the quote's own fiat as the
  currency filter (upstream hardcoded MXN) and always sends the wallet the
  API requires.
- Asset identifiers are always discovered via `GET /ramp/assets` — upstream
  additionally shipped hardcoded issuer constants.
- Expired pre-built transactions are regenerated via
  `POST /ramp/order/{id}/regenerate_tx` with explicit state-machine states
  (`transaction_expired`, `regenerating`,
  `awaiting_regenerated_transaction`), including proactive refresh while a
  transaction is open for signing.
- `simulateFiatReceived` throws on failure and is refused outside sandbox —
  upstream returned the raw status code and would run against production.
- Not carried over (out of v0 scope): webhook payload type (upstream's flat
  `{event, data}` shape does not match real tagged deliveries — document
  only), KYC status enum fix, anchor mode, embedded wallets, swaps.
