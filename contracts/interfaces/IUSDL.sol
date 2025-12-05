// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title IUSDL
 * @author Lendefi Markets
 * @notice Interface for USDL vault callbacks from YieldRouter
 * @dev Used by YieldRouter to update USDL state after yield accrual
 */
interface IUSDL {
    /**
     * @notice Update the rebase index after yield accrual
     * @dev Only callable by YieldRouter (ROUTER_ROLE)
     * @param newIndex New rebase index value
     */
    function updateRebaseIndex(uint256 newIndex) external;

    /**
     * @notice Update total deposited assets after yield accrual
     * @dev Only callable by YieldRouter (ROUTER_ROLE)
     * @param newTotal New total deposited assets value
     */
    function updateTotalDepositedAssets(uint256 newTotal) external;

    /**
     * @notice Get current rebase index
     * @return Current rebase index (scaled by REBASE_INDEX_PRECISION)
     */
    function rebaseIndex() external view returns (uint256);

    /**
     * @notice Get total deposited assets
     * @return Total USDC deposited by users
     */
    function totalDepositedAssets() external view returns (uint256);

    /**
     * @notice Get the underlying asset address (USDC)
     * @return USDC token address
     */
    function asset() external view returns (address);
}
