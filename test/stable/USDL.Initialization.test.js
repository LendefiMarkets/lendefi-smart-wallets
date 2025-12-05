const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture } = require("./helpers/setup");

describe("USDL - Initialization", function () {
    describe("Constructor and Initialize", function () {
        it("Should initialize with correct name and symbol", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.name()).to.equal("Lendefi USD V3");
            expect(await usdl.symbol()).to.equal("USDL");
        });

        it("Should initialize with correct decimals", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.decimals()).to.equal(6);
        });

        it("Should initialize with version 3", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.version()).to.equal(3);
        });

        it("Should set correct asset address", async function () {
            const { usdl, usdc } = await loadFixture(usdlFixture);
            expect(await usdl.asset()).to.equal(await usdc.getAddress());
        });

        it("Should set correct treasury address", async function () {
            const { usdl, treasury } = await loadFixture(usdlFixture);
            expect(await usdl.treasury()).to.equal(treasury.address);
        });

        it("Should set correct CCIP admin", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            expect(await usdl.getCCIPAdmin()).to.equal(owner.address);
        });

        it("Should set default redemption fee to 0.1%", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.redemptionFeeBps()).to.equal(10);
        });

        it("Should set initial rebase index to 1e6", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.getRebaseIndex()).to.equal(1000000n);
        });

        it("Should set default yield accrual interval to 1 day", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.yieldAccrualInterval()).to.equal(86400);
        });
    });

    describe("Role Assignments", function () {
        it("Should grant DEFAULT_ADMIN_ROLE to owner", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            const DEFAULT_ADMIN_ROLE = await usdl.DEFAULT_ADMIN_ROLE();
            expect(await usdl.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
        });

        it("Should grant PAUSER_ROLE to owner", async function () {
            const { usdl, owner, roles } = await loadFixture(usdlFixture);
            expect(await usdl.hasRole(roles.PAUSER_ROLE, owner.address)).to.be.true;
        });

        it("Should grant UPGRADER_ROLE to owner", async function () {
            const { usdl, owner, roles } = await loadFixture(usdlFixture);
            expect(await usdl.hasRole(roles.UPGRADER_ROLE, owner.address)).to.be.true;
        });

        it("Should grant MANAGER_ROLE to owner", async function () {
            const { usdl, owner, roles } = await loadFixture(usdlFixture);
            expect(await usdl.hasRole(roles.MANAGER_ROLE, owner.address)).to.be.true;
        });

        it("Should grant BLACKLISTER_ROLE to owner", async function () {
            const { usdl, owner, roles } = await loadFixture(usdlFixture);
            expect(await usdl.hasRole(roles.BLACKLISTER_ROLE, owner.address)).to.be.true;
        });

        it("Should grant BRIDGE_ROLE to bridge address", async function () {
            const { usdl, bridge, roles } = await loadFixture(usdlFixture);
            expect(await usdl.hasRole(roles.BRIDGE_ROLE, bridge.address)).to.be.true;
        });
    });

    describe("Initialization Reverts", function () {
        it("Should revert if owner is zero address", async function () {
            const { usdc, treasury } = await loadFixture(usdlFixture);
            const USDL = await ethers.getContractFactory("USDL");
            
            await expect(
                USDL.deploy().then(async (impl) => {
                    const initData = impl.interface.encodeFunctionData("initialize", [
                        ethers.ZeroAddress,
                        await usdc.getAddress(),
                        treasury.address
                    ]);
                    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
                    return ERC1967Proxy.deploy(await impl.getAddress(), initData);
                })
            ).to.be.revertedWithCustomError({ interface: USDL.interface }, "ZeroAddress");
        });

        it("Should revert if USDC is zero address", async function () {
            const { owner, treasury } = await loadFixture(usdlFixture);
            const USDL = await ethers.getContractFactory("USDL");
            
            await expect(
                USDL.deploy().then(async (impl) => {
                    const initData = impl.interface.encodeFunctionData("initialize", [
                        owner.address,
                        ethers.ZeroAddress,
                        treasury.address
                    ]);
                    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
                    return ERC1967Proxy.deploy(await impl.getAddress(), initData);
                })
            ).to.be.revertedWithCustomError({ interface: USDL.interface }, "ZeroAddress");
        });

        it("Should revert if treasury is zero address", async function () {
            const { owner, usdc } = await loadFixture(usdlFixture);
            const USDL = await ethers.getContractFactory("USDL");
            
            await expect(
                USDL.deploy().then(async (impl) => {
                    const initData = impl.interface.encodeFunctionData("initialize", [
                        owner.address,
                        await usdc.getAddress(),
                        ethers.ZeroAddress
                    ]);
                    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
                    return ERC1967Proxy.deploy(await impl.getAddress(), initData);
                })
            ).to.be.revertedWithCustomError({ interface: USDL.interface }, "ZeroAddress");
        });

        it("Should revert on double initialization", async function () {
            const { usdl, owner, usdc, treasury } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.initialize(owner.address, await usdc.getAddress(), treasury.address)
            ).to.be.reverted;
        });
    });

    describe("Constants", function () {
        it("Should have correct BASIS_POINTS constant", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.BASIS_POINTS()).to.equal(10000);
        });

        it("Should have correct MIN_DEPOSIT constant", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.MIN_DEPOSIT()).to.equal(1000000n); // 1 USDC
        });

        it("Should have correct MAX_FEE_BPS constant", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.MAX_FEE_BPS()).to.equal(500); // 5%
        });

        it("Should have correct MAX_YIELD_ASSETS constant", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.MAX_YIELD_ASSETS()).to.equal(10);
        });

        it("Should have correct role constants", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.PAUSER_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")));
            expect(await usdl.MANAGER_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE")));
            expect(await usdl.BRIDGE_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE")));
            expect(await usdl.UPGRADER_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE")));
            expect(await usdl.BLACKLISTER_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("BLACKLISTER_ROLE")));
        });
    });
});
