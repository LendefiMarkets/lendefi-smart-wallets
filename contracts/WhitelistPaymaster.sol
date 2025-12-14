// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BasePaymaster} from "./aa-v07/contracts/core/BasePaymaster.sol";
import {PackedUserOperation} from "./aa-v07/contracts/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "./aa-v07/contracts/core/UserOperationLib.sol";
import {IEntryPoint} from "./aa-v07/contracts/interfaces/IEntryPoint.sol";

/// @dev Minimal interface for registry/factory wallet validation
interface IWalletRegistry {
    function isValidWallet(address wallet) external view returns (bool);
}

/**
 * @title WhitelistPaymaster
 * @author Lendefi Team
 * @notice Sponsors transactions to whitelisted smart contracts
 * @dev Paymaster that validates target contracts are in whitelist before sponsoring gas
 *      Inherits from BasePaymaster which already provides Ownable functionality
 */
contract WhitelistPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    // ============ Constants ============

    /// @dev SmartWallet.execute(address,uint256,bytes)
    bytes4 private constant EXECUTE_SELECTOR = 0xb61d27f6;

    /// @dev SmartWallet.executeBatch(address[],uint256[],bytes[])
    bytes4 private constant EXECUTE_BATCH_SELECTOR = 0x47e1da2a;

    // ============ Storage ============

    /// @notice Mapping of whitelisted contract addresses
    mapping(address contractAddress => bool isWhitelisted) public whitelistedContracts;

    /// @notice Total number of sponsored transactions
    uint256 public totalSponsoredTransactions;

    /// @notice Total gas sponsored (in wei)
    uint256 public totalGasSponsored;

    /// @notice Optional registry/factory used to validate `userOp.sender`
    address public walletRegistry;

    /// @notice If true, require `userOp.sender` to be a valid wallet in `walletRegistry`
    bool public enforceWalletRegistry;

    // ============ Events ============

    event ContractWhitelisted(address indexed contractAddress, bool whitelisted);
    event TransactionSponsored(address indexed user, address indexed target, uint256 actualGasCost);

    event WalletRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event WalletRegistryEnforcementUpdated(bool enforced);

    // ============ Errors ============

    error TargetNotWhitelisted(address target);
    error InvalidUserOperation();
    error ZeroAddress();
    error InvalidWallet(address wallet);
    error WalletRegistryNotSet();

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
     * @notice Set wallet registry/factory contract used to validate `userOp.sender`
     * @dev Set to address(0) to disable registry lookups (also disables enforcement).
     */
    function setWalletRegistry(address newRegistry) external onlyOwner {
        address old = walletRegistry;
        walletRegistry = newRegistry;
        if (newRegistry == address(0)) {
            enforceWalletRegistry = false;
            emit WalletRegistryEnforcementUpdated(false);
        }
        emit WalletRegistryUpdated(old, newRegistry);
    }

    /**
     * @notice Enable/disable wallet registry enforcement
     * @dev When enabled, `walletRegistry` must be set and `userOp.sender` must be valid.
     */
    function setEnforceWalletRegistry(bool enforced) external onlyOwner {
        if (enforced && walletRegistry == address(0)) revert WalletRegistryNotSet();
        enforceWalletRegistry = enforced;
        emit WalletRegistryEnforcementUpdated(enforced);
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
        if (enforceWalletRegistry) {
            address registry = walletRegistry;
            if (registry == address(0)) revert WalletRegistryNotSet();
            if (!IWalletRegistry(registry).isValidWallet(userOp.sender)) {
                revert InvalidWallet(userOp.sender);
            }
        }

        bytes calldata callData = userOp.callData;
        if (callData.length < 4) revert InvalidUserOperation();

        bytes4 selector = bytes4(callData[0:4]);

        // SmartWallet.execute(address,uint256,bytes)
        if (selector == EXECUTE_SELECTOR) {
            (address target,,) = abi.decode(callData[4:], (address, uint256, bytes));
            if (target == address(0)) revert ZeroAddress();
            if (!whitelistedContracts[target]) revert TargetNotWhitelisted(target);
            return ("", 0);
        }

        // SmartWallet.executeBatch(address[],uint256[],bytes[])
        if (selector == EXECUTE_BATCH_SELECTOR) {
            (address[] memory targets,,) = abi.decode(callData[4:], (address[], uint256[], bytes[]));
            uint256 length = targets.length;
            for (uint256 i = 0; i < length; ++i) {
                address target = targets[i];
                if (target == address(0)) revert ZeroAddress();
                if (!whitelistedContracts[target]) revert TargetNotWhitelisted(target);
            }
            return ("", 0);
        }

        revert InvalidUserOperation();
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
    function _extractTarget(bytes calldata callData) internal pure returns (address) {
        (callData);
        revert InvalidUserOperation();
    }
}
