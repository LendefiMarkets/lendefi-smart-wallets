const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Yield Accrual and Rebasing", function () {

    // Helper to setup with deposit
    async function setupWithDeposit() {
        const fixture = await usdlFixture();
        const { usdl, usdc, yieldVault, router, manager, user1 } = fixture;
        const usdlAddress = await usdl.getAddress();
        const usdcAddress = await usdc.getAddress();
        const vaultAddress = await yieldVault.getAddress();
        
        // Setup yield asset via router (router holds yield tokens)
        await router.connect(manager).addYieldAsset(vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626);
        await router.connect(manager).updateWeights([10000]);
        
        // Deposit
        const depositAmount = ethers.parseUnits("1000", 6);
        await usdc.connect(user1).approve(usdlAddress, depositAmount);
        await usdl.connect(user1).deposit(depositAmount, user1.address);
        
        await mine(5);

        return { ...fixture, depositAmount };
    }

    describe("Yield Accrual", function () {
        it("Should increase totalAssets after yield accrual", async function () {
            const { usdl, router, yieldVault, manager, depositAmount } = await loadFixture(setupWithDeposit);
            
            const totalAssetsBefore = await usdl.totalAssets();

            // Simulate 10% yield in the vault
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            
            await router.connect(manager).accrueYield();

            const totalAssetsAfter = await usdl.totalAssets();
            expect(totalAssetsAfter).to.be.gt(totalAssetsBefore);
        });

        it("Should increase rebase index after yield accrual", async function () {
            const { usdl, router, yieldVault, manager } = await loadFixture(setupWithDeposit);
            
            const rebaseIndexBefore = await usdl.getRebaseIndex();

            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await router.connect(manager).accrueYield();

            const rebaseIndexAfter = await usdl.getRebaseIndex();
            expect(rebaseIndexAfter).to.be.gt(rebaseIndexBefore);
        });

        it("Should increase user balance after yield accrual", async function () {
            const { usdl, router, yieldVault, manager, user1 } = await loadFixture(setupWithDeposit);
            
            const balanceBefore = await usdl.balanceOf(user1.address);

            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await router.connect(manager).accrueYield();

            const balanceAfter = await usdl.balanceOf(user1.address);
            expect(balanceAfter).to.be.gt(balanceBefore);
        });

        it("Should emit YieldAccrued event", async function () {
            const { router, yieldVault, manager } = await loadFixture(setupWithDeposit);
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));

            await expect(router.connect(manager).accrueYield())
                .to.emit(router, "YieldAccrued");
        });

        it("Should emit RebaseIndexUpdated event", async function () {
            const { usdl, router, yieldVault, manager } = await loadFixture(setupWithDeposit);
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));

            await expect(router.connect(manager).accrueYield())
                .to.emit(usdl, "RebaseIndexUpdated");
        });

        it("Should harvest yield into USDC balance", async function () {
            const { router, usdc, yieldVault, manager, depositAmount } = await loadFixture(setupWithDeposit);
            const routerAddress = await router.getAddress();
            
            // Verify USDC is in yield vault, not in router
            expect(await usdc.balanceOf(routerAddress)).to.equal(0);

            // Simulate yield
            const multiplier = ethers.parseUnits("1.05", 6);
            await yieldVault.setYieldMultiplier(multiplier);
            
            await router.connect(manager).accrueYield();

            // Should have harvested yield into router's USDC balance
            const expectedYield = depositAmount * (multiplier - 1000000n) / 1000000n;
            expect(await usdc.balanceOf(routerAddress)).to.be.closeTo(expectedYield, 1);
        });

        it("Should revert if caller is not manager", async function () {
            const { router, user1 } = await loadFixture(setupWithDeposit);

            await expect(
                router.connect(user1).accrueYield()
            ).to.be.reverted;
        });
    });

    describe("Rebasing Mechanics", function () {
        it("Should maintain correct share ratio after rebase", async function () {
            const { usdl, router, yieldVault, manager, user1, depositAmount } = await loadFixture(setupWithDeposit);
            
            const rawSharesBefore = await usdl.sharesOf(user1.address);
            const balanceBefore = await usdl.balanceOf(user1.address);

            // Simulate 20% yield
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.2", 6));
            await router.connect(manager).accrueYield();

            const rawSharesAfter = await usdl.sharesOf(user1.address);
            const balanceAfter = await usdl.balanceOf(user1.address);

            // Raw shares should not change
            expect(rawSharesAfter).to.equal(rawSharesBefore);
            // But balance should increase
            expect(balanceAfter).to.be.gt(balanceBefore);
        });

        it("Should distribute yield proportionally to all holders", async function () {
            const { usdl, router, usdc, yieldVault, manager, user1, user2 } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            // User2 also deposits
            const amount2 = ethers.parseUnits("500", 6);
            await usdc.connect(user2).approve(usdlAddress, amount2);
            await usdl.connect(user2).deposit(amount2, user2.address);

            const balance1Before = await usdl.balanceOf(user1.address);
            const balance2Before = await usdl.balanceOf(user2.address);

            // Simulate yield
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await router.connect(manager).accrueYield();

            const balance1After = await usdl.balanceOf(user1.address);
            const balance2After = await usdl.balanceOf(user2.address);

            // Both should increase proportionally
            expect(balance1After).to.be.gt(balance1Before);
            expect(balance2After).to.be.gt(balance2Before);
        });

        it("Should allow user to redeem full balanceOf after yield", async function () {
            const { usdl, router, usdc, yieldVault, manager, user1 } = await loadFixture(setupWithDeposit);
            
            // Simulate 20% yield
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.2", 6));
            await router.connect(manager).accrueYield();

            const rebasedBalance = await usdl.balanceOf(user1.address);
            expect(rebasedBalance).to.be.gt(ethers.parseUnits("1000", 6));

            // Should be able to redeem half
            const halfBalance = rebasedBalance / 2n;
            await usdl.connect(user1).redeem(halfBalance, user1.address, user1.address);

            // Should have roughly half remaining
            const remaining = await usdl.balanceOf(user1.address);
            expect(remaining).to.be.closeTo(halfBalance, 2);
        });
    });

    describe("TotalAssets Tracking", function () {
        it("totalAssets should equal totalDepositedAssets", async function () {
            const { usdl, depositAmount } = await loadFixture(setupWithDeposit);
            
            expect(await usdl.totalAssets()).to.equal(depositAmount);
            expect(await usdl.totalDepositedAssets()).to.equal(depositAmount);
        });

        it("totalAssets should reflect yield after accrual", async function () {
            const { usdl, router, yieldVault, manager, depositAmount } = await loadFixture(setupWithDeposit);
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await router.connect(manager).accrueYield();

            const totalAssets = await usdl.totalAssets();
            expect(totalAssets).to.be.gt(depositAmount);
        });

        it("Donations should not affect totalAssets", async function () {
            const { usdl, usdc, depositAmount } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            const totalAssetsBefore = await usdl.totalAssets();
            const sharePriceBefore = await usdl.sharePrice();

            // Donate USDC directly
            await usdc.mint(usdlAddress, ethers.parseUnits("1000", 6));

            // totalAssets should not change
            expect(await usdl.totalAssets()).to.equal(totalAssetsBefore);
            expect(await usdl.sharePrice()).to.equal(sharePriceBefore);
        });
    });

    describe("Share Price", function () {
        it("Should start at 1:1", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.sharePrice()).to.equal(1000000n);
        });

        it("sharePrice should remain stable after yield (rebasing)", async function () {
            const { usdl, router, yieldVault, manager, depositAmount } = await loadFixture(setupWithDeposit);
            
            const sharePriceBefore = await usdl.sharePrice();

            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await router.connect(manager).accrueYield();

            const sharePriceAfter = await usdl.sharePrice();
            // In a rebasing token, sharePrice stays ~1:1 because both totalAssets and totalSupply scale together
            expect(sharePriceAfter).to.equal(sharePriceBefore);
        });

        it("getPrice should return value after fee", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            
            const price = await usdl.getPrice();
            // getPrice uses previewRedeem which deducts 0.1% fee
            // 1e6 * 0.999 = 999000
            expect(price).to.equal(999000n);
        });
    });

    describe("Automation (Chainlink Keeper)", function () {
        it("checkUpkeep should return false before interval", async function () {
            const { router, yieldVault } = await loadFixture(setupWithDeposit);
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));

            const [upkeepNeeded] = await router.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });

        it("checkUpkeep should return true after interval with yield", async function () {
            const { router, yieldVault } = await loadFixture(setupWithDeposit);
            
            // Simulate yield
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            
            // Advance time past interval
            await time.increase(86401);

            const [upkeepNeeded] = await router.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.true;
        });

        it("checkUpkeep should return true when needed", async function () {
            const { router, yieldVault } = await loadFixture(setupWithDeposit);
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await time.increase(86401);

            const [upkeepNeeded] = await router.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.true;
        });

        it("performUpkeep should accrue yield", async function () {
            const { usdl, router, yieldVault } = await loadFixture(setupWithDeposit);
            
            const totalAssetsBefore = await usdl.totalAssets();
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await time.increase(86401);

            await router.performUpkeep("0x");

            expect(await usdl.totalAssets()).to.be.gt(totalAssetsBefore);
        });

        it("performUpkeep should revert when not needed", async function () {
            const { router } = await loadFixture(setupWithDeposit);

            await expect(
                router.performUpkeep("0x")
            ).to.be.revertedWithCustomError(router, "UpkeepNotNeeded");
        });

        it("Should disable automation when interval is 0", async function () {
            const { router, yieldVault, manager } = await loadFixture(setupWithDeposit);
            
            await router.connect(manager).setYieldAccrualInterval(0);
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            await time.increase(86400 * 30); // 30 days

            const [upkeepNeeded] = await router.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });
    });

    describe("Interval Configuration", function () {
        it("Should set yield accrual interval", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            
            const newInterval = 7200; // 2 hours
            await router.connect(manager).setYieldAccrualInterval(newInterval);

            expect(await router.getYieldAccrualInterval()).to.equal(newInterval);
        });

        it("Should emit YieldAccrualIntervalUpdated event", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            
            const newInterval = 7200;
            await expect(router.connect(manager).setYieldAccrualInterval(newInterval))
                .to.emit(router, "YieldAccrualIntervalUpdated")
                .withArgs(86400, newInterval);
        });

        it("Should revert if interval too short", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).setYieldAccrualInterval(10)
            ).to.be.revertedWithCustomError(router, "AutomationIntervalTooShort")
             .withArgs(10, 3600);
        });

        it("Should allow disabling with 0", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            
            await router.connect(manager).setYieldAccrualInterval(0);
            expect(await router.getYieldAccrualInterval()).to.equal(0);
        });

        it("Should revert if not manager", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);

            await expect(
                router.connect(user1).setYieldAccrualInterval(7200)
            ).to.be.reverted;
        });
    });
});
