const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlRebasingCCIPFixture, usdlRebasingCCIPWithBalanceFixture, REBASE_INDEX_PRECISION } = require("./helpers/rebasingSetup");

describe("USDLRebasingCCIP - Rebase Index", function () {

    describe("updateRebaseIndex", function () {
        it("Should update rebase index from price feed", async function () {
            const { token, priceFeed } = await loadFixture(usdlRebasingCCIPFixture);
            
            // Set price to $1.05 (5% yield)
            await priceFeed.setPrice(ethers.parseUnits("1.05", 8));

            await expect(token.updateRebaseIndex())
                .to.emit(token, "RebaseIndexUpdated")
                .withArgs(REBASE_INDEX_PRECISION, ethers.parseUnits("1.05", 6));

            expect(await token.rebaseIndex()).to.equal(ethers.parseUnits("1.05", 6));
        });

        it("Should affect user balances after rebase", async function () {
            const { token, priceFeed, user1, initialBalance1 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            // Update price to $1.10 (10% yield)
            await priceFeed.setPrice(ethers.parseUnits("1.1", 8));
            await token.updateRebaseIndex();

            // Balance should reflect 10% increase
            const expectedBalance = initialBalance1 * 110n / 100n;
            expect(await token.balanceOf(user1.address)).to.equal(expectedBalance);
        });

        it("Should affect total supply after rebase", async function () {
            const { token, priceFeed, initialBalance1, initialBalance2 } = await loadFixture(usdlRebasingCCIPWithBalanceFixture);
            
            const initialTotalSupply = initialBalance1 + initialBalance2;

            // Update price to $1.20 (20% yield)
            await priceFeed.setPrice(ethers.parseUnits("1.2", 8));
            await token.updateRebaseIndex();

            const expectedTotalSupply = initialTotalSupply * 120n / 100n;
            expect(await token.totalSupply()).to.equal(expectedTotalSupply);
        });

        it("Should revert when price is zero", async function () {
            const { token, priceFeed } = await loadFixture(usdlRebasingCCIPFixture);
            
            await priceFeed.setPrice(0);

            await expect(token.updateRebaseIndex())
                .to.be.revertedWithCustomError(token, "InvalidPrice");
        });

        it("Should revert when price is negative", async function () {
            const { token, priceFeed } = await loadFixture(usdlRebasingCCIPFixture);
            
            await priceFeed.setPrice(-1);

            await expect(token.updateRebaseIndex())
                .to.be.revertedWithCustomError(token, "InvalidPrice");
        });

        it("Should revert when price is stale (> 24 hours old)", async function () {
            const { token, priceFeed } = await loadFixture(usdlRebasingCCIPFixture);
            
            // Move time forward 30 hours
            await time.increase(30 * 60 * 60);
            
            // Set price with stale timestamp (25 hours ago)
            const staleTimestamp = (await time.latest()) - (25 * 60 * 60);
            await priceFeed.setStalePrice(ethers.parseUnits("1", 8), staleTimestamp);

            await expect(token.updateRebaseIndex())
                .to.be.revertedWithCustomError(token, "StalePrice");
        });

        it("Should not revert when price is within 24 hours", async function () {
            const { token, priceFeed } = await loadFixture(usdlRebasingCCIPFixture);
            
            // Set a fresh price (just updated now)
            await priceFeed.setPrice(ethers.parseUnits("1", 8));

            // Should succeed since price was just updated
            await expect(token.updateRebaseIndex()).not.to.be.reverted;
            expect(await token.rebaseIndex()).to.equal(REBASE_INDEX_PRECISION);
        });
    });

    describe("Multiple rebases", function () {
        it("Should handle multiple consecutive rebases", async function () {
            const { token, priceFeed, bridge, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            
            const initialAmount = ethers.parseUnits("1000", 6);
            await token.connect(bridge).mint(user1.address, initialAmount);

            // First rebase: +1% (within MAX_PRICE_CHANGE_BPS)
            await priceFeed.setPrice(ethers.parseUnits("1.01", 8));
            await token.updateRebaseIndex();
            expect(await token.balanceOf(user1.address)).to.equal(ethers.parseUnits("1010", 6));

            // Second rebase: +1% from previous (1.01 * 1.01 = 1.0201)
            await priceFeed.setPrice(ethers.parseUnits("1.0201", 8));
            await token.updateRebaseIndex();
            expect(await token.balanceOf(user1.address)).to.equal(ethers.parseUnits("1020.1", 6));

            // Third rebase: +1% from previous (1.0201 * 1.01 = 1.030301)
            await priceFeed.setPrice(ethers.parseUnits("1.030301", 8));
            await token.updateRebaseIndex();
            expect(await token.balanceOf(user1.address)).to.equal(ethers.parseUnits("1030.301", 6));
        });
    });

    describe("Large amounts", function () {
        it("Should handle rebase with very large amounts", async function () {
            const { token, priceFeed, bridge, user1 } = await loadFixture(usdlRebasingCCIPFixture);
            
            const largeAmount = ethers.parseUnits("1000000000", 6); // 1 billion tokens
            await token.connect(bridge).mint(user1.address, largeAmount);

            expect(await token.balanceOf(user1.address)).to.equal(largeAmount);

            // Rebase with large numbers (50% yield)
            await priceFeed.setPrice(ethers.parseUnits("1.5", 8));
            await token.updateRebaseIndex();

            expect(await token.balanceOf(user1.address)).to.equal(ethers.parseUnits("1500000000", 6));
        });
    });

    describe("State preservation after rebase", function () {
        it("Should preserve relative balances after rebase", async function () {
            const { token, priceFeed, user1, user2, initialBalance1, initialBalance2 } = 
                await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            // Set allowance before rebase
            const allowance = ethers.parseUnits("200", 6);
            await token.connect(user1).approve(user2.address, allowance);

            // Rebase 20%
            await priceFeed.setPrice(ethers.parseUnits("1.2", 8));
            await token.updateRebaseIndex();

            // Check balances increased proportionally
            expect(await token.balanceOf(user1.address)).to.equal(initialBalance1 * 120n / 100n);
            expect(await token.balanceOf(user2.address)).to.equal(initialBalance2 * 120n / 100n);
            
            // Total supply should also increase
            const expectedTotalSupply = (initialBalance1 + initialBalance2) * 120n / 100n;
            expect(await token.totalSupply()).to.equal(expectedTotalSupply);

            // Allowance remains unchanged (stored in rebased units)
            expect(await token.allowance(user1.address, user2.address)).to.equal(allowance);
        });
    });
});
