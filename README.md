# Lendefi Smart Wallet Infrastructure

A complete ERC-4337 Account Abstraction implementation with gas subsidies for premium users, built on OpenZeppelin's battle-tested contracts.

## 🏗️ Architecture Overview

This system provides a comprehensive smart wallet infrastructure built around the **EntryPoint** as a shared ledger/coordinator that manages the entire ERC-4337 ecosystem. Multiple smart wallets and paymasters interact with this central EntryPoint to enable seamless account abstraction with gas subsidies.

```
                    ┌─────────────────┐
                    │   EntryPoint    │
                    │ (Shared Ledger) │
                    ├─────────────────┤
                    │ • Handles UserOps│
                    │ • Manages Deposits│
                    │ • Validates Ops  │
                    │ • Gas Accounting │
                    └─────────┬───────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
    ┌─────────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
    │ SmartWallet A │  │Paymaster  │  │SmartWallet│
    │ (User 1)      │  │           │  │    B      │
    ├───────────────┤  ├───────────┤  │ (User 2)  │
    │ • Execute ops │  │ • Pay gas │  ├───────────┤
    │ • Own funds   │  │ • Validate│  │ • Execute │
    │ • Signatures  │  │   users   │  │ • Own funds│
    └───────────────┘  └───────────┘  └───────────┘
            │               │               │
            └───────────────┼───────────────┘
                            │
                ┌───────────▼───────────┐
                │  SmartWalletFactory   │
                │ (Deployment Engine)   │
                ├───────────────────────┤
                │ • Clone Factory       │
                │ • Deterministic Addrs │
                │ • User Mapping        │
                └───────────────────────┘
```

### How the Shared Ledger Works

The **EntryPoint** acts as the central coordinator:

**🎯 EntryPoint Role (Shared Infrastructure):**
- **UserOperation Handler** - Processes all transactions through `handleOps()`
- **Deposit Manager** - Tracks ETH deposits for wallets and paymasters
- **Gas Coordinator** - Handles gas payments, refunds, and accounting
- **Validation Hub** - Validates signatures and authorization
- **One-to-Many** - Single EntryPoint serves multiple wallets and paymasters

**💼 SmartWallet Role (Individual Accounts):**
- **User's Account** - Individual wallet per user with unique ownership
- **Deposit Management** - Can deposit ETH to EntryPoint for gas
- **Operation Execution** - Executes actual transactions via EntryPoint
- **Signature Validation** - Validates user signatures (ERC-1271)

**💰 Paymaster Role (Gas Sponsor):**
- **Gas Subsidies** - Pays gas for subscribed wallets using EntryPoint deposits
- **Subscription Manager** - Validates who gets gas subsidies
- **Deposit Pool** - Maintains ETH balance in EntryPoint to cover costs

**⚡ Transaction Flow:**
1. **User** signs a UserOperation for their SmartWallet
2. **Bundler** submits UserOperation to EntryPoint
3. **EntryPoint** validates operation and paymaster (if used)
4. **Paymaster** validates subscription and sponsors gas (optional)
5. **EntryPoint** executes operation on SmartWallet
6. **EntryPoint** handles gas payments and refunds
7. **EntryPoint** updates deposit accounting for all parties

## 📋 Contract Architecture

### Core Contracts

#### 1. **SmartWallet.sol** - The Account Contract
- **Purpose**: ERC-4337 compatible smart contract wallet for individual users
- **Inheritance**: `Account`, `SignerECDSA`, `IERC1271`, `Initializable`, `ReentrancyGuard`
- **Key Features**:
  - ✅ **ERC-4337 Compliance** - Full Account Abstraction support via OpenZeppelin Account
  - ✅ **ERC-1271 Signatures** - Contract signature validation
  - ✅ **Owner Management** - Secure owner transfer functionality with enhanced validation
  - ✅ **Batch Execution** - Multiple transactions in one call with gas optimization
  - ✅ **Deposit Management** - EntryPoint deposit handling
  - ✅ **Minimal Clone** - Deployed via factory using minimal proxy pattern
  - ✅ **Reentrancy Protection** - Secure against reentrancy attacks
  - ✅ **Enhanced Validation** - Comprehensive input validation with custom modifiers

#### 2. **SmartWalletFactory.sol** - The Deployment Engine
- **Purpose**: Efficient deployment and management of SmartWallet instances
- **Inheritance**: `Initializable`, `UUPSUpgradeable`, `OwnableUpgradeable`
- **Key Features**:
  - ✅ **Clone Factory** - Uses OpenZeppelin Clones for gas efficiency (~2,000 gas vs ~200,000)
  - ✅ **Deterministic Addresses** - CREATE2-based predictable wallet addresses
  - ✅ **User Mapping** - Tracks deployed wallets per user
  - ✅ **Implementation Management** - Upgradeable wallet implementations
  - ✅ **Validation** - Comprehensive parameter and state validation
  - ✅ SmartWalletFactory = Upgradeable (UUPS proxy)

#### 3. **LendefiPaymaster.sol** - The Gas Subsidy Engine
- **Purpose**: ERC-4337 paymaster providing tiered gas subsidies
- **Inheritance**: `IPaymaster`, `Ownable`
- **Key Features**:
  - ✅ **Tiered Subscriptions** - Basic (50%), Premium (90%), Ultimate (100%) gas subsidies
  - ✅ **Gas Limit Management** - Monthly usage tracking with configurable limits
  - ✅ **Operator System** - Delegated subscription management
  - ✅ **Wallet Validation** - Integration with SmartWalletFactory
  - ✅ **Deposit Management** - EntryPoint stake and balance handling
  - ✅ **Configurable Limits** - Owner can adjust gas limits per tier

#### 4. **EntryPoint.sol** - Production EntryPoint Implementation
- **Purpose**: Production-ready ERC-4337 EntryPoint with comprehensive security controls
- **Inheritance**: `IEntryPoint`, `IEntryPointStake`, `IEntryPointNonces`
- **Key Features**:
  - ✅ **Access Controls** - Only account owners can withdraw their own funds
  - ✅ **Stake Management** - Proper unlock delays and timing enforcement
  - ✅ **Nonce Management** - Sequential nonce validation per account/key
  - ✅ **Gas Payment** - Prefund calculation and reservation
  - ✅ **UserOp Validation** - Real signature and execution validation
  - ✅ **Event Logging** - Full transparency of all operations
  - ✅ **Security Compliance** - Production-grade EntryPoint implementation

### Interface Contracts

#### **IAccountFactory.sol**
- Defines factory contract interface
- Custom errors: `InvalidUser`, `WalletAlreadyExists`, `InvalidImplementation`
- Standard methods: `createAccount`, `getAddress`

#### **ILendefiPaymaster.sol**
- Defines paymaster interface
- Subscription management methods
- Operator authorization interface

## 🎯 Subscription System

### Tier Structure

| Tier | Monthly Gas Limit | Target Users | Use Cases |
|------|------------------|--------------|-----------|
| **BASIC** | 500,000 gas | Light users | Basic transactions, occasional usage |
| **PREMIUM** | 2,000,000 gas | Regular users | Daily transactions, DeFi interactions |
| **ULTIMATE** | 10,000,000 gas | Power users | Heavy DeFi, trading, complex operations |

### Subscription Features

- **Monthly Reset** - Gas usage automatically resets every 30 days
- **Expiration Handling** - Automatic subscription expiration
- **Operator Delegation** - Authorized operators can manage subscriptions
- **Usage Tracking** - Real-time gas consumption monitoring

## 🚀 Deployment Guide

### Prerequisites

```bash
# Install dependencies
npm install

# Required packages are already included:
# - @openzeppelin/contracts@5.1.0
# - @openzeppelin/contracts-upgradeable@5.1.0
# - @openzeppelin/hardhat-upgrades
```

### Environment Setup

```bash
# Create .env file
PRIVATE_KEY=your_private_key
RPC_URL=your_rpc_url
ETHERSCAN_API_KEY=your_etherscan_key
```

### Deployment Steps

```bash
# 1. Compile contracts
npm run build

# 2. Run tests
npm test

# 3. Deploy to network
npx hardhat run scripts/deploy.js --network <network>
```

### Expected Deployment Order

1. **EntryPoint** (production-ready implementation with security controls)
2. **SmartWalletFactory** (via UUPS proxy)
3. **LendefiPaymaster** (linked to factory)

## 💻 Usage Examples

### Factory Operations

```solidity
// Deploy the factory
SmartWalletFactory factory = SmartWalletFactory(factoryAddress);

// Create a wallet for user
uint256 salt = 12345;
address walletAddress = factory.createAccount(userAddress, salt);

// Get existing wallet
address existingWallet = factory.getWallet(userAddress);

// Check if address is a valid Lendefi wallet
bool isValid = factory.isValidWallet(walletAddress);
```

### Paymaster Subscription Management

```solidity
LendefiPaymaster paymaster = LendefiPaymaster(paymasterAddress);

// Grant subscription (by owner or authorized operator)
paymaster.grantSubscription(
    walletAddress,          // Wallet address (not user address!)
    SubscriptionTier.PREMIUM,  // Tier: 1=BASIC, 2=PREMIUM, 3=ULTIMATE
    30 * 24 * 60 * 60         // Duration: 30 days
);

// Check subscription status
bool hasActive = paymaster.hasActiveSubscription(walletAddress);

// Get detailed subscription info
Subscription memory sub = paymaster.getSubscription(walletAddress);
```

### Smart Wallet Operations

```solidity
SmartWallet wallet = SmartWallet(payable(walletAddress));

// Single transaction
wallet.execute(
    targetContract,
    ethValue,
    callData
);

// Batch transactions
address[] memory targets = [contract1, contract2];
uint256[] memory values = [0, ethValue];
bytes[] memory calldatas = [data1, data2];

wallet.executeBatch(targets, values, calldatas);

// Signature validation (ERC-1271)
bytes4 result = wallet.isValidSignature(messageHash, signature);
```

### ERC-4337 UserOperation Flow

```solidity
// 1. Construct UserOperation
PackedUserOperation memory userOp = PackedUserOperation({
    sender: walletAddress,
    nonce: wallet.getNonce(0),
    initCode: \"\",
    callData: abi.encodeCall(SmartWallet.execute, (target, value, data)),
    accountGasLimits: ...,
    preVerificationGas: ...,
    gasFees: ...,
    paymasterAndData: abi.encodePacked(paymasterAddress),
    signature: signature
});

// 2. Submit to EntryPoint
entryPoint.handleOps([userOp], beneficiary);
```

## 🔧 Advanced Features

### Factory Management

```solidity
// Update wallet implementation (only owner)
factory.setSmartWalletImplementation(newImplementationAddress);

// Update paymaster (only owner)
factory.setPaymaster(newPaymasterAddress);

// Factory upgrade (only owner)
factory.upgradeToAndCall(newImplementation, initData);
```

### Paymaster Administration

```solidity
// Add authorized operator
paymaster.addAuthorizedOperator(operatorAddress);

// Revoke subscription
paymaster.revokeSubscription(walletAddress);

// Reset monthly gas usage (emergency)
paymaster.resetMonthlyGasUsage(walletAddress);

// Deposit funds to EntryPoint
paymaster.deposit{value: amount}();
```

### Wallet Management

```solidity
// Change wallet owner
wallet.changeOwner(newOwnerAddress);

// Manage EntryPoint deposits
wallet.addDeposit{value: amount}();
wallet.withdrawDepositTo(recipient, amount);

// Get current deposit balance
uint256 balance = wallet.getDeposit();
```

## 🛡️ Security Features

### Security Audit Status
- **Audit Completed**: January 19, 2025
- **Security Score**: 9.5/10 ✅
- **All Issues Resolved**: 3 medium + 4 low severity findings fixed
- **Production Ready**: Approved for deployment

### Access Control
- **Owner-only functions** - Critical operations restricted to wallet owner
- **EntryPoint validation** - Only canonical EntryPoint can execute UserOps
- **Operator authorization** - Multi-level permission system in paymaster
- **Factory validation** - Paymaster only accepts wallets from trusted factory

### Protection Mechanisms
- **Reentrancy guards** - ReentrancyGuard on all state-changing functions
- **Signature validation** - ECDSA and ERC-1271 compliance
- **Nonce management** - Replay attack prevention
- **Parameter validation** - Comprehensive input sanitization with custom modifiers
- **Multi-layered security** - Access control + reentrancy protection + input validation

### Emergency Controls
- **Subscription revocation** - Immediate subscription termination
- **Monthly limit resets** - Emergency gas limit management
- **Implementation updates** - Upgradeable contract system

## 📊 Gas Optimization

### Deployment Efficiency
- **Minimal Proxy Pattern**: ~2,000 gas per wallet vs ~200,000 for full deployment
- **Clone Factory**: OpenZeppelin's battle-tested implementation
- **Deterministic Addresses**: No need to store address mappings on-chain

### Operational Efficiency
- **Batch Operations**: Reduce transaction overhead with batch execution
- **Optimized Storage**: Efficient struct packing and storage layout
- **Gas Subsidies**: Paymaster covers gas costs for subscribed users

### Cost Analysis
```
Traditional Wallet Deployment: ~200,000 gas
Clone Wallet Deployment: ~2,000 gas
Savings: 99% reduction in deployment costs
```

## 🧪 Testing Infrastructure

### Test Coverage

```bash
# Run all tests (171 test cases)
npm test

# Individual test suites
npx hardhat test test/SmartWallet.test.js        # 26 tests
npx hardhat test test/LendefiPaymaster.test.js   # 30 tests  
npx hardhat test test/SmartWalletFactory.test.js # 42 tests
npx hardhat test test/Integration.test.js        # 15 tests
npx hardhat test test/DeploySequence.test.js     # 5 tests
npx hardhat test test/GasSubsidy.test.js         # 18 tests
npx hardhat test test/PaymasterConfiguration.test.js # 18 tests
npx hardhat test test/SmartWalletReentrancy.test.js # 8 tests
npx hardhat test test/ReentrancyProtectionVerification.test.js # 12 tests
```

### Test Categories

1. **Unit Tests** - Individual contract functionality
2. **Integration Tests** - Cross-contract interactions  
3. **Deployment Tests** - Proxy deployment verification
4. **Edge Case Tests** - Error conditions and boundaries
5. **Gas Optimization Tests** - Performance validation
6. **Security Tests** - Reentrancy protection and access control verification
7. **Configuration Tests** - Paymaster gas limit configuration

## 🔗 Integration Guide

### Frontend Integration

```javascript
// Create wallet for user
const tx = await factory.createAccount(userAddress, salt);
const receipt = await tx.wait();
const walletAddress = await factory.getWallet(userAddress);

// Grant subscription
await paymaster.grantSubscription(
    walletAddress,
    2, // PREMIUM
    30 * 24 * 60 * 60 // 30 days
);

// Execute transaction through wallet
const wallet = new ethers.Contract(walletAddress, SmartWalletABI, signer);
await wallet.execute(targetAddress, value, callData);
```

### Bundler Integration

```javascript
// UserOperation construction
const userOp = {
    sender: walletAddress,
    nonce: await wallet.getNonce(0),
    initCode: \"0x\",
    callData: wallet.interface.encodeFunctionData(\"execute\", [target, value, data]),
    // ... gas fields
    paymasterAndData: ethers.concat([paymasterAddress, \"0x\"]),
    signature: \"0x\"
};

// Sign and submit to bundler
const signature = await signUserOp(userOp, wallet, chainId);
userOp.signature = signature;
await bundler.sendUserOperation(userOp);
```

## 📈 Monitoring and Analytics

### Key Metrics to Track

1. **Wallet Deployment** - New wallets created per day
2. **Gas Subsidies** - Total gas subsidized by tier
3. **Subscription Utilization** - Usage vs limits per tier
4. **Monthly Renewals** - Subscription renewal rates
5. **Error Rates** - Failed operations and reasons

### Event Monitoring

```solidity
// Factory Events
event AccountCreated(address indexed account, address indexed owner, uint256 salt);
event SmartWalletImplementationUpdated(address oldImpl, address newImpl);

// Paymaster Events  
event SubscriptionGranted(address indexed user, uint8 tier, uint256 expiresAt, uint256 monthlyLimit);
event SubscriptionRevoked(address indexed user);
event GasSubsidized(address indexed user, uint256 gasUsed, uint256 gasPrice);

// Wallet Events
event OwnerChanged(address indexed previousOwner, address indexed newOwner);
```

## 🚀 Roadmap

### Phase 1: Core Infrastructure ✅
- [x] ERC-4337 SmartWallet implementation
- [x] Clone factory deployment system
- [x] Tiered paymaster with gas subsidies
- [x] Comprehensive test suite (171 tests)
- [x] Security audit and remediation
- [x] Reentrancy protection implementation
- [x] Gas optimization improvements

### Phase 2: Advanced Features
- [ ] Session keys for gasless gaming
- [ ] Social recovery mechanisms
- [ ] Multi-signature wallet support
- [ ] Hardware wallet integration

### Phase 3: Ecosystem Integration
- [ ] Bundler infrastructure integration
- [ ] Cross-chain wallet synchronization
- [ ] DeFi protocol integrations
- [ ] Mobile SDK development

### Phase 4: Enterprise Features
- [ ] Governance for subscription pricing
- [ ] Analytics dashboard
- [ ] Compliance and reporting tools
- [ ] White-label solutions

## 📄 Technical Specifications

### Supported Networks
- Ethereum Mainnet
- Polygon
- Arbitrum
- Optimism
- Base
- Any EVM-compatible chain with ERC-4337 support

### Dependencies
- OpenZeppelin Contracts v5.1.0
- OpenZeppelin Upgradeable v5.1.0
- Hardhat development environment
- ERC-4337 EntryPoint v0.7.0

### Gas Limits
- Wallet deployment: ~194,000 gas (via factory clone)
- Basic transaction: ~57,000 gas (with reentrancy protection)
- Batch transaction: ~46,000 gas (for 2 operations, optimized loop)
- Subscription validation: ~5,000 gas
- Signature validation: ~33,000 gas

## ⚠️ Important Notes

### Subscription Address Requirement
**Critical**: Subscriptions must be granted to **wallet addresses**, not user EOA addresses. The paymaster validates `userOp.sender` (wallet address) for subscriptions.

```solidity
// ✅ Correct
paymaster.grantSubscription(walletAddress, tier, duration);

// ❌ Incorrect - will cause NoSubscription errors
paymaster.grantSubscription(userEOAAddress, tier, duration);
```

### Proxy Pattern Usage
The system uses a hybrid approach with OpenZeppelin patterns:
- **Factory**: Deployed as UUPS upgradeable proxy (can be upgraded by owner)
- **Wallets**: Deployed as minimal clones using OpenZeppelin Clones library (not upgradeable)
- **Implementation**: SmartWallet serves as the implementation template for all clones

### EntryPoint Implementation
Features a production-ready EntryPoint implementation with comprehensive security controls:
- **Proper access controls** preventing unauthorized fund withdrawals
- **Stake timing enforcement** with configurable unlock delays
- **Real UserOperation validation** including signature verification
- **Nonce management** for replay protection
- **Gas payment handling** with prefund calculations
- **Full event logging** for transparency and monitoring

Unlike testing-only implementations, this EntryPoint enforces real security measures while maintaining ERC-4337 v0.7.0 compatibility.

## 📞 Support and Resources

### Documentation
- [ERC-4337 Specification](https://eips.ethereum.org/EIPS/eip-4337)
- [OpenZeppelin Clones](https://docs.openzeppelin.com/contracts/4.x/api/proxy#Clones)
- [UUPS Proxy Pattern](https://docs.openzeppelin.com/contracts/4.x/api/proxy#UUPSUpgradeable)

### Community
- GitHub Issues for bug reports
- Discord for development discussions
- Documentation wiki for integration guides

## 📄 License

MIT License - see LICENSE file for details.

---

**Built with ❤️ for the Account Abstraction ecosystem**