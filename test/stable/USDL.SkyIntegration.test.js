const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlSkyFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Sky Protocol Integration (sUSDS)", function () {

    describe("Sky Configuration", function () {
        it("Should have correct Sky config set", async function () {
            const { router, litePSM, usds, sUsds } = await loadFixture(usdlSkyFixture);
            
            const skyConfig = await router.skyConfig();
            expect(skyConfig.litePSM).to.equal(await litePSM.getAddress());
            expect(skyConfig.usds).to.equal(await usds.getAddress());
            expect(skyConfig.sUsds).to.equal(await sUsds.getAddress());
        });

        it("Should emit SkyConfigUpdated event on setSkyConfig", async function () {
            const { router, owner, litePSM, usds, sUsds } = await loadFixture(usdlSkyFixture);
            
            const litePSMAddress = await litePSM.getAddress();
            const usdsAddress = await usds.getAddress();
            const sUsdsAddress = await sUsds.getAddress();

            await expect(router.connect(owner).setSkyConfig(litePSMAddress, usdsAddress, sUsdsAddress))
                .to.emit(router, "SkyConfigUpdated")
                .withArgs(litePSMAddress, usdsAddress, sUsdsAddress);
        });

        it("Should revert setSkyConfig with zero litePSM address", async function () {
            const { router, owner, usds, sUsds } = await loadFixture(usdlSkyFixture);
            
            await expect(
                router.connect(owner).setSkyConfig(
                    ethers.ZeroAddress, 
                    await usds.getAddress(), 
                    await sUsds.getAddress()
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert setSkyConfig with zero usds address", async function () {
            const { router, owner, litePSM, sUsds } = await loadFixture(usdlSkyFixture);
            
            await expect(
                router.connect(owner).setSkyConfig(
                    await litePSM.getAddress(), 
                    ethers.ZeroAddress, 
                    await sUsds.getAddress()
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert setSkyConfig with zero sUsds address", async function () {
            const { router, owner, litePSM, usds } = await loadFixture(usdlSkyFixture);
            
            await expect(
                router.connect(owner).setSkyConfig(
                    await litePSM.getAddress(), 
                    await usds.getAddress(), 
                    ethers.ZeroAddress
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should restrict setSkyConfig to admin role", async function () {
            const { router, user1, litePSM, usds, sUsds } = await loadFixture(usdlSkyFixture);
            
            await expect(
                router.connect(user1).setSkyConfig(
                    await litePSM.getAddress(), 
                    await usds.getAddress(), 
                    await sUsds.getAddress()
                )
            ).to.be.reverted;
        });
    });

    describe("Add sUSDS Yield Asset", function () {
        it("Should add sUSDS as yield asset", async function () {
            const { router, manager, usdc, sUsds } = await loadFixture(usdlSkyFixture);
            const sUsdsAddress = await sUsds.getAddress();
            const usdcAddress = await usdc.getAddress();

            await router.connect(manager).addYieldAsset(
                sUsdsAddress,
                usdcAddress,
                sUsdsAddress,
                ASSET_TYPE.SKY_SUSDS
            );

            expect(await router.getYieldAssetCount()).to.equal(1);
            
            const config = await router.getYieldAssetConfig(sUsdsAddress);
            expect(config.manager).to.equal(sUsdsAddress);
            expect(config.depositToken).to.equal(usdcAddress);
            expect(config.assetType).to.equal(ASSET_TYPE.SKY_SUSDS);
        });

        it("Should activate sUSDS with weight", async function () {
            const { router, manager, usdc, sUsds } = await loadFixture(usdlSkyFixture);
            const sUsdsAddress = await sUsds.getAddress();

            await router.connect(manager).addYieldAsset(
                sUsdsAddress,
                await usdc.getAddress(),
                sUsdsAddress,
                ASSET_TYPE.SKY_SUSDS
            );

            await router.connect(manager).updateWeights([10000]);

            expect(await router.getYieldAssetWeight(sUsdsAddress)).to.equal(10000);
        });
    });

    describe("Deposit to sUSDS", function () {
        async function setupSkyYieldAsset(router, manager, usdc, sUsds) {
            const sUsdsAddress = await sUsds.getAddress();
            await router.connect(manager).addYieldAsset(
                sUsdsAddress,
                await usdc.getAddress(),
                sUsdsAddress,
                ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).updateWeights([10000]);
        }

        it("Should deposit USDC and receive sUSDS shares via Sky flow", async function () {
            const { usdl, router, usdc, usds, sUsds, manager, user1 } = await loadFixture(usdlSkyFixture);
            await setupSkyYieldAsset(router, manager, usdc, sUsds);

            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // User should have USDL shares
            expect(await usdl.balanceOf(user1.address)).to.be.gt(0);

            // Router should have sUSDS tokens
            const sUsdsBalance = await sUsds.balanceOf(routerAddress);
            expect(sUsdsBalance).to.be.gt(0);

            // USDC should be converted (vault should have 0 USDC)
            expect(await usdc.balanceOf(usdlAddress)).to.equal(0);

            // USDS should also be converted to sUSDS (router should have 0 USDS)
            expect(await usds.balanceOf(routerAddress)).to.equal(0);
        });

        it("Should correctly track total assets via sUSDS", async function () {
            const { usdl, router, usdc, sUsds, manager, user1 } = await loadFixture(usdlSkyFixture);
            await setupSkyYieldAsset(router, manager, usdc, sUsds);

            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            const totalAssets = await usdl.totalAssets();
            expect(totalAssets).to.equal(depositAmount);
        });

        it("Should handle multiple deposits", async function () {
            const { usdl, router, usdc, sUsds, manager, user1, user2 } = await loadFixture(usdlSkyFixture);
            await setupSkyYieldAsset(router, manager, usdc, sUsds);

            const depositAmount1 = ethers.parseUnits("1000", 6);
            const depositAmount2 = ethers.parseUnits("500", 6);
            const usdlAddress = await usdl.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount1);
            await usdl.connect(user1).deposit(depositAmount1, user1.address);

            await usdc.connect(user2).approve(usdlAddress, depositAmount2);
            await usdl.connect(user2).deposit(depositAmount2, user2.address);

            expect(await usdl.balanceOf(user1.address)).to.be.gt(0);
            expect(await usdl.balanceOf(user2.address)).to.be.gt(0);

            const totalAssets = await usdl.totalAssets();
            expect(totalAssets).to.equal(depositAmount1 + depositAmount2);
        });
    });

    describe("Withdraw from sUSDS", function () {
        async function setupWithDeposit(fixture, depositAmount = ethers.parseUnits("1000", 6)) {
            const { usdl, router, usdc, sUsds, manager, user1 } = fixture;
            const sUsdsAddress = await sUsds.getAddress();
            
            await router.connect(manager).addYieldAsset(
                sUsdsAddress,
                await usdc.getAddress(),
                sUsdsAddress,
                ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).updateWeights([10000]);

            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            await mine(5);

            return depositAmount;
        }

        it("Should withdraw USDC from sUSDS via LitePSM", async function () {
            const fixture = await loadFixture(usdlSkyFixture);
            const { usdl, usdc, user1 } = fixture;
            const depositAmount = await setupWithDeposit(fixture);

            const userBalanceBefore = await usdc.balanceOf(user1.address);
            const shares = await usdl.balanceOf(user1.address);

            // Redeem all shares
            await usdl.connect(user1).redeem(shares, user1.address, user1.address);

            const userBalanceAfter = await usdc.balanceOf(user1.address);
            const received = userBalanceAfter - userBalanceBefore;
            
            // User should get USDC back (accounting for redemption fee if any)
            // Default fee is 0.1% (10 bps), so expect ~99.9% back
            const redemptionFeeBps = await usdl.redemptionFeeBps();
            const expectedMin = depositAmount * (10000n - redemptionFeeBps) / 10000n;
            expect(received).to.be.gte(expectedMin - 10n);
        });

        it("Should handle partial withdrawal", async function () {
            const fixture = await loadFixture(usdlSkyFixture);
            const { usdl, usdc, user1 } = fixture;
            const depositAmount = await setupWithDeposit(fixture);

            const shares = await usdl.balanceOf(user1.address);
            const halfShares = shares / 2n;

            const userBalanceBefore = await usdc.balanceOf(user1.address);

            await usdl.connect(user1).redeem(halfShares, user1.address, user1.address);

            const userBalanceAfter = await usdc.balanceOf(user1.address);
            const remainingShares = await usdl.balanceOf(user1.address);
            const received = userBalanceAfter - userBalanceBefore;

            // Should get approximately half back (minus fee)
            const redemptionFeeBps = await usdl.redemptionFeeBps();
            const expectedMin = (depositAmount / 2n) * (10000n - redemptionFeeBps) / 10000n;
            expect(received).to.be.gte(expectedMin - 10n);
            expect(remainingShares).to.be.closeTo(halfShares, 10);
        });

        it("Should handle withdraw by assets amount", async function () {
            const fixture = await loadFixture(usdlSkyFixture);
            const { usdl, usdc, user1 } = fixture;
            await setupWithDeposit(fixture);

            const withdrawAmount = ethers.parseUnits("500", 6);
            const userBalanceBefore = await usdc.balanceOf(user1.address);

            await usdl.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

            const userBalanceAfter = await usdc.balanceOf(user1.address);
            const received = userBalanceAfter - userBalanceBefore;
            
            // Should get the requested amount minus fee
            const redemptionFeeBps = await usdl.redemptionFeeBps();
            const expectedMin = withdrawAmount * (10000n - redemptionFeeBps) / 10000n;
            expect(received).to.be.gte(expectedMin - 10n);
        });
    });

    describe("Mixed Yield Assets (sUSDS + ERC4626)", function () {
        it("Should handle deposits split between sUSDS and ERC4626", async function () {
            const { usdl, router, usdc, sUsds, yieldVault, manager, user1 } = await loadFixture(usdlSkyFixture);
            
            const sUsdsAddress = await sUsds.getAddress();
            const vaultAddress = await yieldVault.getAddress();
            const usdcAddress = await usdc.getAddress();

            await router.connect(manager).addYieldAsset(
                sUsdsAddress, usdcAddress, sUsdsAddress, ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).addYieldAsset(
                vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626
            );

            await router.connect(manager).updateWeights([5000, 5000]);

            const depositAmount = ethers.parseUnits("2000", 6);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(await sUsds.balanceOf(routerAddress)).to.be.gt(0);
            expect(await yieldVault.balanceOf(routerAddress)).to.be.gt(0);

            expect(await usdl.totalAssets()).to.equal(depositAmount);
        });

        it("Should withdraw proportionally from both assets", async function () {
            const { usdl, router, usdc, sUsds, yieldVault, manager, user1 } = await loadFixture(usdlSkyFixture);
            
            const sUsdsAddress = await sUsds.getAddress();
            const vaultAddress = await yieldVault.getAddress();
            const usdcAddress = await usdc.getAddress();

            await router.connect(manager).addYieldAsset(
                sUsdsAddress, usdcAddress, sUsdsAddress, ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).addYieldAsset(
                vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([5000, 5000]);

            const depositAmount = ethers.parseUnits("2000", 6);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            await mine(5);

            const shares = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(shares / 2n, user1.address, user1.address);

            expect(await sUsds.balanceOf(routerAddress)).to.be.gt(0);
            expect(await yieldVault.balanceOf(routerAddress)).to.be.gt(0);
        });
    });

    describe("Edge Cases", function () {
        it("Should handle deposit when Sky config is set but no sUSDS yield asset", async function () {
            const { usdl, router, usdc, yieldVault, manager, user1 } = await loadFixture(usdlSkyFixture);
            
            const vaultAddress = await yieldVault.getAddress();
            await router.connect(manager).addYieldAsset(
                vaultAddress,
                await usdc.getAddress(),
                vaultAddress,
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);

            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(await yieldVault.balanceOf(routerAddress)).to.be.gt(0);
            expect(await usdl.totalAssets()).to.equal(depositAmount);
        });

        it("Should handle very small deposits to sUSDS", async function () {
            const { usdl, router, usdc, sUsds, manager, user1 } = await loadFixture(usdlSkyFixture);
            
            const sUsdsAddress = await sUsds.getAddress();
            await router.connect(manager).addYieldAsset(
                sUsdsAddress,
                await usdc.getAddress(),
                sUsdsAddress,
                ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).updateWeights([10000]);

            const depositAmount = ethers.parseUnits("1", 6);
            const usdlAddress = await usdl.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(await usdl.balanceOf(user1.address)).to.be.gt(0);
        });

        it("Should handle large deposits to sUSDS", async function () {
            const { usdl, router, usdc, sUsds, manager, user1 } = await loadFixture(usdlSkyFixture);
            
            const sUsdsAddress = await sUsds.getAddress();
            await router.connect(manager).addYieldAsset(
                sUsdsAddress,
                await usdc.getAddress(),
                sUsdsAddress,
                ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).updateWeights([10000]);

            const depositAmount = ethers.parseUnits("50000", 6);
            await usdc.mint(user1.address, depositAmount);
            const usdlAddress = await usdl.getAddress();

            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(await usdl.totalAssets()).to.equal(depositAmount);
        });
    });
});
