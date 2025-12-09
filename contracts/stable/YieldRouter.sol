// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {AutomationCompatibleInterface} from "../interfaces/AutomationCompatibleInterface.sol";
import {
    AssetType,
    IOUSGInstantManager,
    IOndoOracle,
    IAaveV3Pool,
    ILitePSMWrapper
} from "../interfaces/IYieldProtocols.sol";
import {IYieldRouter} from "../interfaces/IYieldRouter.sol";
import {IUSDL} from "../interfaces/IUSDL.sol";

/**
 * @title YieldRouter - Yield Strategy Router for USDL
 * @author Lendefi Markets
 * @notice Manages yield asset allocations and protocol interactions for USDL vault
 * @dev Handles all yield-related logic:
 *      - Yield asset registry (add/update/remove)
 *      - Weight-based allocation management
 *      - Protocol-specific deposit/withdraw routing
 *      - Value calculation across protocols
 *      - Chainlink Automation for yield accrual
 *
 * Supported Protocols:
 * - ERC4626 vaults (sDAI, Morpho, etc.)
 * - Aave V3 (aUSDC)
 * - Ondo OUSG (tokenized treasuries)
 * - Sky sUSDS (USDC → USDS → sUSDS flow)
 *
 * Token Custody:
 * - YieldRouter holds all yield tokens (aUSDC, sUSDS, OUSG, etc.)
 * - USDL only handles USDC during deposit/redeem
 *
 * @custom:security-contact security@lendefimarkets.com
 */
contract YieldRouter is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    AutomationCompatibleInterface,
    IYieldRouter
{
    using SafeERC20 for IERC20;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    // ============ Constants ============

    /// @notice Basis points divisor (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Maximum number of yield assets to prevent gas issues
    uint256 public constant MAX_YIELD_ASSETS = 10;

    /// @notice Minimum interval allowed for automated yield accrual (1 hour)
    uint256 public constant MIN_AUTOMATION_INTERVAL = 1 hours;

    /// @notice Minimum USDC amount for Ondo OUSG deposits/withdrawals ($5,000)
    uint256 public constant ONDO_MIN_AMOUNT = 5_000e6;

    /// @dev Role for USDL vault to call deposit/redeem
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    /// @dev Role for managing yield assets
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @dev Role for authorizing upgrades
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ============ Storage ============

    /// @notice Contract version (increments on each upgrade)
    uint256 public version;

    /// @notice USDL vault address
    address public vault;

    /// @notice USDC asset address
    address public usdc;

    /// @notice Yield asset weights (token => weight in BPS)
    EnumerableMap.AddressToUintMap internal _yieldAssetWeights;

    /// @notice Yield asset configurations
    mapping(address token => YieldAssetConfig config) public yieldAssetConfigs;

    /// @notice Sky protocol configuration
    SkyConfig public skyConfig;

    /// @notice Automation interval (seconds between yield accruals)
    uint256 public yieldAccrualInterval;

    /// @notice Last yield accrual timestamp
    uint256 public lastYieldAccrualTimestamp;

    /// @notice Tracked USDC balance (internal accounting to prevent inflation attacks)
    /// @dev Only USDC received through depositToProtocols or harvested yield is tracked
    uint256 public trackedUSDCBalance;

    /// @notice Pending deposits waiting to be allocated to protocols
    /// @dev Accumulated during deposits, allocated to protocols during performUpkeep
    uint256 public pendingDeposits;

    /// @notice OUSG token address for efficient minimum check
    address public ousgToken;

    /// @notice Total deposited assets tracked internally
    uint256 public totalDepositedAssets;

    /// @notice Storage gap for upgrades
    uint256[36] private __gap;

    // ============ Modifiers ============

    /// @notice Restricts function to VAULT_ROLE only
    modifier onlyVault() {
        _onlyVault();
        _;
    }

    // ============ Constructor ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    /**
     * @notice Initialize the YieldRouter contract
     * @param _multisig Admin address (gets DEFAULT_ADMIN_ROLE) - Multisig
     * @param _usdc USDC token address
     * @param _vault USDL vault address
     */
    function initialize(address _multisig, address _usdc, address _vault) external initializer {
        if (_multisig == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MANAGER_ROLE, _multisig);
        _grantRole(UPGRADER_ROLE, _multisig);
        _grantRole(VAULT_ROLE, _vault);

        usdc = _usdc;
        vault = _vault;
        version = 1;

        // Default automation settings: daily accruals
        yieldAccrualInterval = 1 days;
        lastYieldAccrualTimestamp = block.timestamp;
    }

    // ============ Core Routing Functions ============

    /**
     * @inheritdoc IYieldRouter
     * @dev LAZY ALLOCATION: Does not immediately deposit to protocols.
     *      USDC is tracked as pending and allocated during performUpkeep.
     *      This reduces gas per user deposit by ~50%.
     */
    function depositToProtocols(uint256 amount) external override nonReentrant whenNotPaused onlyVault {
        if (amount == 0) revert ZeroAmount();

        // Track incoming USDC (internal accounting for inflation attack protection)
        trackedUSDCBalance += amount;

        // Track total deposited assets
        totalDepositedAssets += amount;

        // Track as pending - will be allocated to protocols during performUpkeep
        pendingDeposits += amount;
        emit DepositedToProtocols(amount);
        IERC20(usdc).safeTransferFrom(vault, address(this), amount);
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function redeemFromProtocols(uint256 amount)
        external
        override
        nonReentrant
        whenNotPaused
        onlyVault
        returns (uint256 redeemed)
    {
        if (amount == 0) revert ZeroAmount();

        // Cache storage reads
        uint256 tracked = trackedUSDCBalance;

        // If we don't have enough tracked USDC, redeem from yield assets
        if (tracked < amount) {
            uint256 needed = amount - tracked;
            _withdrawFromYieldAssets(needed);
            // Re-read after redemption (state changed)
            tracked = trackedUSDCBalance;
        }

        // Calculate redeemed based on tracked balance
        redeemed = tracked > amount ? amount : tracked;

        // Update tracked balance and transfer
        if (redeemed > 0) {
            trackedUSDCBalance = tracked - redeemed;
            totalDepositedAssets -= redeemed;
            emit RedeemedFromProtocols(amount, redeemed);
            IERC20(usdc).safeTransfer(vault, redeemed);
        }
    }

    // ============ Yield Asset Management ============

    /**
     * @notice Registers a new yield asset with weight = 0 (inactive)
     * @dev Asset receives no deposits until weight is set via updateWeights()
     *      Two-step activation: addYieldAsset() -> updateWeights()
     * @param token Yield-bearing token address (sDAI, aUSDC, OUSG)
     * @param depositToken Token used to acquire yield asset (USDC, DAI)
     * @param manager Manager contract address (vault, pool, oracle)
     * @param assetType Protocol type for deposit/withdraw routing
     */
    function addYieldAsset(address token, address depositToken, address manager, AssetType assetType)
        external
        onlyRole(MANAGER_ROLE)
    {
        if (token == address(0)) revert ZeroAddress();
        if (depositToken == address(0)) revert ZeroAddress();
        if (manager == address(0)) revert ZeroAddress();
        if (_yieldAssetWeights.contains(token)) revert AssetAlreadyExists(token);
        if (_yieldAssetWeights.length() > MAX_YIELD_ASSETS - 1) revert MaxYieldAssetsReached(MAX_YIELD_ASSETS);

        _yieldAssetWeights.set(token, 0); // Always starts inactive
        yieldAssetConfigs[token] =
            YieldAssetConfig({manager: manager, depositToken: depositToken, assetType: assetType});

        // Track OUSG token for efficient minimum checks
        if (assetType == AssetType.ONDO_OUSG) {
            ousgToken = token;
        }

        emit YieldAssetAdded(token, manager, 0);
    }

    /**
     * @notice Updates weights for ALL registered yield assets
     * @dev Array length MUST match number of registered assets.
     *      Sum of weights MUST equal BASIS_POINTS (10,000).
     *      Setting weight to 0 automatically drains all holdings from that asset.
     *      Two-step deactivation: updateWeights([..., 0, ...]) -> removeYieldAsset()
     * @param weights Ordered array of weights matching _yieldAssetWeights.keys() order
     */
    function updateWeights(uint256[] calldata weights) external onlyRole(MANAGER_ROLE) {
        address[] memory tokens = _yieldAssetWeights.keys();

        // Enforce: must provide weight for every registered asset
        if (weights.length != tokens.length) {
            revert LengthMismatch(weights.length, tokens.length);
        }

        uint256 total = 0;
        for (uint256 i = 0; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 oldWeight = _yieldAssetWeights.get(token);
            uint256 newWeight = weights[i];

            // Auto-drain: if weight goes from >0 to 0, liquidate all holdings
            if (oldWeight > 0 && newWeight == 0) {
                uint256 balance = IERC20(token).balanceOf(address(this));
                if (balance > 0) {
                    uint256 redeemed = _redeemFromSingleYieldAsset(token, type(uint256).max);
                    emit YieldAssetDrained(token, redeemed);
                }
            }

            _yieldAssetWeights.set(token, newWeight);
            total += newWeight;
            emit YieldAssetWeightUpdated(token, newWeight);
        }

        // Enforce: weights must sum to 100%
        if (total != BASIS_POINTS) revert InvalidTotalWeight(total);
    }

    /**
     * @notice Removes a yield asset from the registry
     * @dev Requires weight = 0 (via updateWeights) and balance = 0 (auto-drained by updateWeights)
     *      Two-step removal: updateWeights([..., 0, ...]) -> removeYieldAsset()
     * @param token Yield asset token address to remove
     */
    function removeYieldAsset(address token) external onlyRole(MANAGER_ROLE) {
        if (!_yieldAssetWeights.contains(token)) revert AssetNotFound(token);

        uint256 weight = _yieldAssetWeights.get(token);
        if (weight != 0) revert AssetStillActive(token, weight);

        // Ensure no funds remain in this yield asset
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) revert FundsRemaining(balance);

        _yieldAssetWeights.remove(token);
        YieldAssetConfig memory config = yieldAssetConfigs[token];
        delete yieldAssetConfigs[token];

        // Clear OUSG token if this was OUSG
        if (config.assetType == AssetType.ONDO_OUSG) {
            ousgToken = address(0);
        }

        emit YieldAssetRemoved(token);
    }

    // ============ Sky Protocol ============

    /**
     * @inheritdoc IYieldRouter
     */
    function setSkyConfig(address litePSM, address _usds, address sUsds) external override onlyRole(MANAGER_ROLE) {
        if (litePSM == address(0)) revert ZeroAddress();
        if (_usds == address(0)) revert ZeroAddress();
        if (sUsds == address(0)) revert ZeroAddress();

        skyConfig = SkyConfig({litePSM: litePSM, usds: _usds, sUsds: sUsds});

        emit SkyConfigUpdated(litePSM, _usds, sUsds);
    }

    // ============ Chainlink Automation ============

    /**
     * @notice Perform upkeep (called by Chainlink Automation)
     * @dev Optimized netting: Instead of deposit + withdraw, we net the amounts:
     *      - If pendingDeposits > yieldToHarvest: Only deposit the difference
     *      - If yieldToHarvest > pendingDeposits: Only withdraw the difference
     *      This saves gas by avoiding unnecessary deposit/withdraw pairs
     */
    function performUpkeep(bytes calldata /* performData */ ) external override nonReentrant whenNotPaused {
        if (yieldAccrualInterval == 0) revert UpkeepNotNeeded();

        uint256 timeSinceLastAccrual = block.timestamp - lastYieldAccrualTimestamp;
        if (timeSinceLastAccrual < yieldAccrualInterval) {
            revert UpkeepNotNeeded();
        }

        lastYieldAccrualTimestamp = block.timestamp;

        // Cache values
        uint256 pending = pendingDeposits;
        uint256 currentDeposited = totalDepositedAssets;

        if (currentDeposited == 0 && pending == 0) return;

        IUSDL usdl = IUSDL(vault);

        // Calculate yield: (protocol value) - (what we deployed to protocols)
        // trackedUSDCBalance includes pending deposits (not yet in protocols)
        // So deployed = trackedUSDCBalance - pending
        uint256 actualProtocolValue = _calculateTrackedValue();
        uint256 deployedToProtocols = trackedUSDCBalance - pending;

        // Yield = how much more protocols are worth than what we put in
        // Note: actualProtocolValue includes trackedUSDCBalance which has pending
        // So actual yield from protocols = (actualProtocolValue - pending) - deployedToProtocols
        uint256 yieldAccrued = 0;
        uint256 protocolValueOnly = actualProtocolValue - pending; // Exclude pending USDC from value
        if (protocolValueOnly > deployedToProtocols) {
            yieldAccrued = protocolValueOnly - deployedToProtocols;
        }

        // Clear pending deposits
        if (pending > 0) {
            pendingDeposits = 0;
            emit PendingDepositsAllocated(pending);
        }

        // === NETTING LOGIC ===
        // pending = USDC sitting idle that should go to protocols
        // yieldAccrued = value we need to pull from protocols to USDC
        // Instead of: allocate(pending) + harvest(yield), we net them

        if (pending > yieldAccrued) {
            // More deposits than yield: only deposit the net amount
            // yieldAccrued worth of USDC stays idle (as harvested yield)
            // Remaining goes to protocols
            uint256 netDeposit = pending - yieldAccrued;
            _allocateToYieldAssets(netDeposit);
            // trackedUSDCBalance stays correct: we had pending, we allocated netDeposit
            // so yieldAccrued stays as USDC which will be tracked
        } else if (yieldAccrued > pending) {
            // More yield than deposits: only withdraw the net amount
            // pending is used to offset some yield (stays as USDC)
            // Only withdraw what's still needed
            uint256 netWithdraw = yieldAccrued - pending;
            _harvestYield(netWithdraw);
        }
        // If equal: nothing to move! Pending USDC = yield to harvest, perfect offset

        // Update USDL state if there was yield
        if (yieldAccrued > 0 && currentDeposited > 0) {
            // Recalculate actual value after netting operations
            uint256 newTotalValue = _calculateTrackedValue();

            uint256 currentIndex = usdl.rebaseIndex();
            uint256 newIndex = (currentIndex * newTotalValue) / currentDeposited;

            usdl.updateRebaseIndex(newIndex);
            usdl.updateTotalDepositedAssets(newTotalValue);

            emit YieldAccrued(yieldAccrued, newTotalValue);
        } else if (pending > 0 && yieldAccrued == 0) {
            // No yield, but we had pending deposits - just update total assets
            usdl.updateTotalDepositedAssets(_calculateTrackedValue());
        }
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function emergencyWithdraw() external override onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant whenPaused {
        // Cache storage reads
        address _usdc = usdc;
        address _vault = vault;

        // Redeem all from protocols
        address[] memory tokens = _yieldAssetWeights.keys();
        uint256 length = tokens.length;

        for (uint256 i = 0; i < length; ++i) {
            address token = tokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                _redeemFromSingleYieldAsset(token, type(uint256).max);
            }
        }

        // Transfer ALL USDC to vault (not just tracked, since redeems added to balance)
        uint256 usdcBalance = IERC20(_usdc).balanceOf(address(this));
        if (usdcBalance > 0) {
            trackedUSDCBalance = 0;
            IERC20(_usdc).safeTransfer(_vault, usdcBalance);
            emit EmergencyWithdrawal(_vault, usdcBalance);
        }
    }

    /**
     * @notice Pauses the contract
     * @dev Only callable by MANAGER_ROLE
     */
    function pause() external onlyRole(MANAGER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract
     * @dev Only callable by MANAGER_ROLE
     */
    function unpause() external onlyRole(MANAGER_ROLE) {
        _unpause();
    }

    /**
     * @notice Rescue USDC tokens sent directly to this contract (donations)
     * @param to Address to receive rescued tokens
     * @dev Only rescues tokens above tracked balance (excess/donated tokens)
     */
    function rescueDonatedTokens(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();

        // Cache usdc storage read
        address _usdc = usdc;
        uint256 actualBalance = IERC20(_usdc).balanceOf(address(this));
        uint256 tracked = trackedUSDCBalance;

        // Can only rescue excess tokens (donations)
        if (actualBalance > tracked) {
            uint256 excess = actualBalance - tracked;
            IERC20(_usdc).safeTransfer(to, excess);
            emit DonatedTokensRescued(to, excess);
        }
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function setVault(address _vault) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_vault == address(0)) revert ZeroAddress();

        address oldVault = vault;

        // Revoke old vault's role
        if (oldVault != address(0)) {
            _revokeRole(VAULT_ROLE, oldVault);
        }

        vault = _vault;
        _grantRole(VAULT_ROLE, _vault);

        emit VaultUpdated(oldVault, _vault);
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function accrueYield() external override onlyRole(MANAGER_ROLE) returns (uint256 yieldAccrued) {
        yieldAccrued = _accrueYield();
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function setYieldAccrualInterval(uint256 interval) external override onlyRole(MANAGER_ROLE) {
        if (interval != 0 && interval < MIN_AUTOMATION_INTERVAL) {
            revert AutomationIntervalTooShort(interval, MIN_AUTOMATION_INTERVAL);
        }

        uint256 oldInterval = yieldAccrualInterval;
        yieldAccrualInterval = interval;

        emit YieldAccrualIntervalUpdated(oldInterval, interval);
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getTotalValue() external view override returns (uint256 value) {
        // Reuse internal function to avoid code duplication
        value = _calculateTrackedValue();
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getYieldAssetConfig(address token) external view override returns (YieldAssetConfig memory config) {
        return yieldAssetConfigs[token];
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getYieldAssetWeight(address token) external view override returns (uint256 weight) {
        if (!_yieldAssetWeights.contains(token)) return 0;
        return _yieldAssetWeights.get(token);
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getAllYieldAssets() external view override returns (address[] memory tokens, uint256[] memory weights) {
        tokens = _yieldAssetWeights.keys();
        weights = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            weights[i] = _yieldAssetWeights.get(tokens[i]);
        }
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getYieldAssetCount() external view override returns (uint256 count) {
        return _yieldAssetWeights.length();
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getSkyConfig() external view override returns (address litePSM, address _usds, address sUsds) {
        SkyConfig memory config = skyConfig;
        return (config.litePSM, config.usds, config.sUsds);
    }

    /**
     * @notice Check if upkeep is needed (Chainlink Automation)
     * @dev Triggers when:
     *      1. Time interval passed AND (pending deposits OR yield to accrue)
     *      2. No external calls needed - all data is internal
     * @return upkeepNeeded True if upkeep is needed
     * @return performData Encoded pending deposits and yield info
     */
    function checkUpkeep(bytes calldata /* checkData */ )
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        if (yieldAccrualInterval == 0) return (false, "");

        uint256 timeSinceLastAccrual = block.timestamp - lastYieldAccrualTimestamp;
        if (timeSinceLastAccrual < yieldAccrualInterval) {
            return (false, "");
        }

        // Check if there are pending deposits to allocate
        uint256 pending = pendingDeposits;

        // Calculate actual value using internal accounting (excludes donations)
        uint256 actualValue = _calculateTrackedValue();

        // Calculate expected value (tracked USDC that should be in protocols)
        // This is trackedUSDCBalance - pendingDeposits (pending is not yet in protocols)
        uint256 deployedValue = trackedUSDCBalance - pending;

        // Yield = actualValue - deployedValue (excluding pending)
        bool hasYield = actualValue > deployedValue + pending;
        bool hasPending = pending > 0;

        if (hasYield || hasPending) {
            upkeepNeeded = true;
            performData = abi.encode(pending, hasYield);
        }
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getLastYieldAccrualTimestamp() external view override returns (uint256 timestamp) {
        return lastYieldAccrualTimestamp;
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getYieldAccrualInterval() external view override returns (uint256 interval) {
        return yieldAccrualInterval;
    }

    // ============ Admin Functions ============

    /**
     * @inheritdoc IYieldRouter
     */
    function getVault() external view override returns (address) {
        return vault;
    }

    // ============ Internal Functions ============

    /**
     * @notice Allocate USDC to yield assets by weight
     * @param amount Amount of USDC to allocate
     */
    function _allocateToYieldAssets(uint256 amount) internal {
        uint256 length = _yieldAssetWeights.length();
        if (length == 0) return;

        (address[] memory tokens, uint256[] memory weights, uint256 lastActiveIndex) = _loadAssetWeights(length);

        // If no active assets, USDC stays idle
        if (lastActiveIndex == type(uint256).max) return;

        // Check OUSG minimum requirements
        if (!_checkOUSGMinimum(amount)) return;

        // Deposit to protocols
        uint256 allocated = _performDeposits(tokens, weights, lastActiveIndex, amount);

        // Update storage
        if (allocated > 0) {
            trackedUSDCBalance -= allocated;
        }
    }

    /**
     * @notice Deposit USDC to a specific yield protocol
     * @param token Yield asset token address
     * @param config Yield asset configuration
     * @param amount Amount of USDC to deposit
     */
    function _depositToProtocol(address token, YieldAssetConfig storage config, uint256 amount) internal {
        if (config.assetType == AssetType.ONDO_OUSG) {
            _depositOUSG(config.manager, config.depositToken, amount);
        } else if (config.assetType == AssetType.AAVE_V3) {
            _depositAaveV3(config.manager, config.depositToken, amount);
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            _depositSky(config.depositToken, amount);
        } else {
            _depositERC4626(config.manager, config.depositToken, amount);
        }
        emit ProtocolDeposited(token, amount);
    }

    /**
     * @notice Redeem USDC from yield assets by weight (using withdraw flow)
     * @param amount Target amount of USDC to redeem
     */
    function _withdrawFromYieldAssets(uint256 amount) internal {
        address[] memory tokens = _yieldAssetWeights.keys();
        uint256 length = tokens.length;
        uint256 remaining = amount;

        // Cache storage reads
        address _usdc = usdc;
        uint256 tracked = trackedUSDCBalance;

        // Cache weights in memory
        uint256[] memory weights = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            weights[i] = _yieldAssetWeights.get(tokens[i]);
        }

        // PRE-CHECK: Verify OUSG redemption meets minimum if OUSG is active
        // If OUSG redemption would be below minimum, skip entire rebalancing to maintain weight averages
        address _ousgToken = ousgToken;
        if (_ousgToken != address(0) && _yieldAssetWeights.contains(_ousgToken)) {
            uint256 ousgWeight = _yieldAssetWeights.get(_ousgToken);
            if (ousgWeight > 0) {
                uint256 ousgRedemption = (amount * ousgWeight) / BASIS_POINTS;
                if (ousgRedemption > 0 && ousgRedemption < ONDO_MIN_AMOUNT) {
                    // OUSG redemption below minimum - skip entire rebalancing
                    // No redemptions occur, tracked balance unchanged
                    return;
                }
            }
        }

        // All redemptions meet minimums - proceed with withdrawals
        for (uint256 i = 0; i < length && remaining > 0; ++i) {
            uint256 weight = weights[i];
            if (weight == 0) continue;

            uint256 redeemTarget = (amount * weight) / BASIS_POINTS;
            if (redeemTarget > remaining) redeemTarget = remaining;

            if (redeemTarget > 0) {
                address token = tokens[i];
                YieldAssetConfig storage config = yieldAssetConfigs[token];
                address manager = config.manager;

                uint256 usdcBefore = IERC20(_usdc).balanceOf(address(this));
                _withdrawSingleAsset(token, redeemTarget, config, manager);

                uint256 actualRedeemed = IERC20(_usdc).balanceOf(address(this)) - usdcBefore;
                // Track the redeemed USDC
                if (actualRedeemed > 0) {
                    tracked += actualRedeemed;
                    remaining = remaining > actualRedeemed ? remaining - actualRedeemed : 0;
                }
            }
        }

        // Write tracked balance once at the end
        trackedUSDCBalance = tracked;
    }

    /**
     * @notice Redeem USDC from a single yield asset
     * @param token Yield token address
     * @param amount Target amount of USDC to redeem (or type(uint256).max to redeem all shares)
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemFromSingleYieldAsset(address token, uint256 amount) internal returns (uint256 redeemed) {
        YieldAssetConfig storage config = yieldAssetConfigs[token];
        uint256 balance = IERC20(token).balanceOf(address(this));

        if (balance == 0) return 0;

        // Cache usdc storage read
        address _usdc = usdc;
        uint256 usdcBefore = IERC20(_usdc).balanceOf(address(this));

        // If amount is max, redeem all shares; otherwise redeem target amount
        if (amount == type(uint256).max) {
            _redeemAllShares(token, balance, config, config.manager);
        } else {
            _redeemSingleAsset(token, amount, config, config.manager);
        }

        redeemed = IERC20(_usdc).balanceOf(address(this)) - usdcBefore;
    }

    /**
     * @notice Deposit USDC to Ondo OUSG
     * @param manager InstantManager contract address
     * @param depositToken Token to deposit (USDC)
     * @param amount Amount of USDC to deposit
     */
    function _depositOUSG(address manager, address depositToken, uint256 amount) internal {
        if (amount < ONDO_MIN_AMOUNT) return;
        IERC20(depositToken).forceApprove(manager, amount);
        IOUSGInstantManager(manager).subscribe(depositToken, amount, 0);
    }

    /**
     * @notice Deposit to Aave V3
     * @param manager Aave V3 pool address
     * @param depositToken Token to deposit (USDC)
     * @param amount Amount to deposit
     */
    function _depositAaveV3(address manager, address depositToken, uint256 amount) internal {
        IERC20(depositToken).forceApprove(manager, amount);
        IAaveV3Pool(manager).supply(depositToken, amount, address(this), 0);
    }

    /**
     * @notice Deposit to Sky sUSDS
     * @param depositToken Token to deposit (USDC)
     * @param amount Amount to deposit
     */
    function _depositSky(address depositToken, uint256 amount) internal {
        SkyConfig memory sky = skyConfig;
        // Step 1: USDC -> USDS via LitePSM
        IERC20(depositToken).forceApprove(sky.litePSM, amount);
        uint256 usdsReceived = ILitePSMWrapper(sky.litePSM).sellGem(address(this), amount);
        require(usdsReceived == amount * 1e12, "Sky PSM deposit failed");
        // Step 2: USDS -> sUSDS via ERC4626 deposit
        IERC20(sky.usds).forceApprove(sky.sUsds, usdsReceived);
        IERC4626(sky.sUsds).deposit(usdsReceived, address(this));
    }

    /**
     * @notice Deposit to ERC4626 vault
     * @param manager Vault address
     * @param depositToken Token to deposit
     * @param amount Amount to deposit
     */
    function _depositERC4626(address manager, address depositToken, uint256 amount) internal {
        IERC20(depositToken).forceApprove(manager, amount);
        IERC4626(manager).deposit(amount, address(this));
    }

    /**
     * @notice Redeem from a single asset (used in loops)
     * @param token Yield token address
     * @param redeemTarget Target amount to redeem
     * @param config Asset configuration
     * @param manager Manager contract address
     */
    function _redeemSingleAsset(address token, uint256 redeemTarget, YieldAssetConfig storage config, address manager)
        internal
    {
        uint256 received;
        if (config.assetType == AssetType.ONDO_OUSG) {
            (received,) = _redeemOUSG(token, redeemTarget, manager, config.depositToken);
        } else if (config.assetType == AssetType.AAVE_V3) {
            received = _redeemAaveV3(token, redeemTarget, manager, config.depositToken);
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            received = _redeemSky(redeemTarget);
        } else {
            received = _redeemERC4626(redeemTarget, manager);
        }
        emit ProtocolRedeemed(token, redeemTarget, received);
    }

    /**
     * @notice Withdraw from a single asset (used in loops)
     * @param token Yield token address
     * @param withdrawTarget Target amount to withdraw
     * @param config Asset configuration
     * @param manager Manager contract address
     */
    function _withdrawSingleAsset(
        address token,
        uint256 withdrawTarget,
        YieldAssetConfig storage config,
        address manager
    ) internal {
        uint256 sharesUsed;
        if (config.assetType == AssetType.ONDO_OUSG) {
            (, sharesUsed) = _redeemOUSG(token, withdrawTarget, manager, config.depositToken);
        } else if (config.assetType == AssetType.AAVE_V3) {
            sharesUsed = _withdrawAaveV3(token, withdrawTarget, manager, config.depositToken);
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            sharesUsed = _withdrawSky(withdrawTarget);
        } else {
            sharesUsed = _withdrawERC4626(withdrawTarget, manager);
        }
        emit ProtocolWithdrawn(token, withdrawTarget, sharesUsed);
    }

    /**
     * @notice Redeem OUSG tokens for USDC
     * @param token OUSG token address
     * @param usdcTarget Target USDC amount to receive
     * @param manager InstantManager contract address
     * @param depositToken Token used to acquire OUSG (USDC)
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemOUSG(address token, uint256 usdcTarget, address manager, address depositToken)
        internal
        returns (uint256 redeemed, uint256 ousgRedeemed)
    {
        if (usdcTarget < ONDO_MIN_AMOUNT) return (0, 0);

        uint256 usdcBefore = IERC20(depositToken).balanceOf(address(this));

        // Get OUSG oracle price to convert USDC target to OUSG amount
        IOUSGInstantManager instantManager = IOUSGInstantManager(manager);
        IOndoOracle oracle = IOndoOracle(instantManager.ondoOracle());
        uint256 price = oracle.getAssetPrice(token);

        // Convert USDC (6 decimals) to OUSG tokens (18 decimals)
        // OUSG value = balance * price / 1e30
        // So: OUSG balance = USDC value * 1e30 / price
        uint256 ousgAmount = (usdcTarget * 1e30) / price;

        // Cap at available balance
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (ousgAmount > balance) ousgAmount = balance;

        IERC20(token).forceApprove(manager, ousgAmount);
        IOUSGInstantManager(manager).redeem(ousgAmount, depositToken, 0);

        redeemed = IERC20(depositToken).balanceOf(address(this)) - usdcBefore;
        ousgRedeemed = ousgAmount;
    }

    /**
     * @notice Redeem aTokens from Aave V3 for USDC
     * @param token aToken address
     * @param redeemTarget Target USDC amount to receive
     * @param manager Aave V3 pool address
     * @param depositToken Underlying token (USDC)
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemAaveV3(address token, uint256 redeemTarget, address manager, address depositToken)
        internal
        returns (uint256 redeemed)
    {
        uint256 usdcBefore = IERC20(depositToken).balanceOf(address(this));
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = redeemTarget > balance ? balance : redeemTarget;
        if (withdrawAmount > 0) {
            IAaveV3Pool(manager).withdraw(depositToken, withdrawAmount, address(this));
        }
        redeemed = IERC20(depositToken).balanceOf(address(this)) - usdcBefore;
    }

    /**
     * @notice Withdraw USDC from Aave V3 (direct asset-based withdrawal)
     * @param token aToken address
     * @param withdrawTarget Target USDC amount to receive
     * @param manager Aave V3 pool address
     * @param depositToken Underlying token (USDC)
     */
    function _withdrawAaveV3(address token, uint256 withdrawTarget, address manager, address depositToken)
        internal
        returns (uint256 withdrawn)
    {
        uint256 maxWithdraw = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = withdrawTarget > maxWithdraw ? maxWithdraw : withdrawTarget;
        if (withdrawAmount > 0) {
            IAaveV3Pool(manager).withdraw(depositToken, withdrawAmount, address(this));
            withdrawn = withdrawAmount;
        }
    }

    /**
     * @notice Redeem sUSDS shares for USDC
     * @param redeemTarget Target USDC amount to receive
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemSky(uint256 redeemTarget) internal returns (uint256 redeemed) {
        SkyConfig memory sky = skyConfig;
        // The contract has `usdc` state variable.
        uint256 usdcBalanceBefore = IERC20(usdc).balanceOf(address(this));

        IERC4626 sUsdsVault = IERC4626(sky.sUsds);
        uint256 usdsTarget = redeemTarget * 1e12;
        uint256 maxShares = sUsdsVault.maxRedeem(address(this));
        uint256 usdsRecieved;
        if (maxShares > 0) {
            // Convert target USDS assets to shares needed
            uint256 sharesToRedeem = sUsdsVault.convertToShares(usdsTarget);
            // Cap at max available shares
            if (sharesToRedeem > maxShares) {
                sharesToRedeem = maxShares;
            }
            if (sharesToRedeem > 0) {
                usdsRecieved = sUsdsVault.redeem(sharesToRedeem, address(this), address(this));
            }
        }
        // Convert USDS to USDC via LitePSM
        // uint256 usdsBalance = IERC20(sky.usds).balanceOf(address(this));
        uint256 usdcAmount = usdsRecieved / 1e12;
        if (usdcAmount > 0) {
            IERC20(sky.usds).forceApprove(sky.litePSM, usdsRecieved);
            ILitePSMWrapper(sky.litePSM).buyGem(address(this), usdcAmount);
        }

        redeemed = IERC20(usdc).balanceOf(address(this)) - usdcBalanceBefore;
    }

    /**
     * @notice Withdraw USDC from Sky sUSDS (direct asset-based withdrawal)
     * @param withdrawTarget Target USDC amount to receive
     */
    function _withdrawSky(uint256 withdrawTarget) internal returns (uint256 sharesUsed) {
        SkyConfig memory sky = skyConfig;
        IERC4626 sUsdsVault = IERC4626(sky.sUsds);
        uint256 usdsTarget = withdrawTarget * 1e12;
        uint256 maxWithdraw = sUsdsVault.maxWithdraw(address(this));
        uint256 usdsWithdrawn;
        if (maxWithdraw > 0) {
            usdsWithdrawn = usdsTarget > maxWithdraw ? maxWithdraw : usdsTarget;
            if (usdsWithdrawn > 0) {
                sharesUsed = sUsdsVault.withdraw(usdsWithdrawn, address(this), address(this));
            }
        }
        // Convert USDS to USDC via LitePSM
        uint256 usdcAmount = usdsWithdrawn / 1e12;
        if (usdcAmount > 0) {
            IERC20(sky.usds).forceApprove(sky.litePSM, usdsWithdrawn);
            uint256 usdsUsed = ILitePSMWrapper(sky.litePSM).buyGem(address(this), usdcAmount);
            require(usdsUsed == usdcAmount * 1e12, "Sky PSM withdraw failed");
        }
    }

    /**
     * @notice Redeem shares from ERC4626 vault for USDC
     * @param redeemTarget Target USDC amount to receive
     * @param manager Vault address
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemERC4626(uint256 redeemTarget, address manager) internal returns (uint256 redeemed) {
        // We assume the vault asset is USDC.
        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));

        IERC4626 vaultContract = IERC4626(manager);
        uint256 maxShares = vaultContract.maxRedeem(address(this));

        // Convert target assets to shares needed
        uint256 sharesToRedeem = vaultContract.convertToShares(redeemTarget);
        // Cap at max available shares
        sharesToRedeem = sharesToRedeem > maxShares ? maxShares : sharesToRedeem;

        if (sharesToRedeem > 0) {
            vaultContract.redeem(sharesToRedeem, address(this), address(this));
        }

        redeemed = IERC20(usdc).balanceOf(address(this)) - usdcBefore;
    }

    /**
     * @notice Withdraw assets from ERC4626 vault (direct asset-based withdrawal)
     * @param withdrawTarget Target USDC amount to receive
     * @param manager Vault address
     */
    function _withdrawERC4626(uint256 withdrawTarget, address manager) internal returns (uint256 shares) {
        IERC4626 vaultContract = IERC4626(manager);
        uint256 maxWithdraw = vaultContract.maxWithdraw(address(this));

        uint256 withdrawAmount = withdrawTarget > maxWithdraw ? maxWithdraw : withdrawTarget;
        if (withdrawAmount > 0) {
            shares = vaultContract.withdraw(withdrawAmount, address(this), address(this));
        }
    }

    /**
     * @notice Redeem all shares from a single asset (for auto-drain)
     * @param token Yield token address
     * @param balance Balance of yield tokens to redeem
     * @param config Asset configuration
     * @param manager Manager contract address
     */
    function _redeemAllShares(address token, uint256 balance, YieldAssetConfig storage config, address manager)
        internal
    {
        if (config.assetType == AssetType.ONDO_OUSG) {
            _redeemOUSG(token, balance, manager, config.depositToken);
        } else if (config.assetType == AssetType.AAVE_V3) {
            // Aave aTokens: withdraw all balance (aTokens are 1:1 with underlying)
            IAaveV3Pool(manager).withdraw(config.depositToken, balance, address(this));
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            // Sky sUSDS: redeem all shares
            SkyConfig memory sky = skyConfig;
            IERC4626 sUsdsVault = IERC4626(sky.sUsds);
            sUsdsVault.redeem(balance, address(this), address(this));
            // Convert all USDS to USDC
            uint256 usdsBalance = IERC20(sky.usds).balanceOf(address(this));
            if (usdsBalance > 0) {
                uint256 usdcAmount = usdsBalance / 1e12;
                if (usdcAmount > 0) {
                    IERC20(sky.usds).forceApprove(sky.litePSM, usdsBalance);
                    ILitePSMWrapper(sky.litePSM).buyGem(address(this), usdcAmount);
                }
            }
        } else {
            // ERC4626: redeem all shares
            IERC4626(manager).redeem(balance, address(this), address(this));
        }
    }

    /**
     * @notice Accrue yield and update USDL state
     * @return yieldAccrued Amount of yield accrued
     */
    function _accrueYield() internal returns (uint256 yieldAccrued) {
        uint256 currentDeposited = totalDepositedAssets;

        lastYieldAccrualTimestamp = block.timestamp;

        if (currentDeposited == 0) return 0;

        // Cache vault storage read
        IUSDL usdl = IUSDL(vault);

        uint256 currentIndex = usdl.rebaseIndex();

        // Calculate actual value using internal accounting (excludes donations)
        uint256 actualValue = _calculateTrackedValue();

        if (actualValue > currentDeposited) {
            yieldAccrued = actualValue - currentDeposited;

            // Harvest yield (pull USDC back from protocols)
            _harvestYield(yieldAccrued);

            // Recalculate after harvest using internal accounting
            actualValue = _calculateTrackedValue();

            // Calculate new rebase index
            uint256 newIndex = (currentIndex * actualValue) / currentDeposited;

            // Update USDL state
            usdl.updateRebaseIndex(newIndex);
            usdl.updateTotalDepositedAssets(actualValue);

            emit YieldAccrued(yieldAccrued, actualValue);
        }
    }

    /**
     * @notice Harvest yield from protocols
     * @param amount Amount of yield to harvest
     */
    function _harvestYield(uint256 amount) internal {
        if (amount == 0) return;
        _withdrawFromYieldAssets(amount);
    }

    // ============ Upgrade Authorization ============

    /**
     * @notice Authorizes contract upgrades through the UUPS proxy pattern
     * @dev Internal function called by the UUPS upgrade mechanism to verify
     *      that the caller has permission to upgrade the contract implementation.
     *      Increments version number for tracking and emits Upgrade event.
     * @param newImplementation Address of the new implementation contract
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {
        if (newImplementation == address(0)) revert ZeroAddress();
        ++version;
        emit Upgrade(msg.sender, newImplementation);
    }

    /**
     * @notice Perform deposits to all active protocols
     * @param tokens Array of token addresses
     * @param weights Array of weights
     * @param lastActiveIndex Index of last active asset
     * @param amount Total amount to allocate
     * @return allocated Total amount allocated
     */
    function _performDeposits(
        address[] memory tokens,
        uint256[] memory weights,
        uint256 lastActiveIndex,
        uint256 amount
    ) internal returns (uint256 allocated) {
        uint256 length = tokens.length;
        for (uint256 i = 0; i < length; ++i) {
            uint256 weight = weights[i];
            if (weight == 0) continue;

            uint256 allocation;
            if (i == lastActiveIndex) {
                allocation = amount - allocated;
            } else {
                allocation = (amount * weight) / BASIS_POINTS;
            }

            if (allocation > 0) {
                _depositToProtocol(tokens[i], yieldAssetConfigs[tokens[i]], allocation);
                allocated += allocation;
            }
        }
    }

    /**
     * @notice Check if OUSG allocation meets minimum requirements
     * @param amount Amount to allocate
     * @return valid True if OUSG minimum is met or not applicable
     */
    function _checkOUSGMinimum(uint256 amount) internal view returns (bool valid) {
        address _ousgToken = ousgToken;
        if (_ousgToken == address(0) || !_yieldAssetWeights.contains(_ousgToken)) {
            return true;
        }

        uint256 ousgWeight = _yieldAssetWeights.get(_ousgToken);
        if (ousgWeight == 0) return true;

        uint256 ousgAllocation = (amount * ousgWeight) / BASIS_POINTS;
        if (ousgAllocation > 0 && ousgAllocation < ONDO_MIN_AMOUNT) {
            return false;
        }
        return true;
    }

    /**
     * @notice Get value of a specific protocol position
     * @param token Yield token address
     * @param config Yield asset configuration
     * @return value Value in USDC (6 decimals)
     */
    function _getProtocolValue(address token, YieldAssetConfig storage config) internal view returns (uint256 value) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return 0;

        if (config.assetType == AssetType.ONDO_OUSG) {
            // OUSG: Get oracle from InstantManager, then query price
            // config.manager is the InstantManager, which has ondoOracle() getter
            IOUSGInstantManager instantManager = IOUSGInstantManager(config.manager);
            IOndoOracle oracle = IOndoOracle(instantManager.ondoOracle());

            // Get OUSG token address from InstantManager
            address ousgTokenAddr = instantManager.rwaToken();

            // Get price (18 decimals)
            uint256 price = oracle.getAssetPrice(ousgTokenAddr);

            // Validate price is positive
            if (price == 0) revert InvalidOraclePrice();

            // OUSG has 18 decimals, oracle price has 18 decimals
            // Example: OUSG balance = 100e18, price = 113.47e18 (=$113.47)
            // value = 100e18 * 113.47e18 / 1e18 / 1e12 = 11347e6 USDC
            // Formula: balance * price / 1e18 / 1e12 = balance * price / 1e30
            value = (balance * price) / 1e30;
        } else if (config.assetType == AssetType.AAVE_V3) {
            // aToken is 1:1 with underlying
            value = balance;
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            // sUSDS: Convert shares to USDS value, then scale to USDC
            uint256 usdsValue = IERC4626(skyConfig.sUsds).convertToAssets(balance);
            value = usdsValue / 1e12; // Scale 18 to 6 decimals
        } else {
            // ERC4626: Convert shares to assets
            value = IERC4626(config.manager).convertToAssets(balance);
        }
    }

    /**
     * @notice Calculate actual value using internal accounting (excludes donations)
     * @return total Total value excluding donated USDC
     */
    function _calculateTrackedValue() internal view returns (uint256 total) {
        // Cache storage reads
        address[] memory tokens = _yieldAssetWeights.keys();
        uint256 length = tokens.length;

        // Cache weights to avoid repeated .get() calls
        for (uint256 i = 0; i < length; ++i) {
            address token = tokens[i];
            // Only check weight > 0, don't need to cache since single read per token
            if (_yieldAssetWeights.get(token) > 0) {
                total += _getProtocolValue(token, yieldAssetConfigs[token]);
            }
        }

        // Add only tracked USDC (excludes donations)
        // trackedUSDCBalance only increases through:
        // 1. depositToProtocols (when USDC comes from USDL)
        // 2. _redeemFromYieldAssets (when we redeem from protocols)
        total += trackedUSDCBalance;
    }

    /**
     * @notice Load asset weights and find last active index
     * @param length Number of yield assets
     * @return tokens Array of token addresses
     * @return weights Array of weights
     * @return lastActiveIndex Index of last active asset
     */
    function _loadAssetWeights(uint256 length)
        internal
        view
        returns (address[] memory tokens, uint256[] memory weights, uint256 lastActiveIndex)
    {
        tokens = new address[](length);
        weights = new uint256[](length);
        lastActiveIndex = type(uint256).max;

        for (uint256 i = 0; i < length; ++i) {
            (tokens[i], weights[i]) = _yieldAssetWeights.at(i);
            if (weights[i] > 0) {
                lastActiveIndex = i;
            }
        }
    }

    function _onlyVault() internal view {
        if (msg.sender != vault) revert OnlyVault(msg.sender);
    }
}
