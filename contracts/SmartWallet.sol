// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Account } from "@openzeppelin/contracts/account/Account.sol";
import { SignerECDSA } from "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IEntryPoint } from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/**
 * @title SmartWallet
 * @dev ERC-4337 compliant smart contract wallet built on OpenZeppelin Account abstraction
 * Combines OZ Account base with execute functionality and ownership management
 */
contract SmartWallet is Account, SignerECDSA, IERC1271, Initializable, ReentrancyGuard {
    // Constants
    uint256 public constant MAX_BATCH_SIZE = 50;

    // State variables
    IEntryPoint private immutable _entryPoint;
    address public owner;

    // Events
    event SmartWalletInitialized(IEntryPoint indexed entryPoint, address indexed owner);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    // Custom errors
    error ZeroAddress();
    error InvalidUserOp();
    error Unauthorized();
    error SameOwner();
    error InvalidOwner();
    error BatchTooLarge();
    error ContractOwnerWarning();

    // Modifiers
    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyOwnerOrEntryPoint() {
        if (msg.sender != address(entryPoint()) && msg.sender != owner) {
            revert Unauthorized();
        }
        _;
    }

    modifier nonZeroAddress(address _address) {
        if (_address == address(0)) revert ZeroAddress();
        _;
    }

    /**
     * @dev Constructor that sets the EntryPoint address
     * @param entryPointAddr The EntryPoint contract address
     */
    constructor(IEntryPoint entryPointAddr) SignerECDSA(address(0)) nonZeroAddress(address(entryPointAddr)) {
        _entryPoint = entryPointAddr;
        _disableInitializers();
    }

    /**
     * @dev Receive function to accept plain ETH transfers
     * This is essential for smart wallets to receive ETH from transfers,
     * exchanges, and other contracts that don't use call with data
     */
    receive() external payable override {}

    /**
     * @dev Initialize the account with an owner
     * @param _owner The owner of this account
     */
    function initialize(address _owner) external virtual initializer nonZeroAddress(_owner) {
        owner = _owner;
        _setSigner(_owner); // Set the signer for OZ SignerECDSA
        emit SmartWalletInitialized(entryPoint(), _owner);
    }

    /**
     * @dev Execute a transaction
     * @param dest Destination address
     * @param value ETH value
     * @param func Call data
     */
    function execute(address dest, uint256 value, bytes calldata func) external onlyOwnerOrEntryPoint nonReentrant {
        _call(dest, value, func);
    }

    /**
     * @dev Execute batch of transactions
     * @param targets Array of target addresses
     * @param values Array of ETH values
     * @param datas Array of call data
     */
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external onlyOwnerOrEntryPoint nonReentrant {
        if (targets.length != values.length || values.length != datas.length) {
            revert InvalidUserOp();
        }
        if (targets.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge();
        }
        for (uint256 i = 0; i < targets.length; ) {
            _call(targets[i], values[i], datas[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev Deposit funds to EntryPoint
     */
    function addDeposit() external payable {
        entryPoint().depositTo{ value: msg.value }(address(this));
    }

    /**
     * @dev Withdraw funds from EntryPoint
     * @param withdrawAddress Address to withdraw to
     * @param amount Amount to withdraw
     */
    function withdrawDepositTo(
        address payable withdrawAddress,
        uint256 amount
    ) external onlyOwner nonZeroAddress(withdrawAddress) {
        entryPoint().withdrawTo(withdrawAddress, amount);
    }

    /**
     * @dev Change owner
     * @notice WARNING: If newOwner is a contract, ensure it can sign messages
     *         or the wallet may become inaccessible for UserOp validation.
     *         Contract owners must implement proper signature validation.
     * @param newOwner New owner address
     */
    function changeOwner(address newOwner) external onlyOwner nonZeroAddress(newOwner) {
        if (newOwner == owner) revert SameOwner(); // Cannot transfer to same owner

        // Prevent setting this contract as its own owner
        if (newOwner == address(this)) revert InvalidOwner();

        // Check if newOwner is a contract and emit warning event
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(newOwner)
        }
        
        address oldOwner = owner;
        owner = newOwner;
        _setSigner(newOwner); // Update signer for OZ SignerECDSA
        emit OwnerChanged(oldOwner, newOwner);
    }

    /**
     * @dev Check if signature is valid (ERC-1271)
     * @param hash Hash that was signed
     * @param signature Signature to verify
     * @return magicValue ERC-1271 magic value if valid
     */
    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view override returns (bytes4 magicValue) {
        if (_rawSignatureValidation(hash, signature)) {
            return 0x1626ba7e; // ERC1271_MAGIC_VALUE
        }
        return 0xffffffff;
    }

    /**
     * @dev Returns the EntryPoint address
     */
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    /**
     * @dev Get current nonce for a key
     * @param key The nonce key
     * @return The current nonce
     */
    function getNonce(uint192 key) public view override returns (uint256) {
        return entryPoint().getNonce(address(this), key);
    }

    /**
     * @dev Get deposit balance at EntryPoint
     * @return The deposit balance
     */
    function getDeposit() public view returns (uint256) {
        return entryPoint().balanceOf(address(this));
    }

    /**
     * @dev Internal call helper
     * @param target Target address
     * @param value ETH value
     * @param data Call data
     */
    function _call(address target, uint256 value, bytes memory data) internal {
        (bool success, bytes memory result) = target.call{ value: value }(data);
        if (!success) {
            // The following assembly code is used to revert with the exact error message from the failed call
            // This provides better debugging information than a generic revert
            assembly {
                // result contains the length of the revert data in the first 32 bytes
                // followed by the actual revert data
                // revert(pointer to data, size of data)
                revert(add(result, 32), mload(result))
            }
        }
    }

    /**
     * @dev Check only owner
     */
    function _onlyOwner() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }
}
