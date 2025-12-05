const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlRebasingCCIPFixture, usdlRebasingCCIPWithBalanceFixture } = require("./helpers/rebasingSetup");

describe("USDLRebasingCCIP - Transfers", function () {

    describe("transfer", function () {
        it("Should transfer tokens between accounts", async function () {
            const { token, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const transferAmount = ethers.parseUnits("400", 6);

            await token.connect(user1).transfer(user2.address, transferAmount);

            expect(await token.balanceOf(user1.address)).to.equal(initialBalance1 - transferAmount);
            expect(await token.balanceOf(user2.address))
                .to.equal(ethers.parseUnits("500", 6) + transferAmount); // user2 had 500 initially
        });

        it("Should transfer tokens correctly after rebase", async function () {
            const { token, priceFeed, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            // Rebase to 1.1 (10% yield)
            await priceFeed.setPrice(ethers.parseUnits("1.1", 8));
            await token.updateRebaseIndex();

            // User1 now has 1100 rebased tokens
            const rebasedBalance = initialBalance1 * 110n / 100n;
            expect(await token.balanceOf(user1.address)).to.equal(rebasedBalance);

            // Transfer half of rebased balance
            const transferAmount = rebasedBalance / 2n;
            await token.connect(user1).transfer(user2.address, transferAmount);

            expect(await token.balanceOf(user1.address)).to.equal(transferAmount);
        });

        it("Should revert when transferring more than balance", async function () {
            const { token, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const excessAmount = initialBalance1 + ethers.parseUnits("1", 6);

            await expect(
                token.connect(user1).transfer(user2.address, excessAmount)
            ).to.be.revertedWithCustomError(token, "InsufficientBalance");
        });

        it("Should revert when transferring to zero address", async function () {
            const { token, user1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const amount = ethers.parseUnits("50", 6);

            await expect(
                token.connect(user1).transfer(ethers.ZeroAddress, amount)
            ).to.be.revertedWithCustomError(token, "ZeroAddress");
        });

        it("Should allow zero amount transfer", async function () {
            const { token, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            await token.connect(user1).transfer(user2.address, 0);

            expect(await token.balanceOf(user1.address)).to.equal(initialBalance1);
            expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits("500", 6));
        });

        it("Should emit Transfer event", async function () {
            const { token, user1, user2 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const amount = ethers.parseUnits("100", 6);

            await expect(token.connect(user1).transfer(user2.address, amount))
                .to.emit(token, "Transfer")
                .withArgs(user1.address, user2.address, amount);
        });
    });

    describe("transferFrom", function () {
        it("Should transfer tokens with allowance", async function () {
            const { token, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const allowanceAmount = ethers.parseUnits("500", 6);
            const transferAmount = ethers.parseUnits("300", 6);

            await token.connect(user1).approve(user2.address, allowanceAmount);
            await token.connect(user2).transferFrom(user1.address, user2.address, transferAmount);

            expect(await token.balanceOf(user1.address)).to.equal(initialBalance1 - transferAmount);
            expect(await token.allowance(user1.address, user2.address))
                .to.equal(allowanceAmount - transferAmount);
        });

        it("Should not decrease unlimited allowance", async function () {
            const { token, user1, user2 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const transferAmount = ethers.parseUnits("500", 6);

            await token.connect(user1).approve(user2.address, ethers.MaxUint256);
            await token.connect(user2).transferFrom(user1.address, user2.address, transferAmount);

            // Unlimited allowance should not decrease
            expect(await token.allowance(user1.address, user2.address)).to.equal(ethers.MaxUint256);
        });

        it("Should revert when allowance is insufficient", async function () {
            const { token, user1, user2 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const approvedAmount = ethers.parseUnits("100", 6);
            const transferAmount = ethers.parseUnits("200", 6);

            await token.connect(user1).approve(user2.address, approvedAmount);

            await expect(
                token.connect(user2).transferFrom(user1.address, user2.address, transferAmount)
            ).to.be.revertedWithCustomError(token, "InsufficientAllowance");
        });

        it("Should revert when balance is insufficient", async function () {
            const { token, user1, user2, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            const excessAmount = initialBalance1 + ethers.parseUnits("1", 6);

            await token.connect(user1).approve(user2.address, excessAmount);

            await expect(
                token.connect(user2).transferFrom(user1.address, user2.address, excessAmount)
            ).to.be.revertedWithCustomError(token, "InsufficientBalance");
        });
    });

    describe("approve", function () {
        it("Should set allowance correctly", async function () {
            const { token, user1, user2 } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            await token.connect(user1).approve(user2.address, amount);

            expect(await token.allowance(user1.address, user2.address)).to.equal(amount);
        });

        it("Should emit Approval event", async function () {
            const { token, user1, user2 } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            await expect(token.connect(user1).approve(user2.address, amount))
                .to.emit(token, "Approval")
                .withArgs(user1.address, user2.address, amount);
        });

        it("Should revert when approving zero address spender", async function () {
            const { token, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            const amount = ethers.parseUnits("1000", 6);

            await expect(
                token.connect(user1).approve(ethers.ZeroAddress, amount)
            ).to.be.revertedWithCustomError(token, "ZeroAddress");
        });

        it("Should allow updating existing allowance", async function () {
            const { token, user1, user2 } = await loadFixture(usdlRebasingCCIPFixture);

            await token.connect(user1).approve(user2.address, ethers.parseUnits("100", 6));
            expect(await token.allowance(user1.address, user2.address))
                .to.equal(ethers.parseUnits("100", 6));

            await token.connect(user1).approve(user2.address, ethers.parseUnits("500", 6));
            expect(await token.allowance(user1.address, user2.address))
                .to.equal(ethers.parseUnits("500", 6));
        });
    });
});
