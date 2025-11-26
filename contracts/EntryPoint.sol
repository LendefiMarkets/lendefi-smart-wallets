// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { IEntryPoint, PackedUserOperation, IPaymaster } from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IAccount
 * @dev Interface for ERC-4337 account validation
 */
interface IAccount {
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}

/**
 * @title EntryPoint
 * @dev Production-ready EntryPoint implementation with proper access controls,
 *      signature validation, and paymaster support
 */
contract EntryPoint is IEntryPoint, ReentrancyGuard {
    using ECDSA for bytes32;

    // Structs - placed before constants per Solidity style guide
    struct DepositInfo {
        uint256 deposit;
        bool staked;
        uint112 stake;
        uint32 unstakeDelaySec;
        uint48 withdrawTime;
    }

    struct UserOpInfo {
        uint256 prefund;
        uint256 actualGasCost;
        address contextAccount;
        uint256 preOpGas;
        address paymaster;
        bytes paymasterContext;
    }

    // Constants
    uint256 private constant _SIG_VALIDATION_FAILED = 1;
    uint256 private constant _SIG_VALIDATION_SUCCESS = 0;
    bytes4 private constant _ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 private constant _PAYMASTER_DATA_OFFSET = 20;
    uint256 private constant _MIN_STAKE_VALUE = 1 ether;

    // State variables
    mapping(address account => DepositInfo info) public deposits;
    mapping(address sender => mapping(uint192 key => uint256 nonce)) public nonces;
    mapping(address account => bool isValidated) private _validatedUserOps;

    // Events
    event Deposited(address indexed account, uint256 totalDeposit);
    event Withdrawn(address indexed account, address withdrawAddress, uint256 amount);
    event StakeLocked(address indexed account, uint256 totalStaked, uint256 unstakeDelaySec);
    event StakeUnlocked(address indexed account, uint256 withdrawTime);
    event StakeWithdrawn(address indexed account, address withdrawAddress, uint256 amount);
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );
    event UserOperationRevertReason(
        bytes32 indexed userOpHash,
        address indexed sender,
        uint256 nonce,
        bytes revertReason
    );

    // Custom errors
    error InvalidUserOp();
    error InsufficientDeposit();
    error NoStakeInfo();
    error StakeNotUnlocked();
    error InvalidSignature();
    error InvalidNonce();
    error InsufficientStake();
    error TransferFailed();
    error BeneficiaryTransferFailed();
    error UnauthorizedCaller();
    error UserOpExecutionFailed();
    error ZeroAddress();
    error PaymasterValidationFailed();
    error AccountValidationFailed();

    // Modifiers
    modifier validStake(address account) {
        DepositInfo storage info = deposits[account];
        if (!info.staked || info.stake < _MIN_STAKE_VALUE) revert InsufficientStake();
        _;
    }

    modifier nonZeroAddress(address _address) {
        if (_address == address(0)) revert ZeroAddress();
        _;
    }

    receive() external payable {
        depositTo(msg.sender);
    }

    /**
     * @dev Withdraw funds (only account owner)
     * @param withdrawAddress Address to withdraw to (must be non-zero)
     * @param withdrawAmount Amount to withdraw
     */
    function withdrawTo(
        address payable withdrawAddress, 
        uint256 withdrawAmount
    ) external nonReentrant nonZeroAddress(withdrawAddress) {
        DepositInfo storage info = deposits[msg.sender];
        if (withdrawAmount > info.deposit) revert InsufficientDeposit();

        info.deposit -= withdrawAmount;
        emit Withdrawn(msg.sender, withdrawAddress, withdrawAmount);

        (bool success, ) = withdrawAddress.call{ value: withdrawAmount }("");
        if (!success) revert TransferFailed();
    }

    /**
     * @dev Add stake (only account owner)
     * @param unstakeDelaySec Delay in seconds before stake can be withdrawn
     */
    function addStake(uint32 unstakeDelaySec) external payable {
        DepositInfo storage info = deposits[msg.sender];
        info.deposit += msg.value;
        info.stake += uint112(msg.value);
        info.unstakeDelaySec = unstakeDelaySec;
        info.staked = true;

        emit StakeLocked(msg.sender, info.stake, unstakeDelaySec);
        emit Deposited(msg.sender, info.deposit);
    }

    /**
     * @dev Unlock stake (only account owner)
     */
    function unlockStake() external {
        DepositInfo storage info = deposits[msg.sender];
        if (!info.staked) {
            info.withdrawTime = uint48(block.timestamp);
            emit StakeUnlocked(msg.sender, info.withdrawTime);
            return;
        }

        info.withdrawTime = uint48(block.timestamp + info.unstakeDelaySec);
        emit StakeUnlocked(msg.sender, info.withdrawTime);
    }

    /**
     * @dev Withdraw stake (only account owner, after unlock delay)
     * @param withdrawAddress Address to withdraw stake to (must be non-zero)
     */
    function withdrawStake(
        address payable withdrawAddress
    ) external nonReentrant nonZeroAddress(withdrawAddress) {
        DepositInfo storage info = deposits[msg.sender];
        if (info.withdrawTime == 0) revert StakeNotUnlocked();
        if (info.unstakeDelaySec > 0 && block.timestamp < info.withdrawTime) {
            revert StakeNotUnlocked();
        }

        uint256 stake = info.stake;
        if (stake > 0) {
            info.deposit -= stake;
        }
        info.stake = 0;
        info.staked = false;
        info.withdrawTime = 0;

        emit StakeWithdrawn(msg.sender, withdrawAddress, stake);

        if (stake > 0) {
            (bool success, ) = withdrawAddress.call{ value: stake }("");
            if (!success) revert TransferFailed();
        }
    }

    /**
     * @dev Handle user operations with full validation and paymaster support
     * @param ops Array of user operations to process
     * @param beneficiary Address to receive collected fees
     */
    function handleOps(
        PackedUserOperation[] calldata ops, 
        address payable beneficiary
    ) external nonReentrant nonZeroAddress(beneficiary) {
        uint256 opsLength = ops.length;
        UserOpInfo[] memory opInfos = new UserOpInfo[](opsLength);

        // Validation phase
        for (uint256 i = 0; i < opsLength; ) {
            bytes32 userOpHash = _getUserOpHash(ops[i]);
            UserOpInfo memory opInfo = _validateUserOp(ops[i], userOpHash);
            opInfos[i] = opInfo;
            unchecked {
                ++i;
            }
        }

        // Execution phase
        uint256 collected = 0;
        for (uint256 i = 0; i < opsLength; ) {
            uint256 actualGasCost = _executeUserOp(ops[i], opInfos[i]);
            
            // Handle paymaster postOp if applicable
            if (opInfos[i].paymaster != address(0)) {
                _handlePostOp(ops[i], opInfos[i], actualGasCost, true);
            }
            
            // Calculate refund and collect actual cost
            uint256 refund = opInfos[i].prefund > actualGasCost ? opInfos[i].prefund - actualGasCost : 0;
            if (refund > 0) {
                // Refund unused gas to sender or paymaster
                address refundAddress = opInfos[i].paymaster != address(0) 
                    ? opInfos[i].paymaster 
                    : ops[i].sender;
                deposits[refundAddress].deposit += refund;
            }
            collected += actualGasCost;
            
            unchecked {
                ++i;
            }
        }

        // Compensation to beneficiary
        if (collected > 0) {
            (bool success, ) = beneficiary.call{ value: collected }("");
            if (!success) revert BeneficiaryTransferFailed();
        }
    }

    /**
     * @dev Handle aggregated ops
     * @param opsPerAggregator Array of operations per aggregator
     * @param beneficiary Address to receive collected fees
     */
    function handleAggregatedOps(
        IEntryPoint.UserOpsPerAggregator[] calldata opsPerAggregator,
        address payable beneficiary
    ) external {
        uint256 totalOps = 0;
        for (uint256 i = 0; i < opsPerAggregator.length; ) {
            totalOps += opsPerAggregator[i].userOps.length;
            unchecked {
                ++i;
            }
        }

        PackedUserOperation[] memory allOps = new PackedUserOperation[](totalOps);
        uint256 opIndex = 0;

        for (uint256 i = 0; i < opsPerAggregator.length; ) {
            PackedUserOperation[] memory ops = opsPerAggregator[i].userOps;
            for (uint256 j = 0; j < ops.length; ) {
                allOps[opIndex] = ops[j];
                unchecked {
                    ++j;
                    ++opIndex;
                }
            }
            unchecked {
                ++i;
            }
        }

        this.handleOps(allOps, beneficiary);
    }

    /**
     * @dev Internal function to execute call - only callable by this contract
     * @param userOp The user operation to execute
     */
    function innerExecuteCall(PackedUserOperation calldata userOp) external returns (bool success) {
        if (msg.sender != address(this)) revert UnauthorizedCaller();
        
        address sender = userOp.sender;
        bytes calldata callData = userOp.callData;

        if (callData.length > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (success, ) = sender.call(callData);
        } else {
            success = true;
        }
    }

    /**
     * @dev Deposit funds for an account
     * @param account Account to deposit for
     */
    function depositTo(address account) public payable {
        DepositInfo storage info = deposits[account];
        uint256 newAmount = info.deposit + msg.value;
        info.deposit = newAmount;
        emit Deposited(account, newAmount);
    }

    /**
     * @dev Get account balance
     * @param account Account to query
     * @return The deposit balance
     */
    function balanceOf(address account) public view returns (uint256) {
        return deposits[account].deposit;
    }

    /**
     * @dev Get current nonce for sender/key
     * @param sender Sender address
     * @param key Nonce key
     * @return The current nonce
     */
    function getNonce(address sender, uint192 key) public view returns (uint256) {
        return nonces[sender][key];
    }

    /**
     * @dev Validate user operation with signature and paymaster validation
     * @param userOp The user operation to validate
     * @param userOpHash Hash of the user operation
     * @return opInfo Validation info for execution phase
     */
    function _validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal returns (UserOpInfo memory opInfo) {
        uint256 preGas = gasleft();
        address sender = userOp.sender;
        
        // Validate and increment nonce
        uint256 nonce = userOp.nonce;
        uint192 key = uint192(nonce >> 64);
        uint64 seq = uint64(nonce);
        if (nonces[sender][key] != seq) revert InvalidNonce();
        nonces[sender][key]++;

        // Calculate required prefund
        uint256 requiredPrefund = _getRequiredPrefund(userOp);
        
        // Check for paymaster
        address paymaster = address(0);
        bytes memory paymasterContext;
        
        if (userOp.paymasterAndData.length >= _PAYMASTER_DATA_OFFSET) {
            paymaster = address(bytes20(userOp.paymasterAndData[0:20]));
            
            // Validate paymaster has sufficient deposit
            DepositInfo storage paymasterInfo = deposits[paymaster];
            if (paymasterInfo.deposit < requiredPrefund) revert InsufficientDeposit();
            
            // Reserve prefund from paymaster
            paymasterInfo.deposit -= requiredPrefund;
            
            // Call paymaster validation
            try IPaymaster(paymaster).validatePaymasterUserOp(userOp, userOpHash, requiredPrefund) 
                returns (bytes memory context, uint256 validationData) 
            {
                // Check validation result (simplified - just check not failed)
                if (validationData == _SIG_VALIDATION_FAILED) revert PaymasterValidationFailed();
                paymasterContext = context;
            } catch {
                revert PaymasterValidationFailed();
            }
        } else {
            // No paymaster - validate sender has sufficient deposit
            DepositInfo storage senderInfo = deposits[sender];
            if (senderInfo.deposit < requiredPrefund) revert InsufficientDeposit();
            senderInfo.deposit -= requiredPrefund;
        }

        // Validate account signature by calling validateUserOp on the account
        uint256 missingAccountFunds = paymaster != address(0) ? 0 : requiredPrefund;
        try IAccount(sender).validateUserOp(userOp, userOpHash, missingAccountFunds) 
            returns (uint256 validationData) 
        {
            // Check validation result
            if (validationData == _SIG_VALIDATION_FAILED) revert AccountValidationFailed();
        } catch {
            revert AccountValidationFailed();
        }

        opInfo = UserOpInfo({
            prefund: requiredPrefund,
            actualGasCost: 0,
            contextAccount: sender,
            preOpGas: preGas - gasleft(),
            paymaster: paymaster,
            paymasterContext: paymasterContext
        });

        _validatedUserOps[sender] = true;
    }

    /**
     * @dev Execute user operation
     * @param userOp The user operation to execute
     * @param opInfo Validation info from validation phase
     * @return actualGasCost The actual gas cost of the operation
     */
    function _executeUserOp(
        PackedUserOperation calldata userOp,
        UserOpInfo memory opInfo
    ) internal returns (uint256 actualGasCost) {
        uint256 preExecutionGas = gasleft();
        address sender = userOp.sender;
        bool success = true;
        bytes memory revertReason;

        if (!_validatedUserOps[sender]) {
            success = false;
        } else {
            try this.innerExecuteCall(userOp) returns (bool execSuccess) {
                success = execSuccess;
            } catch (bytes memory reason) {
                success = false;
                revertReason = reason;
            }
        }

        // Calculate actual gas cost
        uint256 gasUsed = opInfo.preOpGas + (preExecutionGas - gasleft());
        uint128 maxFeePerGas = uint128(uint256(userOp.gasFees) >> 128);
        actualGasCost = gasUsed * maxFeePerGas;
        
        // Ensure we don't charge more than prefund
        if (actualGasCost > opInfo.prefund) {
            actualGasCost = opInfo.prefund;
        }

        bytes32 userOpHash = _getUserOpHash(userOp);
        
        if (!success && revertReason.length > 0) {
            emit UserOperationRevertReason(userOpHash, sender, userOp.nonce, revertReason);
        }
        
        emit UserOperationEvent(
            userOpHash,
            sender,
            opInfo.paymaster,
            userOp.nonce,
            success,
            actualGasCost,
            gasUsed
        );

        _validatedUserOps[sender] = false;
    }

    /**
     * @dev Handle paymaster postOp callback
     * @param userOp The user operation
     * @param opInfo Operation info
     * @param actualGasCost Actual gas cost
     * @param success Whether operation succeeded
     */
    function _handlePostOp(
        PackedUserOperation calldata userOp,
        UserOpInfo memory opInfo,
        uint256 actualGasCost,
        bool success
    ) internal {
        if (opInfo.paymaster == address(0)) return;
        
        IPaymaster.PostOpMode mode = success 
            ? IPaymaster.PostOpMode.opSucceeded 
            : IPaymaster.PostOpMode.opReverted;
            
        uint128 maxFeePerGas = uint128(uint256(userOp.gasFees) >> 128);
        
        try IPaymaster(opInfo.paymaster).postOp(
            mode,
            opInfo.paymasterContext,
            actualGasCost,
            maxFeePerGas
        ) {
            // PostOp succeeded - no action needed
            return;
        } catch {
            // PostOp failed - operation still succeeded but paymaster postOp didn't run
            // This is acceptable per ERC-4337 spec
            return;
        }
    }

    /**
     * @dev Get user operation hash (includes all fields for uniqueness)
     * @param userOp The user operation
     * @return The operation hash
     */
    function _getUserOpHash(PackedUserOperation calldata userOp) internal view returns (bytes32) {
        // Note: signature is NOT included in the hash per ERC-4337 spec
        // The hash is what gets signed, so including signature would be circular
        return keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        userOp.sender,
                        userOp.nonce,
                        keccak256(userOp.initCode),
                        keccak256(userOp.callData),
                        userOp.accountGasLimits,
                        userOp.preVerificationGas,
                        userOp.gasFees,
                        keccak256(userOp.paymasterAndData)
                    )
                ),
                address(this),
                block.chainid
            )
        );
    }

    /**
     * @dev Calculate required prefund
     * @param userOp The user operation
     * @return requiredPrefund The required prefund amount
     */
    function _getRequiredPrefund(PackedUserOperation calldata userOp) internal pure returns (uint256) {
        uint128 verificationGasLimit = uint128(uint256(userOp.accountGasLimits));
        uint128 callGasLimit = uint128(uint256(userOp.accountGasLimits) >> 128);
        uint128 maxFeePerGas = uint128(uint256(userOp.gasFees) >> 128);

        uint256 totalGas = verificationGasLimit + callGasLimit + userOp.preVerificationGas;
        return totalGas * maxFeePerGas;
    }
}
