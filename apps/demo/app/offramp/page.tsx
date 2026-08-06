'use client';

import { useState } from 'react';
import { useOfframp, useRampAssets } from '@seu-escopo/rampkit/react';
import { BankAccountPicker, ErrorLine, Phase, Section } from '../ui';

export default function OfframpPage() {
    const { assets } = useRampAssets({ currency: 'MXN' });
    const { phase, quote, order, burnXdr, preflightIssues, txHash, error, actions } =
        useOfframp();
    const [asset, setAsset] = useState('CETES');
    const [amount, setAmount] = useState('1');
    const [bankAccountId, setBankAccountId] = useState('');
    const [resumeId, setResumeId] = useState('');

    const busy = phase === 'quoting' || phase === 'creating_order';

    return (
        <main>
            <h2>Offramp — tokens → MXN</h2>
            <Phase phase={phase} />
            <ErrorLine error={error} />

            {phase === 'preflight_failed' && preflightIssues && (
                <Section title="Wallet not ready (caught BEFORE creating the order)">
                    <ul>
                        {preflightIssues.map((issue, i) => (
                            <li key={i}>
                                {issue.code === 'account_not_found' &&
                                    'Wallet does not exist on-chain — fund it with XLM first.'}
                                {issue.code === 'insufficient_xlm' &&
                                    `Not enough XLM: has ${issue.available}, needs ~${issue.required}.`}
                                {issue.code === 'missing_trustline' &&
                                    `No trustline for ${issue.asset}.`}
                                {issue.code === 'insufficient_asset_balance' &&
                                    `Balance too low: has ${issue.available}, selling ${issue.required}.`}
                            </li>
                        ))}
                    </ul>
                    <p>
                        Without this check, Etherfuse would silently never produce a burn
                        transaction and the order would hang forever.
                    </p>
                </Section>
            )}

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
                tokens{' '}
                <button
                    disabled={busy}
                    onClick={() => void actions.requestQuote({ asset, fiat: 'MXN', amount })}
                >
                    Get quote
                </button>
                {quote && (
                    <p>
                        {quote.sourceAmount} {asset} → <b>{quote.destinationAmount}</b> MXN @{' '}
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

            <Section title="2 · Create order (preflight runs first)">
                <BankAccountPicker value={bankAccountId} onChange={setBankAccountId} />{' '}
                <button
                    disabled={phase !== 'quote_ready' || !bankAccountId}
                    onClick={() => void actions.start({ bankAccountId })}
                >
                    Create order
                </button>
            </Section>

            {(phase === 'awaiting_transaction' ||
                phase === 'awaiting_regenerated_transaction' ||
                phase === 'regenerating') && (
                <Section title="3 · Burn transaction">
                    <p>Waiting for Etherfuse to prepare the burn transaction…</p>
                </Section>
            )}

            {phase === 'transaction_ready' && burnXdr && (
                <Section title="3 · Sign the burn transaction">
                    <p>
                        XDR ready ({burnXdr.length} chars). It expires in ~1–2 min; rampkit
                        auto-regenerates it while you wait.
                    </p>
                    <button onClick={() => void actions.sign()}>Sign &amp; submit</button>{' '}
                    <button onClick={() => void actions.refreshTransaction()}>
                        Refresh manually
                    </button>
                </Section>
            )}

            {txHash && (
                <p>
                    Submitted: <code>{txHash}</code>
                </p>
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
