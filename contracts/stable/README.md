# USDL - Yield-Bearing USD Stablecoin

**Version:** 1.0  
**Contracts:** `USDL.sol` + `YieldRouter.sol`  
**Lines of Code:** ~900 (USDL) + ~950 (YieldRouter)  
**Test Coverage:** 451 tests (100% passing)  
**Audit Status:** Complete - All HIGH findings resolved

---

## Overview

USDL is a **yield-bearing USD stablecoin** that generates passive income for holders through automated DeFi yield strategies. Built on the ERC-4626 vault standard, USDL maintains a 1:1 peg with USDC while automatically distributing yield to all holders through daily rebasing.

### The Problem with Traditional Stablecoins

Traditional stablecoins like USDC and USDT sit idle in wallets, earning nothing for holders while issuers collect billions in treasury yield. USDL changes this paradigm by:

1. **Passing yield to holders** - All protocol earnings flow to USDL holders
2. **Zero onboarding friction** - Deposit USDC, receive USDL. No KYC, no lock-ups, no minimums beyond 1 USDC
3. **Daily automatic rebasing** - Your balance grows automatically without any action required
4. **Institutional-grade yield sources** - US Treasuries (OUSG), blue-chip DeFi (Aave, Morpho, sUSDS)

---

## Architecture

USDL separates concerns into two contracts for better security, upgradeability, and maintainability:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USDL ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────────┐          ┌──────────────────────────┐            │
│   │       USDL.sol       │          │     YieldRouter.sol      │            │
│   │   (Vault + Token)    │◄────────►│   (Yield Management)     │            │
│   ├──────────────────────┤          ├──────────────────────────┤            │
│   │ • ERC20/ERC4626      │          │ • Yield Asset Registry   │            │
│   │ • Rebasing Shares    │          │ • Protocol Routing       │            │
│   │ • CCIP Bridge        │          │ • Chainlink Automation   │            │
│   │ • Access Control     │          │ • Multi-Protocol Support │            │
│   │ • Pause/Blacklist    │          │ • Inflation Protection   │            │
│   └──────────────────────┘          └──────────────────────────┘            │
│              │                                   │                          │
│              │      USDC                         │  Yield Tokens            │
│              ▼                                   ▼                          │
│   ┌──────────────────────────────────────────────────────────────┐          │
│   │                     Yield Protocols                          │          │
│   ├──────────┬──────────┬──────────┬──────────┬──────────────────┤          │
│   │   OUSG   │  Aave V3 │  Morpho  │ Lendefi  │     sUSDS        │          │
│   │ (T-Bills)│ (aUSDC)  │ (Vaults) │ (Vaults) │  (Sky Protocol)  │          │
│   └──────────┴──────────┴──────────┴──────────┴──────────────────┘          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Contract Responsibilities

| Contract | Responsibility |
|----------|---------------|
| **USDL.sol** | ERC20/ERC4626 vault, rebasing mechanism, CCIP bridge, access control, pause/blacklist |
| **YieldRouter.sol** | Yield asset registry, protocol-specific deposit/withdraw, Chainlink Automation, value calculation |

### User Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER FLOW                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   USDC ──────► USDL ──────► YieldRouter ──────► Yield Protocols │
│                 │                │                    │          │
│                 │         pendingDeposits       ┌─────┴─────┐    │
│                 │          (lazy batch)         │           │    │
│                 │                │           OUSG    Aave   Sky  │
│                 │                │         (T-Bills) (aUSDC)(sUSDS)│
│                 │                │              │           │    │
│                 │                │              └─────┬─────┘    │
│                 │                │                    │          │
│                 │    Chainlink Automation (2x daily)  │          │
│                 │         performUpkeep()             │          │
│                 │                │                    │          │
│                 │                ◄────────────────────┘          │
│                 │    Netting: allocate OR harvest (not both)     │
│                 │                │                               │
│                 ◄────────────────┘                               │
│           Rebase Index ↑                                         │
│                 │                                                │
│                 ▼                                                │
│           User balanceOf() ↑                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Simple Example

```
Day 1:   Alice deposits 10,000 USDC → receives 10,000 USDL
         Bob deposits 5,000 USDC → receives 5,000 USDL
         
Day 2:   YieldRouter accrues yield, USDL.rebaseIndex increases
         Alice's wallet now shows 10,001.37 USDL (no action taken)
         Bob's wallet now shows 5,000.68 USDL (no action taken)
         
Day 365: After 5% APY from yield positions
         Alice: 10,000 USDL → redeemable for 10,500 USDC
         Bob: 5,000 USDL → redeemable for 5,250 USDC
         
         Alice redeems: 10,500 USDC - 10.50 fee (0.1%) = 10,489.50 USDC received
```

---

## Key Features

### 1. Zero Onboarding Friction

USDL is designed for maximum accessibility:

- **No KYC Required** - Permissionless smart contract
- **No Minimum Beyond 1 USDC** - Anyone can participate
- **No Lock-up Periods** - Withdraw anytime
- **No Claiming Required** - Yield appears automatically in your balance
- **No Gas for Yield** - Rebasing is handled by Chainlink Automation

Simply approve and deposit USDC. Your wallet balance grows daily.

### 2. Daily Automatic Rebasing

USDL uses a **rebase index** to distribute yield proportionally to all holders without requiring any user action:

```solidity
// Rebase math (6 decimal precision matching USDC)
balanceOf(user) = rawShares[user] × rebaseIndex / 1,000,000

// Example progression
Day 1:   rebaseIndex = 1,000,000 (1.0)  → 1000 shares = 1000 USDL
Day 30:  rebaseIndex = 1,004,100 (1.0041) → 1000 shares = 1004.10 USDL  
Day 365: rebaseIndex = 1,050,000 (1.05)  → 1000 shares = 1050 USDL
```

**How Rebasing Works:**
1. Chainlink Automation triggers `YieldRouter.performUpkeep()` (2x daily)
2. YieldRouter calculates total yield from all protocol positions
3. YieldRouter uses **netting optimization** to minimize gas (see below)
4. YieldRouter calls `USDL.updateRebaseIndex()` with new value
5. All holder balances increase automatically (no user action needed)

### 3. Batched Deposits with Netting Optimization (v5.0)

**The Problem with Immediate Deposits:**
In v4.0, every user deposit immediately called `depositToProtocols()`, triggering expensive protocol interactions for every single deposit. This wasted gas, especially when yield was being harvested at the same time.

**The v5.0 Solution - Lazy Batched Deposits with Netting:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    BATCHED DEPOSIT FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User deposits throughout the day:                               │
│                                                                  │
│    User A: 1,000 USDC ──► pendingDeposits += 1,000              │
│    User B: 5,000 USDC ──► pendingDeposits += 5,000              │
│    User C: 2,000 USDC ──► pendingDeposits += 2,000              │
│                          ─────────────────                       │
│                          pendingDeposits = 8,000                 │
│                                                                  │
│  Chainlink Automation (2x daily):                                │
│                                                                  │
│    performUpkeep() calculates:                                   │
│    ├── pendingDeposits = 8,000 USDC                             │
│    ├── yieldAccrued = 500 USDC (from protocols)                 │
│    │                                                             │
│    └── NETTING: 8,000 - 500 = 7,500 USDC                        │
│                                                                  │
│    Result: Only allocate 7,500 to protocols                      │
│            500 stays as USDC (harvested yield)                   │
│            ✓ Saved one protocol withdraw operation!              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Netting Logic:**

| Scenario | Old Way (v4.0) | New Way (v5.0 Netting) | Gas Saved |
|----------|----------------|------------------------|-----------|
| pending=8000, yield=500 | deposit(8000) + harvest(500) | deposit(7500) only | ~50% |
| pending=500, yield=2000 | deposit(500) + harvest(2000) | harvest(1500) only | ~50% |
| pending=1000, yield=1000 | deposit(1000) + harvest(1000) | Nothing! Perfect offset | ~100% |
| pending=5000, yield=0 | deposit(5000) | deposit(5000) | 0% |

**Key Insight:** When pending deposits ≈ yield to harvest, they cancel out and we move nothing!

### 4. Withdraw vs Redeem Flows (v5.1)

To ensure robust handling of different asset types (ERC4626 shares vs underlying assets), YieldRouter implements strict separation of concerns:

| Flow | Function | Use Case | Logic |
|------|----------|----------|-------|
| **Withdraw** | `_withdraw*` | Amount-based operations (Harvesting yield, User withdrawals) | Withdraws specific amount of underlying asset (USDC). Ensures exact output. |
| **Redeem** | `_redeem*` | Share-based operations (Auto-drain, Emergency withdraw) | Burns specific amount of shares. Used when exiting positions completely. |

This separation prevents issues where share-to-asset conversion rates might leave dust or fail to extract exact amounts needed for rebalancing.

### 5. Multi-Protocol Yield Generation

YieldRouter diversifies across institutional-grade yield sources:

| Protocol | Asset | Yield Source | Risk Profile |
|----------|-------|--------------|--------------|
| **Ondo OUSG** | Tokenized T-Bills | US Treasury yield | Ultra-low (US govt backed) |
| **Aave V3** | aUSDC | DeFi lending | Low (battle-tested) |
| **Sky Protocol** | sUSDS | USDS savings rate | Low (Sky governance) |
| **Lendefi** | Lending Vaults | DeFi lending | Low (audited) |
| **ERC4626 Vaults** | Various | Optimized strategies | Configurable |

**Configurable Allocation (managed by YieldRouter):**
```
Example conservative allocation:
├── OUSG (T-Bills):  50%  ─── US Treasury yield (~5%)
├── sUSDS (Sky):     30%  ─── Sky savings rate (~6%)
└── Aave V3:         20%  ─── DeFi lending (~3-4%)
                    ────
                    100%
```

### 6. Minimal Fee Structure

| Fee | Amount | When Applied |
|-----|--------|--------------|
| **Deposit Fee** | **0%** | Never |
| **Redemption Fee** | **0.1%** | Only on withdrawal |
| **Management Fee** | **0%** | Never |
| **Performance Fee** | **0%** | Never |

### 7. Cross-Chain Native (CCIP)

USDL is designed for multi-chain from day one:

- **Chainlink CCIP Integration** - Native burn-and-mint bridging
- **Ghost Share Pattern** - Bridge mints don't affect share price
- **No Wrapped Tokens** - Native USDL on all chains
- **Inflation Protected** - Bridge mints don't dilute existing holders

---

## Security Features

### Inflation Attack Resistance

YieldRouter uses `trackedUSDCBalance` for internal accounting, preventing donation attacks:

```solidity
// Donation attack prevented
Attacker donates 1M USDC directly to YieldRouter
Result: Ignored - trackedUSDCBalance only updates through legitimate deposits/redeems

// Value calculation uses internal accounting
getTotalValue() = sum(yieldAssetValues) + trackedUSDCBalance
// NOT: IERC20(usdc).balanceOf(address(this)) ← vulnerable to donations
```

### Oracle Security (OUSG)

Comprehensive Chainlink oracle validation for OUSG price:
- Staleness check: Maximum 1 hour
- Round completeness verification
- Positive price validation

### Access Control

**USDL Roles:**
| Role | Permissions |
|------|-------------|
| `DEFAULT_ADMIN` | Role management, treasury, router configuration |
| `PAUSER` | Emergency pause/unpause |
| `BRIDGE` | CCIP mint/burn |
| `UPGRADER` | Contract upgrades |
| `BLACKLISTER` | Compliance blacklist |
| `ROUTER` | Rebase index and total assets updates (YieldRouter only) |

**YieldRouter Roles:**
| Role | Permissions |
|------|-------------|
| `DEFAULT_ADMIN` | Role management, vault configuration, emergency |
| `MANAGER` | Yield assets, weights, accrual, Sky config |
| `UPGRADER` | Contract upgrades |
| `VAULT` | Deposit/redeem operations (USDL only) |

### Emergency Controls

- **Pause (USDL)** - Halt all vault operations
- **Emergency Withdraw (YieldRouter)** - Redeem all yield positions to vault
- **Rescue Donated Tokens** - Recover excess tokens from donations

---

## Technical Specifications

### USDL Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_DEPOSIT` | 1 USDC | Minimum deposit amount |
| `MAX_FEE_BPS` | 500 (5%) | Maximum redemption fee |
| `REBASE_INDEX_PRECISION` | 1e6 | 6 decimal precision |
| `BASIS_POINTS` | 10,000 | 100% in basis points |

### YieldRouter Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_YIELD_ASSETS` | 10 | Gas limit protection |
| `MAX_ORACLE_STALENESS` | 1 hour | Oracle freshness requirement |
| `MIN_AUTOMATION_INTERVAL` | 1 hour | Minimum accrual frequency |
| `BASIS_POINTS` | 10,000 | Weight precision |

### ERC-4626 Compliance

Full ERC-4626 vault standard with rebased share interface:

```solidity
// All share amounts are REBASED (matching balanceOf output)
deposit(assets) → returns rebased shares
mint(shares)    → accepts rebased shares  
withdraw(assets) → returns rebased shares burned
redeem(shares)  → accepts rebased shares

// User experience
uint256 myBalance = vault.balanceOf(me);  // Shows 1,050 after yield
vault.redeem(myBalance, me, me);          // ✅ Works - redeems full balance
```

### Gas Optimizations

- Memory caching of storage variables (`usdc`, `vault`, `trackedUSDCBalance`)
- Batched storage writes in loops
- EnumerableMap for O(1) yield asset lookups
- Maximum 10 yield assets to bound gas costs

---

## Interface Overview

### IUSDL (Router Callbacks)

```solidity
interface IUSDL {
    function updateRebaseIndex(uint256 newIndex) external;
    function updateTotalDepositedAssets(uint256 newTotal) external;
    function rebaseIndex() external view returns (uint256);
    function totalDepositedAssets() external view returns (uint256);
    function asset() external view returns (address);
}
```

### IYieldRouter (Core Functions)

```solidity
interface IYieldRouter {
    // Core routing
    function depositToProtocols(uint256 amount) external;
    function redeemFromProtocols(uint256 amount) external returns (uint256);
    function getTotalValue() external view returns (uint256);
    
    // Yield asset management
    function addYieldAsset(address token, address depositToken, address manager, AssetType assetType) external;
    function updateWeights(uint256[] calldata weights) external;
    function removeYieldAsset(address token) external;
    
    // Chainlink Automation
    function checkUpkeep(bytes calldata) external view returns (bool, bytes memory);
    function performUpkeep(bytes calldata) external;
    function accrueYield() external returns (uint256);
}
```

---

## Quick Start

### Deposit USDC

```solidity
// 1. Approve USDC
IERC20(usdc).approve(address(USDL), amount);

// 2. Deposit
uint256 shares = USDL.deposit(amount, msg.sender);
```

### Check Your Balance

```solidity
// Balance grows daily automatically
uint256 balance = USDL.balanceOf(msg.sender);
```

### Withdraw

```solidity
// Redeem all (0.1% fee applied)
uint256 assets = USDL.redeem(USDL.balanceOf(msg.sender), msg.sender, msg.sender);
```

### Admin: Configure Yield Assets

```solidity
// Add a yield asset (starts inactive with weight=0)
yieldRouter.addYieldAsset(
    sUSDS,          // yield token
    USDC,           // deposit token  
    sUSDS,          // manager (vault address)
    AssetType.SKY_SUSDS
);

// Activate with weights (must sum to 10000)
yieldRouter.updateWeights([5000, 3000, 2000]); // 50%, 30%, 20%
```

---

## Deployment

### Prerequisites

1. Deploy USDL proxy
2. Deploy YieldRouter proxy with USDL address
3. Call `USDL.setYieldRouter(routerAddress)` to link them
4. Configure yield assets on YieldRouter
5. Register with Chainlink Automation

### Mutual Trust Setup

```solidity
// USDL grants ROUTER_ROLE to YieldRouter
usdl.setYieldRouter(routerAddress);  // Also grants ROUTER_ROLE

// YieldRouter already has VAULT_ROLE for USDL from initialization
// Both contracts can now interact securely
```

---

## Audit Status

✅ **All findings resolved**

| Severity | Finding | Status |
|----------|---------|--------|
| HIGH | Share accounting conflicts | ✅ Fixed |
| HIGH | ERC-4626 raw/rebased mismatch | ✅ Fixed |
| HIGH | Allowance unit mismatch | ✅ Fixed |
| HIGH | Inflation attack via donations | ✅ Fixed (trackedUSDCBalance) |
| MEDIUM | Oracle validation | ✅ Implemented |
| MEDIUM | Aave V3 integration | ✅ Implemented |
| MEDIUM | OUSG minimum redemption | ✅ Handled (try/catch) |
| LOW | Unbounded yield assets | ✅ Capped at 10 |

---

## Version History

| Version | Changes |
|---------|---------|
| **v5.0** | **Batched deposits with netting optimization** - Lazy `pendingDeposits` tracking, Chainlink batches allocations 2x daily, netting algorithm saves ~50% gas by offsetting deposits against yield harvesting |
| v4.0 | Separated yield logic into YieldRouter, inflation attack protection, gas optimizations |
| v3.0 | Multi-protocol support, Chainlink Automation, Sky Protocol integration |
| v2.0 | ERC-4626 compliance, rebasing mechanism |
| v1.0 | Initial release |

---

## License

MIT License

---

## Contact

**Security:** security@lendefimarkets.com  
**Website:** https://lendefimarkets.com
