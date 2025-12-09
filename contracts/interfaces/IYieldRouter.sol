// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AssetType} from "./IYieldProtocols.sol";

/**
 * @title IYieldRouter
 * @author Lendefi Markets
 * @notice Interface for the YieldRouter contract
 * @dev Manages yield asset allocations and protocol interactions for USDL vault
 */
interface IYieldRouter {
    // ============ Structs ============

    /// @notice Yield asset configuration
    struct YieldAssetConfig {
        address manager; // Manager contract (vault, pool, oracle)
        address depositToken; // Token to deposit (USDC, DAI)
        AssetType assetType; // Protocol type for routing
    }

    /// @notice Sky protocol configuration
    struct SkyConfig {
        address litePSM; // LitePSMWrapper for USDC <-> USDS
        address usds; // USDS stablecoin
        address sUsds; // sUSDS ERC-4626 vault
    }

    // ============ Events ============

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

    /// @notice Emitted when Sky config is updated
    event SkyConfigUpdated(address indexed litePSM, address indexed usds, address indexed sUsds);

    /// @notice Emitted when USDC is deposited to protocols
    event DepositedToProtocols(uint256 amount);

    /// @notice Emitted when USDC is redeemed from protocols
    event RedeemedFromProtocols(uint256 requested, uint256 received);

    /// @notice Emitted when yield is accrued
    /// @param yieldAmount Amount of yield accrued (indexed for gas optimization)
    /// @param newTotalAssets New total assets after accrual (indexed for gas optimization)
    event YieldAccrued(uint256 indexed yieldAmount, uint256 indexed newTotalAssets);

    /// @notice Emitted when vault is updated
    event VaultUpdated(address indexed oldVault, address indexed newVault);

    /// @notice Emitted when contract is upgraded
    event Upgrade(address indexed sender, address indexed implementation);

    /// @notice Emitted when yield accrual interval is updated
    /// @param oldInterval Previous interval in seconds (indexed for gas optimization)
    /// @param newInterval New interval in seconds (indexed for gas optimization)
    event YieldAccrualIntervalUpdated(uint256 indexed oldInterval, uint256 indexed newInterval);

    /// @notice Emitted when donated tokens are rescued
    /// @param to Recipient address (indexed for gas optimization)
    /// @param amount Amount rescued (indexed for gas optimization)
    event DonatedTokensRescued(address indexed to, uint256 indexed amount);

    /// @notice Emitted when pending deposits are allocated to protocols
    /// @param amount Amount of USDC allocated (indexed for gas optimization)
    event PendingDepositsAllocated(uint256 indexed amount);

    // ============ Errors ============

    /// @notice Thrown when zero address is provided
    error ZeroAddress();

    /// @notice Thrown when zero amount is provided
    error ZeroAmount();

    /// @notice Thrown when asset already exists in registry
    error AssetAlreadyExists(address token);

    /// @notice Thrown when asset is not found in registry
    error AssetNotFound(address token);

    /// @notice Thrown when total weight doesn't equal BASIS_POINTS
    error InvalidTotalWeight(uint256 totalBps);

    /// @notice Thrown when weights array length doesn't match assets
    error LengthMismatch(uint256 provided, uint256 expected);

    /// @notice Thrown when trying to remove asset that still has weight
    error AssetStillActive(address token, uint256 weight);

    /// @notice Thrown when trying to remove asset that still has funds
    error FundsRemaining(uint256 balance);

    /// @notice Thrown when max yield assets limit is reached
    error MaxYieldAssetsReached(uint256 max);

    /// @notice Thrown when OUSG oracle price is invalid
    error InvalidOraclePrice();

    /// @notice Thrown when automation interval is too short
    error AutomationIntervalTooShort(uint256 providedInterval, uint256 minInterval);

    /// @notice Thrown when upkeep is not needed
    error UpkeepNotNeeded();

    /// @notice Thrown when insufficient liquidity for redemption
    error InsufficientLiquidity(uint256 requested, uint256 available);

    /// @notice Thrown when caller is not self (for external try/catch wrapper)
    error OnlySelf();

    /// @notice Thrown when caller is not the vault
    error OnlyVault(address caller);

    // ============ Core Routing Functions ============

    /**
     * @notice Deposit USDC to yield protocols based on weights
     * @dev Called by USDL vault after receiving USDC from user
     * @param amount Amount of USDC to deposit
     */
    function depositToProtocols(uint256 amount) external;

    /**
     * @notice Redeem USDC from yield protocols based on weights
     * @dev Called by USDL vault to fulfill user redemption
     * @param amount Target amount of USDC to redeem
     * @return redeemed Actual amount of USDC redeemed
     */
    function redeemFromProtocols(uint256 amount) external returns (uint256 redeemed);

    // ============ Yield Asset Management ============

    /**
     * @notice Add a new yield asset (always starts with weight=0)
     * @dev Asset starts inactive. Use updateWeights() to activate.
     * @param token Yield token address (aUSDC, sUSDS, OUSG, etc.)
     * @param depositToken Token to deposit (usually USDC)
     * @param manager Manager contract (vault, pool, instant manager)
     * @param assetType Protocol type for routing
     */
    function addYieldAsset(address token, address depositToken, address manager, AssetType assetType) external;

    /**
     * @notice Updates weights for ALL registered yield assets
     * @dev Array length MUST match number of registered assets.
     *      Sum of weights MUST equal BASIS_POINTS (10,000).
     *      Setting weight to 0 automatically drains all holdings from that asset.
     *      Two-step deactivation: updateWeights([..., 0, ...]) -> removeYieldAsset()
     * @param weights Ordered array of weights matching registered asset order
     */
    function updateWeights(uint256[] calldata weights) external;

    /**
     * @notice Remove a yield asset (must have weight=0 and balance=0)
     * @dev Two-step removal: updateWeights([..., 0, ...]) -> removeYieldAsset()
     * @param token Yield token address to remove
     */
    function removeYieldAsset(address token) external;

    /**
     * @notice Get total value across all yield protocols (in USDC)
     * @return value Total value in USDC (6 decimals)
     */
    function getTotalValue() external view returns (uint256 value);

    /**
     * @notice Get yield asset configuration
     * @param token Yield token address
     * @return config Yield asset configuration
     */
    function getYieldAssetConfig(address token) external view returns (YieldAssetConfig memory config);

    /**
     * @notice Get yield asset weight
     * @param token Yield token address
     * @return weight Weight in basis points
     */
    function getYieldAssetWeight(address token) external view returns (uint256 weight);

    /**
     * @notice Get all yield assets with weights
     * @return tokens Array of yield token addresses
     * @return weights Array of weights in basis points
     */
    function getAllYieldAssets() external view returns (address[] memory tokens, uint256[] memory weights);

    /**
     * @notice Get number of yield assets
     * @return count Number of configured yield assets
     */
    function getYieldAssetCount() external view returns (uint256 count);

    // ============ Sky Protocol ============

    /**
     * @notice Configure Sky protocol addresses
     * @param litePSM LitePSMWrapper address
     * @param usds USDS stablecoin address
     * @param sUsds sUSDS vault address
     */
    function setSkyConfig(address litePSM, address usds, address sUsds) external;

    /**
     * @notice Get Sky protocol configuration
     * @return litePSM LitePSMWrapper address
     * @return usds USDS stablecoin address
     * @return sUsds sUSDS vault address
     */
    function getSkyConfig() external view returns (address litePSM, address usds, address sUsds);

    // ============ Chainlink Automation ============

    /**
     * @notice Manually accrue yield from underlying yield assets
     * @dev Calculates actual value and updates USDL rebase index
     * @return yieldAccrued Amount of yield accrued
     */
    function accrueYield() external returns (uint256 yieldAccrued);

    /**
     * @notice Set automation interval for yield accrual
     * @param interval Interval in seconds (0 to disable)
     */
    function setYieldAccrualInterval(uint256 interval) external;

    /**
     * @notice Get last yield accrual timestamp
     * @return timestamp Unix timestamp of last accrual
     */
    function getLastYieldAccrualTimestamp() external view returns (uint256 timestamp);

    /**
     * @notice Get automation interval
     * @return interval Interval in seconds
     */
    function getYieldAccrualInterval() external view returns (uint256 interval);

    // ============ Admin ============

    /**
     * @notice Set the USDL vault address
     * @param vault USDL vault address
     */
    function setVault(address vault) external;

    /**
     * @notice Get the USDL vault address
     * @return vault USDL vault address
     */
    function getVault() external view returns (address vault);

    /**
     * @notice Emergency withdraw all assets to vault
     * @dev Only callable by admin in emergency situations
     */
    function emergencyWithdraw() external;
}
