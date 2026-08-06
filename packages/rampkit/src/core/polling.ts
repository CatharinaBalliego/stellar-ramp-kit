import { TX_POLL_MS } from './constants';
import type { RampOrder, TransactionSource } from './types';

/**
 * Polling implementation of {@link TransactionSource}: re-reads the order
 * until `burnTransaction` is present and different from `previousXdr`.
 *
 * v0 default. If the sandbox probe shows `GET /ramp/order` does NOT reflect
 * regenerated transactions, a websocket source replaces this as default —
 * same interface.
 */
export function pollingSource(
    getOrder: (orderId: string) => Promise<RampOrder>,
    opts: { intervalMs?: number } = {},
): TransactionSource {
    const intervalMs = opts.intervalMs ?? TX_POLL_MS;

    return {
        waitForFresh(orderId, { previousXdr }, signal) {
            return new Promise<string>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined;

                const stop = (fn: () => void) => {
                    if (timer !== undefined) clearTimeout(timer);
                    signal.removeEventListener('abort', onAbort);
                    fn();
                };
                const onAbort = () =>
                    stop(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) return onAbort();

                const tick = async () => {
                    try {
                        const order = await getOrder(orderId);
                        const xdr = order.burnTransaction;
                        if (xdr && xdr !== previousXdr) return stop(() => resolve(xdr));
                    } catch (error) {
                        // Transient read failures shouldn't kill the wait; only
                        // abort does. Surface persistent failures via abort/timeouts
                        // at the caller.
                        void error;
                    }
                    if (!signal.aborted) timer = setTimeout(tick, intervalMs);
                };
                void tick();
            });
        },
    };
}
