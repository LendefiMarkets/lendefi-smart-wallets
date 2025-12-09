// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {BasePaymaster} from "./aa-v07/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "./aa-v07/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "./aa-v07/contracts/interfaces/PackedUserOperation.sol";

/**
 * @title LendefiPaymaster
 * @dev ERC-4337 Paymaster inheriting from audited BasePaymaster
 *      Supports subscription-based gas sponsorship with tiered subsidies
 */
contract LendefiPaymaster is BasePaymaster {
    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    enum SubscriptionTier {
        NONE,
        BASIC, // 50% gas subsidy
        PREMIUM, // 90% gas subsidy
        ULTIMATE // 100% gas subsidy

    }

    struct UserSubscription {
        SubscriptionTier tier;
        uint48 expiresAt;
        uint48 lastResetTime;
        uint256 gasUsedThisMonth;
        uint256 monthlyGasLimit;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 private constant SUBSIDY_BASIC = 50;
    uint256 private constant SUBSIDY_PREMIUM = 90;
    uint256 private constant SUBSIDY_ULTIMATE = 100;
    uint256 private constant MONTH = 30 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    address public immutable smartWalletFactory;

    mapping(address user => UserSubscription subscription) public subscriptions;
    mapping(address operator => bool isAuthorized) public authorizedOperators;

    uint256 public maxGasPerMonthBasic = 500_000;
    uint256 public maxGasPerMonthPremium = 2_000_000;
    uint256 public maxGasPerMonthUltimate = 10_000_000;
    uint256 public maxGasPerOperation = 500_000;

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error Unauthorized();
    error InvalidWallet();
    error InvalidTier();
    error NoSubscription();
    error SubscriptionExpired();
    error MonthlyLimitExceeded();
    error GasLimitExceeded();
    error PaymasterDepositTooLow();
    error ZeroAddress();
    error InvalidGasLimit();
    error GasLimitTooHigh();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event SubscriptionGranted(address indexed user, SubscriptionTier tier, uint48 expiresAt, uint256 monthlyLimit);
    event SubscriptionRevoked(address indexed user);
    event GasSubsidized(address indexed user, uint256 gasUsed, uint256 subsidyAmount, SubscriptionTier tier);
    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);
    event TierLimitUpdated(SubscriptionTier tier, uint256 oldLimit, uint256 newLimit);
    event MaxGasPerOperationUpdated(uint256 oldLimit, uint256 newLimit);
    event MonthlyGasReset(address indexed user);

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyAuthorized() {
        if (!authorizedOperators[msg.sender] && msg.sender != owner()) {
            revert Unauthorized();
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(IEntryPoint _entryPoint, address _smartWalletFactory) BasePaymaster(_entryPoint) {
        if (_smartWalletFactory == address(0)) revert ZeroAddress();
        smartWalletFactory = _smartWalletFactory;
        authorizedOperators[msg.sender] = true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PAYMASTER IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Validate user operation for gas sponsorship
     */
    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, /*userOpHash*/ uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        // Validate wallet
        address wallet = userOp.sender;
        if (!_isValidWallet(wallet)) revert InvalidWallet();

        // Validate subscription
        UserSubscription storage sub = subscriptions[wallet];
        if (sub.tier == SubscriptionTier.NONE) revert NoSubscription();
        if (block.timestamp >= sub.expiresAt) revert SubscriptionExpired();

        // Reset monthly usage if needed
        if (block.timestamp >= sub.lastResetTime + MONTH) {
            sub.gasUsedThisMonth = 0;
            sub.lastResetTime = uint48(block.timestamp);
        }

        // Validate gas limits
        uint256 estimatedGas = _extractGasLimits(userOp);
        if (estimatedGas > maxGasPerOperation) revert GasLimitExceeded();
        if (sub.gasUsedThisMonth + estimatedGas > sub.monthlyGasLimit) revert MonthlyLimitExceeded();

        // Check deposit
        uint256 subsidy = (maxCost * _getSubsidyPercentage(sub.tier)) / 100;
        if (entryPoint.balanceOf(address(this)) < subsidy) revert PaymasterDepositTooLow();

        // Pre-deduct gas for atomic accounting (prevents free gas on reverts)
        uint256 gasUsedBefore = sub.gasUsedThisMonth;
        sub.gasUsedThisMonth += estimatedGas;

        // Return context for postOp (includes previous usage for potential refund)
        context = abi.encode(wallet, estimatedGas, gasUsedBefore, sub.tier);
        validationData = 0; // Valid with no time restrictions
    }

    /**
     * @dev Post-operation accounting
     */
    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 /*actualUserOpFeePerGas*/ )
        internal
        override
    {
        (address wallet, uint256 estimatedGas, uint256 gasUsedBefore, SubscriptionTier tier) =
            abi.decode(context, (address, uint256, uint256, SubscriptionTier));

        if (mode == PostOpMode.postOpReverted) {
            // Refund pre-deducted gas on revert
            subscriptions[wallet].gasUsedThisMonth = gasUsedBefore;
            return;
        }

        // Gas was already deducted in validation, emit event with actual cost
        uint256 sponsored = (actualGasCost * _getSubsidyPercentage(tier)) / 100;
        emit GasSubsidized(wallet, estimatedGas, sponsored, tier);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SUBSCRIPTION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Grant subscription to user
     */
    function grantSubscription(address user, SubscriptionTier tier, uint256 durationInSeconds)
        external
        onlyAuthorized
    {
        if (user == address(0)) revert ZeroAddress();
        if (tier == SubscriptionTier.NONE) revert InvalidTier();

        uint48 expiresAt = uint48(block.timestamp + durationInSeconds);
        uint256 monthlyLimit = _getMonthlyGasLimit(tier);

        subscriptions[user] = UserSubscription({
            tier: tier,
            expiresAt: expiresAt,
            lastResetTime: uint48(block.timestamp),
            gasUsedThisMonth: 0,
            monthlyGasLimit: monthlyLimit
        });

        emit SubscriptionGranted(user, tier, expiresAt, monthlyLimit);
    }

    /**
     * @dev Revoke user subscription
     */
    function revokeSubscription(address user) external onlyAuthorized {
        delete subscriptions[user];
        emit SubscriptionRevoked(user);
    }

    /**
     * @dev Reset monthly gas usage for user
     */
    function resetMonthlyGasUsage(address user) external onlyAuthorized {
        subscriptions[user].gasUsedThisMonth = 0;
        subscriptions[user].lastResetTime = uint48(block.timestamp);
        emit MonthlyGasReset(user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // OPERATOR MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Add authorized operator
     */
    function addAuthorizedOperator(address operator) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        authorizedOperators[operator] = true;
        emit OperatorAdded(operator);
    }

    /**
     * @dev Remove authorized operator
     */
    function removeAuthorizedOperator(address operator) external onlyOwner {
        authorizedOperators[operator] = false;
        emit OperatorRemoved(operator);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Set gas limit for a specific tier
     */
    function setTierGasLimit(SubscriptionTier tier, uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidGasLimit();

        uint256 oldLimit;
        if (tier == SubscriptionTier.BASIC) {
            oldLimit = maxGasPerMonthBasic;
            maxGasPerMonthBasic = newLimit;
        } else if (tier == SubscriptionTier.PREMIUM) {
            oldLimit = maxGasPerMonthPremium;
            maxGasPerMonthPremium = newLimit;
        } else if (tier == SubscriptionTier.ULTIMATE) {
            oldLimit = maxGasPerMonthUltimate;
            maxGasPerMonthUltimate = newLimit;
        } else {
            revert InvalidTier();
        }

        emit TierLimitUpdated(tier, oldLimit, newLimit);
    }

    /**
     * @dev Set maximum gas per operation
     */
    function setMaxGasPerOperation(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidGasLimit();
        if (newLimit > 30_000_000) revert GasLimitTooHigh();

        uint256 oldLimit = maxGasPerOperation;
        maxGasPerOperation = newLimit;

        emit MaxGasPerOperationUpdated(oldLimit, newLimit);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Check if user has active subscription
     */
    function hasActiveSubscription(address user) external view returns (bool) {
        UserSubscription memory sub = subscriptions[user];
        return sub.tier != SubscriptionTier.NONE && block.timestamp < sub.expiresAt;
    }

    /**
     * @dev Get subscription info
     */
    function getSubscription(address user) external view returns (UserSubscription memory) {
        return subscriptions[user];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _isValidWallet(address wallet) internal view returns (bool) {
        (bool success, bytes memory data) =
            smartWalletFactory.staticcall(abi.encodeWithSignature("isValidWallet(address)", wallet));
        return success && data.length >= 32 && abi.decode(data, (bool));
    }

    function _extractGasLimits(PackedUserOperation calldata userOp) internal pure returns (uint256) {
        uint256 packed = uint256(userOp.accountGasLimits);
        uint128 verificationGas = uint128(packed >> 128);
        uint128 callGas = uint128(packed);
        return uint256(verificationGas) + uint256(callGas) + userOp.preVerificationGas;
    }

    function _getSubsidyPercentage(SubscriptionTier tier) internal pure returns (uint256) {
        if (tier == SubscriptionTier.BASIC) return SUBSIDY_BASIC;
        if (tier == SubscriptionTier.PREMIUM) return SUBSIDY_PREMIUM;
        return SUBSIDY_ULTIMATE;
    }

    function _getMonthlyGasLimit(SubscriptionTier tier) internal view returns (uint256) {
        if (tier == SubscriptionTier.BASIC) return maxGasPerMonthBasic;
        if (tier == SubscriptionTier.PREMIUM) return maxGasPerMonthPremium;
        return maxGasPerMonthUltimate;
    }
}
