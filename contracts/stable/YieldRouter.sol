// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
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
    IRWAOracle,
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

    /// @notice Maximum oracle staleness (1 hour)
    uint256 public constant MAX_ORACLE_STALENESS = 1 hours;

    /// @notice Minimum interval allowed for automated yield accrual (1 hour)
    uint256 public constant MIN_AUTOMATION_INTERVAL = 1 hours;

    /// @notice Precision for rebase index (1e6 for 6 decimal token)
    uint256 public constant REBASE_INDEX_PRECISION = 1e6;

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

    /// @notice Storage gap for upgrades
    uint256[38] private __gap;

    // ============ Modifiers ============

    /// @notice Restricts function to VAULT_ROLE only
    modifier onlyVault() {
        if (!hasRole(VAULT_ROLE, msg.sender)) {
            revert IYieldRouter.InsufficientLiquidity(0, 0);
        }
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
    function depositToProtocols(uint256 amount) external override nonReentrant onlyVault {
        if (amount == 0) revert ZeroAmount();

        // Track incoming USDC (internal accounting for inflation attack protection)
        trackedUSDCBalance += amount;

        // Track as pending - will be allocated to protocols during performUpkeep
        pendingDeposits += amount;

        emit DepositedToProtocols(amount);
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function redeemFromProtocols(uint256 amount) external override nonReentrant onlyVault returns (uint256 redeemed) {
        if (amount == 0) revert ZeroAmount();

        // Cache storage reads
        uint256 tracked = trackedUSDCBalance;

        // If we don't have enough tracked USDC, redeem from yield assets
        if (tracked < amount) {
            uint256 needed = amount - tracked;
            _redeemFromYieldAssets(needed);
            // Re-read after redemption (state changed)
            tracked = trackedUSDCBalance;
        }

        // Calculate redeemed based on tracked balance
        redeemed = tracked > amount ? amount : tracked;

        // Update tracked balance and transfer
        if (redeemed > 0) {
            trackedUSDCBalance = tracked - redeemed;
            IERC20(usdc).safeTransfer(vault, redeemed);
        }

        emit RedeemedFromProtocols(amount, redeemed);
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function getTotalValue() external view override returns (uint256 value) {
        // Reuse internal function to avoid code duplication
        value = _calculateTrackedValue();
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
    function addYieldAsset(
        address token,
        address depositToken,
        address manager,
        AssetType assetType
    ) external onlyRole(MANAGER_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (depositToken == address(0)) revert ZeroAddress();
        if (manager == address(0)) revert ZeroAddress();
        if (_yieldAssetWeights.contains(token)) revert AssetAlreadyExists(token);
        if (_yieldAssetWeights.length() > MAX_YIELD_ASSETS - 1) revert MaxYieldAssetsReached(MAX_YIELD_ASSETS);

        _yieldAssetWeights.set(token, 0); // Always starts inactive
        yieldAssetConfigs[token] = YieldAssetConfig({
            manager: manager,
            depositToken: depositToken,
            assetType: assetType
        });

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
                    YieldAssetConfig storage config = yieldAssetConfigs[token];
                    if (config.assetType == AssetType.ONDO_OUSG) {
                        // Skip drain if below minimum to avoid blocking weight updates
                        // Manager must manually drain OUSG positions below minimum
                        try this.redeemFromSingleYieldAssetExternal(token, balance) returns (uint256 redeemed) {
                            emit YieldAssetDrained(token, redeemed);
                        } catch {
                            // Log event but don't revert the weight update
                            emit YieldAssetDrained(token, 0);
                        }
                    } else {
                        uint256 redeemed = _redeemFromSingleYieldAsset(token, balance);
                        emit YieldAssetDrained(token, redeemed);
                    }
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
     * @notice External wrapper for _redeemFromSingleYieldAsset to allow try/catch
     * @dev Only callable by this contract itself
     * @param token Yield asset token
     * @param amount Amount to redeem
     * @return redeemed Amount of USDC received
     */
    function redeemFromSingleYieldAssetExternal(address token, uint256 amount) external returns (uint256 redeemed) {
        if (msg.sender != address(this)) revert OnlySelf();
        return _redeemFromSingleYieldAsset(token, amount);
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
        delete yieldAssetConfigs[token];

        emit YieldAssetRemoved(token);
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

    /**
     * @inheritdoc IYieldRouter
     */
    function getSkyConfig() external view override returns (address litePSM, address _usds, address sUsds) {
        SkyConfig memory config = skyConfig;
        return (config.litePSM, config.usds, config.sUsds);
    }

    // ============ Chainlink Automation ============

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
     * @notice Perform upkeep (called by Chainlink Automation)
     * @dev Optimized netting: Instead of deposit + withdraw, we net the amounts:
     *      - If pendingDeposits > yieldToHarvest: Only deposit the difference
     *      - If yieldToHarvest > pendingDeposits: Only withdraw the difference
     *      This saves gas by avoiding unnecessary deposit/withdraw pairs
     */
    function performUpkeep(bytes calldata /* performData */ ) external override nonReentrant {
        if (yieldAccrualInterval == 0) revert UpkeepNotNeeded();

        uint256 timeSinceLastAccrual = block.timestamp - lastYieldAccrualTimestamp;
        if (timeSinceLastAccrual < yieldAccrualInterval) {
            revert UpkeepNotNeeded();
        }

        lastYieldAccrualTimestamp = block.timestamp;

        // Cache values
        uint256 pending = pendingDeposits;
        IUSDL usdl = IUSDL(vault);
        uint256 currentDeposited = usdl.totalDepositedAssets();

        if (currentDeposited == 0 && pending == 0) return;

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
    function getVault() external view override returns (address) {
        return vault;
    }

    /**
     * @inheritdoc IYieldRouter
     */
    function emergencyWithdraw() external override onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
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
        }
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

    // ============ Internal Functions ============

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
     * @notice Validate that active weights sum to BASIS_POINTS
     */
    function _validateWeightSum() internal view {
        address[] memory tokens = _yieldAssetWeights.keys();
        uint256 length = tokens.length;
        uint256 totalWeight = 0;

        for (uint256 i = 0; i < length; ++i) {
            totalWeight += _yieldAssetWeights.get(tokens[i]);
        }

        // Allow 0 total weight (no active assets) or exactly BASIS_POINTS
        if (totalWeight != 0 && totalWeight != BASIS_POINTS) {
            revert InvalidTotalWeight(totalWeight);
        }
    }

    /**
     * @notice Allocate USDC to yield assets by weight
     * @param amount Amount of USDC to allocate
     */
    function _allocateToYieldAssets(uint256 amount) internal {
        uint256 length = _yieldAssetWeights.length();
        if (length == 0) return;

        address[] memory tokens = new address[](length);
        uint256[] memory weights = new uint256[](length);
        uint256 lastActiveIndex = type(uint256).max;

        // Combine loading and finding last active index into one loop
        for (uint256 i = 0; i < length; ++i) {
            (tokens[i], weights[i]) = _yieldAssetWeights.at(i);
            if (weights[i] > 0) {
                lastActiveIndex = i;
            }
        }

        // If no active assets, USDC stays idle in this contract (tracked balance unchanged)
        if (lastActiveIndex == type(uint256).max) return;

        uint256 allocated = 0;

        for (uint256 i = 0; i < length; ++i) {
            uint256 weight = weights[i];
            if (weight == 0) continue;

            uint256 allocation;
            if (i == lastActiveIndex) {
                // Last active asset gets remainder
                allocation = amount - allocated;
            } else {
                allocation = (amount * weight) / BASIS_POINTS;
            }

            if (allocation > 0) {
                _depositToProtocol(yieldAssetConfigs[tokens[i]], allocation);
                allocated += allocation;
            }
        }

        // Update storage once at the end
        if (allocated > 0) {
            trackedUSDCBalance -= allocated;
        }
    }

    /**
     * @notice Deposit USDC to a specific yield protocol
     * @param config Yield asset configuration
     * @param amount Amount of USDC to deposit
     */
    function _depositToProtocol(YieldAssetConfig storage config, uint256 amount) internal {
        if (config.assetType == AssetType.ONDO_OUSG) {
            IERC20(config.depositToken).safeIncreaseAllowance(config.manager, amount);
            IOUSGInstantManager(config.manager).mint(amount);
        } else if (config.assetType == AssetType.AAVE_V3) {
            IERC20(config.depositToken).safeIncreaseAllowance(config.manager, amount);
            IAaveV3Pool(config.manager).supply(config.depositToken, amount, address(this), 0);
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            SkyConfig memory sky = skyConfig;

            // Step 1: USDC -> USDS via LitePSM
            IERC20(config.depositToken).safeIncreaseAllowance(sky.litePSM, amount);
            ILitePSMWrapper(sky.litePSM).sellGem(address(this), amount);

            // Step 2: USDS -> sUSDS via ERC4626 deposit
            uint256 usdsBalance = IERC20(sky.usds).balanceOf(address(this));
            IERC20(sky.usds).safeIncreaseAllowance(sky.sUsds, usdsBalance);
            IERC4626(sky.sUsds).deposit(usdsBalance, address(this));
        } else {
            // ERC4626: Standard vault deposit
            IERC20(config.depositToken).safeIncreaseAllowance(config.manager, amount);
            IERC4626(config.manager).deposit(amount, address(this));
        }
    }

    /**
     * @notice Redeem USDC from yield assets by weight
     * @param amount Target amount of USDC to redeem
     */
    function _redeemFromYieldAssets(uint256 amount) internal {
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

        for (uint256 i = 0; i < length && remaining > 0; ++i) {
            uint256 weight = weights[i];
            if (weight == 0) continue;

            uint256 redeemTarget = (amount * weight) / BASIS_POINTS;
            if (redeemTarget > remaining) redeemTarget = remaining;

            if (redeemTarget > 0) {
                uint256 usdcBefore = IERC20(_usdc).balanceOf(address(this));
                _redeemFromSingleYieldAsset(tokens[i], redeemTarget);
                uint256 actualRedeemed = IERC20(_usdc).balanceOf(address(this)) - usdcBefore;
                // Track the redeemed USDC
                tracked += actualRedeemed;
                remaining = remaining > actualRedeemed ? remaining - actualRedeemed : 0;
            }
        }

        // Write tracked balance once at the end
        trackedUSDCBalance = tracked;
    }

    /**
     * @notice Redeem USDC from a single yield asset
     * @param token Yield token address
     * @param amount Target amount of USDC to redeem
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemFromSingleYieldAsset(address token, uint256 amount) internal returns (uint256 redeemed) {
        YieldAssetConfig storage config = yieldAssetConfigs[token];
        uint256 balance = IERC20(token).balanceOf(address(this));

        if (balance == 0) return 0;

        // Cache usdc storage read
        address _usdc = usdc;
        uint256 usdcBefore = IERC20(_usdc).balanceOf(address(this));

        AssetType assetType = config.assetType;
        address manager = config.manager;

        if (assetType == AssetType.ONDO_OUSG) {
            // OUSG: Redeem entire balance (has minimum redemption requirements)
            IERC20(token).safeIncreaseAllowance(manager, balance);
            IOUSGInstantManager(manager).redeem(balance);
        } else if (assetType == AssetType.AAVE_V3) {
            // Aave V3: Withdraw from pool (aTokens are burned automatically)
            uint256 withdrawAmount = amount > balance ? balance : amount;
            IAaveV3Pool(manager).withdraw(config.depositToken, withdrawAmount, address(this));
        } else if (assetType == AssetType.SKY_SUSDS) {
            // Sky Protocol: sUSDS -> USDS (via redeem) -> USDC (via LitePSM buyGem)
            // Cache skyConfig storage read
            SkyConfig memory sky = skyConfig;
            IERC4626 sUsdsVault = IERC4626(sky.sUsds);

            // Step 1: Calculate shares to redeem for target USDC amount
            uint256 sharesToRedeem = sUsdsVault.convertToShares(amount * 1e12); // Scale 6 to 18 decimals
            if (sharesToRedeem == 0) sharesToRedeem = balance;
            if (sharesToRedeem > balance) sharesToRedeem = balance;

            // Step 2: Redeem sUSDS for USDS
            sUsdsVault.redeem(sharesToRedeem, address(this), address(this));

            // Step 3: Swap USDS for USDC via LitePSM
            uint256 usdsBalance = IERC20(sky.usds).balanceOf(address(this));
            uint256 usdcAmount = usdsBalance / 1e12; // Scale 18 to 6 decimals
            if (usdcAmount > 0) {
                IERC20(sky.usds).safeIncreaseAllowance(sky.litePSM, usdsBalance);
                ILitePSMWrapper(sky.litePSM).buyGem(address(this), usdcAmount);
            }
        } else {
            // ERC4626: Convert target amount to shares and redeem
            IERC4626 vaultContract = IERC4626(manager);
            uint256 sharesToRedeem = vaultContract.convertToShares(amount);
            if (sharesToRedeem == 0) sharesToRedeem = balance;
            if (sharesToRedeem > balance) sharesToRedeem = balance;
            vaultContract.redeem(sharesToRedeem, address(this), address(this));
        }

        redeemed = IERC20(_usdc).balanceOf(address(this)) - usdcBefore;
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
            // OUSG: Use RWA oracle for price (Chainlink-compatible, 8 decimals)
            // config.manager stores the oracle address for OUSG
            IRWAOracle oracle = IRWAOracle(config.manager);
            (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) = oracle.latestRoundData();

            // Validate price is positive
            if (price < 1) revert InvalidOraclePrice();

            // Validate oracle data is not stale
            if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) {
                revert StaleOraclePrice(updatedAt, MAX_ORACLE_STALENESS);
            }

            // Validate round is complete
            if (answeredInRound < roundId) {
                revert IncompleteOracleRound(roundId, answeredInRound);
            }

            // OUSG has 18 decimals, oracle price has 8 decimals (Chainlink standard)
            // Example: OUSG balance = 100e18, price = 113.47e8 (=$113.47)
            // value = 100e18 * 113.47e8 / 1e8 / 1e12 = 11347e6 USDC
            // Formula: balance * price / 1e8 / 1e12 = balance * price / 1e20
            value = (balance * uint256(price)) / 1e20;
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
     * @notice Accrue yield and update USDL state
     * @return yieldAccrued Amount of yield accrued
     */
    function _accrueYield() internal returns (uint256 yieldAccrued) {
        // Cache vault storage read
        IUSDL usdl = IUSDL(vault);
        uint256 currentDeposited = usdl.totalDepositedAssets();

        lastYieldAccrualTimestamp = block.timestamp;

        if (currentDeposited == 0) return 0;

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
        _redeemFromYieldAssets(amount);
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
}
