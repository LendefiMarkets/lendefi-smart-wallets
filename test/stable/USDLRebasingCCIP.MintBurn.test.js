const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlRebasingCCIPFixture, usdlRebasingCCIPWithBalanceFixture } = require("./helpers/rebasingSetup");

describe("USDLRebasingCCIP - Mint & Burn", function () {

    describe("mint", function () {
        it("Should mint tokens to user", async function () {
            const { token, bridge, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            await expect(token.connect(bridge).mint(user1.address, amount))
                .to.emit(token, "BridgeMint")
                .withArgs(bridge.address, user1.address, amount);

            expect(await token.balanceOf(user1.address)).to.equal(amount);
            expect(await token.totalSupply()).to.equal(amount);
        });

        it("Should revert when caller does not have BRIDGE_ROLE", async function () {
            const { token, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            await expect(
                token.connect(user1).mint(user1.address, amount)
            ).to.be.reverted;
        });

        it("Should revert when minting to zero address", async function () {
            const { token, bridge } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            await expect(
                token.connect(bridge).mint(ethers.ZeroAddress, amount)
            ).to.be.revertedWithCustomError(token, "ZeroAddress");
        });

        it("Should allow minting multiple times", async function () {
            const { token, bridge, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            const amount1 = ethers.parseUnits("500", 6);
            const amount2 = ethers.parseUnits("300", 6);

            await token.connect(bridge).mint(user1.address, amount1);
            await token.connect(bridge).mint(user1.address, amount2);

            expect(await token.balanceOf(user1.address)).to.equal(amount1 + amount2);
        });
    });

    describe("burn (with account)", function () {
        it("Should burn tokens from user", async function () {
            const { token, bridge, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            await expect(token.connect(bridge)["burn(address,uint256)"](user1.address, initialBalance1))
                .to.emit(token, "BridgeBurn")
                .withArgs(bridge.address, user1.address, initialBalance1);

            expect(await token.balanceOf(user1.address)).to.equal(0);
            expect(await token.totalSupply()).to.equal(ethers.parseUnits("500", 6)); // user2 still has tokens
        });

        it("Should revert when burning more than balance", async function () {
            const { token, bridge, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const excessAmount = initialBalance1 + ethers.parseUnits("1", 6);

            await expect(
                token.connect(bridge)["burn(address,uint256)"](user1.address, excessAmount)
            ).to.be.revertedWithCustomError(token, "InsufficientBalance");
        });

        it("Should revert when caller does not have BRIDGE_ROLE", async function () {
            const { token, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            await expect(
                token.connect(user1)["burn(address,uint256)"](user1.address, initialBalance1)
            ).to.be.reverted;
        });
    });

    describe("burn (from caller)", function () {
        it("Should burn tokens from caller's own balance", async function () {
            const { token, bridge } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            // Mint to bridge itself
            await token.connect(bridge).mint(bridge.address, amount);
            expect(await token.balanceOf(bridge.address)).to.equal(amount);

            // Burn from self using single-argument burn
            await token.connect(bridge)["burn(uint256)"](amount);
            expect(await token.balanceOf(bridge.address)).to.equal(0);
        });
    });

    describe("burnFrom", function () {
        it("Should burn tokens using allowance", async function () {
            const { token, bridge, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            // User1 approves bridge
            await token.connect(user1).approve(bridge.address, initialBalance1);

            // Bridge burns from user1 using allowance
            await token.connect(bridge).burnFrom(user1.address, initialBalance1);

            expect(await token.balanceOf(user1.address)).to.equal(0);
        });

        it("Should decrease allowance after burnFrom", async function () {
            const { token, bridge, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const burnAmount = ethers.parseUnits("500", 6);

            await token.connect(user1).approve(bridge.address, initialBalance1);
            await token.connect(bridge).burnFrom(user1.address, burnAmount);

            expect(await token.allowance(user1.address, bridge.address))
                .to.equal(initialBalance1 - burnAmount);
        });

        it("Should revert when allowance is insufficient", async function () {
            const { token, bridge, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const approvedAmount = ethers.parseUnits("500", 6);

            await token.connect(user1).approve(bridge.address, approvedAmount);

            await expect(
                token.connect(bridge).burnFrom(user1.address, initialBalance1)
            ).to.be.revertedWithCustomError(token, "InsufficientAllowance");
        });

        it("Should revert when caller does not have BRIDGE_ROLE", async function () {
            const { token, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            await token.connect(user1).approve(user2.address, initialBalance1);

            await expect(
                token.connect(user2).burnFrom(user1.address, initialBalance1)
            ).to.be.reverted;
        });
    });
});
