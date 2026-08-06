'use client';

import { useMemo, type ReactNode } from 'react';
import { createRampClient } from '@spacecathy/rampkit/client';
import { RampProvider, type RampSigner } from '@spacecathy/rampkit/react';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Demo signer: signs with a TESTNET secret key from env, in the browser.
 * This is the wallet-agnostic boundary — swap this object for Freighter,
 * Lobstr, etc. in a real app; rampkit never imports any wallet SDK.
 */
function makeDemoSigner(): RampSigner | null {
    const secret = process.env.NEXT_PUBLIC_DEMO_WALLET_SECRET;
    if (!secret) return null;
    let keypair: Keypair;
    try {
        keypair = Keypair.fromSecret(secret);
    } catch {
        // Placeholder or malformed secret (e.g. the example file's "S...").
        // Render as "signer: not configured" instead of a 500 — run
        // scripts/bootstrap-sandbox.mjs to fill in real values.
        return null;
    }
    return {
        address: keypair.publicKey(),
        async signTransaction({ xdr, networkPassphrase }) {
            const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
            tx.sign(keypair);
            // Returning { signedXdr } — rampkit submits to Horizon. A wallet
            // that submits itself would return { hash } instead.
            return { signedXdr: tx.toXDR() };
        },
    };
}

export function DemoRampProvider(props: { children: ReactNode }): ReactNode {
    const client = useMemo(() => createRampClient(), []);
    const signer = useMemo(makeDemoSigner, []);
    return (
        <RampProvider client={client} signer={signer}>
            {props.children}
        </RampProvider>
    );
}
