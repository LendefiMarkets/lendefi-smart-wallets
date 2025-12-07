// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Yield Protocol Interfaces
 * @notice Interfaces for various yield-bearing asset protocols
 * @dev Used by YieldRouter for protocol-specific deposit/redeem calls
 */

// ============ Asset Type Enum ============

/**
 * @notice Enum to identify yield protocol types
 * @dev Used to route deposit/redeem calls to correct interface
 */
enum AssetType {
    ERC4626, // Standard tokenized vault (sDAI, Morpho vaults)
    AAVE_V3, // Aave V3 lending pool
    ONDO_OUSG, // Ondo OUSG InstantManager (requires whitelist)
    SKY_SUSDS // Sky sUSDS (USDC → USDS via LitePSM → sUSDS via ERC4626)
}

// ============ Aave V3 Interface ============

/**
 * @title IAaveV3Pool
 * @notice Interface for Aave V3 lending pool
 * @dev Mainnet: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
 */
interface IAaveV3Pool {
    /**
     * @notice Supply assets to the pool
     * @param asset The address of the underlying asset to supply
     * @param amount The amount to be supplied
     * @param onBehalfOf Address that will receive the aTokens
     * @param referralCode Code for referral program (use 0)
     */
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /**
     * @notice Withdraw assets from the pool
     * @param asset The address of the underlying asset
     * @param amount The amount to withdraw (type(uint256).max for all)
     * @param to Address that will receive the underlying
     * @return The final amount withdrawn
     */
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /**
     * @notice Get the aToken address for an asset
     */
    function getReserveData(address asset)
        external
        view
        returns (
            uint256 configuration,
            uint128 liquidityIndex,
            uint128 currentLiquidityRate,
            uint128 variableBorrowIndex,
            uint128 currentVariableBorrowRate,
            uint128 currentStableBorrowRate,
            uint40 lastUpdateTimestamp,
            uint16 id,
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress,
            address interestRateStrategyAddress,
            uint128 accruedToTreasury,
            uint128 unbacked,
            uint128 isolationModeTotalDebt
        );
}

// ============ Ondo OUSG Interface (Optional) ============

/**
 * @title IOndoOracle
 * @notice Interface for Ondo Oracle
 * @dev Returns price with 18 decimals
 */
interface IOndoOracle {
    /**
     * @notice Get the price of an asset
     * @param token The asset address to get price for
     * @return price The price (scaled by 1e18)
     */
    function getAssetPrice(address token) external view returns (uint256 price);
}

/**
 * @title IOUSGInstantManager
 * @notice Interface for Ondo OUSG Instant Minting
 * @dev Mainnet: 0x93358db73B6cd4b98D89c8F5f230E81a95c2643a
 *      REQUIRES WHITELIST - Your contract must be registered in OndoIDRegistry
 */
interface IOUSGInstantManager {
    /**
     * @notice Subscribe to OUSG by depositing a supported token
     * @param depositToken Address of the deposit token (e.g., USDC)
     * @param depositAmount Amount of deposit token to convert
     * @param minimumRwaReceived Minimum amount of OUSG to receive (slippage protection)
     * @return rwaAmountOut Amount of OUSG received
     */
    function subscribe(
        address depositToken,
        uint256 depositAmount,
        uint256 minimumRwaReceived
    ) external returns (uint256 rwaAmountOut);

    /**
     * @notice Redeem OUSG for a supported token
     * @param rwaAmount Amount of OUSG to redeem
     * @param receivingToken Address of the token to receive (e.g., USDC)
     * @param minimumTokenReceived Minimum amount of tokens to receive (slippage protection)
     * @return receiveTokenAmount Amount of tokens received
     */
    function redeem(
        uint256 rwaAmount,
        address receivingToken,
        uint256 minimumTokenReceived
    ) external returns (uint256 receiveTokenAmount);

    /**
     * @notice Minimum deposit amount in USD (scaled by 1e18)
     */
    function minimumDepositUSD() external view returns (uint256);

    /**
     * @notice Minimum redemption amount in USD (scaled by 1e18)
     */
    function minimumRedemptionUSD() external view returns (uint256);

    /**
     * @notice Get the OUSG token address
     */
    function rwaToken() external view returns (address);

    /**
     * @notice Get the Ondo oracle address for price data
     */
    function ondoOracle() external view returns (address);
}

/**
 * @title IOUSG
 * @notice Interface for OUSG token
 * @dev Mainnet: 0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92
 */
interface IOUSG {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// ============ Sky Protocol Interfaces ============

/**
 * @title ILitePSMWrapper
 * @notice Interface for Sky LitePSM Wrapper (USDC <-> USDS)
 * @dev Mainnet: 0xA188EEC8F81263234dA3622A406892F3D630f98c
 *      Enables 1:1 conversion between USDC and USDS with no fees currently
 */
interface ILitePSMWrapper {
    /**
     * @notice Sell USDC to receive USDS (USDC → USDS)
     * @param usr Address to receive USDS
     * @param gemAmt Amount of USDC to sell (6 decimals)
     * @return usdsAmt Amount of USDS received (18 decimals)
     */
    function sellGem(address usr, uint256 gemAmt) external returns (uint256 usdsAmt);

    /**
     * @notice Buy USDC with USDS (USDS → USDC)
     * @param usr Address to receive USDC
     * @param gemAmt Amount of USDC to buy (6 decimals)
     * @return usdsAmt Amount of USDS spent (18 decimals)
     */
    function buyGem(address usr, uint256 gemAmt) external returns (uint256 usdsAmt);

    /**
     * @notice Get the USDS token address
     * @return The USDS token contract address
     */
    function usds() external view returns (address);

    /**
     * @notice Get the USDC (gem) token address
     * @return The USDC token contract address
     */
    function gem() external view returns (address);

    /**
     * @notice Fee for selling gem (USDC → USDS), in WAD (1e18 = 100%)
     * @return The tin fee value
     */
    function tin() external view returns (uint256);

    /**
     * @notice Fee for buying gem (USDS → USDC), in WAD (1e18 = 100%)
     * @return The tout fee value
     */
    function tout() external view returns (uint256);
}

/**
 * @title ISUsds
 * @notice Interface for Sky sUSDS (Savings USDS) vault
 * @dev Mainnet: 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD
 *      ERC4626 compliant vault that earns Sky Savings Rate on USDS deposits
 *      No fees assessed, fees cannot be enabled in the future
 */
interface ISUsds {
    // ERC4626 functions
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function maxDeposit(address) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewWithdraw(uint256 assets) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);

    // ERC20 functions
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}
