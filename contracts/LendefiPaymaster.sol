// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC4337Utils } from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import { IEntryPoint, PackedUserOperation, IPaymaster } from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {
    NotFromEntryPoint,
    InvalidWallet,
    InvalidTier,
    NoSubscription,
    SubscriptionExpired,
    MonthlyLimitExceeded,
    GasLimitExceeded,
    PaymasterDepositTooLow,
    Unauthorized,
    InvalidGasLimit,
    GasLimitTooHigh
} from "./interfaces/ILendefiPaymaster.sol";
import { IAccountFactory } from "./interfaces/IAccountFactory.sol";

/**
 * @title LendefiPaymaster
 * @dev ERC-4337 compliant Paymaster for subsidizing gas fees
 */
contract LendefiPaymaster is IPaymaster, Ownable {
    // Subscription tiers
    enum SubscriptionTier {
        NONE,
        BASIC, // 50% gas subsidy
        PREMIUM, // 90% gas subsidy
        ULTIMATE // 100% gas subsidy
    }

    struct UserSubscription {
        SubscriptionTier tier; // 1 byte (enum)
        uint48 expiresAt; // 6 bytes
        uint48 lastResetTime; // 6 bytes
        uint256 gasUsedThisMonth; // 32 bytes
        uint256 monthlyGasLimit; // 32 bytes
    }

    // Subsidy percentages
    uint256 private constant _SUBSIDY_PERCENTAGE_BASIC = 50;
    uint256 private constant _SUBSIDY_PERCENTAGE_PREMIUM = 90;
    uint256 private constant _SUBSIDY_PERCENTAGE_ULTIMATE = 100;

    // Immutable variables
    IEntryPoint public immutable entryPoint;
    address public immutable smartWalletFactory;

    // Gas limits per tier (configurable by owner)
    uint256 public maxGasPerMonthBasic = 500_000;
    uint256 public maxGasPerMonthPremium = 2_000_000;
    uint256 public maxGasPerMonthUltimate = 10_000_000;

    // State variables
    mapping(address user => UserSubscription subscription) public subscriptions;
    mapping(address operator => bool isAuthorized) public authorizedOperators;

    uint256 public maxGasPerOperation = 500_000;

    // Events
    event SubscriptionGranted(address indexed user, SubscriptionTier tier, uint48 expiresAt, uint256 monthlyLimit);
    event SubscriptionRevoked(address indexed user);
    event GasSubsidized(address indexed user, uint256 gasUsed, uint256 subsidyAmount, SubscriptionTier tier);
    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);
    event TierLimitUpdated(SubscriptionTier tier, uint256 oldLimit, uint256 newLimit);
    event MaxGasPerOperationUpdated(uint256 oldLimit, uint256 newLimit);

    // Modifiers
    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotFromEntryPoint();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedOperators[msg.sender] && msg.sender != owner()) {
            revert Unauthorized();
        }
        _;
    }

    /**
     * @dev Constructor
     * @param _entryPoint EntryPoint contract address
     * @param _smartWalletFactory Smart wallet factory address
     */
    constructor(IEntryPoint _entryPoint, address _smartWalletFactory) Ownable(msg.sender) {
        if (address(_entryPoint) == address(0) || _smartWalletFactory == address(0)) {
            revert IAccountFactory.InvalidUser();
        }
        entryPoint = _entryPoint;
        smartWalletFactory = _smartWalletFactory;
        authorizedOperators[msg.sender] = true;
    }

    /**
     * @dev Receive ETH
     */
    receive() external payable {
        // Accept ETH deposits
    }

    /**
     * @dev Validate paymaster user operation
     * @param userOp The user operation
     * @param userOpHash Hash of the user operation
     * @param maxCost Maximum cost of the operation
     * @return context Context for postOp
     * @return validationData Validation data
     */
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external override onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        userOpHash; // unused in this implementation

        address user = _validateAndExtractUser(userOp);
        UserSubscription storage subscription = _validateSubscription(user);
        uint256 estimatedGas = _validateGasLimits(userOp, subscription);
        uint256 subsidyAmount = _calculateSubsidy(maxCost, subscription.tier);

        // Pack context for postOp
        context = abi.encode(user, estimatedGas, subsidyAmount, subscription.tier);

        // Return validation data with no time bounds
        validationData = ERC4337Utils.packValidationData(address(0), 0, 0);
    }

    /**
     * @dev Post-operation handler
     * @param mode Operation mode
     * @param context Context from validation
     * @param actualGasCost Actual gas cost
     * @param actualUserOpFeePerGas Actual fee per gas
     */
    function postOp(
        IPaymaster.PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external override onlyEntryPoint {
        actualUserOpFeePerGas; // unused

        if (mode == IPaymaster.PostOpMode.opSucceeded || mode == IPaymaster.PostOpMode.opReverted) {
            (address user, uint256 estimatedGas, , SubscriptionTier tier) = abi.decode(
                context,
                (address, uint256, uint256, SubscriptionTier)
            );

            // Update gas usage
            subscriptions[user].gasUsedThisMonth += estimatedGas;

            // Calculate actual subsidy
            uint256 subsidyPercentage = _getSubsidyPercentage(tier);
            uint256 actualSubsidy = (actualGasCost * subsidyPercentage) / 100;

            emit GasSubsidized(user, estimatedGas, actualSubsidy, tier);
        }
    }

    /**
     * @dev Grant subscription to user
     * @param user User address
     * @param tier Subscription tier
     * @param durationInSeconds Duration in seconds
     */
    function grantSubscription(address user, SubscriptionTier tier, uint256 durationInSeconds) external onlyAuthorized {
        if (user == address(0)) revert IAccountFactory.InvalidUser();
        if (tier == SubscriptionTier.NONE) revert InvalidTier();

        uint48 expiresAt = uint48(block.timestamp + durationInSeconds);
        uint256 monthlyLimit = _getMonthlyGasLimit(tier);

        subscriptions[user] = UserSubscription({
            tier: tier,
            expiresAt: expiresAt,
            gasUsedThisMonth: 0,
            monthlyGasLimit: monthlyLimit,
            lastResetTime: uint48(block.timestamp)
        });

        emit SubscriptionGranted(user, tier, expiresAt, monthlyLimit);
    }

    /**
     * @dev Revoke user subscription
     * @param user User address
     */
    function revokeSubscription(address user) external onlyAuthorized {
        delete subscriptions[user];
        emit SubscriptionRevoked(user);
    }

    /**
     * @dev Reset monthly gas usage for user (admin function)
     * @param user User address
     */
    function resetMonthlyGasUsage(address user) external onlyAuthorized {
        subscriptions[user].gasUsedThisMonth = 0;
        subscriptions[user].lastResetTime = uint48(block.timestamp);
    }

    /**
     * @dev Add authorized operator
     * @param operator Operator address
     */
    function addAuthorizedOperator(address operator) external onlyOwner {
        if (operator == address(0)) revert IAccountFactory.InvalidUser();
        authorizedOperators[operator] = true;
        emit OperatorAdded(operator);
    }

    /**
     * @dev Remove authorized operator
     * @param operator Operator address
     */
    function removeAuthorizedOperator(address operator) external onlyOwner {
        authorizedOperators[operator] = false;
        emit OperatorRemoved(operator);
    }

    /**
     * @dev Deposit to EntryPoint
     */
    function deposit() external payable onlyAuthorized {
        entryPoint.depositTo{ value: msg.value }(address(this));
    }

    /**
     * @dev Withdraw from EntryPoint
     * @param withdrawAddress Address to withdraw to
     * @param amount Amount to withdraw
     */
    function withdrawTo(address payable withdrawAddress, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(withdrawAddress, amount);
    }

    /**
     * @dev Add stake to paymaster
     * @param unstakeDelaySec Unstake delay
     */
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{ value: msg.value }(unstakeDelaySec);
    }

    /**
     * @dev Unlock stake
     */
    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    /**
     * @dev Withdraw stake
     * @param withdrawAddress Address to withdraw to
     */
    function withdrawStake(address payable withdrawAddress) external onlyOwner {
        entryPoint.withdrawStake(withdrawAddress);
    }

    /**
     * @dev Set gas limit for a specific tier (only owner)
     * @param tier Subscription tier to update
     * @param newLimit New monthly gas limit
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
            // This covers NONE and any other invalid tier values
            revert InvalidTier();
        }

        emit TierLimitUpdated(tier, oldLimit, newLimit);
    }

    /**
     * @dev Set maximum gas per operation (only owner)
     * @param newLimit New maximum gas per operation
     */
    function setMaxGasPerOperation(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidGasLimit();
        if (newLimit > 30_000_000) revert GasLimitTooHigh(); // Reasonable upper bound

        uint256 oldLimit = maxGasPerOperation;
        maxGasPerOperation = newLimit;

        emit MaxGasPerOperationUpdated(oldLimit, newLimit);
    }

    /**
     * @dev Get deposit info
     * @return info Deposit information
     */
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /**
     * @dev Check if user has active subscription
     * @param user User address
     * @return True if active
     */
    function hasActiveSubscription(address user) external view returns (bool) {
        UserSubscription memory sub = subscriptions[user];
        return sub.tier != SubscriptionTier.NONE && sub.expiresAt > block.timestamp;
    }

    /**
     * @dev Get subscription info
     * @param user User address
     * @return subscription Subscription details
     */
    function getSubscription(address user) external view returns (UserSubscription memory) {
        return subscriptions[user];
    }

    /**
     * @dev Validate subscription status
     * @param user User address
     * @return subscription User subscription storage reference
     */
    function _validateSubscription(address user) private returns (UserSubscription storage subscription) {
        subscription = subscriptions[user];

        // Check subscription validity
        if (subscription.tier == SubscriptionTier.NONE) revert NoSubscription();
        // M-04 Fix: Use >= comparison for clearer expiry check
        if (block.timestamp >= subscription.expiresAt) revert SubscriptionExpired();

        // Check monthly reset - uses fixed 30 day period for consistency
        // M-03 Fix: Use exact 30 days comparison
        if (block.timestamp >= subscription.lastResetTime + 30 days) {
            subscription.gasUsedThisMonth = 0;
            subscription.lastResetTime = uint48(block.timestamp);
        }
    }

    /**
     * @dev Extract and validate user from operation
     * @notice The "user" in this context is the smart wallet address itself.
     *         Subscription management uses wallet addresses as the key because:
     *         1. UserOperations only contain the wallet address (sender), not the wallet owner
     *         2. The wallet is what executes operations and consumes gas
     *         3. One subscription per wallet ensures clear gas accounting
     *         When granting subscriptions, use the wallet address, not the owner address.
     * @param userOp The user operation
     * @return user The smart wallet address (which is the subscription key)
     */
    function _validateAndExtractUser(PackedUserOperation calldata userOp) private view returns (address user) {
        // The "user" for subscription purposes is the smart wallet address
        address wallet = userOp.sender;
        
        // Verify sender is a valid Lendefi wallet
        (bool success, bytes memory data) = smartWalletFactory.staticcall(
            abi.encodeWithSelector(bytes4(keccak256("isValidWallet(address)")), wallet)
        );
        if (!success || !abi.decode(data, (bool))) revert InvalidWallet();

        // Return wallet address as the user for subscription lookup
        // Note: Subscriptions should be granted to wallet addresses, not owner addresses
        user = wallet;
        if (user == address(0)) revert IAccountFactory.InvalidUser();
    }

    /**
     * @dev Calculate subsidy amount
     * @param maxCost Maximum cost
     * @param tier Subscription tier
     * @return subsidyAmount Calculated subsidy
     */
    function _calculateSubsidy(uint256 maxCost, SubscriptionTier tier) private view returns (uint256 subsidyAmount) {
        uint256 subsidyPercentage = _getSubsidyPercentage(tier);
        subsidyAmount = (maxCost * subsidyPercentage) / 100;

        // Check paymaster has sufficient deposit
        if (entryPoint.balanceOf(address(this)) < subsidyAmount) {
            revert PaymasterDepositTooLow();
        }
    }

    /**
     * @dev Validate gas limits
     * @param userOp User operation
     * @param subscription User subscription
     * @return estimatedGas Estimated gas usage
     */
    function _validateGasLimits(
        PackedUserOperation calldata userOp,
        UserSubscription storage subscription
    ) private view returns (uint256 estimatedGas) {
        // Extract gas limits from accountGasLimits (packed as bytes32)
        uint128 verificationGasLimit = uint128(uint256(userOp.accountGasLimits));
        uint128 callGasLimit = uint128(uint256(userOp.accountGasLimits) >> 128);
        estimatedGas = verificationGasLimit + callGasLimit + userOp.preVerificationGas;

        if (estimatedGas > maxGasPerOperation) revert GasLimitExceeded();
        if (subscription.gasUsedThisMonth + estimatedGas > subscription.monthlyGasLimit) {
            revert MonthlyLimitExceeded();
        }
    }

    /**
     * @dev Get monthly gas limit for tier
     * @param tier Subscription tier
     * @return limit Monthly gas limit
     */
    function _getMonthlyGasLimit(SubscriptionTier tier) private view returns (uint256) {
        if (tier == SubscriptionTier.BASIC) return maxGasPerMonthBasic;
        if (tier == SubscriptionTier.PREMIUM) return maxGasPerMonthPremium;
        // tier must be ULTIMATE due to validation in grantSubscription
        return maxGasPerMonthUltimate;
    }

    /**
     * @dev Get subsidy percentage for tier
     * @param tier Subscription tier
     * @return percentage Subsidy percentage
     */
    function _getSubsidyPercentage(SubscriptionTier tier) private pure returns (uint256) {
        if (tier == SubscriptionTier.BASIC) return _SUBSIDY_PERCENTAGE_BASIC;
        if (tier == SubscriptionTier.PREMIUM) return _SUBSIDY_PERCENTAGE_PREMIUM;
        // tier must be ULTIMATE due to validation in calling functions
        return _SUBSIDY_PERCENTAGE_ULTIMATE;
    }
}
