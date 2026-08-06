import type { ReactNode } from 'react';
import { DemoRampProvider } from '../lib/ramp';

export const metadata = {
    title: 'Rampkit demo',
    description: 'Etherfuse ramp kit for Stellar — sandbox demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body
                style={{
                    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                    maxWidth: 720,
                    margin: '0 auto',
                    padding: '2rem 1rem',
                    lineHeight: 1.5,
                }}
            >
                <header style={{ marginBottom: '2rem' }}>
                    <h1 style={{ margin: 0 }}>Rampkit demo</h1>
                    <p style={{ color: '#666', margin: '0.25rem 0 0' }}>
                        Etherfuse sandbox · Stellar testnet ·{' '}
                        <a href="/">home</a> · <a href="/onramp">onramp</a> ·{' '}
                        <a href="/offramp">offramp</a>
                    </p>
                </header>
                <DemoRampProvider>{children}</DemoRampProvider>
            </body>
        </html>
    );
}
