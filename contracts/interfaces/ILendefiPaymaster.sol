// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

// Custom errors for LendefiPaymaster
error NotFromEntryPoint();
error InvalidWallet();
error InvalidTier();
error NoSubscription();
error SubscriptionExpired();
error MonthlyLimitExceeded();
error GasLimitExceeded();
error PaymasterDepositTooLow();
error Unauthorized();
error InvalidGasLimit();
error GasLimitTooHigh();
