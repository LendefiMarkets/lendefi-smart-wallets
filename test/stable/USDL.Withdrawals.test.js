const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Withdrawals and Redemptions", function () {

    // Helper to setup with deposit
    async function setupWithDeposit() {
        const fixture = await usdlFixture();
        const { usdl, router, usdc, yieldVault, manager, user1 } = fixture;
        const usdlAddress = await usdl.getAddress();
        const usdcAddress = await usdc.getAddress();
        const vaultAddress = await yieldVault.getAddress();
        
        // Setup yield asset via router
        await router.connect(manager).addYieldAsset(vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626);
        await router.connect(manager).updateWeights([10000]);
        
        // Deposit
        const depositAmount = ethers.parseUnits("1000", 6);
        await usdc.connect(user1).approve(usdlAddress, depositAmount);
        await usdl.connect(user1).deposit(depositAmount, user1.address);
        
        // Advance time and call performUpkeep to allocate pending deposits to protocols
        await time.increase(86401); // 1 day + 1 second
        await router.performUpkeep("0x");
        
        // Mine blocks to pass hold time
        await mine(5);
        
        return { ...fixture, depositAmount };
    }

    describe("Withdraw", function () {
        it("Should withdraw USDC by burning shares", async function () {
            const { usdl, usdc, user1, depositAmount, INITIAL_USDC } = await loadFixture(setupWithDeposit);
            const withdrawAmount = ethers.parseUnits("500", 6);
            
            const userBalanceBefore = await usdc.balanceOf(user1.address);
            await usdl.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);
            const userBalanceAfter = await usdc.balanceOf(user1.address);

            // Should receive assets minus fee
            const fee = withdrawAmount * 10n / 10000n; // 0.1% fee
            expect(userBalanceAfter - userBalanceBefore).to.equal(withdrawAmount - fee);
        });

        it("Should charge redemption fee to treasury", async function () {
            const { usdl, usdc, user1, treasury, depositAmount } = await loadFixture(setupWithDeposit);
            const withdrawAmount = ethers.parseUnits("500", 6);
            
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await usdl.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);
            const treasuryAfter = await usdc.balanceOf(treasury.address);

            const expectedFee = withdrawAmount * 10n / 10000n; // 0.1%
            expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
        });

        it("Should emit Withdraw event", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            const withdrawAmount = ethers.parseUnits("500", 6);

            await expect(usdl.connect(user1).withdraw(withdrawAmount, user1.address, user1.address))
                .to.emit(usdl, "Withdraw");
        });

        it("Should revert if amount is zero", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);

            await expect(
                usdl.connect(user1).withdraw(0, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert if receiver is zero address", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);

            await expect(
                usdl.connect(user1).withdraw(depositAmount, ethers.ZeroAddress, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should work with allowance for third party", async function () {
            const { usdl, usdc, user1, user2, depositAmount, INITIAL_USDC } = await loadFixture(setupWithDeposit);
            const withdrawAmount = ethers.parseUnits("100", 6);
            
            // User1 approves user2
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("500", 6));
            
            const user2BalanceBefore = await usdc.balanceOf(user2.address);
            await usdl.connect(user2).withdraw(withdrawAmount, user2.address, user1.address);
            const user2BalanceAfter = await usdc.balanceOf(user2.address);

            const fee = withdrawAmount * 10n / 10000n;
            expect(user2BalanceAfter - user2BalanceBefore).to.equal(withdrawAmount - fee);
        });

        it("Should revert if sender is blacklisted", async function () {
            const { usdl, user1, blacklister, depositAmount } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(blacklister).blacklist(user1.address);

            await expect(
                usdl.connect(user1).withdraw(depositAmount, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });

        it("Should revert if receiver is blacklisted", async function () {
            const { usdl, user1, user2, blacklister, depositAmount } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(blacklister).blacklist(user2.address);

            await expect(
                usdl.connect(user1).withdraw(depositAmount, user2.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user2.address);
        });

        it("Should revert when paused", async function () {
            const { usdl, user1, pauser, depositAmount } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(pauser).pause();

            await expect(
                usdl.connect(user1).withdraw(depositAmount, user1.address, user1.address)
            ).to.be.reverted;
        });

        it("Should allow partial withdrawal", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            const withdrawAmount = ethers.parseUnits("100", 6);
            
            const sharesBefore = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);
            const sharesAfter = await usdl.balanceOf(user1.address);

            expect(sharesAfter).to.be.lt(sharesBefore);
            expect(sharesAfter).to.be.gt(0);
        });
    });

    describe("Redeem", function () {
        it("Should redeem shares for USDC", async function () {
            const { usdl, usdc, user1, depositAmount, INITIAL_USDC } = await loadFixture(setupWithDeposit);
            const sharesToRedeem = await usdl.balanceOf(user1.address);
            
            const userBalanceBefore = await usdc.balanceOf(user1.address);
            await usdl.connect(user1).redeem(sharesToRedeem, user1.address, user1.address);
            const userBalanceAfter = await usdc.balanceOf(user1.address);

            // Should receive assets minus fee
            const fee = depositAmount * 10n / 10000n;
            expect(userBalanceAfter - userBalanceBefore).to.equal(depositAmount - fee);
            expect(await usdl.balanceOf(user1.address)).to.equal(0);
        });

        it("Should emit Withdraw event on redeem", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);
            const sharesToRedeem = await usdl.balanceOf(user1.address);

            await expect(usdl.connect(user1).redeem(sharesToRedeem, user1.address, user1.address))
                .to.emit(usdl, "Withdraw");
        });

        it("Should revert if shares is zero", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);

            await expect(
                usdl.connect(user1).redeem(0, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert if receiver is zero address", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);
            const sharesToRedeem = await usdl.balanceOf(user1.address);

            await expect(
                usdl.connect(user1).redeem(sharesToRedeem, ethers.ZeroAddress, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should work with allowance for third party", async function () {
            const { usdl, usdc, user1, user2, depositAmount, INITIAL_USDC } = await loadFixture(setupWithDeposit);
            const sharesToRedeem = ethers.parseUnits("100", 6);
            
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("500", 6));
            
            await usdl.connect(user2).redeem(sharesToRedeem, user2.address, user1.address);

            expect(await usdc.balanceOf(user2.address)).to.be.gt(INITIAL_USDC);
        });

        it("Should allow partial redemption", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            const shares = await usdl.balanceOf(user1.address);
            const halfShares = shares / 2n;
            
            await usdl.connect(user1).redeem(halfShares, user1.address, user1.address);

            expect(await usdl.balanceOf(user1.address)).to.be.gt(0);
        });
    });

    describe("Preview Functions", function () {
        it("previewWithdraw should return shares needed", async function () {
            const { usdl, depositAmount } = await loadFixture(setupWithDeposit);
            const withdrawAmount = ethers.parseUnits("500", 6);
            
            const shares = await usdl.previewWithdraw(withdrawAmount);
            expect(shares).to.equal(withdrawAmount); // 1:1 initially
        });

        it("previewRedeem should return assets after fee", async function () {
            const { usdl, depositAmount } = await loadFixture(setupWithDeposit);
            const shares = ethers.parseUnits("1000", 6);
            
            const assets = await usdl.previewRedeem(shares);
            const expectedFee = shares * 10n / 10000n;
            expect(assets).to.equal(shares - expectedFee);
        });
    });

    describe("Max Functions", function () {
        it("maxWithdraw should return user's convertible assets", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            
            const maxWithdraw = await usdl.maxWithdraw(user1.address);
            expect(maxWithdraw).to.equal(depositAmount);
        });

        it("maxRedeem should return user's balance", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            
            const maxRedeem = await usdl.maxRedeem(user1.address);
            expect(maxRedeem).to.equal(await usdl.balanceOf(user1.address));
        });
    });

    describe("Fee Calculation", function () {
        it("Should calculate exact redemption fee", async function () {
            const { usdl, usdc, user1, treasury, depositAmount } = await loadFixture(setupWithDeposit);
            
            const expectedFee = depositAmount * 10n / 10000n; // 0.1%
            const expectedNet = depositAmount - expectedFee;
            
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            const userBefore = await usdc.balanceOf(user1.address);
            
            const shares = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(shares, user1.address, user1.address);
            
            const treasuryAfter = await usdc.balanceOf(treasury.address);
            const userAfter = await usdc.balanceOf(user1.address);

            expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
            expect(userAfter - userBefore).to.equal(expectedNet);
        });

        it("Should work with zero redemption fee", async function () {
            const { usdl, usdc, user1, treasury, owner, depositAmount } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(owner).setRedemptionFee(0);
            
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            const userBefore = await usdc.balanceOf(user1.address);
            
            const shares = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(shares, user1.address, user1.address);
            
            const treasuryAfter = await usdc.balanceOf(treasury.address);
            const userAfter = await usdc.balanceOf(user1.address);

            expect(treasuryAfter - treasuryBefore).to.equal(0);
            expect(userAfter - userBefore).to.equal(depositAmount);
        });
    });

    describe("Proportional Redemption", function () {
        it("Should redeem from single yield asset", async function () {
            const { usdl, router, yieldVault, user1, depositAmount } = await loadFixture(setupWithDeposit);
            const routerAddress = await router.getAddress();
            
            const vaultBalanceBefore = await yieldVault.balanceOf(routerAddress);
            
            const shares = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(shares / 2n, user1.address, user1.address);
            
            const vaultBalanceAfter = await yieldVault.balanceOf(routerAddress);

            expect(vaultBalanceAfter).to.be.lt(vaultBalanceBefore);
        });

        it("Should redeem from multiple yield assets proportionally", async function () {
            const { usdl, router, usdc, yieldVault, yieldVault2, manager, user1 } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            // Setup two assets with 60/40 split via router
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), usdcAddress, await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(), usdcAddress, await yieldVault2.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([6000, 4000]);

            // Deposit
            const depositAmount = ethers.parseUnits("10000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // Advance time and call performUpkeep to allocate pending deposits to protocols
            await time.increase(86401);
            await router.performUpkeep("0x");

            await mine(5);

            const vault1Before = await yieldVault.balanceOf(routerAddress);
            const vault2Before = await yieldVault2.balanceOf(routerAddress);

            // Withdraw 50%
            const shares = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(shares / 2n, user1.address, user1.address);

            const vault1After = await yieldVault.balanceOf(routerAddress);
            const vault2After = await yieldVault2.balanceOf(routerAddress);

            // Both vaults should decrease
            expect(vault1After).to.be.lt(vault1Before);
            expect(vault2After).to.be.lt(vault2Before);
        });

        it("Should allow full redemption", async function () {
            const { usdl, usdc, user1, depositAmount, INITIAL_USDC } = await loadFixture(setupWithDeposit);
            
            const shares = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(shares, user1.address, user1.address);

            expect(await usdl.balanceOf(user1.address)).to.equal(0);
            expect(await usdc.balanceOf(user1.address)).to.be.gt(INITIAL_USDC - depositAmount);
        });
    });
});
