// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {IGetCCIPAdmin} from "../interfaces/IGetCCIPAdmin.sol";
import {IBurnMintERC20} from "../interfaces/IBurnMintERC20.sol";
import {AssetType, IOUSGInstantManager, IRWAOracle, IAaveV3Pool, ILitePSMWrapper, ISUsds} from "../interfaces/IYieldProtocols.sol";
import {AutomationCompatibleInterface} from "../interfaces/AutomationCompatibleInterface.sol";

/**
 * @title USDL - Yield-Bearing USD Vault (Version 3)
 * @author Lendefi Markets
 * @notice ERC-4626 vault that accepts USDC deposits and allocates to yield-bearing RWA assets
 * @dev Users deposit USDC, receive USDL shares. Share price increases as yield accrues from underlying protocols.
 *
 *      Example:
 *      - User deposits 1000 USDC at launch → gets 1000 USDL
 *      - After 1 year of 5% yield → 1000 USDL redeemable for 1050 USDC
 *
 *      Supported yield assets:
 *      - ERC-4626 vaults (sDAI, Morpho, etc.)
 *      - Aave V3 (aUSDC)
 *      - Ondo OUSG (requires whitelist)
 *
 *      Key mechanisms:
 *      - Internal Accounting: totalDepositedAssets tracks user deposits to prevent inflation
 *        attacks from bridge mints
 *      - Rebase Index: Increases with yield accrual, distributing gains proportionally while
 *        maintaining 1:1 USDC peg
 *      - Bridge Compatibility: CCIP burn-and-mint operations bypass internal accounting to
 *        avoid double-counting
 *
 *      Security features:
 *      - Blacklist for regulatory compliance
 *      - Emergency pause functionality
 *      - Role-based access control (DEFAULT_ADMIN, PAUSER, MANAGER, etc.)
 *      - Reentrancy protection on state-changing functions
 *      - UUPS upgradeable proxy pattern
 *
 *      Yield management:
 *      - Automated yield accrual via Chainlink Automation
 *      - Configurable allocation across multiple protocols
 *      - Waterfall redemption strategy for withdrawals
 *
 * @custom:security-contact security@lendefimarkets.com
 */
/// @custom:oz-upgrades
contract USDL is
    IERC165,
    IGetCCIPAdmin,
    IBurnMintERC20,
    IERC4626,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    AutomationCompatibleInterface
{
    using SafeERC20 for IERC20;
    using Math for uint256;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    // ============ Yield Asset Configuration ============

    /// @notice Yield asset configuration (weight stored separately in EnumerableMap)
    struct YieldAssetConfig {
        address manager; // Manager contract (vault, pool, oracle)
        address depositToken; // Token to deposit (USDC, DAI)
        AssetType assetType; // Protocol type for routing
        // NOTE: No 'active' field - weight > 0 means active, weight = 0 means inactive
    }

    /// @notice Sky protocol configuration for sUSDS yield strategy
    struct SkyConfig {
        address litePSM; // LitePSMWrapper for USDC <-> USDS conversion
        address usds; // USDS stablecoin address
        address sUsds; // sUSDS ERC-4626 vault address
    }

    // ============ Constants ============

    /// @notice Basis points divisor (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10_000;
    /// @notice Minimum deposit amount in USDC (1 USDC with 6 decimals)
    uint256 public constant MIN_DEPOSIT = 1e6;
    /// @notice Maximum redemption fee in basis points (5%)
    uint256 public constant MAX_FEE_BPS = 500;
    /// @notice Maximum number of yield assets to prevent gas issues
    uint256 public constant MAX_YIELD_ASSETS = 10;

    /// @notice Maximum oracle staleness (1 hour)
    uint256 public constant MAX_ORACLE_STALENESS = 1 hours;
    /// @notice Minimum OUSG price in USD (8 decimals) - $100
    int256 public constant MIN_OUSG_PRICE = 100e8;
    /// @notice Maximum OUSG price in USD (8 decimals) - $200
    int256 public constant MAX_OUSG_PRICE = 200e8;

    /// @notice Precision for rebase index (1e6 for 6 decimal token)
    uint256 public constant REBASE_INDEX_PRECISION = 1e6;

    /// @notice Minimum interval allowed for automated yield accrual (1 hour)
    uint256 public constant MIN_AUTOMATION_INTERVAL = 1 hours;

    /// @dev AccessControl Role Constants
    /// @notice Role for pausing contract operations
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Role for managing yield assets
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    /// @notice Role for CCIP bridge token pool
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    /// @notice Role for authorizing contract upgrades
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// @notice Role for blacklisting addresses
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");

    // ============ Storage Variables ============

    /// @notice Deployed version (increments on each upgrade)
    uint256 public version;

    /// @notice CCIP admin address for token admin registry
    address public ccipAdmin;

    /// @notice Blacklisted addresses (for compliance)
    mapping(address account => bool isBlacklisted) public blacklisted;

    /// @notice Treasury address for fees
    address public treasury;

    /// @notice Underlying asset address (USDC)
    address public assetAddress;

    /// @notice Redemption fee in basis points (e.g., 10 = 0.1%)
    uint256 public redemptionFeeBps;

    /// @notice Total assets deposited by users (internal accounting)
    /// @dev This tracks actual deposited liquidity, separate from totalSupply() which can be
    ///      inflated by bridge mints. Used for share price calculations to prevent inflation attacks.
    uint256 public totalDepositedAssets;

    /// @notice Maps yield asset token => weight in BPS (0 = inactive, sum must = 10000)
    EnumerableMap.AddressToUintMap internal yieldAssetWeights;

    /// @notice Yield asset configurations (non-weight data)
    mapping(address token => YieldAssetConfig config) public yieldAssetConfigs;

    /// @notice Minimum interval (seconds) between automated yield accruals (0 disables automation)
    uint256 public yieldAccrualInterval;

    /// @notice Timestamp of last yield accrual (manual or automated)
    uint256 public lastYieldAccrualTimestamp;

    /// @notice Rebase index for yield distribution (starts at 1e6, increases with yield)
    /// @dev balanceOf(user) = shares[user] * rebaseIndex / REBASE_INDEX_PRECISION
    ///      This maintains 1:1 USDC peg while distributing yield to all holders
    uint256 public rebaseIndex;

    // ============ ERC20 Storage (owned, not inherited) ============

    /// @notice Token name
    string private _name;

    /// @notice Token symbol
    string private _symbol;

    /// @notice Raw share balances (not rebased)
    mapping(address => uint256) private _shares;

    /// @notice Total raw shares (not rebased)
    uint256 private _totalShares;

    /// @notice Allowances (stored in REBASED units for UX consistency)
    mapping(address => mapping(address => uint256)) private _allowances;

    // ============ Sky Protocol Storage ============

    /// @notice Sky protocol configuration for sUSDS yield strategy
    /// @dev Addresses: litePSM, usds, sUsds for USDC -> USDS -> sUSDS flow
    SkyConfig public skyConfig;

    /// @notice Storage gap for future upgrades
    uint256[31] private __gap;

    // ============ Events ============

    /// @notice Emitted when CCIP admin is transferred
    /// @param previousAdmin Previous CCIP admin address
    /// @param newAdmin New CCIP admin address
    event CCIPAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    /// @notice Emitted when an address is blacklisted
    /// @param account Blacklisted address
    event Blacklisted(address indexed account);
    /// @notice Emitted when an address is removed from blacklist
    /// @param account Address removed from blacklist
    event UnBlacklisted(address indexed account);
    /// @notice Emitted when contract is upgraded
    /// @param sender Address initiating the upgrade
    /// @param implementation New implementation address
    event Upgrade(address indexed sender, address indexed implementation);
    /// @notice Emitted when a yield asset is added
    /// @param token Yield asset token address
    /// @param manager Manager contract address
    /// @param allocation Allocation in basis points (indexed for gas optimization)
    event YieldAssetAdded(address indexed token, address indexed manager, uint256 indexed allocation);
    /// @notice Emitted when yield asset weight is updated
    /// @param token Yield asset token address
    /// @param newWeight New weight in basis points (indexed for gas optimization)
    event YieldAssetWeightUpdated(address indexed token, uint256 indexed newWeight);
    /// @notice Emitted when a yield asset is removed
    /// @param token Yield asset token address
    event YieldAssetRemoved(address indexed token);
    /// @notice Emitted when a yield asset is drained (all holdings liquidated)
    /// @param token Yield asset token address
    /// @param amount Amount of USDC recovered
    event YieldAssetDrained(address indexed token, uint256 indexed amount);
    /// @notice Emitted when treasury address is updated
    /// @param oldTreasury Previous treasury address (indexed for gas optimization)
    /// @param newTreasury New treasury address (indexed for gas optimization)
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    /// @notice Emitted when redemption fee is updated
    /// @param oldFeeBps Previous fee in basis points (indexed for gas optimization)
    /// @param newFeeBps New fee in basis points (indexed for gas optimization)
    event RedemptionFeeUpdated(uint256 indexed oldFeeBps, uint256 indexed newFeeBps);
    /// @notice Emitted when tokens are emergency withdrawn
    /// @param token Token address (indexed for gas optimization)
    /// @param to Recipient address (indexed for gas optimization)
    /// @param amount Amount withdrawn (indexed for gas optimization)
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 indexed amount);
    /// @notice Emitted when internal accounting is updated
    /// @param oldAmount Previous tracked amount (indexed for gas optimization)
    /// @param newAmount New tracked amount (indexed for gas optimization)
    event InternalAccountingUpdated(uint256 indexed oldAmount, uint256 indexed newAmount);
    /// @notice Emitted when yield is accrued
    /// @param yieldAmount Amount of yield accrued (indexed for gas optimization)
    /// @param newTotalAssets New total assets after accrual (indexed for gas optimization)
    event YieldAccrued(uint256 indexed yieldAmount, uint256 indexed newTotalAssets);
    /// @notice Emitted when donated tokens are rescued
    /// @param to Recipient address (indexed for gas optimization)
    /// @param amount Amount rescued (indexed for gas optimization)
    event DonatedTokensRescued(address indexed to, uint256 indexed amount);
    /// @notice Emitted when yield accrual interval is updated
    /// @param oldInterval Previous interval in seconds (indexed for gas optimization)
    /// @param newInterval New interval in seconds (indexed for gas optimization)
    event YieldAccrualIntervalUpdated(uint256 indexed oldInterval, uint256 indexed newInterval);
    /// @notice Emitted when rebase index is updated
    /// @param oldIndex Previous rebase index (indexed for gas optimization)
    /// @param newIndex New rebase index (indexed for gas optimization)
    event RebaseIndexUpdated(uint256 indexed oldIndex, uint256 indexed newIndex);
    /// @notice Emitted when the bridge mints shares on this chain
    /// @param caller BRIDGE_ROLE contract performing the mint
    /// @param account Recipient receiving freshly minted shares
    /// @param amount Number of shares minted
    event BridgeMint(address indexed caller, address indexed account, uint256 indexed amount);
    /// @notice Emitted when the bridge burns shares as part of CCIP flows
    /// @param caller BRIDGE_ROLE contract initiating the burn
    /// @param account Address whose shares were burned
    /// @param amount Number of shares burned
    event BridgeBurn(address indexed caller, address indexed account, uint256 indexed amount);
    /// @notice Emitted when Sky protocol configuration is updated
    /// @param litePSM LitePSMWrapper address for USDC/USDS conversion
    /// @param usds USDS stablecoin address
    /// @param sUsds sUSDS savings vault address
    event SkyConfigUpdated(address indexed litePSM, address indexed usds, address indexed sUsds);

    // ============ Errors ============

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient(address recipient);
    error AddressBlacklisted(address account);
    error BelowMinimumDeposit(uint256 amount, uint256 minimum);
    error AssetAlreadyExists(address token);
    error AssetNotFound(address token);
    error InvalidAllocation(uint256 totalBps);
    error InvalidTotalWeight(uint256 totalBps);
    error LengthMismatch(uint256 provided, uint256 expected);
    error AssetStillActive(address token, uint256 weight);
    error InvalidFee(uint256 fee);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error AutomationIntervalTooShort(uint256 providedInterval);
    error UpkeepNotNeeded();
    error FundsRemaining(uint256 balance);
    error InvalidOraclePrice();
    error MaxYieldAssetsReached(uint256 max);
    error StaleOraclePrice(uint256 updatedAt, uint256 staleness);
    error OraclePriceOutOfBounds(int256 price, int256 min, int256 max);
    error IncompleteOracleRound(uint80 roundId, uint80 answeredInRound);
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error OnlySelf();

    // ============ Modifiers ============

    modifier nonZeroAmount(uint256 amount) {
        if (amount == 0) revert ZeroAmount();
        _;
    }

    modifier nonZeroAddress(address addr) {
        if (addr == address(0)) revert ZeroAddress();
        _;
    }

    modifier notBlacklisted(address account) {
        if (blacklisted[account]) revert AddressBlacklisted(account);
        _;
    }

    // ============ Constructor ============

    /// @notice Disables initializers for upgradeable contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    /**
     * @notice Initialize the USDL vault
     * @param _owner Owner/admin address
     * @param _usdc USDC token address (underlying asset)
     * @param _treasury Treasury address for fees
     */
    function initialize(address _owner, address _usdc, address _treasury) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        // Initialize ERC20 state directly (we own the storage)
        _name = "Lendefi USD V3";
        _symbol = "USDL";

        __Pausable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        _grantRole(PAUSER_ROLE, _owner);
        _grantRole(UPGRADER_ROLE, _owner);
        _grantRole(MANAGER_ROLE, _owner);
        _grantRole(BLACKLISTER_ROLE, _owner);

        version = 3;
        ccipAdmin = _owner;
        treasury = _treasury;
        assetAddress = _usdc;

        // Default redemption fee: 0.1%
        redemptionFeeBps = 10;

        // Default automation settings: daily accruals
        yieldAccrualInterval = 1 days;
        lastYieldAccrualTimestamp = block.timestamp;

        // Initialize rebase index at 1:1 (1e6 precision for 6 decimal token)
        rebaseIndex = REBASE_INDEX_PRECISION;
    }

    // ============ EXTERNAL NONPAYABLE (State-changing) ============

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
        nonZeroAddress(token)
        nonZeroAddress(depositToken)
        nonZeroAddress(manager)
    {
        if (yieldAssetWeights.contains(token)) {
            revert AssetAlreadyExists(token);
        }
        if (yieldAssetWeights.length() > MAX_YIELD_ASSETS - 1) {
            revert MaxYieldAssetsReached(MAX_YIELD_ASSETS);
        }

        yieldAssetWeights.set(token, 0); // Always starts inactive
        yieldAssetConfigs[token] =
            YieldAssetConfig({manager: manager, depositToken: depositToken, assetType: assetType});

        emit YieldAssetAdded(token, manager, 0);
    }

    /**
     * @notice Updates weights for ALL registered yield assets
     * @dev Array length MUST match number of registered assets.
     *      Sum of weights MUST equal BASIS_POINTS (10,000).
     *      Setting weight to 0 automatically drains all holdings from that asset.
     *      Two-step deactivation: updateWeights([..., 0, ...]) -> removeYieldAsset()
     * @param weights Ordered array of weights matching yieldAssetWeights.keys() order
     */
    function updateWeights(uint256[] calldata weights) external onlyRole(MANAGER_ROLE) {
        address[] memory tokens = yieldAssetWeights.keys();

        // Enforce: must provide weight for every registered asset
        if (weights.length != tokens.length) {
            revert LengthMismatch(weights.length, tokens.length);
        }

        uint256 total = 0;
        for (uint256 i = 0; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 oldWeight = yieldAssetWeights.get(token);
            uint256 newWeight = weights[i];

            // Auto-drain: if weight goes from >0 to 0, liquidate all holdings
            if (oldWeight > 0 && newWeight == 0) {
                uint256 balance = IERC20(token).balanceOf(address(this));
                if (balance > 0) {
                    // For OUSG, check minimum redemption amount (~$1.1M) to avoid revert
                    YieldAssetConfig storage config = yieldAssetConfigs[token];
                    if (config.assetType == AssetType.ONDO_OUSG) {
                        // Skip drain if below minimum to avoid blocking weight updates
                        // Manager must manually drain OUSG positions below minimum
                        try this._redeemFromSingleYieldAssetExternal(token, config, balance) returns (
                            uint256 redeemed
                        ) {
                            emit YieldAssetDrained(token, redeemed);
                        } catch {
                            // Log event but don't revert the weight update
                            emit YieldAssetDrained(token, 0);
                        }
                    } else {
                        uint256 redeemed = _redeemFromSingleYieldAsset(token, config, balance);
                        emit YieldAssetDrained(token, redeemed);
                    }
                }
            }

            yieldAssetWeights.set(token, newWeight);
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
        if (!yieldAssetWeights.contains(token)) revert AssetNotFound(token);

        uint256 weight = yieldAssetWeights.get(token);
        if (weight != 0) revert AssetStillActive(token, weight);

        // Ensure no funds remain in this yield asset
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) revert FundsRemaining(balance);

        yieldAssetWeights.remove(token);
        delete yieldAssetConfigs[token];

        emit YieldAssetRemoved(token);
    }

    /**
     * @notice Grant bridge role (for CCIP Token Pool)
     * @param bridge Address to grant BRIDGE_ROLE to
     */
    function grantBridgeRole(address bridge) external nonZeroAddress(bridge) onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(BRIDGE_ROLE, bridge);
    }

    /**
     * @notice Revoke bridge role
     * @param bridge Address to revoke BRIDGE_ROLE from
     */
    function revokeBridgeRole(address bridge) external nonZeroAddress(bridge) onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(BRIDGE_ROLE, bridge);
    }

    /**
     * @notice Set CCIP admin address
     * @param newAdmin New CCIP admin address
     */
    function setCCIPAdmin(address newAdmin) external nonZeroAddress(newAdmin) onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAdmin = ccipAdmin;
        ccipAdmin = newAdmin;
        emit CCIPAdminTransferred(oldAdmin, newAdmin);
    }

    /**
     * @notice Set treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external nonZeroAddress(newTreasury) onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Configure the interval used by Chainlink Automation for yield accruals
     * @param newInterval Interval in seconds. Set to 0 to disable automation.
     * @dev Minimum non-zero interval is 1 hour to avoid spamming keepers
     */
    function setYieldAccrualInterval(uint256 newInterval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newInterval != 0 && newInterval < MIN_AUTOMATION_INTERVAL) {
            revert AutomationIntervalTooShort(newInterval);
        }

        uint256 oldInterval = yieldAccrualInterval;
        yieldAccrualInterval = newInterval;
        emit YieldAccrualIntervalUpdated(oldInterval, newInterval);
    }

    /**
     * @notice Set redemption fee
     * @dev Fee is deducted from withdrawals/redemptions and transferred to the treasury address.
     * @param newFeeBps New redemption fee in basis points (max MAX_FEE_BPS = 5%)
     */
    function setRedemptionFee(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee(newFeeBps);

        uint256 oldFeeBps = redemptionFeeBps;
        redemptionFeeBps = newFeeBps;
        emit RedemptionFeeUpdated(oldFeeBps, newFeeBps);
    }

    /**
     * @notice Configure Sky protocol integration for USDS savings rate yield
     * @dev Sets the addresses for LitePSM (USDC/USDS conversion) and sUSDS vault
     * @param litePSM_ LitePSMWrapper contract address for USDC/USDS swaps
     * @param usds_ USDS stablecoin token address
     * @param sUsds_ sUSDS ERC-4626 vault address for savings rate
     */
    function setSkyConfig(
        address litePSM_,
        address usds_,
        address sUsds_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (litePSM_ == address(0) || usds_ == address(0) || sUsds_ == address(0)) {
            revert ZeroAddress();
        }

        skyConfig = SkyConfig({
            litePSM: litePSM_,
            usds: usds_,
            sUsds: sUsds_
        });

        emit SkyConfigUpdated(litePSM_, usds_, sUsds_);
    }

    /**
     * @notice Blacklist an address
     * @param account Address to blacklist
     */
    function blacklist(address account) external nonZeroAddress(account) onlyRole(BLACKLISTER_ROLE) {
        blacklisted[account] = true;
        emit Blacklisted(account);
    }

    /**
     * @notice Remove address from blacklist
     * @param account Address to remove from blacklist
     */
    function unblacklist(address account) external nonZeroAddress(account) onlyRole(BLACKLISTER_ROLE) {
        blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @notice Emergency withdraw tokens
     * @param token Token address to withdraw
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonZeroAddress(token)
        nonZeroAddress(to)
        nonZeroAmount(amount)
    {
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /**
     * @notice Accrue yield from underlying yield assets into internal accounting
     * @dev This function calculates the actual value of yield positions and updates
     *      totalDepositedAssets to reflect accrued yield. Should be called periodically.
     *      Only increases totalDepositedAssets (yield accrual), never decreases.
     * @return yieldAccrued Amount of yield accrued
     */
    function accrueYield() external onlyRole(MANAGER_ROLE) returns (uint256 yieldAccrued) {
        (yieldAccrued,) = _accrueYieldInternal();
    }

    /**
     * @notice External wrapper for _redeemFromSingleYieldAsset to enable try-catch in updateWeights
     * @dev This function exists solely to allow try-catch handling for OUSG redemptions that may
     *      fail due to minimum redemption requirements. Only callable by this contract.
     * @param token Yield asset token address
     * @param config Yield asset configuration
     * @param amount Amount to redeem
     * @return redeemed Actual amount redeemed
     */
    function _redeemFromSingleYieldAssetExternal(address token, YieldAssetConfig calldata config, uint256 amount)
        external
        returns (uint256 redeemed)
    {
        if (msg.sender != address(this)) revert OnlySelf();

        // Use the passed config directly (stored in calldata from caller)
        // We need to copy to memory since _redeemFromSingleYieldAsset expects storage
        YieldAssetConfig storage storageConfig = yieldAssetConfigs[token];
        // Validate config matches (caller passed yieldAssetConfigs[token])
        assert(storageConfig.manager == config.manager);
        return _redeemFromSingleYieldAsset(token, storageConfig, amount);
    }

    /**
     * @notice Rescue any tokens accidentally sent to the contract
     * @dev Allows recovery of donations/dust. Cannot withdraw more than excess above tracked assets.
     * @param to Address to send rescued tokens
     */
    function rescueDonatedTokens(address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonZeroAddress(to) {
        IERC20 usdc = IERC20(asset());
        uint256 balance = usdc.balanceOf(address(this));
        uint256 tracked = totalDepositedAssets;

        // Can only rescue excess tokens (donations)
        if (balance > tracked) {
            uint256 excess = balance - tracked;
            usdc.safeTransfer(to, excess);
            emit DonatedTokensRescued(to, excess);
        }
    }

    /**
     * @inheritdoc AutomationCompatibleInterface
     */
    function performUpkeep(bytes calldata) external override {
        uint256 interval = yieldAccrualInterval;
        if (interval == 0) revert UpkeepNotNeeded();

        if (block.timestamp - lastYieldAccrualTimestamp < interval) revert UpkeepNotNeeded();

        uint256 currentDeposited = totalDepositedAssets;
        uint256 actualValue = _calculateActualYieldValue(currentDeposited);
        if (actualValue < currentDeposited) revert UpkeepNotNeeded();

        _accrueYieldInternal();
    }

    /**
     * @notice Mint shares for CCIP bridge (Ghost Share pattern)
     * @dev Conforms to Chainlink IBurnMintERC20 signature: mint(address,uint256).
     *      Uses Ghost Share accounting: mints to user but does not increase totalShares.
     * @param account Address receiving the newly minted shares on this chain
     * @param amount Amount of RAW SHARES to mint (preserved yield)
     */
    function mint(address account, uint256 amount)
        external
        whenNotPaused
        onlyRole(BRIDGE_ROLE)
        notBlacklisted(account)
    {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (account == address(this)) revert InvalidRecipient(account);

        // amount is interpreted as RAW SHARES directly
        _mintSharesCCIP(account, amount);
        emit BridgeMint(msg.sender, account, amount);
    }

    /**
     * @notice Burn shares for CCIP bridge (Ghost Share pattern)
     * @dev Only callable by BRIDGE_ROLE (CCIP Token Pool).
     *      Uses Ghost Share accounting: burns from user but does not decrease totalShares.
     * @param account Address to burn from
     * @param amount Amount of RAW SHARES to burn
     */
    function burn(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // amount is interpreted as RAW SHARES directly
        _burnSharesCCIP(account, amount);
        emit BridgeBurn(msg.sender, account, amount);
    }

    /**
     * @notice Burn shares from caller's balance
     * @dev Conforms to Chainlink IBurnMintERC20 signature: burn(uint256)
     *      Only callable by BRIDGE_ROLE for CCIP compatibility
     * @param amount Amount of RAW SHARES to burn
     */
    function burn(uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        if (amount == 0) revert ZeroAmount();

        // amount is interpreted as RAW SHARES directly
        _burnSharesCCIP(msg.sender, amount);
        emit BridgeBurn(msg.sender, msg.sender, amount);
    }

    /**
     * @notice Burn shares from account using allowance
     * @dev Conforms to Chainlink IBurnMintERC20 signature: burnFrom(address,uint256)
     *      Only callable by BRIDGE_ROLE for CCIP compatibility
     * @param account Address to burn from
     * @param amount Amount of RAW SHARES to burn
     */
    function burnFrom(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Spend allowance in rebased terms (must convert raw amount to rebased for allowance check)
        uint256 rebasedAmount = _toRebasedAmount(amount);
        _spendAllowance(account, msg.sender, rebasedAmount);

        // Burn raw shares using Ghost Share accounting
        _burnSharesCCIP(account, amount);
        emit BridgeBurn(msg.sender, account, amount);
    }

    // ============ EXTERNAL VIEW ============

    /**
     * @inheritdoc AutomationCompatibleInterface
     */
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256 interval = yieldAccrualInterval;
        if (interval == 0) {
            return (false, "");
        }

        if (block.timestamp - lastYieldAccrualTimestamp < interval) {
            return (false, "");
        }

        uint256 currentDeposited = totalDepositedAssets;
        uint256 actualValue = _calculateActualYieldValue(currentDeposited);
        if (actualValue > currentDeposited) {
            upkeepNeeded = true;
            performData = abi.encode(actualValue, currentDeposited);
        }
    }

    /// @inheritdoc IGetCCIPAdmin
    function getCCIPAdmin() external view override returns (address) {
        return ccipAdmin;
    }

    /**
     * @notice Get yield asset configuration
     * @param token Yield asset token address
     * @return config Yield asset configuration (manager, depositToken, assetType)
     */
    function getYieldAssetConfig(address token) external view returns (YieldAssetConfig memory config) {
        return yieldAssetConfigs[token];
    }

    /**
     * @notice Get yield asset weight
     * @param token Yield asset token address
     * @return weight Weight in basis points (0 = inactive)
     */
    function getYieldAssetWeight(address token) external view returns (uint256 weight) {
        if (!yieldAssetWeights.contains(token)) return 0;
        return yieldAssetWeights.get(token);
    }

    /**
     * @notice Get all yield assets with their weights
     * @return tokens Array of yield asset token addresses
     * @return weights Array of weights in basis points
     */
    function getAllYieldAssets() external view returns (address[] memory tokens, uint256[] memory weights) {
        tokens = yieldAssetWeights.keys();
        weights = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            weights[i] = yieldAssetWeights.get(tokens[i]);
        }
    }

    /**
     * @notice Get number of yield assets
     * @return Number of configured yield assets
     */
    function getYieldAssetCount() external view returns (uint256) {
        return yieldAssetWeights.length();
    }

    /**
     * @notice Get the current rebase index
     * @dev Index starts at 1e6 and increases as yield accrues
     *      balance = rawShares * rebaseIndex / 1e6
     * @return The current rebase index
     */
    function getRebaseIndex() external view returns (uint256) {
        return rebaseIndex;
    }

    /**
     * @notice Get current share price (assets per share)
     * @dev Calculates the price per share including accrued yield. Uses totalAssets() for numerator.
     * @return price Share price scaled by 1e6 (USDC decimals)
     */
    function sharePrice() external view returns (uint256 price) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e6; // 1:1 initially

        price = (totalAssets() * 1e6) / supply;
    }

    /**
     * @notice Get the price of 1 USDL share in USDC
     * @dev Uses previewRedeem to calculate how much USDC 1 full share would return
     * @return price Price of 1 USDL in USDC (6 decimals)
     */
    function getPrice() external view returns (uint256 price) {
        // 1 full share = 1e6 (6 decimals)
        price = previewRedeem(1e6);
    }

    // ============ EXTERNAL PURE ============
    // (none)

    // ============ PUBLIC NONPAYABLE (State-changing) ============

    /**
     * @notice Deposit USDC to receive shares
     * @dev Implements ERC4626 with fee logic and yield allocation
     * @param assets Amount of USDC to deposit
     * @param receiver Address receiving the shares
     * @return shares Number of rebased shares minted (matches balanceOf output)
     */
    function deposit(uint256 assets, address receiver)
        public
        nonReentrant
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        returns (uint256 shares)
    {
        if (assets < MIN_DEPOSIT) {
            revert BelowMinimumDeposit(assets, MIN_DEPOSIT);
        }
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert InvalidRecipient(receiver);

        // No deposit fees - calculate raw shares based on full assets
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Floor);
        if (rawShares == 0) revert ZeroAmount();

        // Transfer assets from sender
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);

        // Update internal accounting BEFORE allocation
        totalDepositedAssets += assets;

        // Allocate assets to yield positions
        _allocateToYieldAssets(assets);

        // Mint raw shares
        _mintShares(receiver, rawShares);

        // Return rebased shares (matches balanceOf)
        shares = _toRebasedAmount(rawShares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /**
     * @notice Mint shares by depositing USDC
     * @dev Implements ERC4626 with fee logic and yield allocation
     * @param shares Number of rebased shares to mint (matches balanceOf output)
     * @param receiver Address receiving the shares
     * @return assets Amount of USDC deposited (including fee)
     */
    function mint(uint256 shares, address receiver)
        public
        nonReentrant
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert InvalidRecipient(receiver);

        // Convert rebased shares to raw for internal accounting
        uint256 rawShares = _toRawShares(shares);

        // Calculate assets needed using internal accounting (no deposit fees)
        assets = _convertToAssets(rawShares, Math.Rounding.Ceil);

        if (assets < MIN_DEPOSIT) {
            revert BelowMinimumDeposit(assets, MIN_DEPOSIT);
        }

        // Transfer assets from sender
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);

        // Update internal accounting BEFORE allocation
        totalDepositedAssets += assets;

        // Allocate to yield positions
        _allocateToYieldAssets(assets);

        // Mint raw shares
        _mintShares(receiver, rawShares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /**
     * @notice Withdraw USDC by burning shares
     * @dev Implements ERC4626 with fee logic and yield asset redemption
     * @param assets Amount of USDC to withdraw
     * @param receiver Address receiving the USDC
     * @param owner Address whose shares are being burned
     * @return shares Number of rebased shares burned (matches balanceOf output)
     */
    function withdraw(uint256 assets, address receiver, address owner)
        public
        nonReentrant
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        notBlacklisted(owner)
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (assets > totalDepositedAssets) {
            revert InsufficientLiquidity(assets, totalDepositedAssets);
        }

        // Calculate raw shares to burn using internal accounting
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Ceil);

        // Convert to rebased for allowance check and return value
        shares = _toRebasedAmount(rawShares);

        // Check allowance if not owner (allowance in rebased terms)
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        // Calculate redemption fee
        uint256 fee = (assets * redemptionFeeBps) / BASIS_POINTS;
        uint256 netAssets = assets - fee;

        // Update internal accounting BEFORE redemption
        totalDepositedAssets -= assets;

        // Redeem from yield assets
        _redeemFromYieldAssets(assets);

        // Burn raw shares
        _burnShares(owner, rawShares);

        // Transfer fee to treasury
        if (fee > 0) {
            IERC20(asset()).safeTransfer(treasury, fee);
        }

        // Transfer net assets to receiver
        IERC20(asset()).safeTransfer(receiver, netAssets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /**
     * @notice Redeem shares for USDC
     * @dev Implements ERC4626 with fee logic
     * @param shares Amount of rebased shares to redeem (matches balanceOf output)
     * @param receiver Address receiving the USDC
     * @param owner Address whose shares are being redeemed
     * @return assets Amount of USDC returned
     */
    function redeem(uint256 shares, address receiver, address owner)
        public
        nonReentrant
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        notBlacklisted(owner)
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Check allowance if not owner (shares is already rebased)
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        // Convert rebased shares to raw for internal accounting
        uint256 rawShares = _toRawShares(shares);

        // Calculate assets to return using internal accounting (raw shares)
        assets = _convertToAssets(rawShares, Math.Rounding.Floor);

        // Cap to totalDepositedAssets to handle rounding dust on full redemption
        uint256 deposited = totalDepositedAssets;
        if (assets > deposited) {
            assets = deposited;
        }

        // Calculate redemption fee
        uint256 fee = (assets * redemptionFeeBps) / BASIS_POINTS;
        uint256 netAssets = assets - fee;

        // Update internal accounting BEFORE redemption
        totalDepositedAssets -= assets;

        // Redeem from yield assets
        _redeemFromYieldAssets(assets);

        // Burn raw shares
        _burnShares(owner, rawShares);

        // Transfer fee to treasury
        if (fee > 0) {
            IERC20(asset()).safeTransfer(treasury, fee);
        }

        // Transfer net assets to receiver
        IERC20(asset()).safeTransfer(receiver, netAssets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /**
     * @notice Transfer rebased tokens
     * @dev Converts rebased amount to raw shares, transfers via internal storage
     * @param to Recipient address
     * @param value Rebased amount to transfer
     * @return True if successful
     */
    function transfer(address to, uint256 value) public override whenNotPaused returns (bool) {
        _transferShares(msg.sender, to, _toRawShares(value));
        return true;
    }

    /**
     * @notice Transfer rebased tokens from another account
     * @dev Spends allowance in rebased terms, transfers raw shares
     * @param from Sender address
     * @param to Recipient address
     * @param value Rebased amount to transfer
     * @return True if successful
     */
    function transferFrom(address from, address to, uint256 value) public override whenNotPaused returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transferShares(from, to, _toRawShares(value));
        return true;
    }

    /**
     * @notice Approve spender to transfer tokens
     * @param spender Address to approve
     * @param value Amount to approve (in rebased units)
     * @return True if successful
     */
    function approve(address spender, uint256 value) public override whenNotPaused returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    // ============ PUBLIC VIEW ============

    /**
     * @notice Get the underlying asset address (USDC)
     * @return Address of the underlying asset
     */
    function asset() public view override returns (address) {
        return assetAddress;
    }

    /**
     * @notice Get total assets managed by the vault
     * @dev Uses internal accounting (totalDepositedAssets) to prevent donation attacks.
     *      External actors cannot manipulate this by sending USDC directly to contract.
     * @return Total assets in USDC (6 decimals)
     */
    function totalAssets() public view override returns (uint256) {
        return totalDepositedAssets;
    }

    /**
     * @notice Get total supply of shares (rebased)
     * @dev Returns rebased total supply for ERC20 compatibility
     *      totalSupply = rawTotalShares * rebaseIndex / PRECISION
     * @return Total supply in rebased units
     */
    function totalSupply() public view override returns (uint256) {
        return (_totalShares * rebaseIndex) / REBASE_INDEX_PRECISION;
    }

    /**
     * @notice Get balance of account (rebased)
     * @dev Returns rebased balance for ERC20 compatibility
     *      balance = rawShares * rebaseIndex / PRECISION
     * @param account Address to query
     * @return Balance in rebased units
     */
    function balanceOf(address account) public view override returns (uint256) {
        return (_shares[account] * rebaseIndex) / REBASE_INDEX_PRECISION;
    }

    /**
     * @notice Get allowance
     * @param owner Token owner
     * @param spender Approved spender
     * @return Allowance amount (in rebased units)
     */
    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @notice Get raw share balance (not rebased)
     * @param account Address to query
     * @return Raw share balance
     */
    function sharesOf(address account) public view returns (uint256) {
        return _shares[account];
    }

    /**
     * @notice Get total raw shares (not rebased)
     * @return Total raw shares
     */
    function totalShares() public view returns (uint256) {
        return _totalShares;
    }

    /**
     * @notice Preview deposit amount
     * @dev Returns rebased shares that would be minted for given assets (no deposit fee)
     * @param assets Amount of assets to deposit
     * @return Rebased shares that would be minted (matches balanceOf output)
     */
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Floor);
        return _toRebasedAmount(rawShares);
    }

    /**
     * @notice Preview mint amount
     * @dev Returns assets needed to mint given rebased shares (no deposit fee)
     * @param shares Amount of rebased shares to mint (matches balanceOf output)
     * @return Assets needed
     */
    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 rawShares = _toRawShares(shares);
        return _convertToAssets(rawShares, Math.Rounding.Ceil);
    }

    /**
     * @notice Preview withdraw amount
     * @dev Returns rebased shares needed to withdraw given assets (after redemption fee)
     * @param assets Amount of assets to withdraw (gross amount)
     * @return Rebased shares needed (matches balanceOf output)
     */
    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Ceil);
        return _toRebasedAmount(rawShares);
    }

    /**
     * @notice Preview redeem amount
     * @dev Returns assets received for redeeming given rebased shares (after redemption fee)
     * @param shares Amount of rebased shares to redeem (matches balanceOf output)
     * @return Assets received (net of redemption fee)
     */
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 rawShares = _toRawShares(shares);
        uint256 assets = _convertToAssets(rawShares, Math.Rounding.Floor);
        uint256 fee = (assets * redemptionFeeBps) / BASIS_POINTS;
        return assets - fee;
    }

    /**
     * @notice Convert assets to shares
     * @dev Returns rebased shares equivalent to given assets
     * @param assets Amount of assets
     * @return Equivalent rebased shares (matches balanceOf output)
     */
    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Floor);
        return _toRebasedAmount(rawShares);
    }

    /**
     * @notice Convert shares to assets
     * @dev Returns assets equivalent to given rebased shares
     * @param shares Amount of rebased shares (matches balanceOf output)
     * @return Equivalent assets
     */
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 rawShares = _toRawShares(shares);
        return _convertToAssets(rawShares, Math.Rounding.Floor);
    }

    /**
     * @notice Get maximum withdraw amount for account
     * @dev Uses raw shares internally for accurate calculation
     * @param owner Address whose shares to withdraw
     * @return Maximum withdraw amount in assets
     */
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 rawShares = _shares[owner];
        return _convertToAssets(rawShares, Math.Rounding.Floor);
    }

    /**
     * @notice Get maximum redeem amount for account
     * @param owner Address whose shares to redeem
     * @return Maximum redeem amount
     */
    function maxRedeem(address owner) public view override returns (uint256) {
        return balanceOf(owner);
    }

    /**
     * @notice Get token name
     * @return Token name
     */
    function name() public view override returns (string memory) {
        return _name;
    }

    /**
     * @notice Get token symbol
     * @return Token symbol
     */
    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC20).interfaceId || interfaceId == type(IERC4626).interfaceId
            || interfaceId == type(IERC165).interfaceId || interfaceId == type(IAccessControl).interfaceId
            || interfaceId == type(IGetCCIPAdmin).interfaceId || interfaceId == type(IBurnMintERC20).interfaceId
            || interfaceId == type(AutomationCompatibleInterface).interfaceId || super.supportsInterface(interfaceId);
    }

    // ============ PUBLIC PURE ============

    /// @inheritdoc IERC4626
    function maxDeposit(address) public pure override returns (uint256) {
        return type(uint256).max;
    }

    /// @inheritdoc IERC4626
    function maxMint(address) public pure override returns (uint256) {
        return type(uint256).max;
    }

    /**
     * @notice Get token decimals
     * @return Number of decimals (6 for USDC compatibility)
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ============ INTERNAL FUNCTIONS ============

    /**
     * @notice Allocate deposits proportionally to all active yield assets by weight
     * @dev Deposits are split across all assets with weight > 0.
     *      Last active asset receives remainder to avoid dust.
     * @param amount Amount of USDC to allocate
     */
    function _allocateToYieldAssets(uint256 amount) internal {
        address[] memory tokens = yieldAssetWeights.keys();
        uint256 length = tokens.length;
        uint256 allocated = 0;
        uint256 lastActiveIndex = type(uint256).max;

        // Cache weights in memory to avoid double SLOAD per token
        uint256[] memory weights = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            weights[i] = yieldAssetWeights.get(tokens[i]);
        }

        // Find last active asset for dust handling
        for (uint256 i = length; i > 0; --i) {
            if (weights[i - 1] > 0) {
                lastActiveIndex = i - 1;
                break;
            }
        }

        for (uint256 i = 0; i < length; ++i) {
            address token = tokens[i];
            uint256 weight = weights[i];

            if (weight == 0) continue; // Skip inactive assets

            uint256 allocation;
            if (i == lastActiveIndex) {
                // Last active asset gets remainder to avoid dust
                allocation = amount - allocated;
            } else {
                allocation = (amount * weight) / BASIS_POINTS;
            }

            if (allocation > 0) {
                _depositToYieldAsset(yieldAssetConfigs[token], allocation);
                allocated += allocation;
            }
        }
    }

    /**
     * @notice Deposits USDC into a specific yield-generating protocol
     * @dev Routes deposit based on asset type:
     *      - ERC4626: Calls deposit(amount, address(this))
     *      - ONDO_OUSG: Calls mint(amount) on InstantManager
     * @param config Yield asset configuration
     * @param amount Amount of USDC to deposit (6 decimals)
     */
    function _depositToYieldAsset(YieldAssetConfig storage config, uint256 amount) internal {
        if (config.assetType == AssetType.ONDO_OUSG) {
            IERC20(config.depositToken).safeIncreaseAllowance(config.manager, amount);
            IOUSGInstantManager(config.manager).mint(amount);
        } else if (config.assetType == AssetType.AAVE_V3) {
            // Aave V3: Supply to the pool, receive aTokens
            IERC20(config.depositToken).safeIncreaseAllowance(config.manager, amount);
            IAaveV3Pool(config.manager).supply(config.depositToken, amount, address(this), 0);
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            // Sky Protocol: USDC -> USDS (via LitePSM) -> sUSDS (via ERC4626 deposit)
            SkyConfig memory sky = skyConfig;
            
            // Step 1: Approve USDC to LitePSM and swap for USDS
            IERC20(config.depositToken).safeIncreaseAllowance(sky.litePSM, amount);
            ILitePSMWrapper(sky.litePSM).sellGem(address(this), amount);
            
            // Step 2: Get USDS balance received and deposit to sUSDS vault
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
     * @notice Redeem from yield assets (enforces exact amount)
     * @dev H-01 Fix: Tracks actual balance changes, not assumed amounts.
     *      Prevents silent failures from illiquid yield protocols.
     * @param amount Amount to redeem
     */
    function _redeemFromYieldAssets(uint256 amount) internal {
        _redeemFromYieldAssets(amount, true);
    }

    /**
     * @notice Redeem proportionally from all active yield assets by weight
     * @dev H-01 Fix: Tracks actual USDC received, not requested amount.
     * @param amount Total USDC amount requested
     * @param enforceExactAmount When false, allows rounding shortfalls instead of reverting
     */
    function _redeemFromYieldAssets(uint256 amount, bool enforceExactAmount) internal {
        IERC20 usdc = IERC20(asset());
        address[] memory tokens = yieldAssetWeights.keys();
        uint256 length = tokens.length;
        uint256 totalRedeemed = 0;
        uint256 remaining = amount;

        // Cache weights in memory to avoid SLOAD per iteration
        uint256[] memory weights = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            weights[i] = yieldAssetWeights.get(tokens[i]);
        }

        for (uint256 i = 0; i < length && remaining > 0; ++i) {
            address token = tokens[i];
            uint256 weight = weights[i];

            if (weight == 0) continue; // Skip inactive assets

            uint256 redeemTarget = (amount * weight) / BASIS_POINTS;
            if (redeemTarget > remaining) redeemTarget = remaining;

            if (redeemTarget > 0) {
                uint256 balanceBefore = usdc.balanceOf(address(this));
                _redeemFromSingleYieldAsset(token, yieldAssetConfigs[token], redeemTarget);
                uint256 actualRedeemed = usdc.balanceOf(address(this)) - balanceBefore;
                totalRedeemed += actualRedeemed;
                remaining -= actualRedeemed;
            }
        }

        // H-01 Fix: Final verification that we have enough USDC
        // Allow 1 wei tolerance for rounding dust
        if (enforceExactAmount && totalRedeemed + 1 < amount) {
            revert InsufficientLiquidity(amount, totalRedeemed);
        }
    }

    /**
     * @notice Redeems USDC from a single yield protocol
     * @dev Routes redemption based on asset type. Returns actual USDC redeemed.
     * @param token Yield asset token address
     * @param config Yield asset configuration
     * @param amount Target amount of USDC to redeem (6 decimals)
     * @return redeemed Actual USDC amount redeemed
     */
    function _redeemFromSingleYieldAsset(address token, YieldAssetConfig storage config, uint256 amount)
        internal
        returns (uint256 redeemed)
    {
        IERC20 yieldToken = IERC20(token);
        IERC20 usdc = IERC20(asset());
        uint256 balance = yieldToken.balanceOf(address(this));

        if (balance == 0) return 0;

        uint256 usdcBefore = usdc.balanceOf(address(this));

        if (config.assetType == AssetType.ONDO_OUSG) {
            // OUSG: Redeem entire balance (has minimum redemption requirements)
            yieldToken.safeIncreaseAllowance(config.manager, balance);
            IOUSGInstantManager(config.manager).redeem(balance);
        } else if (config.assetType == AssetType.AAVE_V3) {
            // Aave V3: Withdraw from pool (aTokens are burned automatically)
            uint256 withdrawAmount = amount;
            if (withdrawAmount > balance) withdrawAmount = balance;
            IAaveV3Pool(config.manager).withdraw(config.depositToken, withdrawAmount, address(this));
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            // Sky Protocol: sUSDS -> USDS (via redeem) -> USDC (via LitePSM buyGem)
            SkyConfig memory sky = skyConfig;
            IERC4626 sUsdsVault = IERC4626(sky.sUsds);
            
            // Step 1: Calculate shares to redeem for target USDC amount
            // sUSDS.convertToAssets gives USDS value, which is 1:1 with USDC
            uint256 sharesToRedeem = sUsdsVault.convertToShares(amount * 1e12); // Scale 6 to 18 decimals
            if (sharesToRedeem == 0) sharesToRedeem = balance;
            if (sharesToRedeem > balance) sharesToRedeem = balance;
            
            // Step 2: Redeem sUSDS for USDS
            sUsdsVault.redeem(sharesToRedeem, address(this), address(this));
            
            // Step 3: Swap USDS for USDC via LitePSM
            uint256 usdsBalance = IERC20(sky.usds).balanceOf(address(this));
            // Note: buyGem takes gemAmt (USDC amount desired), not USDS amount
            // We need to divide by 1e12 to convert USDS (18 decimals) to USDC (6 decimals)
            uint256 usdcAmount = usdsBalance / 1e12;
            if (usdcAmount > 0) {
                IERC20(sky.usds).safeIncreaseAllowance(sky.litePSM, usdsBalance);
                ILitePSMWrapper(sky.litePSM).buyGem(address(this), usdcAmount);
            }
        } else {
            // ERC4626: Convert target amount to shares and redeem
            IERC4626 vault = IERC4626(config.manager);
            uint256 sharesToRedeem = vault.convertToShares(amount);
            if (sharesToRedeem == 0) sharesToRedeem = balance;
            if (sharesToRedeem > balance) sharesToRedeem = balance;
            vault.redeem(sharesToRedeem, address(this), address(this));
        }

        redeemed = usdc.balanceOf(address(this)) - usdcBefore;
    }

    /**
     * @notice Accrue yield internally
     * @dev Shared by manual accruals and Chainlink Automation
     *      Updates rebaseIndex so that: newBalance = oldBalance * newIndex / oldIndex
     *      This maintains 1:1 USDC peg while distributing yield proportionally
     * @return yieldAccrued Amount of yield accrued
     * @return actualValue Actual value after accrual
     */
    function _accrueYieldInternal() internal returns (uint256 yieldAccrued, uint256 actualValue) {
        uint256 currentDeposited = totalDepositedAssets;
        actualValue = _calculateActualYieldValue(currentDeposited);

        lastYieldAccrualTimestamp = block.timestamp;

        if (actualValue > currentDeposited && currentDeposited > 0) {
            yieldAccrued = actualValue - currentDeposited;
            // Pull realized gains back into USDC before updating accounting
            _harvestYield(yieldAccrued);

            // After harvest, recalculate with all USDC now in contract
            uint256 vaultValue = _sumActiveYieldAssetValue();
            IERC20 usdc = IERC20(assetAddress);
            uint256 usdcBalance = usdc.balanceOf(address(this));
            actualValue = vaultValue + usdcBalance;

            // Update rebase index proportionally to distribute yield to all holders
            // newIndex = oldIndex * actualValue / currentDeposited
            uint256 oldIndex = rebaseIndex;
            uint256 newIndex = (oldIndex * actualValue) / currentDeposited;
            rebaseIndex = newIndex;

            totalDepositedAssets = actualValue;

            emit RebaseIndexUpdated(oldIndex, newIndex);
            emit YieldAccrued(yieldAccrued, actualValue);
        }
    }

    /**
     * @notice Withdraws accrued yield from external protocols into USDC held by this contract
     * @dev Reuses the redemption waterfall to realize profits before updating internal accounting
     * @param amount Amount of yield to harvest
     */
    function _harvestYield(uint256 amount) internal {
        if (amount == 0) return;
        _redeemFromYieldAssets(amount, false);
    }

    // ============ INTERNAL ERC20 FUNCTIONS ============

    /**
     * @notice Mint raw shares to account
     * @dev Emits Transfer event with REBASED amount for ERC20 compatibility
     * @param account Recipient address
     * @param rawShares Number of raw shares to mint
     */
    function _mintShares(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        _shares[account] += rawShares;
        _totalShares += rawShares;

        uint256 rebasedAmount = (rawShares * rebaseIndex) / REBASE_INDEX_PRECISION;
        emit Transfer(address(0), account, rebasedAmount);
    }

    /**
     * @notice Burn raw shares from account
     * @dev Emits Transfer event with REBASED amount for ERC20 compatibility
     * @param account Address to burn from
     * @param rawShares Number of raw shares to burn
     */
    function _burnShares(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        uint256 accountShares = _shares[account];
        if (accountShares < rawShares) {
            revert ERC20InsufficientBalance(account, accountShares, rawShares);
        }

        unchecked {
            _shares[account] = accountShares - rawShares;
        }
        _totalShares -= rawShares;

        uint256 rebasedAmount = (rawShares * rebaseIndex) / REBASE_INDEX_PRECISION;
        emit Transfer(account, address(0), rebasedAmount);
    }

    /**
     * @notice Mint raw shares for CCIP (Ghost Share Accounting)
     * @dev Updates user balance but NOT totalShares to prevent dilution of existing stakers.
     *      Reclaims "ghost shares" left behind by previous burns.
     * @param account Recipient address
     * @param rawShares Number of raw shares to mint
     */
    function _mintSharesCCIP(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        _shares[account] += rawShares;
        // NOTE: Do NOT increment _totalShares. These shares are already accounted for
        // in the denominator from the perspective of backing assets.

        uint256 rebasedAmount = (rawShares * rebaseIndex) / REBASE_INDEX_PRECISION;
        emit Transfer(address(0), account, rebasedAmount);
    }

    /**
     * @notice Burn raw shares for CCIP (Ghost Share Accounting)
     * @dev Updates user balance but NOT totalShares to prevent inflation attack.
     *      Creates "ghost shares" that hold value in the vault while bridged out.
     * @param account Address to burn from
     * @param rawShares Number of raw shares to burn
     */
    function _burnSharesCCIP(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        uint256 accountShares = _shares[account];
        if (accountShares < rawShares) {
            revert ERC20InsufficientBalance(account, accountShares, rawShares);
        }

        unchecked {
            _shares[account] = accountShares - rawShares;
        }
        // NOTE: Do NOT decrement _totalShares. This locks the backing assets and
        // prevents the share price from spiking (inflation attack).

        uint256 rebasedAmount = (rawShares * rebaseIndex) / REBASE_INDEX_PRECISION;
        emit Transfer(account, address(0), rebasedAmount);
    }

    /**
     * @notice Transfer raw shares between accounts
     * @dev Includes blacklist checks, emits Transfer with rebased amount
     * @param from Sender address
     * @param to Recipient address
     * @param rawShares Number of raw shares to transfer
     */
    function _transferShares(address from, address to, uint256 rawShares) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (blacklisted[from]) revert AddressBlacklisted(from);
        if (blacklisted[to]) revert AddressBlacklisted(to);

        uint256 fromShares = _shares[from];
        if (fromShares < rawShares) {
            revert ERC20InsufficientBalance(from, fromShares, rawShares);
        }

        unchecked {
            _shares[from] = fromShares - rawShares;
        }
        _shares[to] += rawShares;

        uint256 rebasedAmount = (rawShares * rebaseIndex) / REBASE_INDEX_PRECISION;
        emit Transfer(from, to, rebasedAmount);
    }

    /**
     * @notice Internal approve
     * @param owner Token owner
     * @param spender Approved spender
     * @param value Amount to approve (in rebased units)
     */
    function _approve(address owner, address spender, uint256 value) internal {
        if (owner == address(0)) revert ZeroAddress();
        if (spender == address(0)) revert ZeroAddress();
        _allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    /**
     * @notice Internal spend allowance
     * @param owner Token owner
     * @param spender Spender address
     * @param value Amount to spend (in rebased units)
     */
    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 currentAllowance = _allowances[owner][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _allowances[owner][spender] = currentAllowance - value;
            }
        }
    }

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
     * @notice Convert assets to shares internally
     * @dev Uses RAW total shares for consistent math with _mintShares/_burnShares
     * @param assets Amount of assets
     * @param rounding Rounding direction
     * @return shares Amount of RAW shares
     */
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view returns (uint256 shares) {
        uint256 supply = _totalShares; // RAW shares, not rebased
        uint256 depositedAssets = totalDepositedAssets;

        // If no shares exist, 1:1 ratio
        if (supply == 0 || depositedAssets == 0) {
            return assets;
        }

        // shares = assets * totalRawShares / totalDepositedAssets
        return assets.mulDiv(supply, depositedAssets, rounding);
    }

    /**
     * @notice Convert shares to assets internally
     * @dev Uses RAW total shares for consistent math with _mintShares/_burnShares
     * @param shares Amount of RAW shares
     * @param rounding Rounding direction
     * @return assets Amount of assets
     */
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view returns (uint256 assets) {
        uint256 supply = _totalShares; // RAW shares, not rebased
        uint256 depositedAssets = totalDepositedAssets;

        // If no shares exist, 1:1 ratio
        if (supply == 0 || depositedAssets == 0) {
            return shares;
        }

        // assets = shares * totalDepositedAssets / totalRawShares
        return shares.mulDiv(depositedAssets, supply, rounding);
    }

    /**
     * @notice Calculate the actual value of all yield positions in USDC terms
     * @dev Used for yield accrual to update internal accounting
     * @param trackedDeposits Current tracked deposits
     * @return total Total value of all yield assets plus any USDC held
     */
    function _calculateActualYieldValue(uint256 trackedDeposits) internal view returns (uint256 total) {
        uint256 vaultValue = _sumActiveYieldAssetValue();
        total = vaultValue;

        // Add USDC held directly (only the tracked portion, not donations)
        // We use min(balance, trackedDeposits - vaultValue) to avoid counting donations
        IERC20 usdc = IERC20(assetAddress);
        uint256 usdcBalance = usdc.balanceOf(address(this));
        uint256 usdcTracked = trackedDeposits > vaultValue ? trackedDeposits - vaultValue : 0;
        total += usdcBalance < usdcTracked ? usdcBalance : usdcTracked;
    }

    /**
     * @notice Sum value of all yield assets (active and inactive)
     * @return vaultValue Total value in yield positions
     */
    function _sumActiveYieldAssetValue() internal view returns (uint256 vaultValue) {
        address[] memory tokens = yieldAssetWeights.keys();
        for (uint256 i = 0; i < tokens.length; ++i) {
            vaultValue += _getYieldAssetValue(tokens[i], yieldAssetConfigs[tokens[i]]);
        }
    }

    /**
     * @notice Calculates the USDC-equivalent value of a yield asset position
     * @dev Routes valuation logic based on asset type:
     *      - ERC4626: Uses vault's convertToAssets() for share-to-asset conversion
     *      - AAVE_V3: Returns balance directly (aTokens rebase 1:1 with underlying)
     *      - ONDO_OUSG: Fetches price from RWA Oracle (Chainlink-compatible, 8 decimals)
     *
     *      For OUSG valuation formula:
     *      value = (balance * oraclePrice) / 1e20
     *      where balance is 18 decimals, price is 8 decimals, result is 6 decimals (USDC)
     *
     * @param token Yield asset token address
     * @param config Yield asset configuration
     * @return value The USDC-equivalent value of the vault's holdings in this asset (6 decimals)
     *
     * @custom:requirements
     *   - For OUSG: config.manager must be the RWA Oracle address
     *   - Oracle price must be positive (reverts otherwise)
     */
    function _getYieldAssetValue(address token, YieldAssetConfig storage config) internal view returns (uint256 value) {
        IERC20 yieldToken = IERC20(token);
        uint256 balance = yieldToken.balanceOf(address(this));

        if (balance == 0) return 0;

        if (config.assetType == AssetType.ERC4626) {
            // ERC-4626: convertToAssets gives underlying value
            value = IERC4626(config.manager).convertToAssets(balance);
        } else if (config.assetType == AssetType.AAVE_V3) {
            // Aave aTokens are 1:1 with underlying (they rebase)
            value = balance;
        } else if (config.assetType == AssetType.ONDO_OUSG) {
            // OUSG - use RWA oracle for price (Chainlink-compatible, 8 decimals)
            // config.manager stores the oracle address for OUSG
            IRWAOracle oracle = IRWAOracle(config.manager);
            (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) = oracle.latestRoundData();

            // Validate price is positive
            if (price < 1) revert InvalidOraclePrice();

            // Validate price is within reasonable bounds
            if (price < MIN_OUSG_PRICE || price > MAX_OUSG_PRICE) {
                revert OraclePriceOutOfBounds(price, MIN_OUSG_PRICE, MAX_OUSG_PRICE);
            }

            // Validate oracle data is not stale
            if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) {
                revert StaleOraclePrice(updatedAt, block.timestamp - updatedAt);
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
        } else if (config.assetType == AssetType.SKY_SUSDS) {
            // sUSDS: ERC-4626 vault holding USDS
            // convertToAssets returns USDS value (18 decimals)
            // USDS is 1:1 with USDC via LitePSM, so divide by 1e12 for USDC value (6 decimals)
            uint256 usdsValue = IERC4626(skyConfig.sUsds).convertToAssets(balance);
            value = usdsValue / 1e12;
        }
    }

    /**
     * @notice Convert rebased amount to raw shares
     * @param rebasedAmount Rebased amount
     * @return rawShares Raw share amount
     */
    function _toRawShares(uint256 rebasedAmount) internal view returns (uint256 rawShares) {
        if (rebaseIndex == 0) return rebasedAmount;
        return rebasedAmount * REBASE_INDEX_PRECISION / rebaseIndex;
    }

    /**
     * @notice Convert raw shares to rebased amount
     * @param rawShares Raw share amount
     * @return rebasedAmount Rebased amount
     */
    function _toRebasedAmount(uint256 rawShares) internal view returns (uint256 rebasedAmount) {
        if (rebaseIndex == 0) return rawShares;
        return rawShares * rebaseIndex / REBASE_INDEX_PRECISION;
    }
}
