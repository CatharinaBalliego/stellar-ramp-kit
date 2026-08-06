/**
 * Rampkit — isomorphic core: types, errors, state-machine helpers, the
 * offramp preflight, Horizon submission, and the polling transaction source.
 * No secrets, no Node APIs, no dependencies.
 */

export const RAMPKIT_VERSION = '0.4.0';

export {
    NETWORKS,
    QUOTE_TTL_MS,
    REGENERATE_AFTER_MS,
    ORDER_POLL_MS,
    TX_POLL_MS,
} from './core/constants';

export {
    RampkitError,
    EtherfuseApiError,
    DuplicatePendingOrderError,
    OfframpPreflightError,
    HorizonError,
    TransactionFailedError,
} from './core/errors';

export { fetchAccount, offrampPreflight, submitToHorizon } from './core/horizon';
export { pollingSource } from './core/polling';

export {
    quoteRemainingMs,
    transactionIsStale,
    isTerminalStatus,
    phaseForTerminalStatus,
    type OnrampPhase,
    type OfframpPhase,
} from './core/machines';

export type {
    RampEnvironment,
    RampEvent,
    SignerResult,
    SignRequest,
    RampSigner,
    KycStatus,
    KycRequirement,
    CustomerKyc,
    CreatedCustomer,
    KycLaunch,
    WalletKyc,
    WalletKycStatus,
    HostedOnboarding,
    SpeiDeposit,
    PixDeposit,
    RampAsset,
    RampDirection,
    RampQuote,
    OrderStatus,
    DepositInstructions,
    RampOrder,
    RegenerateResult,
    RampBankAccount,
    PreflightIssue,
    PreflightResult,
    TransactionSource,
    RampOperation,
    RampPublicConfig,
    RampErrorEnvelope,
} from './core/types';

export { TERMINAL_ONRAMP_STATUSES, TERMINAL_OFFRAMP_STATUSES } from './core/types';
