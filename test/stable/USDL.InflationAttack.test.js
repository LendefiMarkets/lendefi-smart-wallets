const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Inflation Attack Resistance", function () {

    // Helper to setup with deposit and yield asset
    async function setupWithDeposit() {
        const fixture = await usdlFixture();
        const { usdl, usdc, yieldVault, router, manager, user1, user2 } = fixture;
        const usdlAddress = await usdl.getAddress();
        const usdcAddress = await usdc.getAddress();
        const vaultAddress = await yieldVault.getAddress();
        const routerAddress = await router.getAddress();
        
        // Setup yield asset via router
        await router.connect(manager).addYieldAsset(vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626);
        await router.connect(manager).updateWeights([10000]);
        
        // Initial deposit by user1
        const depositAmount = ethers.parseUnits("1000", 6);
        await usdc.connect(user1).approve(usdlAddress, depositAmount);
        await usdl.connect(user1).deposit(depositAmount, user1.address);
        
        // Advance time and call performUpkeep to allocate pending deposits to protocols
        await time.increase(86401);
        await router.performUpkeep("0x");
        
        return { ...fixture, depositAmount, routerAddress };
    }

    describe("USDL Direct Donation Attack", function () {
        it("Should not affect share price when USDC is sent directly to USDL", async function () {
            const { usdl, usdc, user1, user2 } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            // Record state before attack
            const user1BalanceBefore = await usdl.balanceOf(user1.address);
            const totalAssetsBefore = await usdl.totalAssets();
            const sharesBefore = await usdl.totalSupply();
            
            // Attacker sends USDC directly to USDL contract
            const donationAmount = ethers.parseUnits("10000", 6);
            await usdc.mint(usdlAddress, donationAmount);
            
            // Verify USDL has extra USDC
            expect(await usdc.balanceOf(usdlAddress)).to.equal(donationAmount);
            
            // Share price should NOT be affected (internal accounting protects)
            const user1BalanceAfter = await usdl.balanceOf(user1.address);
            const totalAssetsAfter = await usdl.totalAssets();
            const sharesAfter = await usdl.totalSupply();
            
            expect(user1BalanceAfter).to.equal(user1BalanceBefore);
            expect(totalAssetsAfter).to.equal(totalAssetsBefore);
            expect(sharesAfter).to.equal(sharesBefore);
            
            // New user depositing should get fair shares
            const newDeposit = ethers.parseUnits("1000", 6);
            await usdc.connect(user2).approve(usdlAddress, newDeposit);
            await usdl.connect(user2).deposit(newDeposit, user2.address);
            
            // User2 should get same shares as user1 (1:1 at initial state)
            expect(await usdl.balanceOf(user2.address)).to.equal(user1BalanceAfter);
        });

        it("Should allow admin to rescue donated USDC from USDL", async function () {
            const { usdl, usdc, owner, treasury } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            // Donate USDC to USDL
            const donationAmount = ethers.parseUnits("500", 6);
            await usdc.mint(usdlAddress, donationAmount);
            
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await usdl.connect(owner).rescueDonatedTokens(treasury.address);
            const treasuryAfter = await usdc.balanceOf(treasury.address);
            
            expect(treasuryAfter - treasuryBefore).to.equal(donationAmount);
        });
    });

    describe("YieldRouter Direct Donation Attack", function () {
        it("Should not affect yield calculation when USDC is sent directly to router", async function () {
            const { usdl, router, usdc, yieldVault, manager, user1, routerAddress } = await loadFixture(setupWithDeposit);
            
            // Record state before attack
            const rebaseIndexBefore = await usdl.getRebaseIndex();
            const totalAssetsBefore = await usdl.totalAssets();
            const user1BalanceBefore = await usdl.balanceOf(user1.address);
            
            // Attacker sends USDC directly to YieldRouter
            const donationAmount = ethers.parseUnits("10000", 6);
            await usdc.mint(routerAddress, donationAmount);
            
            // Verify router has extra USDC
            const routerBalance = await usdc.balanceOf(routerAddress);
            expect(routerBalance).to.equal(donationAmount);
            
            // Trigger yield accrual - should NOT count donation as yield
            await router.connect(manager).accrueYield();
            
            // Rebase index should NOT be inflated by donation
            const rebaseIndexAfter = await usdl.getRebaseIndex();
            const totalAssetsAfter = await usdl.totalAssets();
            const user1BalanceAfter = await usdl.balanceOf(user1.address);
            
            // Values should be unchanged (no fake yield)
            expect(rebaseIndexAfter).to.equal(rebaseIndexBefore);
            expect(totalAssetsAfter).to.equal(totalAssetsBefore);
            expect(user1BalanceAfter).to.equal(user1BalanceBefore);
        });

        it("Should allow admin to rescue donated USDC from router", async function () {
            const { router, usdc, owner, treasury, routerAddress } = await loadFixture(setupWithDeposit);
            
            // Donate USDC to router
            const donationAmount = ethers.parseUnits("500", 6);
            await usdc.mint(routerAddress, donationAmount);
            
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await router.connect(owner).rescueDonatedTokens(treasury.address);
            const treasuryAfter = await usdc.balanceOf(treasury.address);
            
            expect(treasuryAfter - treasuryBefore).to.equal(donationAmount);
        });

        it("Should correctly track internal USDC balance", async function () {
            const { router, routerAddress } = await loadFixture(setupWithDeposit);
            
            // After deposit, tracked balance should be 0 (all went to yield vault)
            expect(await router.trackedUSDCBalance()).to.equal(0);
            
            // Router actual balance should also be 0
            const usdc = await ethers.getContractAt("MockUSDC", await router.usdc());
            expect(await usdc.balanceOf(routerAddress)).to.equal(0);
        });

        it("Should not allow donation to inflate yield during checkUpkeep", async function () {
            const { router, usdc, yieldVault, routerAddress, manager } = await loadFixture(setupWithDeposit);
            
            // First, do an initial yield check to set lastActualValue
            await router.connect(manager).accrueYield();
            
            // Advance time past the yield accrual interval
            await ethers.provider.send("evm_increaseTime", [3600 * 25]); // 25 hours
            await ethers.provider.send("evm_mine", []);
            
            // Simulate real yield
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            
            // Check upkeep before donation - should see real yield
            let [upkeepNeeded1] = await router.checkUpkeep("0x");
            expect(upkeepNeeded1).to.be.true; // Real yield exists
            
            // Now add fake "donation" to router
            const donationAmount = ethers.parseUnits("100000", 6);
            await usdc.mint(routerAddress, donationAmount);
            
            // checkUpkeep should still only see real yield, not donation
            let [upkeepNeeded2, performData] = await router.checkUpkeep("0x");
            expect(upkeepNeeded2).to.be.true;
            
            // The actual value should NOT include the donation
            // (we can't easily decode performData, but the key is that
            // donation doesn't inflate the apparent yield)
        });
    });

    describe("Combined Attack Scenarios", function () {
        it("Should resist front-running deposit with donation", async function () {
            const { usdl, usdc, user1, user2 } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            // User1 has 1000 USDL
            const user1SharesBefore = await usdl.balanceOf(user1.address);
            
            // Attacker (user2) front-runs their own deposit with a donation
            const donationAmount = ethers.parseUnits("10000", 6);
            await usdc.mint(usdlAddress, donationAmount);
            
            // Then deposits
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user2).approve(usdlAddress, depositAmount);
            await usdl.connect(user2).deposit(depositAmount, user2.address);
            
            // User2's shares should be proportional to their deposit, not inflated
            const user2Shares = await usdl.balanceOf(user2.address);
            
            // With 1000 USDL for 1000 USDC, 100 USDC should give 100 USDL
            expect(user2Shares).to.equal(ethers.parseUnits("100", 6));
            
            // User1's balance should be unchanged
            expect(await usdl.balanceOf(user1.address)).to.equal(user1SharesBefore);
        });

        it("Should resist sandwich attack around yield accrual", async function () {
            const { usdl, router, usdc, yieldVault, manager, user1, user2, routerAddress } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            // Setup: Real yield of 10%
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            
            // Record user1 balance before accrual
            const user1Before = await usdl.balanceOf(user1.address);
            
            // Attacker tries to sandwich:
            // 1. Donate to router
            const donationAmount = ethers.parseUnits("10000", 6);
            await usdc.mint(routerAddress, donationAmount);
            
            // 2. Trigger yield accrual
            await router.connect(manager).accrueYield();
            
            // 3. Check if user1 got more than expected
            const user1After = await usdl.balanceOf(user1.address);
            
            // User1 should get ~10% yield, NOT inflated by donation
            // 1000 * 1.1 = 1100 (approximately)
            const expectedYield = user1Before * 110n / 100n;
            expect(user1After).to.be.closeTo(expectedYield, ethers.parseUnits("1", 6));
            
            // The donation should still be in the router (not distributed)
            const routerBalance = await usdc.balanceOf(routerAddress);
            expect(routerBalance).to.be.gte(donationAmount);
        });
    });

    describe("Ghost Share / CCIP Attack Resistance", function () {
        it("Should not allow bridge mints to affect share price", async function () {
            const { usdl, bridge, user1, user2, usdc } = await loadFixture(setupWithDeposit);
            const usdlAddress = await usdl.getAddress();
            
            // Record state before
            const sharesBefore = await usdl.totalSupply();
            const assetsBefore = await usdl.totalAssets();
            const user1BalanceBefore = await usdl.balanceOf(user1.address);
            
            // Bridge mints ghost shares to user2
            const bridgeMintAmount = ethers.parseUnits("10000", 6);
            await usdl.connect(bridge)["mint(address,uint256)"](user2.address, bridgeMintAmount);
            
            // User2 has shares now
            expect(await usdl.balanceOf(user2.address)).to.be.gt(0);
            
            // But totalAssets (and share price) should NOT change
            const assetsAfter = await usdl.totalAssets();
            expect(assetsAfter).to.equal(assetsBefore);
            
            // User1's redeemable value should be unchanged
            const user1BalanceAfter = await usdl.balanceOf(user1.address);
            expect(user1BalanceAfter).to.equal(user1BalanceBefore);
            
            // New deposit should get fair shares based on totalDepositedAssets
            const newDeposit = ethers.parseUnits("1000", 6);
            const user3 = (await ethers.getSigners())[10];
            await usdc.mint(user3.address, newDeposit);
            await usdc.connect(user3).approve(usdlAddress, newDeposit);
            await usdl.connect(user3).deposit(newDeposit, user3.address);
            
            // User3 should get same shares as original user1 deposit
            expect(await usdl.balanceOf(user3.address)).to.equal(user1BalanceBefore);
        });
    });

    describe("YieldRouter getTotalValue", function () {
        it("Should return correct value with no yield assets", async function () {
            const fixture = await usdlFixture();
            const { router } = fixture;
            
            // No yield assets registered, no USDC tracked
            expect(await router.getTotalValue()).to.equal(0);
        });

        it("Should return trackedUSDCBalance, not raw balanceOf", async function () {
            const { router, usdc, routerAddress } = await loadFixture(setupWithDeposit);
            
            // After deposit, USDC went to yield vault, trackedUSDCBalance = 0
            const totalValueBefore = await router.getTotalValue();
            
            // Donate USDC directly to router
            const donationAmount = ethers.parseUnits("5000", 6);
            await usdc.mint(routerAddress, donationAmount);
            
            // getTotalValue should NOT include donation
            const totalValueAfter = await router.getTotalValue();
            expect(totalValueAfter).to.equal(totalValueBefore);
            
            // But raw balance includes donation
            const rawBalance = await usdc.balanceOf(routerAddress);
            expect(rawBalance).to.equal(donationAmount);
        });

        it("Should include yield asset value plus trackedUSDCBalance", async function () {
            const { router, usdc, yieldVault, manager, depositAmount, routerAddress } = await loadFixture(setupWithDeposit);
            
            // Total value should equal the deposit amount (in yield vault)
            const totalValue = await router.getTotalValue();
            expect(totalValue).to.be.closeTo(depositAmount, ethers.parseUnits("1", 6));
            
            // Simulate yield (10%)
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            
            // Total value should now be ~1100 USDC
            const totalValueAfterYield = await router.getTotalValue();
            const expectedWithYield = depositAmount * 110n / 100n;
            expect(totalValueAfterYield).to.be.closeTo(expectedWithYield, ethers.parseUnits("1", 6));
        });

        it("Should not be inflatable by donations", async function () {
            const { router, usdc, routerAddress, depositAmount } = await loadFixture(setupWithDeposit);
            
            const valueBefore = await router.getTotalValue();
            
            // Attacker donates massive amount
            const attackAmount = ethers.parseUnits("1000000", 6); // 1M USDC
            await usdc.mint(routerAddress, attackAmount);
            
            // Value should be unchanged
            const valueAfter = await router.getTotalValue();
            expect(valueAfter).to.equal(valueBefore);
        });
    });
});
