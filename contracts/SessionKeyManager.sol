// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/**
 * @title SessionKeyManager
 * @dev Abstract contract providing session key management for smart wallets.
 * Session keys allow users to grant time-limited, scope-restricted permissions
 * to dApps without exposing their main wallet key.
 * 
 * Supports two signature types:
 * - ECDSA (secp256k1): Traditional Ethereum signatures
 * - P256 (secp256r1): Passkeys, WebAuthn, Apple/Google device login, FIDO2
 * 
 * Key features:
 * - Time-bounded validity (validAfter, validUntil)
 * - Target contract restrictions (allowlist)
 * - Function selector restrictions
 * - Spending limits (per-tx and total)
 * - Call count limits
 * - Immediate revocation capability
 * - Support for both secp256k1 (ECDSA) and secp256r1 (P256/Passkeys)
 */
abstract contract SessionKeyManager {
    using ECDSA for bytes32;

    // ============ Enums ============

    /**
     * @dev Type of signer for a session key
     */
    enum SignerType {
        ECDSA,      // secp256k1 - Traditional Ethereum keys
        P256        // secp256r1 - Passkeys, WebAuthn, FIDO2, Secure Enclave
    }

    // ============ Data Structures ============

    /**
     * @dev Packed session key data structure (optimized for storage)
     */
    struct SessionKeyPacked {
        // For ECDSA keys
        address ecdsaKey;         // 20 bytes - The ECDSA session key address
        
        // For P256/Passkey keys (public key coordinates)
        bytes32 p256KeyX;         // 32 bytes - P256 public key X coordinate
        bytes32 p256KeyY;         // 32 bytes - P256 public key Y coordinate
        
        // Timing
        uint48 validAfter;        // 6 bytes - Timestamp when key becomes valid
        uint48 validUntil;        // 6 bytes - Timestamp when key expires
        
        // Value limits
        uint128 maxValuePerTx;    // 16 bytes - Max ETH per transaction (0 = no limit)
        uint128 maxValueTotal;    // 16 bytes - Max total ETH (0 = no limit)
        
        // Usage tracking
        uint128 valueUsed;        // 16 bytes - Running total of ETH used
        uint64 maxCalls;          // 8 bytes - Max number of calls (0 = unlimited)
        uint64 callsUsed;         // 8 bytes - Running count of calls
        
        // Status
        SignerType signerType;    // 1 byte - Type of signer
        bool revoked;             // 1 byte - Manual revocation flag
        bytes32 permissionsHash;  // 32 bytes - Hash of allowed targets/selectors
    }

    /**
     * @dev Configuration for creating an ECDSA session key
     */
    struct SessionConfigECDSA {
        address key;                    // The ECDSA session key address
        uint48 validAfter;              // Start time (0 = immediate)
        uint48 validUntil;              // End time
        uint128 maxValuePerTx;          // Max ETH per tx (0 = no limit)
        uint128 maxValueTotal;          // Max total ETH (0 = no limit)
        uint64 maxCalls;                // Max calls (0 = unlimited)
        address[] allowedTargets;       // Allowed target contracts
        bytes4[] allowedSelectors;      // Allowed function selectors
    }

    /**
     * @dev Configuration for creating a P256/Passkey session key
     */
    struct SessionConfigP256 {
        bytes32 keyX;                   // P256 public key X coordinate
        bytes32 keyY;                   // P256 public key Y coordinate
        uint48 validAfter;              // Start time (0 = immediate)
        uint48 validUntil;              // End time
        uint128 maxValuePerTx;          // Max ETH per tx (0 = no limit)
        uint128 maxValueTotal;          // Max total ETH (0 = no limit)
        uint64 maxCalls;                // Max calls (0 = unlimited)
        address[] allowedTargets;       // Allowed target contracts
        bytes4[] allowedSelectors;      // Allowed function selectors
    }

    /**
     * @dev Storage layout for session management
     */
    struct SessionStorage {
        // For ECDSA sessions: address => session
        mapping(address => SessionKeyPacked) ecdsaSessions;
        mapping(address => address[]) ecdsaAllowedTargets;
        mapping(address => bytes4[]) ecdsaAllowedSelectors;
        // O(1) lookups for ECDSA sessions
        mapping(address => mapping(address => bool)) ecdsaTargetAllowed;
        mapping(address => mapping(bytes4 => bool)) ecdsaSelectorAllowed;
        
        // For P256 sessions: keccak256(keyX, keyY) => session
        mapping(bytes32 => SessionKeyPacked) p256Sessions;
        mapping(bytes32 => address[]) p256AllowedTargets;
        mapping(bytes32 => bytes4[]) p256AllowedSelectors;
        // O(1) lookups for P256 sessions
        mapping(bytes32 => mapping(address => bool)) p256TargetAllowed;
        mapping(bytes32 => mapping(bytes4 => bool)) p256SelectorAllowed;
    }

    // ============ Constants ============

    /// @dev Signature prefix for ECDSA session keys
    bytes4 public constant SESSION_KEY_ECDSA = 0x00000001;
    
    /// @dev Signature prefix for P256/Passkey session keys
    bytes4 public constant SESSION_KEY_P256 = 0x00000002;
    
    /// @dev Maximum session duration (30 days)
    uint48 public constant MAX_SESSION_DURATION = 30 days;
    
    /// @dev Maximum number of allowed targets per session
    uint256 public constant MAX_TARGETS_PER_SESSION = 10;
    
    /// @dev Maximum number of allowed selectors per session
    uint256 public constant MAX_SELECTORS_PER_SESSION = 20;

    // ============ Storage ============

    /// @dev Storage slot for session data (EIP-7201 style)
    // solhint-disable-next-line private-vars-leading-underscore
    bytes32 private constant SESSION_STORAGE_SLOT = 
        keccak256(abi.encode(uint256(keccak256("lendefi.session.storage.v2")) - 1)) & ~bytes32(uint256(0xff));

    // ============ Events ============

    event SessionCreatedECDSA(
        address indexed sessionKey, 
        uint48 validAfter,
        uint48 validUntil, 
        bytes32 permissionsHash
    );
    
    event SessionCreatedP256(
        bytes32 indexed keyHash,
        bytes32 keyX,
        bytes32 keyY,
        uint48 validAfter,
        uint48 validUntil, 
        bytes32 permissionsHash
    );
    
    event SessionRevokedECDSA(address indexed sessionKey);
    event SessionRevokedP256(bytes32 indexed keyHash);
    
    event SessionUsed(
        bytes32 indexed keyIdentifier,
        SignerType signerType,
        address indexed target, 
        bytes4 selector,
        uint256 value
    );

    // ============ Errors ============

    error InvalidSessionKey();
    error InvalidP256Key();
    error SessionAlreadyActive();
    error SessionExpired();
    error SessionNotYetValid();
    error SessionKeyRevoked();
    error SessionNotFound();
    error InvalidValidityWindow();
    error SessionDurationTooLong();
    error TooManyTargets();
    error TooManySelectors();
    error NoTargetsSpecified();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error ValueExceedsPerTxLimit();
    error ValueExceedsTotalLimit();
    error MaxCallsExceeded();
    error InvalidSessionSignature();
    error InvalidSignatureType();
    error CannotCallSensitiveFunction();
    error CannotTargetSelf();

    // ============ Storage Access ============

    function _sessionStorage() internal pure returns (SessionStorage storage s) {
        bytes32 slot = SESSION_STORAGE_SLOT;
        assembly {
            s.slot := slot
        }
    }

    // ============ External Functions - ECDSA ============

    /**
     * @notice Create a new ECDSA session key (traditional Ethereum key)
     * @param config The session key configuration
     */
    function createSessionECDSA(SessionConfigECDSA calldata config) external virtual {
        _requireOwner();
        _createSessionECDSA(config);
    }

    /**
     * @notice Revoke an ECDSA session key
     * @param sessionKey The session key address to revoke
     */
    function revokeSessionECDSA(address sessionKey) external virtual {
        _requireOwner();
        _revokeSessionECDSA(sessionKey);
    }

    /**
     * @notice Check if an ECDSA session key is currently valid
     * @param sessionKey The session key to check
     */
    function isValidSessionECDSA(address sessionKey) external view returns (bool) {
        SessionKeyPacked storage session = _sessionStorage().ecdsaSessions[sessionKey];
        return _isSessionValid(session);
    }

    /**
     * @notice Get ECDSA session key information
     * @param sessionKey The session key address
     */
    function getSessionECDSA(address sessionKey) external view returns (
        address key,
        uint48 validAfter,
        uint48 validUntil,
        uint128 maxValuePerTx,
        uint128 maxValueTotal,
        uint128 valueUsed,
        uint64 maxCalls,
        uint64 callsUsed,
        bool revoked
    ) {
        SessionKeyPacked storage session = _sessionStorage().ecdsaSessions[sessionKey];
        return (
            session.ecdsaKey,
            session.validAfter,
            session.validUntil,
            session.maxValuePerTx,
            session.maxValueTotal,
            session.valueUsed,
            session.maxCalls,
            session.callsUsed,
            session.revoked
        );
    }

    /**
     * @notice Get ECDSA session permissions
     * @param sessionKey The session key address
     */
    function getSessionPermissionsECDSA(address sessionKey) external view returns (
        address[] memory allowedTargets,
        bytes4[] memory allowedSelectors
    ) {
        SessionStorage storage ss = _sessionStorage();
        return (ss.ecdsaAllowedTargets[sessionKey], ss.ecdsaAllowedSelectors[sessionKey]);
    }

    // ============ External Functions - P256/Passkey ============

    /**
     * @notice Create a new P256/Passkey session key (WebAuthn, FIDO2, Secure Enclave)
     * @param config The session key configuration with P256 public key coordinates
     */
    function createSessionP256(SessionConfigP256 calldata config) external virtual {
        _requireOwner();
        _createSessionP256(config);
    }

    /**
     * @notice Revoke a P256/Passkey session key
     * @param keyX The P256 public key X coordinate
     * @param keyY The P256 public key Y coordinate
     */
    function revokeSessionP256(bytes32 keyX, bytes32 keyY) external virtual {
        _requireOwner();
        _revokeSessionP256(keyX, keyY);
    }

    /**
     * @notice Check if a P256 session key is currently valid
     * @param keyX The P256 public key X coordinate
     * @param keyY The P256 public key Y coordinate
     */
    function isValidSessionP256(bytes32 keyX, bytes32 keyY) external view returns (bool) {
        bytes32 keyHash = keccak256(abi.encodePacked(keyX, keyY));
        SessionKeyPacked storage session = _sessionStorage().p256Sessions[keyHash];
        return _isSessionValid(session);
    }

    /**
     * @notice Get P256 session key information
     * @param keyX The P256 public key X coordinate
     * @param keyY The P256 public key Y coordinate
     */
    function getSessionP256(bytes32 keyX, bytes32 keyY) external view returns (
        bytes32 storedKeyX,
        bytes32 storedKeyY,
        uint48 validAfter,
        uint48 validUntil,
        uint128 maxValuePerTx,
        uint128 maxValueTotal,
        uint128 valueUsed,
        uint64 maxCalls,
        uint64 callsUsed,
        bool revoked
    ) {
        bytes32 keyHash = keccak256(abi.encodePacked(keyX, keyY));
        SessionKeyPacked storage session = _sessionStorage().p256Sessions[keyHash];
        return (
            session.p256KeyX,
            session.p256KeyY,
            session.validAfter,
            session.validUntil,
            session.maxValuePerTx,
            session.maxValueTotal,
            session.valueUsed,
            session.maxCalls,
            session.callsUsed,
            session.revoked
        );
    }

    /**
     * @notice Get P256 session permissions
     * @param keyX The P256 public key X coordinate
     * @param keyY The P256 public key Y coordinate
     */
    function getSessionPermissionsP256(bytes32 keyX, bytes32 keyY) external view returns (
        address[] memory allowedTargets,
        bytes4[] memory allowedSelectors
    ) {
        bytes32 keyHash = keccak256(abi.encodePacked(keyX, keyY));
        SessionStorage storage ss = _sessionStorage();
        return (ss.p256AllowedTargets[keyHash], ss.p256AllowedSelectors[keyHash]);
    }

    // ============ Backward Compatibility ============

    /**
     * @notice Create session (alias for createSessionECDSA for backward compatibility)
     */
    function createSession(SessionConfigECDSA calldata config) external virtual {
        _requireOwner();
        _createSessionECDSA(config);
    }

    /**
     * @notice Revoke session (alias for revokeSessionECDSA for backward compatibility)
     */
    function revokeSession(address sessionKey) external virtual {
        _requireOwner();
        _revokeSessionECDSA(sessionKey);
    }

    /**
     * @notice Check if session is valid (alias for isValidSessionECDSA)
     */
    function isValidSession(address sessionKey) external view returns (bool) {
        SessionKeyPacked storage session = _sessionStorage().ecdsaSessions[sessionKey];
        return _isSessionValid(session);
    }

    // ============ Internal Functions - ECDSA ============

    function _createSessionECDSA(SessionConfigECDSA calldata config) internal {
        if (config.key == address(0)) revert InvalidSessionKey();
        _validateSessionTiming(config.validAfter, config.validUntil);
        _validatePermissions(config.allowedTargets.length, config.allowedSelectors.length);

        SessionStorage storage ss = _sessionStorage();
        
        SessionKeyPacked storage existing = ss.ecdsaSessions[config.key];
        if (existing.ecdsaKey != address(0) && _isSessionValid(existing)) {
            revert SessionAlreadyActive();
        }

        bytes32 permissionsHash = keccak256(
            abi.encode(config.allowedTargets, config.allowedSelectors)
        );

        ss.ecdsaSessions[config.key] = SessionKeyPacked({
            ecdsaKey: config.key,
            p256KeyX: bytes32(0),
            p256KeyY: bytes32(0),
            validAfter: config.validAfter,
            validUntil: config.validUntil,
            maxValuePerTx: config.maxValuePerTx,
            maxValueTotal: config.maxValueTotal,
            valueUsed: 0,
            maxCalls: config.maxCalls,
            callsUsed: 0,
            signerType: SignerType.ECDSA,
            revoked: false,
            permissionsHash: permissionsHash
        });

        ss.ecdsaAllowedTargets[config.key] = config.allowedTargets;
        ss.ecdsaAllowedSelectors[config.key] = config.allowedSelectors;

        // Populate O(1) lookup mappings and check for self-targeting
        for (uint256 i = 0; i < config.allowedTargets.length; ) {
            if (config.allowedTargets[i] == address(this)) revert CannotTargetSelf();
            ss.ecdsaTargetAllowed[config.key][config.allowedTargets[i]] = true;
            unchecked { ++i; }
        }
        for (uint256 i = 0; i < config.allowedSelectors.length; ) {
            ss.ecdsaSelectorAllowed[config.key][config.allowedSelectors[i]] = true;
            unchecked { ++i; }
        }

        emit SessionCreatedECDSA(
            config.key,
            config.validAfter,
            config.validUntil,
            permissionsHash
        );
    }

    function _revokeSessionECDSA(address sessionKey) internal {
        SessionStorage storage ss = _sessionStorage();
        if (ss.ecdsaSessions[sessionKey].ecdsaKey == address(0)) revert SessionNotFound();
        
        ss.ecdsaSessions[sessionKey].revoked = true;
        emit SessionRevokedECDSA(sessionKey);
    }

    // ============ Internal Functions - P256 ============

    function _createSessionP256(SessionConfigP256 calldata config) internal {
        // Validate P256 public key
        if (!P256.isValidPublicKey(config.keyX, config.keyY)) revert InvalidP256Key();
        _validateSessionTiming(config.validAfter, config.validUntil);
        _validatePermissions(config.allowedTargets.length, config.allowedSelectors.length);

        bytes32 keyHash = keccak256(abi.encodePacked(config.keyX, config.keyY));
        SessionStorage storage ss = _sessionStorage();
        
        SessionKeyPacked storage existing = ss.p256Sessions[keyHash];
        if (existing.p256KeyX != bytes32(0) && _isSessionValid(existing)) {
            revert SessionAlreadyActive();
        }

        bytes32 permissionsHash = keccak256(
            abi.encode(config.allowedTargets, config.allowedSelectors)
        );

        ss.p256Sessions[keyHash] = SessionKeyPacked({
            ecdsaKey: address(0),
            p256KeyX: config.keyX,
            p256KeyY: config.keyY,
            validAfter: config.validAfter,
            validUntil: config.validUntil,
            maxValuePerTx: config.maxValuePerTx,
            maxValueTotal: config.maxValueTotal,
            valueUsed: 0,
            maxCalls: config.maxCalls,
            callsUsed: 0,
            signerType: SignerType.P256,
            revoked: false,
            permissionsHash: permissionsHash
        });

        ss.p256AllowedTargets[keyHash] = config.allowedTargets;
        ss.p256AllowedSelectors[keyHash] = config.allowedSelectors;

        // Populate O(1) lookup mappings and check for self-targeting
        for (uint256 i = 0; i < config.allowedTargets.length; ) {
            if (config.allowedTargets[i] == address(this)) revert CannotTargetSelf();
            ss.p256TargetAllowed[keyHash][config.allowedTargets[i]] = true;
            unchecked { ++i; }
        }
        for (uint256 i = 0; i < config.allowedSelectors.length; ) {
            ss.p256SelectorAllowed[keyHash][config.allowedSelectors[i]] = true;
            unchecked { ++i; }
        }

        emit SessionCreatedP256(
            keyHash,
            config.keyX,
            config.keyY,
            config.validAfter,
            config.validUntil,
            permissionsHash
        );
    }

    function _revokeSessionP256(bytes32 keyX, bytes32 keyY) internal {
        bytes32 keyHash = keccak256(abi.encodePacked(keyX, keyY));
        SessionStorage storage ss = _sessionStorage();
        if (ss.p256Sessions[keyHash].p256KeyX == bytes32(0)) revert SessionNotFound();
        
        ss.p256Sessions[keyHash].revoked = true;
        emit SessionRevokedP256(keyHash);
    }

    // ============ Internal Functions - Shared ============

    function _validateSessionTiming(uint48 validAfter, uint48 validUntil) internal view {
        // solhint-disable-next-line not-rely-on-time
        if (validUntil < block.timestamp + 1) revert InvalidValidityWindow();
        if (validUntil < validAfter + 1) revert InvalidValidityWindow();
        if (validUntil - validAfter > MAX_SESSION_DURATION) {
            revert SessionDurationTooLong();
        }
    }

    function _validatePermissions(uint256 targetsLen, uint256 selectorsLen) internal pure {
        if (targetsLen == 0) revert NoTargetsSpecified();
        if (targetsLen > MAX_TARGETS_PER_SESSION) revert TooManyTargets();
        if (selectorsLen > MAX_SELECTORS_PER_SESSION) revert TooManySelectors();
    }

    function _isSessionValid(SessionKeyPacked storage session) internal view returns (bool) {
        // Check if session exists
        if (session.signerType == SignerType.ECDSA) {
            if (session.ecdsaKey == address(0)) return false;
        } else {
            if (session.p256KeyX == bytes32(0)) return false;
        }
        
        if (session.revoked) return false;
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < session.validAfter) return false;
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp > session.validUntil) return false;
        return true;
    }

    /**
     * @dev Validate a session key signature for a UserOperation
     * Supports both ECDSA and P256 signatures based on prefix
     */
    function _validateSessionKeySignature(
        bytes32 userOpHash,
        bytes calldata signature,
        bytes calldata callData
    ) internal returns (uint256 validationData) {
        bytes4 sigType = bytes4(signature[:4]);
        
        if (sigType == SESSION_KEY_ECDSA) {
            return _validateECDSASessionSignature(userOpHash, signature, callData);
        } else if (sigType == SESSION_KEY_P256) {
            return _validateP256SessionSignature(userOpHash, signature, callData);
        } else {
            revert InvalidSignatureType();
        }
    }

    /**
     * @dev Validate ECDSA session key signature
     * Format: [4 bytes prefix][20 bytes session key][65 bytes signature]
     */
    function _validateECDSASessionSignature(
        bytes32 userOpHash,
        bytes calldata signature,
        bytes calldata callData
    ) internal returns (uint256) {
        if (signature.length < 89) revert InvalidSessionSignature();
        
        address sessionKey = address(bytes20(signature[4:24]));
        bytes calldata sig = signature[24:];
        
        SessionStorage storage ss = _sessionStorage();
        SessionKeyPacked storage session = ss.ecdsaSessions[sessionKey];
        
        if (session.ecdsaKey == address(0)) revert SessionNotFound();
        if (session.revoked) revert SessionKeyRevoked();
        
        // Verify ECDSA signature
        address recovered = userOpHash.recover(sig);
        if (recovered != sessionKey) revert InvalidSessionSignature();
        
        // Check permissions and limits
        _checkPermissionsAndLimitsECDSA(sessionKey, callData, session, ss);
        
        return _getValidationData(session);
    }

    /**
     * @dev Validate P256/Passkey session key signature
     * Format: [4 bytes prefix][32 bytes keyX][32 bytes keyY][64 bytes signature (r,s)]
     */
    function _validateP256SessionSignature(
        bytes32 userOpHash,
        bytes calldata signature,
        bytes calldata callData
    ) internal returns (uint256) {
        // Minimum: 4 + 32 + 32 + 64 = 132 bytes
        if (signature.length < 132) revert InvalidSessionSignature();
        
        bytes32 keyX = bytes32(signature[4:36]);
        bytes32 keyY = bytes32(signature[36:68]);
        bytes32 r = bytes32(signature[68:100]);
        bytes32 s = bytes32(signature[100:132]);
        
        bytes32 keyHash = keccak256(abi.encodePacked(keyX, keyY));
        SessionStorage storage ss = _sessionStorage();
        SessionKeyPacked storage session = ss.p256Sessions[keyHash];
        
        if (session.p256KeyX == bytes32(0)) revert SessionNotFound();
        if (session.revoked) revert SessionKeyRevoked();
        
        // Verify P256 signature
        if (!P256.verify(userOpHash, r, s, keyX, keyY)) {
            revert InvalidSessionSignature();
        }
        
        // Check permissions and limits
        _checkPermissionsAndLimitsP256(keyHash, callData, session, ss);
        
        return _getValidationData(session);
    }

    function _getValidationData(SessionKeyPacked storage session) internal view returns (uint256) {
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < session.validAfter) {
            return _packValidationData(false, session.validUntil, session.validAfter);
        }
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp > session.validUntil) {
            return _packValidationData(false, 0, 0);
        }
        return _packValidationData(true, session.validUntil, session.validAfter);
    }

    function _checkPermissionsAndLimitsECDSA(
        address sessionKey,
        bytes calldata callData,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal {
        bytes4 selector = bytes4(callData[:4]);
        _checkSensitiveFunctions(selector);
        
        bytes4 executeSel = 0xb61d27f6;
        if (selector == executeSel) {
            _handleExecuteECDSA(sessionKey, callData, session, ss);
            return;
        }
        
        bytes4 executeBatchSel = 0x47e1da2a;
        if (selector == executeBatchSel) {
            _handleExecuteBatchECDSA(sessionKey, callData, session, ss);
            return;
        }
        
        revert CannotCallSensitiveFunction();
    }

    function _checkPermissionsAndLimitsP256(
        bytes32 keyHash,
        bytes calldata callData,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal {
        bytes4 selector = bytes4(callData[:4]);
        _checkSensitiveFunctions(selector);
        
        bytes4 executeSel = 0xb61d27f6;
        if (selector == executeSel) {
            _handleExecuteP256(keyHash, callData, session, ss);
            return;
        }
        
        bytes4 executeBatchSel = 0x47e1da2a;
        if (selector == executeBatchSel) {
            _handleExecuteBatchP256(keyHash, callData, session, ss);
            return;
        }
        
        revert CannotCallSensitiveFunction();
    }

    function _checkSensitiveFunctions(bytes4 selector) internal pure {
        bytes4 changeOwnerSel = 0xa6f9dae1;
        bytes4 createSessionSel = 0x7b866963;
        bytes4 createSessionECDSASel = 0xf6c5c498;
        bytes4 createSessionP256Sel = 0x3e7b2a6c;
        bytes4 revokeSessionSel = 0x753c7bf9;
        bytes4 revokeSessionECDSASel = 0x6e0f2d6a;
        bytes4 revokeSessionP256Sel = 0x5c7b9a2e;
        bytes4 withdrawSel = 0x205c2878;
        
        if (selector == changeOwnerSel ||
            selector == createSessionSel ||
            selector == createSessionECDSASel ||
            selector == createSessionP256Sel ||
            selector == revokeSessionSel ||
            selector == revokeSessionECDSASel ||
            selector == revokeSessionP256Sel ||
            selector == withdrawSel) {
            revert CannotCallSensitiveFunction();
        }
    }

    // ============ Internal - ECDSA Execute Handlers ============

    function _handleExecuteECDSA(
        address sessionKey,
        bytes calldata callData,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal {
        (address target, uint256 value, bytes memory data) = 
            abi.decode(callData[4:], (address, uint256, bytes));
        
        bytes4 targetSelector = data.length > 3 ? bytes4(data) : bytes4(0);
        
        _validateCallECDSA(sessionKey, target, targetSelector, value, session, ss);
        _updateLimits(session, value);
        
        emit SessionUsed(bytes32(uint256(uint160(sessionKey))), SignerType.ECDSA, target, targetSelector, value);
    }

    function _handleExecuteBatchECDSA(
        address sessionKey,
        bytes calldata callData,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory datas) =
            abi.decode(callData[4:], (address[], uint256[], bytes[]));
        
        uint256 totalValue = 0;
        for (uint256 i = 0; i < targets.length; ) {
            bytes4 targetSelector = datas[i].length > 3 ? bytes4(datas[i]) : bytes4(0);
            
            _validateCallECDSA(sessionKey, targets[i], targetSelector, values[i], session, ss);
            totalValue += values[i];
            
            emit SessionUsed(bytes32(uint256(uint160(sessionKey))), SignerType.ECDSA, targets[i], targetSelector, values[i]);
            unchecked { ++i; }
        }
        
        _updateLimits(session, totalValue);
    }

    function _validateCallECDSA(
        address sessionKey,
        address target,
        bytes4 targetSelector,
        uint256 value,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal view {
        if (session.maxValuePerTx > 0 && value > session.maxValuePerTx) {
            revert ValueExceedsPerTxLimit();
        }
        
        _checkTargetAllowedECDSA(sessionKey, target, ss);
        _checkSelectorAllowedECDSA(sessionKey, targetSelector, ss);
    }

    function _checkTargetAllowedECDSA(address sessionKey, address target, SessionStorage storage ss) internal view {
        if (!ss.ecdsaTargetAllowed[sessionKey][target]) revert TargetNotAllowed();
    }

    function _checkSelectorAllowedECDSA(address sessionKey, bytes4 targetSelector, SessionStorage storage ss) internal view {
        bytes4[] storage allowedSelectors = ss.ecdsaAllowedSelectors[sessionKey];
        if (allowedSelectors.length == 0 || targetSelector == bytes4(0)) return;
        
        if (!ss.ecdsaSelectorAllowed[sessionKey][targetSelector]) revert SelectorNotAllowed();
    }

    // ============ Internal - P256 Execute Handlers ============

    function _handleExecuteP256(
        bytes32 keyHash,
        bytes calldata callData,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal {
        (address target, uint256 value, bytes memory data) = 
            abi.decode(callData[4:], (address, uint256, bytes));
        
        bytes4 targetSelector = data.length > 3 ? bytes4(data) : bytes4(0);
        
        _validateCallP256(keyHash, target, targetSelector, value, session, ss);
        _updateLimits(session, value);
        
        emit SessionUsed(keyHash, SignerType.P256, target, targetSelector, value);
    }

    function _handleExecuteBatchP256(
        bytes32 keyHash,
        bytes calldata callData,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory datas) =
            abi.decode(callData[4:], (address[], uint256[], bytes[]));
        
        uint256 totalValue = 0;
        for (uint256 i = 0; i < targets.length; ) {
            bytes4 targetSelector = datas[i].length > 3 ? bytes4(datas[i]) : bytes4(0);
            
            _validateCallP256(keyHash, targets[i], targetSelector, values[i], session, ss);
            totalValue += values[i];
            
            emit SessionUsed(keyHash, SignerType.P256, targets[i], targetSelector, values[i]);
            unchecked { ++i; }
        }
        
        _updateLimits(session, totalValue);
    }

    function _validateCallP256(
        bytes32 keyHash,
        address target,
        bytes4 targetSelector,
        uint256 value,
        SessionKeyPacked storage session,
        SessionStorage storage ss
    ) internal view {
        if (session.maxValuePerTx > 0 && value > session.maxValuePerTx) {
            revert ValueExceedsPerTxLimit();
        }
        
        _checkTargetAllowedP256(keyHash, target, ss);
        _checkSelectorAllowedP256(keyHash, targetSelector, ss);
    }

    function _checkTargetAllowedP256(bytes32 keyHash, address target, SessionStorage storage ss) internal view {
        if (!ss.p256TargetAllowed[keyHash][target]) revert TargetNotAllowed();
    }

    function _checkSelectorAllowedP256(bytes32 keyHash, bytes4 targetSelector, SessionStorage storage ss) internal view {
        bytes4[] storage allowedSelectors = ss.p256AllowedSelectors[keyHash];
        if (allowedSelectors.length == 0 || targetSelector == bytes4(0)) return;
        
        if (!ss.p256SelectorAllowed[keyHash][targetSelector]) revert SelectorNotAllowed();
    }

    // ============ Internal - Shared ============

    function _updateLimits(SessionKeyPacked storage session, uint256 value) internal {
        if (session.maxValueTotal > 0) {
            if (session.valueUsed + value > session.maxValueTotal) {
                revert ValueExceedsTotalLimit();
            }
            session.valueUsed += uint128(value);
        }
        
        if (session.maxCalls > 0) {
            if (session.callsUsed + 1 > session.maxCalls) {
                revert MaxCallsExceeded();
            }
            session.callsUsed++;
        }
    }

    function _packValidationData(
        bool success,
        uint48 validUntil,
        uint48 validAfter
    ) internal pure returns (uint256) {
        if (!success) {
            return 1; // SIG_VALIDATION_FAILED
        }
        return uint256(validAfter) << 208 | uint256(validUntil) << 160;
    }

    /**
     * @dev Abstract function to require owner - must be implemented by child contract
     */
    function _requireOwner() internal view virtual;
}
