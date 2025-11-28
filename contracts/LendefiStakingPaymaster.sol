// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC4337Utils } from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import { IEntryPoint, PackedUserOperation, IPaymaster } from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import { LendefiStaking } from "./LendefiStaking.sol";
import { IAccountFactory } from "./interfaces/IAccountFactory.sol";

/**
 * @title LendefiStakingPaymaster
 * @notice ERC-4337 Paymaster that sponsors gas based on LDF token staking
 * @dev Users stake LDF tokens in LendefiStaking contract to earn gas subsidies
 * 
 * Flow:
 * 1. User stakes LDF tokens in LendefiStaking contract
 * 2. Staking determines user's tier (BASIC/PREMIUM/ULTIMATE)
 * 3. When user submits UserOp, paymaster checks tier and gas allowance
 * 4. Paymaster sponsors gas based on tier's subsidy percentage
 * 5. Gas usage is recorded back to staking contract
 */
contract LendefiStakingPaymaster is IPaymaster, Ownable {
    // ============ Errors ============
    
    error NotFromEntryPoint();
    error InvalidWallet();
    error NoStake();
    error MonthlyLimitExceeded();
    error GasLimitExceeded();
    error PaymasterDepositTooLow();
    error InvalidGasLimit();

    // ============ State Variables ============

    /// @notice EntryPoint contract
    IEntryPoint public immutable entryPoint;

    /// @notice Smart wallet factory for validation
    address public immutable smartWalletFactory;

    /// @notice Staking contract that determines tiers
    LendefiStaking public immutable stakingContract;

    /// @notice Maximum gas allowed per single operation
    uint256 public maxGasPerOperation = 500_000;

    /// @notice Minimum deposit required in paymaster
    uint256 public minPaymasterDeposit = 0.1 ether;

    // ============ Events ============

    event GasSponsored(
        address indexed user,
        uint256 gasUsed,
        uint256 subsidyAmount,
        LendefiStaking.Tier tier
    );
    event MaxGasPerOperationUpdated(uint256 oldLimit, uint256 newLimit);
    event MinDepositUpdated(uint256 oldMin, uint256 newMin);

    // ============ Modifiers ============

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotFromEntryPoint();
        _;
    }

    // ============ Constructor ============

    /**
     * @param _entryPoint EntryPoint contract address
     * @param _smartWalletFactory Smart wallet factory for validation
     * @param _stakingContract LendefiStaking contract address
     */
    constructor(
        IEntryPoint _entryPoint,
        address _smartWalletFactory,
        LendefiStaking _stakingContract
    ) Ownable(msg.sender) {
        if (address(_entryPoint) == address(0)) revert IAccountFactory.InvalidUser();
        if (_smartWalletFactory == address(0)) revert IAccountFactory.InvalidUser();
        if (address(_stakingContract) == address(0)) revert IAccountFactory.InvalidUser();
        
        entryPoint = _entryPoint;
        smartWalletFactory = _smartWalletFactory;
        stakingContract = _stakingContract;
    }

    // ============ Receive ============

    receive() external payable {}

    // ============ IPaymaster Implementation ============

    /**
     * @notice Validate paymaster is willing to sponsor this UserOp
     * @param userOp The user operation
     * @param userOpHash Hash of the user operation (unused)
     * @param maxCost Maximum cost of the operation
     * @return context Context for postOp
     * @return validationData Validation result
     */
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external override onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        userOpHash; // unused
        
        address user = userOp.sender;
        
        // Validate wallet is from our factory
        if (!_isValidWallet(user)) {
            revert InvalidWallet();
        }

        // Check paymaster has enough deposit
        uint256 paymasterDeposit = entryPoint.balanceOf(address(this));
        if (paymasterDeposit < minPaymasterDeposit || paymasterDeposit < maxCost) {
            revert PaymasterDepositTooLow();
        }

        // Get user's tier from staking contract
        LendefiStaking.Tier tier = stakingContract.getTier(user);
        if (tier == LendefiStaking.Tier.NONE) {
            revert NoStake();
        }

        // Validate gas limits
        uint256 estimatedGas = _extractGasLimits(userOp);
        if (estimatedGas > maxGasPerOperation) {
            revert GasLimitExceeded();
        }

        // Check user has enough gas allowance remaining this month
        (bool hasAllowance, ) = stakingContract.checkGasAllowance(user, estimatedGas);
        if (!hasAllowance) {
            revert MonthlyLimitExceeded();
        }

        // Calculate subsidy amount
        uint256 subsidyPercentage = stakingContract.getSubsidyPercentage(tier);
        uint256 subsidyAmount = (maxCost * subsidyPercentage) / 100;

        // Pack context for postOp
        context = abi.encode(user, estimatedGas, subsidyAmount, tier);

        // Return success with no time bounds
        validationData = ERC4337Utils.packValidationData(address(0), 0, 0);
    }

    /**
     * @notice Post-operation handler - records gas usage
     * @param mode Operation result mode
     * @param context Context from validatePaymasterUserOp
     * @param actualGasCost Actual gas cost incurred
     * @param actualUserOpFeePerGas Actual fee per gas (unused)
     */
    function postOp(
        IPaymaster.PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external override onlyEntryPoint {
        actualUserOpFeePerGas; // unused

        if (mode == IPaymaster.PostOpMode.opSucceeded || mode == IPaymaster.PostOpMode.opReverted) {
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
    }

    // ============ View Functions ============

    /**
     * @notice Check if a user is eligible for gas sponsorship
     * @param user User address
     * @param gasNeeded Estimated gas needed
     * @return eligible True if eligible
     * @return tier User's current tier
     * @return subsidyPercent Subsidy percentage
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

    /**
     * @notice Get paymaster's deposit in EntryPoint
     * @return Deposit amount
     */
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    // ============ Admin Functions ============

    /**
     * @notice Deposit ETH to EntryPoint for gas sponsorship
     */
    function deposit() external payable onlyOwner {
        entryPoint.depositTo{ value: msg.value }(address(this));
    }

    /**
     * @notice Withdraw deposit from EntryPoint
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawDeposit(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    /**
     * @notice Add stake to EntryPoint (required for paymaster)
     * @param unstakeDelaySec Unstake delay in seconds
     */
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{ value: msg.value }(unstakeDelaySec);
    }

    /**
     * @notice Unlock stake from EntryPoint
     */
    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    /**
     * @notice Withdraw stake from EntryPoint
     * @param to Recipient address
     */
    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    /**
     * @notice Update maximum gas per operation
     * @param newLimit New gas limit
     */
    function setMaxGasPerOperation(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidGasLimit();
        uint256 oldLimit = maxGasPerOperation;
        maxGasPerOperation = newLimit;
        emit MaxGasPerOperationUpdated(oldLimit, newLimit);
    }

    /**
     * @notice Update minimum paymaster deposit threshold
     * @param newMin New minimum deposit
     */
    function setMinPaymasterDeposit(uint256 newMin) external onlyOwner {
        uint256 oldMin = minPaymasterDeposit;
        minPaymasterDeposit = newMin;
        emit MinDepositUpdated(oldMin, newMin);
    }

    // ============ Internal Functions ============

    /**
     * @dev Extract gas limits from packed UserOp
     */
    function _extractGasLimits(PackedUserOperation calldata userOp) internal pure returns (uint256) {
        // accountGasLimits is packed as: verificationGasLimit (16 bytes) | callGasLimit (16 bytes)
        bytes32 accountGasLimits = userOp.accountGasLimits;
        uint256 verificationGasLimit = uint128(bytes16(accountGasLimits));
        uint256 callGasLimit = uint128(uint256(accountGasLimits));
        
        return verificationGasLimit + callGasLimit + userOp.preVerificationGas;
    }

    /**
     * @dev Check if wallet is from our factory
     */
    function _isValidWallet(address wallet) internal view returns (bool) {
        // Low-level call to check isValidWallet without requiring it in interface
        (bool success, bytes memory result) = smartWalletFactory.staticcall(
            abi.encodeWithSignature("isValidWallet(address)", wallet)
        );
        
        if (success && result.length >= 32) {
            return abi.decode(result, (bool));
        }
        return false;
    }
}
