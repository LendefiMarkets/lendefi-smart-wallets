# Security Fixes Report - December 9, 2025

This document outlines the security fixes applied to the Lendefi Smart Wallets codebase based on the "Benchmark Security Review Performed by Bug Hunter" (Version: 1.0.6-beta.1).

## 1. Paymaster Fund Draining via Reverts (Critical)

**Finding ID:** BH-L-Lendefi-001 & BH-L-Lendefi-002
**File:** `contracts/LendefiPaymaster.sol`

### Issue
The Paymaster previously refunded the user's monthly gas quota (`gasUsedThisMonth`) if a transaction reverted in `_postOp`.
*   **Vulnerability:** An attacker could repeatedly send high-gas transactions that revert. The Paymaster would pay the EntryPoint for the gas used, but the user's subscription quota would be reset. This allowed draining the Paymaster's ETH deposit without consuming the attacker's subscription limit.

### Fix
*   **Action:** Removed the refund logic in `_postOp`.
*   **Result:** Users are now charged for the gas used by their transactions, regardless of whether the transaction succeeds or reverts. This aligns with standard blockchain behavior and prevents the draining attack.

```solidity
// contracts/LendefiPaymaster.sol

function _postOp(...) internal override {
    // ...
    // REMOVED:
    // if (mode == PostOpMode.postOpReverted) {
    //     subscriptions[wallet].gasUsedThisMonth = gasUsedBefore;
    //     return;
    // }
    // ...
}
```

## 2. Unbounded Gas Price (High)

**Finding ID:** BH-L-Lendefi-003
**File:** `contracts/LendefiPaymaster.sol`

### Issue
The Paymaster validated the *amount* of gas used but not the *price* of gas (`maxFeePerGas`).
*   **Vulnerability:** An attacker could submit a transaction with an exorbitant gas price (e.g., 100,000 gwei). The EntryPoint would charge the Paymaster a massive amount of ETH for a small amount of gas units, draining funds rapidly.

### Fix
*   **Action:**
    1.  Added a `maxGasPrice` state variable (default: 100 gwei).
    2.  Added a `setMaxGasPrice` administrative function.
    3.  Updated `_validatePaymasterUserOp` to enforce that `maxFeePerGas` and `maxPriorityFeePerGas` do not exceed `maxGasPrice`.

```solidity
// contracts/LendefiPaymaster.sol

// Added check in _validatePaymasterUserOp
unchecked {
    uint256 maxFeePerGas = uint256(userOp.gasFees) & type(uint128).max;
    uint256 maxPriorityFeePerGas = uint256(userOp.gasFees) >> 128;
    if (maxFeePerGas > maxGasPrice || maxPriorityFeePerGas > maxGasPrice) revert GasPriceTooHigh();
}
```

## 3. Router Rotation Allowance (High)

**Finding ID:** BH-L-Lendefi-013, 043, 045, 050, 058
**File:** `contracts/stable/USDL.sol`

### Issue
When rotating the `YieldRouter` via `setYieldRouter`, the contract granted approval to the new router but failed to revoke the infinite ERC20 allowance of the *old* router.
*   **Vulnerability:** If a router contract were compromised or malicious, it could continue to drain USDC from the USDL vault even after being replaced.

### Fix
*   **Action:** Updated `setYieldRouter` to explicitly set the allowance of the old router to 0.

```solidity
// contracts/stable/USDL.sol

if (oldRouter != address(0)) {
    _revokeRole(ROUTER_ROLE, oldRouter);
    IERC20(assetAddress).approve(oldRouter, 0); // Added revocation
}
```

## 4. Griefing via `lastDepositBlock` (Medium/High)

**Finding ID:** BH-L-Lendefi-019, 021, 044, 052, 055, 059, 064
**File:** `contracts/stable/USDL.sol`

### Issue
The `_transferShares` function updated the `lastDepositBlock` of the recipient.
*   **Vulnerability:** An attacker could send a tiny amount of shares (dust) to a victim repeatedly. Each transfer would reset the victim's `lastDepositBlock`, permanently locking their funds due to the `MIN_HOLD_BLOCKS` withdrawal restriction.

### Fix
*   **Action:** Removed the line that updates `lastDepositBlock` in `_transferShares`.
*   **Result:** Share transfers no longer affect the recipient's withdrawal timer. The timer is only updated on explicit deposits/mints initiated by the user.

```solidity
// contracts/stable/USDL.sol

function _transferShares(...) internal {
    // ...
    _shares[to] += rawShares;
    // REMOVED: lastDepositBlock[to] = block.number;
    // ...
}
```

## 5. CCIP Ghost Shares (False Positive - Confirmed)

**Finding ID:** BH-L-Lendefi-017, 024
**File:** `contracts/stable/USDL.sol`

### Analysis
The report flagged that `_mintSharesCCIP` and `_burnSharesCCIP` do not update `_totalShares`.
*   **Conclusion:** This is **intentional design** ("Ghost Shares").
    *   When shares are bridged *out* (burned), `_totalShares` is *not* decreased. This keeps the exchange rate constant for remaining users on the source chain.
    *   When shares are bridged *in* (minted), `_totalShares` is *not* increased. The assets backing these shares are held on the original chain.
    *   **Action:** No code changes were made (reverted initial attempt to "fix").

---
**Verified by:** GitHub Copilot
**Date:** December 9, 2025
