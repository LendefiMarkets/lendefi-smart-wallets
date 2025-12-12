// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BasePaymaster} from "./aa-v07/contracts/core/BasePaymaster.sol";
import {PackedUserOperation} from "./aa-v07/contracts/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "./aa-v07/contracts/core/UserOperationLib.sol";
import {IEntryPoint} from "./aa-v07/contracts/interfaces/IEntryPoint.sol";

/**
 * @title WhitelistPaymaster
 * @author Lendefi Team
 * @notice Sponsors transactions to whitelisted smart contracts
 * @dev Paymaster that validates target contracts are in whitelist before sponsoring gas
 *      Inherits from BasePaymaster which already provides Ownable functionality
 */
contract WhitelistPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    // ============ Storage ============

    /// @notice Mapping of whitelisted contract addresses
    mapping(address contractAddress => bool isWhitelisted) public whitelistedContracts;

    /// @notice Total number of sponsored transactions
    uint256 public totalSponsoredTransactions;

    /// @notice Total gas sponsored (in wei)
    uint256 public totalGasSponsored;

    // ============ Events ============

    event ContractWhitelisted(address indexed contractAddress, bool whitelisted);
    event TransactionSponsored(address indexed user, address indexed target, uint256 actualGasCost);

    // ============ Errors ============

    error TargetNotWhitelisted(address target);
    error InvalidUserOperation();
    error ZeroAddress();

    // ============ Constructor ============

    /**
     * @param _entryPoint ERC-4337 EntryPoint contract
     * @param _owner Owner of the paymaster contract
     */
    constructor(IEntryPoint _entryPoint, address _owner) BasePaymaster(_entryPoint) {
        if (_owner == address(0)) revert ZeroAddress();
        _transferOwnership(_owner);
    }

    // ============ External Functions ============

    /**
     * @notice Add or remove a contract from the whitelist
     * @param contractAddress Address of the contract to whitelist/unwhitelist
     * @param whitelisted True to whitelist, false to remove
     */
    function setWhitelistedContract(address contractAddress, bool whitelisted) external onlyOwner {
        if (contractAddress == address(0)) revert ZeroAddress();
        whitelistedContracts[contractAddress] = whitelisted;
        emit ContractWhitelisted(contractAddress, whitelisted);
    }

    /**
     * @notice Batch whitelist multiple contracts
     * @param contractAddresses Array of contract addresses
     * @param whitelisted True to whitelist, false to remove
     */
    function setWhitelistedContractsBatch(address[] calldata contractAddresses, bool whitelisted) external onlyOwner {
        uint256 length = contractAddresses.length;
        for (uint256 i = 0; i < length; ++i) {
            address contractAddress = contractAddresses[i];
            if (contractAddress == address(0)) revert ZeroAddress();
            whitelistedContracts[contractAddress] = whitelisted;
            emit ContractWhitelisted(contractAddress, whitelisted);
        }
    }

    /**
     * @notice Check if a contract is whitelisted
     * @param contractAddress Address to check
     * @return True if whitelisted
     */
    function isWhitelisted(address contractAddress) external view returns (bool) {
        return whitelistedContracts[contractAddress];
    }

    // ============ Internal Functions ============

    /**
     * @notice Validate user operation before sponsoring
     * @param userOp User operation to validate
     * @return context Validation context (empty for this paymaster)
     * @return validationData Validation result (0 for valid)
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /* userOpHash */
        uint256 /* maxCost */
    ) internal view override returns (bytes memory context, uint256 validationData) {
        // Extract target contract from calldata
        address target = _extractTarget(userOp.callData);

        // Validate target is whitelisted
        if (!whitelistedContracts[target]) {
            revert TargetNotWhitelisted(target);
        }

        // Return validation success
        return ("", 0);
    }

    /**
     * @notice Post-operation handler to track gas usage
     * @param actualGasCost Actual gas cost of the operation
     */
    function _postOp(
        PostOpMode, /* mode */
        bytes calldata, /* context */
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) internal override {
        // Track statistics
        totalSponsoredTransactions++;
        totalGasSponsored += actualGasCost;
    }

    /**
     * @notice Extract target contract address from user operation calldata
     * @param callData User operation calldata
     * @return target Target contract address
     */
    function _extractTarget(bytes calldata callData) internal pure returns (address target) {
        // SmartWallet.execute() format: selector(4) + target(20) + value(32) + data_offset
        // SmartWallet.executeBatch() format: selector(4) + targets_offset(32) + values_offset(32) + datas_offset(32) + targets_length(32) + first_target(32)

        if (callData.length < 4) revert InvalidUserOperation();

        bytes4 selector = bytes4(callData[0:4]);

        // execute(address,uint256,bytes) - selector: 0xb61d27f6
        if (selector == 0xb61d27f6) {
            if (callData.length < 36) revert InvalidUserOperation();
            // Target is at bytes 4-35 (address is left-padded in first 32-byte word)
            target = address(uint160(uint256(bytes32(callData[4:36]))));
        }
        // executeBatch(address[],uint256[],bytes[]) - selector: 0x47e1da2a
        else if (selector == 0x47e1da2a) {
            if (callData.length < 164) revert InvalidUserOperation();
            // First target is at bytes 132-163 (after 3 offsets + array length)
            target = address(uint160(uint256(bytes32(callData[132:164]))));
        }
        // Default: try to extract from standard position
        else {
            if (callData.length < 36) revert InvalidUserOperation();
            target = address(uint160(uint256(bytes32(callData[4:36]))));
        }

        if (target == address(0)) revert ZeroAddress();
    }
}
