# Fork Tests for YieldRouter

This directory contains mainnet fork tests that validate the YieldRouter's integration with real DeFi protocols on Ethereum mainnet.

## Overview

These tests use Hardhat's mainnet forking feature to interact with live protocol contracts, ensuring our YieldRouter correctly deposits, allocates, and redeems from each yield provider.

## Prerequisites

### Environment Setup

Set the `ETHEREUM_RPC_URL` environment variable in your `.env` file:

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

Without this variable, fork tests will be skipped automatically.

### Running Fork Tests

```bash
# Run all fork tests
npx hardhat test test/fork/YieldRouter.fork.test.js --network hardhat

# Run a specific protocol's test
npx hardhat test test/fork/YieldRouter.fork.test.js --network hardhat --grep "Aave"
npx hardhat test test/fork/YieldRouter.fork.test.js --network hardhat --grep "Sky"
npx hardhat test test/fork/YieldRouter.fork.test.js --network hardhat --grep "Ondo"
```

---

## Supported Yield Protocols

### 1. Aave V3 (aUSDC)

**Protocol Type:** `AssetType.AAVE_V3`

**Mainnet Contracts:**
| Contract | Address |
|----------|---------|
| Aave V3 Pool | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| aUSDC Token | Dynamically fetched via `pool.getReserveData(USDC)` |

**How it works:**
1. YieldRouter calls `IAaveV3Pool.supply(USDC, amount, router, 0)` to deposit
2. Router receives aUSDC tokens (interest-bearing)
3. For redemption, router calls `IAaveV3Pool.withdraw(USDC, amount, recipient)`

**Test Requirements:**
- Minimum deposit: None (we test with 1,000 USDC)
- No KYC/whitelist requirements

---

### 2. Sky sUSDS (Savings USDS)

**Protocol Type:** `AssetType.SKY_SUSDS`

**Mainnet Contracts:**
| Contract | Address |
|----------|---------|
| LitePSM (USDC→USDS) | `0xA188EEC8F81263234dA3622A406892F3D630f98c` |
| USDS Token | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` |
| sUSDS Vault (ERC4626) | `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD` |

**How it works:**
1. **USDC → USDS**: Router calls `ILitePSMWrapper.sellGem(router, amount)` to swap USDC for USDS at 1:1
2. **USDS → sUSDS**: Router deposits USDS into the sUSDS ERC4626 vault via `IERC4626.deposit(usdsAmount, router)`
3. For redemption:
   - **sUSDS → USDS**: Router calls `IERC4626.redeem(shares, router, router)`
   - **USDS → USDC**: Router calls `ILitePSMWrapper.buyGem(recipient, amount)` to swap back

**Configuration Required:**
```solidity
router.setSkyConfig(SKY_LITE_PSM, SKY_USDS, SKY_SUSDS);
```

**Test Requirements:**
- Minimum deposit: None (we test with 1,000 USDC)
- No KYC/whitelist requirements

---

### 3. Ondo OUSG (US Government Securities)

**Protocol Type:** `AssetType.ONDO_OUSG`

**Mainnet Contracts:**
| Contract | Address | Purpose |
|----------|---------|---------|
| OUSG Token | `0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92` | The RWA token (used for ID registry) |
| rOUSG Token | `0x54043c656F0FAd0652D9Ae2603cDF347c5578d00` | Rebasing version of OUSG |
| InstantManager | `0x93358db73B6cd4b98D89c8F5f230E81a95c2643a` | Handles subscribe/redeem |
| OndoIDRegistry | `0xcf6958D69d535FD03BD6Df3F4fe6CDcd127D97df` | User registration for KYC |
| Ondo Admin | `0x5AE21c99FC5f1584D8Cb09a298CFFd92B5d178eF` | Has MASTER_CONFIGURER_ROLE |

**How it works:**
1. **Subscribe**: Router calls `IOUSGInstantManager.subscribe(USDC, amount, 0)` to deposit USDC and receive OUSG
2. **Redeem**: Router calls `IOUSGInstantManager.redeem(ousgAmount, USDC, 0)` to burn OUSG and receive USDC

**CRITICAL: KYC/Whitelist Requirements**

Ondo requires all users (including smart contracts) to be registered in their OndoIDRegistry before they can subscribe to OUSG. The InstantManager checks:

```solidity
bytes32 userId = ondoIDRegistry.getRegisteredID(rwaToken, msg.sender);
if (userId == bytes32(0)) revert UserNotRegistered();
```

**For fork testing, we impersonate the Ondo admin to whitelist the YieldRouter:**

```javascript
// Impersonate Ondo admin
await network.provider.request({ method: "hardhat_impersonateAccount", params: [ONDO_ADMIN] });
const ondoAdmin = await ethers.getSigner(ONDO_ADMIN);

// Register router in OndoIDRegistry (must use OUSG token address, not rOUSG)
const ondoIDRegistry = new ethers.Contract(ONDO_ID_REGISTRY, [...], ondoAdmin);
const userID = ethers.keccak256(ethers.toUtf8Bytes("LENDEFI_YIELD_ROUTER"));
await ondoIDRegistry.setUserID(OUSG_TOKEN, [routerAddress], userID);
```

**Important Notes:**
- Registration must be against **OUSG token** (`0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92`), NOT rOUSG
- The `setUserID` function requires `MASTER_CONFIGURER_ROLE`
- In production, Lendefi must be officially onboarded by Ondo Finance

**Test Requirements:**
- **Minimum deposit: 100,000 USDC** (Ondo's minimum subscription amount)
- Must whitelist YieldRouter in OndoIDRegistry before any operations

---

## Test Flow

All fork tests follow the same pattern:

1. **Setup Phase (beforeEach)**
   - Deploy USDL and YieldRouter as upgradeable proxies
   - Fund test user with USDC (impersonate Circle treasury whale)
   - Wire USDL to YieldRouter
   - Configure protocol-specific settings (Sky config, Ondo whitelist, etc.)
   - Register yield asset with correct `AssetType`

2. **Deposit Phase**
   - User approves and deposits USDC into USDL
   - USDC is held in YieldRouter as `pendingDeposits`

3. **Allocation Phase**
   - Advance time past `yieldAccrualInterval`
   - Call `router.performUpkeep("0x")` to trigger allocation
   - USDC is deployed to the yield protocol
   - Router receives yield-bearing tokens (aUSDC, sUSDS, or OUSG)

4. **Redemption Phase**
   - Mine additional blocks to satisfy `MIN_HOLD_BLOCKS` (5 blocks)
   - User calls `usdl.redeem(shares, receiver, owner)` to withdraw
   - YieldRouter redeems from protocol and returns USDC
   - Verify user receives ≥99% of original deposit (accounting for fees/rounding)

---

## Key Constants

### USDC Whale (for test funding)
```javascript
const USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8"; // Circle treasury
```

### Asset Types
```javascript
const AssetType = {
    ERC4626: 0,     // Generic ERC4626 vaults
    AAVE_V3: 1,     // Aave V3 lending pools
    ONDO_OUSG: 2,   // Ondo OUSG RWA token
    SKY_SUSDS: 3    // Sky sUSDS savings vault
};
```

---

## Troubleshooting

### "UserNotRegistered" Error (Ondo)
The YieldRouter is not registered in the OndoIDRegistry. Ensure:
1. You're using the correct OUSG token address (NOT rOUSG)
2. The admin address has `MASTER_CONFIGURER_ROLE`
3. You call `setUserID(OUSG_TOKEN, [routerAddress], userID)` with a non-zero userID

### "Minimum deposit" Errors
Some protocols have minimum deposit requirements:
- Ondo OUSG: 100,000 USDC minimum
- Aave V3: No minimum
- Sky sUSDS: No minimum

### Fork Test Timeout
Fork tests can be slow due to RPC calls. Default timeout is 180 seconds. If tests still timeout, check your RPC provider's rate limits.

### "ETHEREUM_RPC_URL not set"
Fork tests require an Ethereum mainnet RPC URL. Add to `.env`:
```
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
```

---

## Production Considerations

### Ondo OUSG
- **Must complete Ondo's KYC onboarding process** for the YieldRouter contract address
- Contact Ondo Finance to register the production YieldRouter address
- Ondo may require legal agreements and compliance verification

### Aave V3
- No special onboarding required
- Monitor Aave's reserve status and utilization rates

### Sky sUSDS
- No special onboarding required
- Monitor Sky's PSM liquidity for large redemptions
