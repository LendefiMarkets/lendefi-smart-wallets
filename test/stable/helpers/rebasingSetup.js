const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ============ Helper Functions and Fixtures ============

/**
 * Deploy a mock price feed contract
 */
async function deployMockPriceFeed() {
    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
    const priceFeed = await MockPriceFeed.deploy();
    await priceFeed.waitForDeployment();
    return priceFeed;
}

/**
 * Main fixture for USDLRebasingCCIP tests
 */
async function usdlRebasingCCIPFixture() {
    const [owner, bridge, user1, user2, manager, upgrader] = await ethers.getSigners();

    // Deploy mock price feed
    const priceFeed = await deployMockPriceFeed();

    // Deploy USDLRebasingCCIP as upgradeable proxy
    const USDLRebasingCCIP = await ethers.getContractFactory("USDLRebasingCCIP");
    const token = await upgrades.deployProxy(
        USDLRebasingCCIP,
        [owner.address, await priceFeed.getAddress()],
        { initializer: "initialize", kind: "uups" }
    );
    await token.waitForDeployment();

    // Grant bridge role
    const BRIDGE_ROLE = await token.BRIDGE_ROLE();
    await token.connect(owner).grantRole(BRIDGE_ROLE, bridge.address);

    return {
        token,
        priceFeed,
        owner,
        bridge,
        user1,
        user2,
        manager,
        upgrader,
        BRIDGE_ROLE,
        MANAGER_ROLE: await token.MANAGER_ROLE(),
        UPGRADER_ROLE: await token.UPGRADER_ROLE(),
        DEFAULT_ADMIN_ROLE: await token.DEFAULT_ADMIN_ROLE(),
    };
}

/**
 * Fixture with tokens already minted to users
 */
async function usdlRebasingCCIPWithBalanceFixture() {
    const fixture = await usdlRebasingCCIPFixture();
    const { token, bridge, user1, user2 } = fixture;

    // Mint tokens to users
    const amount1 = ethers.parseUnits("1000", 6);
    const amount2 = ethers.parseUnits("500", 6);

    await token.connect(bridge).mint(user1.address, amount1);
    await token.connect(bridge).mint(user2.address, amount2);

    return {
        ...fixture,
        initialBalance1: amount1,
        initialBalance2: amount2,
    };
}

// ============ Constants ============
const REBASE_INDEX_PRECISION = BigInt(1e6);
const PRICE_FEED_DECIMALS = 8;

module.exports = {
    deployMockPriceFeed,
    usdlRebasingCCIPFixture,
    usdlRebasingCCIPWithBalanceFixture,
    REBASE_INDEX_PRECISION,
    PRICE_FEED_DECIMALS,
};
