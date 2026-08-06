'use client';

import { useMemo, type ReactNode } from 'react';
import { createRampClient } from '@seu-escopo/rampkit/client';
import { RampProvider, type RampSigner } from '@seu-escopo/rampkit/react';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Demo signer: signs with a TESTNET secret key from env, in the browser.
 * This is the wallet-agnostic boundary — swap this object for Freighter,
 * Lobstr, etc. in a real app; rampkit never imports any wallet SDK.
 */
function makeDemoSigner(): RampSigner | null {
    const secret = process.env.NEXT_PUBLIC_DEMO_WALLET_SECRET;
    if (!secret) return null;
    const keypair = Keypair.fromSecret(secret);
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
