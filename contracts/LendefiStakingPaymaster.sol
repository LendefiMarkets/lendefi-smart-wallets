// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { BasePaymaster } from "./aa-v07/contracts/core/BasePaymaster.sol";
import { IEntryPoint } from "./aa-v07/contracts/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "./aa-v07/contracts/interfaces/PackedUserOperation.sol";
import { LendefiStaking } from "./LendefiStaking.sol";

/**
 * @title LendefiStakingPaymaster
 * @notice ERC-4337 Paymaster that sponsors gas based on LDF token staking
 * @dev Inherits from audited BasePaymaster for stake/deposit management
 * 
 * Flow:
 * 1. User stakes LDF tokens in LendefiStaking contract
 * 2. Staking determines user's tier (BASIC/PREMIUM/ULTIMATE)
 * 3. When user submits UserOp, paymaster checks tier and gas allowance
 * 4. Paymaster sponsors gas based on tier's subsidy percentage
 * 5. Gas usage is recorded back to staking contract
 */
contract LendefiStakingPaymaster is BasePaymaster {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidWallet();
    error NoStake();
    error MonthlyLimitExceeded();
    error GasLimitExceeded();
    error PaymasterDepositTooLow();
    error InvalidGasLimit();
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Smart wallet factory for validation
    address public immutable smartWalletFactory;

    /// @notice Staking contract that determines tiers
    LendefiStaking public immutable stakingContract;

    /// @notice Maximum gas allowed per single operation
    uint256 public maxGasPerOperation = 500_000;

    /// @notice Minimum deposit required in paymaster
    uint256 public minPaymasterDeposit = 0.1 ether;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event GasSponsored(
        address indexed user,
        uint256 gasUsed,
        uint256 subsidyAmount,
        LendefiStaking.Tier tier
    );
    event MaxGasPerOperationUpdated(uint256 oldLimit, uint256 newLimit);
    event MinDepositUpdated(uint256 oldMin, uint256 newMin);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _entryPoint EntryPoint contract address
     * @param _smartWalletFactory Smart wallet factory for validation
     * @param _stakingContract LendefiStaking contract address
     */
    constructor(
        IEntryPoint _entryPoint,
        address _smartWalletFactory,
        LendefiStaking _stakingContract
    ) BasePaymaster(_entryPoint) {
        if (_smartWalletFactory == address(0)) revert ZeroAddress();
        if (address(_stakingContract) == address(0)) revert ZeroAddress();
        
        smartWalletFactory = _smartWalletFactory;
        stakingContract = _stakingContract;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PAYMASTER IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Validate paymaster is willing to sponsor this UserOp
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        address user = userOp.sender;
        
        // Validate wallet is from our factory
        if (!_isValidWallet(user)) revert InvalidWallet();

        // Check paymaster has enough deposit
        uint256 paymasterDeposit = entryPoint.balanceOf(address(this));
        if (paymasterDeposit < minPaymasterDeposit || paymasterDeposit < maxCost) {
            revert PaymasterDepositTooLow();
        }

        // Get user's tier from staking contract
        LendefiStaking.Tier tier = stakingContract.getTier(user);
        if (tier == LendefiStaking.Tier.NONE) revert NoStake();

        // Validate gas limits
        uint256 estimatedGas = _extractGasLimits(userOp);
        if (estimatedGas > maxGasPerOperation) revert GasLimitExceeded();

        // Check user has enough gas allowance remaining this month
        (bool hasAllowance, ) = stakingContract.checkGasAllowance(user, estimatedGas);
        if (!hasAllowance) revert MonthlyLimitExceeded();

        // Calculate subsidy amount
        uint256 subsidyPercentage = stakingContract.getSubsidyPercentage(tier);
        uint256 subsidyAmount = (maxCost * subsidyPercentage) / 100;

        // Pack context for postOp
        context = abi.encode(user, estimatedGas, subsidyAmount, tier);
        validationData = 0; // Valid with no time restrictions
    }

    /**
     * @notice Post-operation handler - records gas usage
     */
    function _postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /*actualUserOpFeePerGas*/
    ) internal override {
        if (mode == PostOpMode.postOpReverted) return;

        (
            address user,
            uint256 estimatedGas,
            ,
            LendefiStaking.Tier tier
        ) = abi.decode(context, (address, uint256, uint256, LendefiStaking.Tier));

        // Record gas usage in staking contract
        stakingContract.recordGasUsage(user, estimatedGas);

        // Calculate actual subsidy for event
        uint256 subsidyPercentage = stakingContract.getSubsidyPercentage(tier);
        uint256 actualSubsidy = (actualGasCost * subsidyPercentage) / 100;

        emit GasSponsored(user, estimatedGas, actualSubsidy, tier);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Check if a user is eligible for gas sponsorship
     */
    function checkEligibility(
        address user,
        uint256 gasNeeded
    ) external view returns (bool eligible, LendefiStaking.Tier tier, uint256 subsidyPercent) {
        tier = stakingContract.getTier(user);
        
        if (tier == LendefiStaking.Tier.NONE) {
            return (false, tier, 0);
        }

        (bool hasAllowance, ) = stakingContract.checkGasAllowance(user, gasNeeded);
        subsidyPercent = stakingContract.getSubsidyPercentage(tier);
        eligible = hasAllowance && gasNeeded <= maxGasPerOperation;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update maximum gas per operation
     */
    function setMaxGasPerOperation(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidGasLimit();
        uint256 oldLimit = maxGasPerOperation;
        maxGasPerOperation = newLimit;
        emit MaxGasPerOperationUpdated(oldLimit, newLimit);
    }

    /**
     * @notice Update minimum paymaster deposit threshold
     */
    function setMinPaymasterDeposit(uint256 newMin) external onlyOwner {
        uint256 oldMin = minPaymasterDeposit;
        minPaymasterDeposit = newMin;
        emit MinDepositUpdated(oldMin, newMin);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Extract gas limits from packed UserOp
     */
    function _extractGasLimits(PackedUserOperation calldata userOp) internal pure returns (uint256) {
        uint256 packed = uint256(userOp.accountGasLimits);
        uint128 verificationGas = uint128(packed >> 128);
        uint128 callGas = uint128(packed);
        return uint256(verificationGas) + uint256(callGas) + userOp.preVerificationGas;
    }

    /**
     * @dev Check if wallet is from our factory
     */
    function _isValidWallet(address wallet) internal view returns (bool) {
        (bool success, bytes memory result) = smartWalletFactory.staticcall(
            abi.encodeWithSignature("isValidWallet(address)", wallet)
        );
        return success && result.length >= 32 && abi.decode(result, (bool));
    }
}
