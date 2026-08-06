/**
 * Rampkit React bindings — provider + flow hooks. The hooks own the state
 * machines and freshness timers; the signer stays wallet-agnostic.
 */

export {
    RampProvider,
    useRampClient,
    useRampSigner,
    type RampProviderProps,
} from './provider';

export {
    useRampAssets,
    useOnramp,
    useOfframp,
    type UseRampAssetsResult,
    type UseOnrampResult,
    type UseOfframpOptions,
    type UseOfframpResult,
} from './hooks';

export type { OnrampPhase, OfframpPhase } from '../core/machines';
export type {
    RampSigner,
    SignerResult,
    SignRequest,
    RampAsset,
    RampQuote,
    RampOrder,
    PreflightIssue,
} from '../core/types';
