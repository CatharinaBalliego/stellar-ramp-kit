/** Per-environment endpoints and Stellar network parameters. */
export const NETWORKS = {
    sandbox: {
        baseUrl: 'https://api.sand.etherfuse.com',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
        statusHost: 'https://sandbox.etherfuse.com',
    },
    production: {
        baseUrl: 'https://api.etherfuse.com',
        horizonUrl: 'https://horizon.stellar.org',
        network: 'public',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        statusHost: 'https://app.etherfuse.com',
    },
} as const;

/** Etherfuse quotes expire 2 minutes after creation. */
export const QUOTE_TTL_MS = 120_000;

/**
 * Pre-built Stellar XDRs live ~1–2 minutes. The docs advise regenerating
 * about once a minute while a transaction is open for signing; we refresh
 * slightly earlier so the user always holds a signable transaction.
 */
export const REGENERATE_AFTER_MS = 50_000;

/** Interval for order-status polling (awaiting deposit / burn confirmation). */
export const ORDER_POLL_MS = 4_000;

/** Interval for burnTransaction freshness polling (pollingSource default). */
export const TX_POLL_MS = 2_000;
