'use client';

import { useState } from 'react';
import { useOnramp, useRampAssets } from '@spacecathy/rampkit/react';
import { BankAccountPicker, ErrorLine, Phase, Section } from '../ui';

export default function OnrampPage() {
    const { assets } = useRampAssets({ currency: 'MXN' });
    const { phase, quote, order, deposit, error, actions } = useOnramp();
    const [asset, setAsset] = useState('CETES');
    const [amount, setAmount] = useState('100');
    const [bankAccountId, setBankAccountId] = useState('');
    const [resumeId, setResumeId] = useState('');

    const busy = phase === 'quoting' || phase === 'creating_order';

    return (
        <main>
            <h2>Onramp — MXN → tokens</h2>
            <Phase phase={phase} />
            <ErrorLine error={error} />

            <Section title="1 · Quote">
                <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                    {(assets.length ? assets : [{ symbol: 'CETES', identifier: 'CETES' }]).map(
                        (a) => (
                            <option key={a.identifier} value={a.symbol}>
                                {a.symbol}
                            </option>
                        ),
                    )}
                </select>{' '}
                <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    style={{ width: 90 }}
                />{' '}
                MXN (sandbox cap: 500){' '}
                <button
                    disabled={busy}
                    onClick={() => void actions.requestQuote({ asset, fiat: 'MXN', amount })}
                >
                    Get quote
                </button>
                {quote && (
                    <p>
                        {quote.sourceAmount} MXN → <b>{quote.destinationAmount}</b> {asset} @{' '}
                        {quote.exchangeRate}
                        {phase === 'quote_expired' ? (
                            <>
                                {' '}
                                <i>(expired)</i>{' '}
                                <button onClick={() => void actions.refreshQuote()}>
                                    Re-quote
                                </button>
                            </>
                        ) : null}
                    </p>
                )}
            </Section>

            <Section title="2 · Create order (as late as possible — quotes live 2 min)">
                <BankAccountPicker value={bankAccountId} onChange={setBankAccountId} />{' '}
                <button
                    disabled={phase !== 'quote_ready' || !bankAccountId}
                    onClick={() => void actions.start({ bankAccountId })}
                >
                    Create order
                </button>
            </Section>

            {deposit && (
                <Section title="3 · Pay the SPEI deposit">
                    <p>
                        CLABE: <code>{deposit.clabe}</code>
                        <br />
                        Bank: {deposit.bankName} · Beneficiary: {deposit.beneficiary}
                        <br />
                        Amount: <b>{deposit.amount} MXN</b>
                    </p>
                    <button onClick={() => void actions.simulateDeposit()}>
                        Simulate deposit (sandbox)
                    </button>
                </Section>
            )}

            {phase === 'claim_required' && (
                <Section title="4 · Claim your tokens">
                    <p>
                        First-time wallet: sign the claim transaction (ChangeTrust +
                        ClaimClaimableBalance) to receive your tokens.
                    </p>
                    <button onClick={() => void actions.signClaim()}>Sign claim</button>
                </Section>
            )}

            {order && (
                <Section title="Order">
                    <p>
                        <code>{order.orderId}</code> — {order.status}
                        {order.statusPage && (
                            <>
                                {' '}
                                · <a href={order.statusPage}>status page</a>
                            </>
                        )}
                    </p>
                </Section>
            )}

            <Section title="Resume (recovery is resume, never recreate)">
                <input
                    placeholder="orderId"
                    value={resumeId}
                    onChange={(e) => setResumeId(e.target.value)}
                    style={{ width: 320 }}
                />{' '}
                <button disabled={!resumeId} onClick={() => void actions.resume(resumeId)}>
                    Resume
                </button>{' '}
                <button onClick={actions.reset}>Reset</button>
            </Section>
        </main>
    );
}
