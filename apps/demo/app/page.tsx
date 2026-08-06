'use client';

import { useEffect, useState } from 'react';
import { useRampClient, useRampSigner } from '@seu-escopo/rampkit/react';
import type { RampBankAccount, RampPublicConfig } from '@seu-escopo/rampkit';

export default function Home() {
    const client = useRampClient();
    const signer = useRampSigner();
    const [config, setConfig] = useState<RampPublicConfig | null>(null);
    const [accounts, setAccounts] = useState<RampBankAccount[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        client.getConfig().then(setConfig, (e: Error) => setError(e.message));
        client.listBankAccounts().then(setAccounts, (e: Error) => setError(e.message));
    }, [client]);

    return (
        <main>
            <h2>Environment check</h2>
            {error && (
                <p style={{ color: 'crimson' }}>
                    {error} — is <code>.env.local</code> filled in? (see{' '}
                    <code>.env.local.example</code>)
                </p>
            )}
            <ul>
                <li>
                    Config:{' '}
                    {config
                        ? `${config.environment} / ${config.network}`
                        : 'loading…'}
                </li>
                <li>Signer: {signer ? <code>{signer.address}</code> : 'not configured'}</li>
                <li>
                    Bank accounts:{' '}
                    {accounts
                        ? accounts.length === 0
                            ? 'none registered'
                            : accounts
                                  .map((a) => `${a.accountIdentifier} (${a.status})`)
                                  .join(', ')
                        : 'loading…'}
                </li>
            </ul>
            <p>
                Try the <a href="/onramp">onramp</a> (MXN → CETES) or the{' '}
                <a href="/offramp">offramp</a> (CETES → MXN).
            </p>
        </main>
    );
}
