import { describe, expect, it, vi } from 'vitest';
import { pollingSource } from '../src/core/polling';
import type { RampOrder } from '../src/core/types';

const orderWith = (burnTransaction: string | null): RampOrder =>
    ({ orderId: 'o-1', burnTransaction }) as unknown as RampOrder;

describe('pollingSource', () => {
    it('resolves once burnTransaction appears', async () => {
        vi.useFakeTimers();
        try {
            const reads = [orderWith(null), orderWith(null), orderWith('XDR_A')];
            const getOrder = vi.fn(() => Promise.resolve(reads.shift() ?? orderWith('XDR_A')));
            const source = pollingSource(getOrder, { intervalMs: 1000 });

            const promise = source.waitForFresh(
                'o-1',
                { previousXdr: null },
                new AbortController().signal,
            );
            await vi.advanceTimersByTimeAsync(3000);
            await expect(promise).resolves.toBe('XDR_A');
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores the previous XDR and resolves only on a DIFFERENT one', async () => {
        vi.useFakeTimers();
        try {
            const reads = [orderWith('XDR_OLD'), orderWith('XDR_OLD'), orderWith('XDR_NEW')];
            const getOrder = vi.fn(() => Promise.resolve(reads.shift() ?? orderWith('XDR_NEW')));
            const source = pollingSource(getOrder, { intervalMs: 1000 });

            const promise = source.waitForFresh(
                'o-1',
                { previousXdr: 'XDR_OLD' },
                new AbortController().signal,
            );
            await vi.advanceTimersByTimeAsync(3000);
            await expect(promise).resolves.toBe('XDR_NEW');
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects on abort and stops polling', async () => {
        vi.useFakeTimers();
        try {
            const getOrder = vi.fn(() => Promise.resolve(orderWith(null)));
            const source = pollingSource(getOrder, { intervalMs: 1000 });
            const controller = new AbortController();

            const promise = source.waitForFresh(
                'o-1',
                { previousXdr: null },
                controller.signal,
            );
            const expectation = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
            await vi.advanceTimersByTimeAsync(1500);
            controller.abort();
            await expectation;

            const calls = getOrder.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5000);
            expect(getOrder.mock.calls.length).toBe(calls); // no reads after abort
        } finally {
            vi.useRealTimers();
        }
    });

    it('survives transient read failures', async () => {
        vi.useFakeTimers();
        try {
            let call = 0;
            const getOrder = vi.fn(() => {
                call += 1;
                return call < 3
                    ? Promise.reject(new Error('network blip'))
                    : Promise.resolve(orderWith('XDR_OK'));
            });
            const source = pollingSource(getOrder, { intervalMs: 1000 });

            const promise = source.waitForFresh(
                'o-1',
                { previousXdr: null },
                new AbortController().signal,
            );
            await vi.advanceTimersByTimeAsync(3000);
            await expect(promise).resolves.toBe('XDR_OK');
        } finally {
            vi.useRealTimers();
        }
    });
});
