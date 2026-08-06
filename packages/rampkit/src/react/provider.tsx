import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { RampClient } from '../client/index';
import type { RampPublicConfig, RampSigner } from '../core/types';

interface RampContextValue {
    client: RampClient;
    signer: RampSigner | null;
    /** Cached `config.get` (network passphrase, Horizon URL). */
    ensureConfig: () => Promise<RampPublicConfig>;
}

const RampContext = createContext<RampContextValue | null>(null);

export interface RampProviderProps {
    /** Browser client from `createRampClient()`. */
    client: RampClient;
    /**
     * Wallet-agnostic signer. Optional so read-only screens can render
     * without a connected wallet; signing actions throw until it exists.
     */
    signer?: RampSigner | null;
    children: ReactNode;
}

export function RampProvider(props: RampProviderProps): ReactNode {
    const configPromise = useRef<Promise<RampPublicConfig> | null>(null);
    const { client } = props;
    const signer = props.signer ?? null;

    const value = useMemo<RampContextValue>(
        () => ({
            client,
            signer,
            ensureConfig: () => {
                // Cache the promise; on failure clear it so a retry can succeed.
                configPromise.current ??= client.getConfig().catch((error: unknown) => {
                    configPromise.current = null;
                    throw error;
                });
                return configPromise.current;
            },
        }),
        [client, signer],
    );

    return <RampContext.Provider value={value}>{props.children}</RampContext.Provider>;
}

export function useRampContext(): RampContextValue {
    const context = useContext(RampContext);
    if (!context) {
        throw new Error('Rampkit hooks must be used inside <RampProvider>');
    }
    return context;
}

/** The RampClient from context. */
export function useRampClient(): RampClient {
    return useRampContext().client;
}

/** The signer from context (null when no wallet is connected). */
export function useRampSigner(): RampSigner | null {
    return useRampContext().signer;
}
