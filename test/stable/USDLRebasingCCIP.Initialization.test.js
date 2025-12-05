const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlRebasingCCIPFixture, REBASE_INDEX_PRECISION } = require("./helpers/rebasingSetup");

describe("USDLRebasingCCIP - Initialization", function () {

    describe("initialize", function () {
        it("Should set correct name", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.name()).to.equal("Lendefi USD V3 (CCIP)");
        });

        it("Should set correct symbol", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.symbol()).to.equal("USDL");
        });

        it("Should set correct decimals", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.decimals()).to.equal(6);
        });

        it("Should set initial rebase index to 1e6", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.rebaseIndex()).to.equal(REBASE_INDEX_PRECISION);
        });

        it("Should set owner as CCIP admin", async function () {
            const { token, owner } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.getCCIPAdmin()).to.equal(owner.address);
        });

        it("Should grant DEFAULT_ADMIN_ROLE to owner", async function () {
            const { token, owner, DEFAULT_ADMIN_ROLE } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
        });

        it("Should grant UPGRADER_ROLE to owner", async function () {
            const { token, owner, UPGRADER_ROLE } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.hasRole(UPGRADER_ROLE, owner.address)).to.be.true;
        });

        it("Should grant MANAGER_ROLE to owner", async function () {
            const { token, owner, MANAGER_ROLE } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.hasRole(MANAGER_ROLE, owner.address)).to.be.true;
        });

        it("Should revert if initialized twice", async function () {
            const { token, owner, priceFeed } = await loadFixture(usdlRebasingCCIPFixture);
            await expect(
                token.initialize(owner.address, await priceFeed.getAddress())
            ).to.be.revertedWithCustomError(token, "InvalidInitialization");
        });
    });

    describe("CCIP Admin", function () {
        it("Should set new CCIP admin", async function () {
            const { token, owner, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            
            await expect(token.connect(owner).setCCIPAdmin(user1.address))
                .to.emit(token, "CCIPAdminTransferred")
                .withArgs(owner.address, user1.address);

            expect(await token.getCCIPAdmin()).to.equal(user1.address);
        });

        it("Should revert setCCIPAdmin with zero address", async function () {
            const { token, owner } = await loadFixture(usdlRebasingCCIPFixture);
            
            await expect(
                token.connect(owner).setCCIPAdmin(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(token, "ZeroAddress");
        });

        it("Should revert setCCIPAdmin when caller is not admin", async function () {
            const { token, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            
            await expect(
                token.connect(user1).setCCIPAdmin(user1.address)
            ).to.be.reverted;
        });
    });
});
