'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRampClient } from '@seu-escopo/rampkit/react';
import type { RampBankAccount } from '@seu-escopo/rampkit';

export function Section(props: { title: string; children: ReactNode }) {
    return (
        <section
            style={{
                border: '1px solid #ddd',
                borderRadius: 8,
                padding: '0.75rem 1rem',
                margin: '1rem 0',
            }}
        >
            <h3 style={{ marginTop: 0, fontSize: '1rem' }}>{props.title}</h3>
            {props.children}
        </section>
    );
}

export function Phase(props: { phase: string }) {
    return (
        <p>
            Phase: <b>{props.phase}</b>
        </p>
    );
}

export function ErrorLine(props: { error: Error | null }) {
    if (!props.error) return null;
    return <p style={{ color: 'crimson' }}>{props.error.message}</p>;
}

/** Bank account selector — an order needs a bankAccountId. */
export function BankAccountPicker(props: {
    value: string;
    onChange: (id: string) => void;
}) {
    const client = useRampClient();
    const [accounts, setAccounts] = useState<RampBankAccount[]>([]);

    useEffect(() => {
        let cancelled = false;
        client.listBankAccounts().then(
            (list) => {
                if (cancelled) return;
                setAccounts(list);
                const first = list.find((a) => a.status === 'active') ?? list[0];
                if (first && !props.value) props.onChange(first.id);
            },
            () => undefined,
        );
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
    }, [client]);

    return (
        <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
            <option value="">— bank account —</option>
            {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                    {a.accountIdentifier} ({a.status})
                </option>
            ))}
        </select>
    );
}
