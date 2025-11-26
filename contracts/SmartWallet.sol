// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Account } from "@openzeppelin/contracts/account/Account.sol";
import { SignerECDSA } from "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IEntryPoint, PackedUserOperation } from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import { ERC4337Utils } from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import { SessionKeyManager } from "./SessionKeyManager.sol";

/**
 * @title SmartWallet
 * @dev ERC-4337 compliant smart contract wallet with session key support.
 * Supports both ECDSA (secp256k1) and P256 (secp256r1/Passkey) session keys
 * for time-limited, scope-restricted delegated signing capabilities.
 * 
 * Key features:
 * - ERC-4337 Account Abstraction
 * - Session keys for delegated access (ECDSA + P256/Passkey)
 * - Time-bounded permissions
 * - Target/selector restrictions
 * - Spending limits
 */
contract SmartWallet is Account, SignerECDSA, IERC1271, Initializable, ReentrancyGuard, SessionKeyManager {
    // ============ Constants ============
    
    uint256 public constant MAX_BATCH_SIZE = 50;

    // ============ State Variables ============
    
    IEntryPoint private immutable _entryPoint;
    address public owner;

    // ============ Events ============
    
    event SmartWalletInitialized(IEntryPoint indexed entryPoint, address indexed owner);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    // ============ Errors ============
    
    error ZeroAddress();
    error InvalidUserOp();
    error Unauthorized();
    error SameOwner();
    error InvalidOwner();
    error BatchTooLarge();

    // ============ Modifiers ============
    
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

    // ============ Constructor ============

    /**
     * @dev Constructor that sets the EntryPoint address
     * @param entryPointAddr The EntryPoint contract address
     */
    constructor(IEntryPoint entryPointAddr) SignerECDSA(address(0)) nonZeroAddress(address(entryPointAddr)) {
        _entryPoint = entryPointAddr;
        _disableInitializers();
    }

    // ============ Receive ============

    /**
     * @dev Receive function to accept plain ETH transfers
     */
    receive() external payable override {}

    // ============ Initialization ============

    /**
     * @dev Initialize the account with an owner
     * @param _owner The owner of this account
     */
    function initialize(address _owner) external virtual initializer nonZeroAddress(_owner) {
        owner = _owner;
        _setSigner(_owner);
        emit SmartWalletInitialized(entryPoint(), _owner);
    }

    // ============ Execution Functions ============

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

    // ============ Deposit Management ============

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

    // ============ Owner Management ============

    /**
     * @dev Change owner
     * @notice WARNING: If newOwner is a contract, ensure it can sign messages
     * @param newOwner New owner address
     */
    function changeOwner(address newOwner) external onlyOwner nonZeroAddress(newOwner) {
        if (newOwner == owner) revert SameOwner();
        if (newOwner == address(this)) revert InvalidOwner();
        
        address oldOwner = owner;
        owner = newOwner;
        _setSigner(newOwner);
        emit OwnerChanged(oldOwner, newOwner);
    }

    // ============ Signature Validation ============

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
        // Check for session key signature (ECDSA or P256)
        if (signature.length > 4) {
            bytes4 sigType = bytes4(signature[:4]);
            
            if (sigType == SESSION_KEY_ECDSA) {
                // ECDSA session key: [4 prefix][20 key][65+ sig]
                if (signature.length < 89) return 0xffffffff;
                
                address sessionKey = address(bytes20(signature[4:24]));
                SessionStorage storage ss = _sessionStorage();
                SessionKeyPacked storage session = ss.ecdsaSessions[sessionKey];
                
                if (!_isSessionValid(session)) return 0xffffffff;
                
                // Verify signature using ECDSA
                bytes calldata sig = signature[24:];
                (address recovered, , ) = ECDSA.tryRecover(hash, sig);
                if (recovered == sessionKey) {
                    return 0x1626ba7e; // ERC1271_MAGIC_VALUE
                }
                return 0xffffffff;
            } else if (sigType == SESSION_KEY_P256) {
                // P256 session key: [4 prefix][32 keyX][32 keyY][64 sig (r,s)]
                if (signature.length < 132) return 0xffffffff;
                
                bytes32 keyX = bytes32(signature[4:36]);
                bytes32 keyY = bytes32(signature[36:68]);
                bytes32 r = bytes32(signature[68:100]);
                bytes32 s = bytes32(signature[100:132]);
                
                bytes32 keyHash = keccak256(abi.encodePacked(keyX, keyY));
                SessionStorage storage ss = _sessionStorage();
                SessionKeyPacked storage session = ss.p256Sessions[keyHash];
                
                if (!_isSessionValid(session)) return 0xffffffff;
                
                // Verify P256 signature
                if (P256.verify(hash, r, s, keyX, keyY)) {
                    return 0x1626ba7e; // ERC1271_MAGIC_VALUE
                }
                return 0xffffffff;
            }
        }
        
        // Default: owner signature
        if (_rawSignatureValidation(hash, signature)) {
            return 0x1626ba7e;
        }
        return 0xffffffff;
    }

    // ============ View Functions ============

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

    // ============ Internal Functions ============

    /**
     * @dev Override _validateUserOp to support session keys
     */
    function _validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal virtual override returns (uint256) {
        // Check if this is a session key signature
        if (userOp.signature.length > 4) {
            bytes4 sigType = bytes4(userOp.signature[:4]);
            if (sigType == SESSION_KEY_ECDSA || sigType == SESSION_KEY_P256) {
                return _validateSessionKeySignature(userOpHash, userOp.signature, userOp.callData);
            }
        }
        
        // Default: owner signature validation
        return _rawSignatureValidation(_signableUserOpHash(userOp, userOpHash), userOp.signature)
            ? ERC4337Utils.SIG_VALIDATION_SUCCESS
            : ERC4337Utils.SIG_VALIDATION_FAILED;
    }

    /**
     * @dev Internal call helper
     */
    function _call(address target, uint256 value, bytes memory data) internal {
        (bool success, bytes memory result) = target.call{ value: value }(data);
        if (!success) {
            assembly {
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

    /**
     * @dev Implementation of SessionKeyManager's _requireOwner
     */
    function _requireOwner() internal view override {
        _onlyOwner();
    }
}
