/**
 * Rampkit server runtime — the only module that sees the Etherfuse API key.
 * Node-conditioned in the exports map: browser bundles cannot resolve it.
 */

export { EtherfuseClient, type EtherfuseClientConfig } from './client';
export {
    RAMP_OPERATIONS,
    type OperationSpec,
    type RampSession,
    BadParamsError,
    NotOwnedError,
} from './operations';
export {
    createRampHandler,
    toNodeHandler,
    unsafeTrustClient,
    type CreateRampHandlerOptions,
    type GetSession,
} from './handler';
export {
    signUserJwt,
    createJwks,
    createJwksHandler,
    type OnboardingConfig,
} from './onboarding';

// Server-relevant core re-exports, so consumers can import from one place.
export { offrampPreflight, fetchAccount } from '../core/horizon';
export {
    RampkitError,
    EtherfuseApiError,
    DuplicatePendingOrderError,
    OfframpPreflightError,
    HorizonError,
} from '../core/errors';
export { NETWORKS } from '../core/constants';
export type {
    RampEnvironment,
    RampEvent,
    RampAsset,
    RampQuote,
    RampOrder,
    RampBankAccount,
    RegenerateResult,
    PreflightIssue,
    PreflightResult,
    RampOperation,
    RampPublicConfig,
    CreatedCustomer,
    CustomerKyc,
    KycRequirement,
    KycStatus,
    KycLaunch,
    WalletKyc,
    WalletKycStatus,
    VerificationData,
    VerificationSubmission,
    HostedOnboarding,
    DepositInstructions,
    SpeiDeposit,
    PixDeposit,
} from '../core/types';
