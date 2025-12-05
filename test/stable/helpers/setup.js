const { ethers, upgrades } = require("hardhat");

/**
 * Deploy mock USDC token
 */
async function deployMockUSDC() {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    return usdc;
}

/**
 * Deploy mock USDS token
 */
async function deployMockUSDS() {
    const MockUSDS = await ethers.getContractFactory("MockUSDS");
    const usds = await MockUSDS.deploy();
    await usds.waitForDeployment();
    return usds;
}

/**
 * Deploy mock ERC4626 yield vault
 */
async function deployMockYieldVault(usdcAddress) {
    const MockERC4626Vault = await ethers.getContractFactory("MockERC4626Vault");
    const vault = await MockERC4626Vault.deploy(usdcAddress);
    await vault.waitForDeployment();
    return vault;
}

/**
 * Deploy mock Sky LitePSM wrapper
 */
async function deployMockLitePSM(usdcAddress, usdsAddress) {
    const MockLitePSMWrapper = await ethers.getContractFactory("MockLitePSMWrapper");
    const litePSM = await MockLitePSMWrapper.deploy(usdcAddress, usdsAddress);
    await litePSM.waitForDeployment();
    return litePSM;
}

/**
 * Deploy mock sUSDS vault
 */
async function deployMockSUsds(usdsAddress) {
    const MockSUsds = await ethers.getContractFactory("MockSUsds");
    const sUsds = await MockSUsds.deploy(usdsAddress);
    await sUsds.waitForDeployment();
    return sUsds;
}

/**
 * Deploy YieldRouter with proxy
 */
async function deployYieldRouter(admin, usdcAddress, vaultAddress) {
    const YieldRouter = await ethers.getContractFactory("YieldRouter");
    const router = await upgrades.deployProxy(
        YieldRouter,
        [admin, usdcAddress, vaultAddress],
        {
            initializer: 'initialize',
            unsafeAllow: ['constructor']
        }
    );
    await router.waitForDeployment();
    return router;
}

/**
 * Deploy USDL vault with proxy
 */
async function deployUSDL(owner, usdcAddress, treasuryAddress) {
    const USDL = await ethers.getContractFactory("USDL");
    const usdl = await upgrades.deployProxy(
        USDL,
        [owner, usdcAddress, treasuryAddress],
        {
            initializer: 'initialize',
            unsafeAllow: ['constructor']
        }
    );
    await usdl.waitForDeployment();
    return usdl;
}

/**
 * Deploy USDL and YieldRouter together with proper role setup
 */
async function deployUSDLWithRouter(owner, usdcAddress, treasuryAddress) {
    // Deploy USDL first
    const usdl = await deployUSDL(owner, usdcAddress, treasuryAddress);
    
    // Deploy YieldRouter with USDL as vault
    const router = await deployYieldRouter(owner, usdcAddress, await usdl.getAddress());
    
    // Set up mutual trust: USDL <-> YieldRouter
    // 1. Set the router on USDL (grants ROUTER_ROLE to router)
    await usdl.setYieldRouter(await router.getAddress());
    
    // 2. Router already has VAULT_ROLE for USDL from initialization
    
    return { usdl, router };
}

/**
 * Deploy USDLRebasingCCIP with proxy
 */
async function deployUSDLRebasingCCIP(owner, priceFeedAddress) {
    const USDLRebasingCCIP = await ethers.getContractFactory("USDLRebasingCCIP");
    const token = await upgrades.deployProxy(
        USDLRebasingCCIP,
        [owner, priceFeedAddress],
        {
            initializer: 'initialize',
            unsafeAllow: ['constructor']
        }
    );
    await token.waitForDeployment();
    return token;
}

/**
 * Deploy mock Chainlink price feed
 */
async function deployMockPriceFeed() {
    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
    const priceFeed = await MockPriceFeed.deploy();
    await priceFeed.waitForDeployment();
    return priceFeed;
}

/**
 * Standard fixture for USDL tests (with YieldRouter)
 */
async function usdlFixture() {
    const [owner, treasury, user1, user2, bridge, manager, pauser, upgrader, blacklister] = await ethers.getSigners();

    const usdc = await deployMockUSDC();
    const yieldVault = await deployMockYieldVault(await usdc.getAddress());
    const yieldVault2 = await deployMockYieldVault(await usdc.getAddress());
    const yieldVault3 = await deployMockYieldVault(await usdc.getAddress());
    
    // Deploy USDL with YieldRouter
    const { usdl, router } = await deployUSDLWithRouter(
        owner.address, 
        await usdc.getAddress(), 
        treasury.address
    );

    // Grant USDL roles
    const BRIDGE_ROLE = await usdl.BRIDGE_ROLE();
    const PAUSER_ROLE = await usdl.PAUSER_ROLE();
    const UPGRADER_ROLE = await usdl.UPGRADER_ROLE();
    const BLACKLISTER_ROLE = await usdl.BLACKLISTER_ROLE();
    const ROUTER_ROLE = await usdl.ROUTER_ROLE();

    await usdl.grantBridgeRole(bridge.address);
    await usdl.grantRole(PAUSER_ROLE, pauser.address);
    await usdl.grantRole(UPGRADER_ROLE, upgrader.address);
    await usdl.grantRole(BLACKLISTER_ROLE, blacklister.address);

    // Grant YieldRouter roles
    const MANAGER_ROLE = await router.MANAGER_ROLE();
    const VAULT_ROLE = await router.VAULT_ROLE();
    
    await router.grantRole(MANAGER_ROLE, manager.address);

    // Mint USDC to users
    const INITIAL_USDC = ethers.parseUnits("100000", 6);
    await usdc.mint(user1.address, INITIAL_USDC);
    await usdc.mint(user2.address, INITIAL_USDC);

    return {
        usdl,
        router,
        usdc,
        yieldVault,
        yieldVault2,
        yieldVault3,
        owner,
        treasury,
        user1,
        user2,
        bridge,
        manager,
        pauser,
        upgrader,
        blacklister,
        INITIAL_USDC,
        roles: { BRIDGE_ROLE, MANAGER_ROLE, PAUSER_ROLE, UPGRADER_ROLE, BLACKLISTER_ROLE, ROUTER_ROLE, VAULT_ROLE }
    };
}

/**
 * Fixture for USDL with Sky protocol mocks (with YieldRouter)
 */
async function usdlSkyFixture() {
    const [owner, treasury, user1, user2, bridge, manager, pauser, upgrader, blacklister] = await ethers.getSigners();

    // Deploy base contracts
    const usdc = await deployMockUSDC();
    const usds = await deployMockUSDS();
    const yieldVault = await deployMockYieldVault(await usdc.getAddress());
    
    // Deploy Sky protocol mocks
    const litePSM = await deployMockLitePSM(await usdc.getAddress(), await usds.getAddress());
    const sUsds = await deployMockSUsds(await usds.getAddress());
    
    // Deploy USDL with YieldRouter
    const { usdl, router } = await deployUSDLWithRouter(
        owner.address, 
        await usdc.getAddress(), 
        treasury.address
    );

    // Grant USDL roles
    const BRIDGE_ROLE = await usdl.BRIDGE_ROLE();
    const PAUSER_ROLE = await usdl.PAUSER_ROLE();
    const UPGRADER_ROLE = await usdl.UPGRADER_ROLE();
    const BLACKLISTER_ROLE = await usdl.BLACKLISTER_ROLE();
    const ROUTER_ROLE = await usdl.ROUTER_ROLE();

    await usdl.grantBridgeRole(bridge.address);
    await usdl.grantRole(PAUSER_ROLE, pauser.address);
    await usdl.grantRole(UPGRADER_ROLE, upgrader.address);
    await usdl.grantRole(BLACKLISTER_ROLE, blacklister.address);

    // Grant YieldRouter roles
    const MANAGER_ROLE = await router.MANAGER_ROLE();
    const VAULT_ROLE = await router.VAULT_ROLE();
    
    await router.grantRole(MANAGER_ROLE, manager.address);

    // Configure Sky protocol on YieldRouter (not USDL)
    await router.setSkyConfig(
        await litePSM.getAddress(),
        await usds.getAddress(),
        await sUsds.getAddress()
    );

    // Mint USDC to users
    const INITIAL_USDC = ethers.parseUnits("100000", 6);
    await usdc.mint(user1.address, INITIAL_USDC);
    await usdc.mint(user2.address, INITIAL_USDC);

    return {
        usdl,
        router,
        usdc,
        usds,
        litePSM,
        sUsds,
        yieldVault,
        owner,
        treasury,
        user1,
        user2,
        bridge,
        manager,
        pauser,
        upgrader,
        blacklister,
        INITIAL_USDC,
        roles: { BRIDGE_ROLE, MANAGER_ROLE, PAUSER_ROLE, UPGRADER_ROLE, BLACKLISTER_ROLE, ROUTER_ROLE, VAULT_ROLE }
    };
}

/**
 * Standard fixture for USDLRebasingCCIP tests
 */
async function usdlRebasingCCIPFixture() {
    const [owner, bridge, user1, user2, manager] = await ethers.getSigners();

    const priceFeed = await deployMockPriceFeed();
    const token = await deployUSDLRebasingCCIP(owner.address, await priceFeed.getAddress());

    // Grant bridge role
    const BRIDGE_ROLE = await token.BRIDGE_ROLE();
    const MANAGER_ROLE = await token.MANAGER_ROLE();
    const UPGRADER_ROLE = await token.UPGRADER_ROLE();
    
    await token.grantRole(BRIDGE_ROLE, bridge.address);

    return {
        token,
        priceFeed,
        owner,
        bridge,
        user1,
        user2,
        manager,
        roles: { BRIDGE_ROLE, MANAGER_ROLE, UPGRADER_ROLE }
    };
}

// Constants
const ASSET_TYPE = {
    ERC4626: 0,
    AAVE_V3: 1,
    ONDO_OUSG: 2,
    SKY_SUSDS: 3
};

const BASIS_POINTS = 10000n;
const MIN_DEPOSIT = ethers.parseUnits("1", 6);
const REBASE_INDEX_PRECISION = 1000000n;

module.exports = {
    deployMockUSDC,
    deployMockUSDS,
    deployMockYieldVault,
    deployMockLitePSM,
    deployMockSUsds,
    deployUSDL,
    deployYieldRouter,
    deployUSDLWithRouter,
    deployUSDLRebasingCCIP,
    deployMockPriceFeed,
    usdlFixture,
    usdlSkyFixture,
    usdlRebasingCCIPFixture,
    ASSET_TYPE,
    BASIS_POINTS,
    MIN_DEPOSIT,
    REBASE_INDEX_PRECISION
};
