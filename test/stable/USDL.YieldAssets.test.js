const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Yield Asset Management", function () {
    
    // Helper to add a single yield asset with 100% weight
    async function addSingleYieldAsset(router, manager, yieldVault, usdc) {
        const usdcAddress = await usdc.getAddress();
        const vaultAddress = await yieldVault.getAddress();
        
        await router.connect(manager).addYieldAsset(
            vaultAddress,
            usdcAddress,
            vaultAddress,
            ASSET_TYPE.ERC4626
        );

        await router.connect(manager).updateWeights([10000]);
    }

    describe("Add Yield Asset", function () {
        it("Should add yield asset with zero weight (inactive)", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );

            expect(await router.getYieldAssetCount()).to.equal(1);
            expect(await router.getYieldAssetWeight(await yieldVault.getAddress())).to.equal(0);
        });

        it("Should store correct yield asset config", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            const usdcAddress = await usdc.getAddress();
            
            await router.connect(manager).addYieldAsset(
                vaultAddress,
                usdcAddress,
                vaultAddress,
                ASSET_TYPE.ERC4626
            );

            const config = await router.getYieldAssetConfig(vaultAddress);
            expect(config.manager).to.equal(vaultAddress);
            expect(config.depositToken).to.equal(usdcAddress);
        });

        it("Should emit YieldAssetAdded event", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await expect(
                router.connect(manager).addYieldAsset(
                    vaultAddress,
                    await usdc.getAddress(),
                    vaultAddress,
                    ASSET_TYPE.ERC4626
                )
            ).to.emit(router, "YieldAssetAdded")
             .withArgs(vaultAddress, vaultAddress, 0);
        });

        it("Should revert if token is zero address", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).addYieldAsset(
                    ethers.ZeroAddress,
                    await usdc.getAddress(),
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert if deposit token is zero address", async function () {
            const { router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await yieldVault.getAddress(),
                    ethers.ZeroAddress,
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert if manager is zero address", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await yieldVault.getAddress(),
                    await usdc.getAddress(),
                    ethers.ZeroAddress,
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert if asset already exists", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            const usdcAddress = await usdc.getAddress();
            
            await router.connect(manager).addYieldAsset(vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626);
            
            await expect(
                router.connect(manager).addYieldAsset(vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626)
            ).to.be.revertedWithCustomError(router, "AssetAlreadyExists")
             .withArgs(vaultAddress);
        });

        it("Should revert if caller is not manager", async function () {
            const { router, user1, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).addYieldAsset(
                    await yieldVault.getAddress(),
                    await usdc.getAddress(),
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.reverted;
        });

        it("Should add multiple yield assets", async function () {
            const { router, manager, yieldVault, yieldVault2, usdc } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), usdcAddress, await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(), usdcAddress, await yieldVault2.getAddress(), ASSET_TYPE.ERC4626
            );

            expect(await router.getYieldAssetCount()).to.equal(2);
        });

        it("Should revert when max yield assets reached", async function () {
            const { router, manager, usdc } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            
            // Add 10 yield assets (the maximum)
            const MockERC4626Vault = await ethers.getContractFactory("MockERC4626Vault");
            for (let i = 0; i < 10; i++) {
                const vault = await MockERC4626Vault.deploy(usdcAddress);
                await vault.waitForDeployment();
                const vaultAddress = await vault.getAddress();
                await router.connect(manager).addYieldAsset(vaultAddress, usdcAddress, vaultAddress, ASSET_TYPE.ERC4626);
            }

            // Try to add 11th asset
            const vault11 = await MockERC4626Vault.deploy(usdcAddress);
            await vault11.waitForDeployment();
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await vault11.getAddress(), usdcAddress, await vault11.getAddress(), ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "MaxYieldAssetsReached")
             .withArgs(10);
        });
    });

    describe("Update Weights", function () {
        it("Should update weight for single asset", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await router.connect(manager).addYieldAsset(
                vaultAddress, await usdc.getAddress(), vaultAddress, ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);

            expect(await router.getYieldAssetWeight(vaultAddress)).to.equal(10000);
        });

        it("Should update weights for multiple assets", async function () {
            const { router, manager, yieldVault, yieldVault2, usdc } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            const vault1Address = await yieldVault.getAddress();
            const vault2Address = await yieldVault2.getAddress();
            
            await router.connect(manager).addYieldAsset(vault1Address, usdcAddress, vault1Address, ASSET_TYPE.ERC4626);
            await router.connect(manager).addYieldAsset(vault2Address, usdcAddress, vault2Address, ASSET_TYPE.ERC4626);
            await router.connect(manager).updateWeights([6000, 4000]);

            expect(await router.getYieldAssetWeight(vault1Address)).to.equal(6000);
            expect(await router.getYieldAssetWeight(vault2Address)).to.equal(4000);
        });

        it("Should emit YieldAssetWeightUpdated events", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await router.connect(manager).addYieldAsset(
                vaultAddress, await usdc.getAddress(), vaultAddress, ASSET_TYPE.ERC4626
            );

            await expect(router.connect(manager).updateWeights([10000]))
                .to.emit(router, "YieldAssetWeightUpdated")
                .withArgs(vaultAddress, 10000);
        });

        it("Should revert if weights length mismatch", async function () {
            const { router, manager, yieldVault, yieldVault2, usdc } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), usdcAddress, await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(), usdcAddress, await yieldVault2.getAddress(), ASSET_TYPE.ERC4626
            );

            await expect(
                router.connect(manager).updateWeights([10000])
            ).to.be.revertedWithCustomError(router, "LengthMismatch")
             .withArgs(1, 2);
        });

        it("Should revert if total weight is not 10000", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), await usdc.getAddress(), await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );

            await expect(
                router.connect(manager).updateWeights([5000])
            ).to.be.revertedWithCustomError(router, "InvalidTotalWeight")
             .withArgs(5000);
        });

        it("Should revert if caller is not manager", async function () {
            const { router, user1, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), await usdc.getAddress(), await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );

            await expect(
                router.connect(user1).updateWeights([10000])
            ).to.be.reverted;
        });

        it("Should auto-drain asset when weight goes to zero", async function () {
            const { usdl, router, manager, yieldVault, yieldVault2, usdc, user1 } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            const vault1Address = await yieldVault.getAddress();
            const vault2Address = await yieldVault2.getAddress();
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            // Setup: single asset, 100% weight
            await router.connect(manager).addYieldAsset(vault1Address, usdcAddress, vault1Address, ASSET_TYPE.ERC4626);
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // Verify funds are in yieldVault (held by router, not USDL)
            expect(await yieldVault.balanceOf(routerAddress)).to.be.gt(0);

            // Add second asset and set first to 0 weight
            await router.connect(manager).addYieldAsset(vault2Address, usdcAddress, vault2Address, ASSET_TYPE.ERC4626);
            await router.connect(manager).updateWeights([0, 10000]);

            // Vault1 should be drained
            expect(await yieldVault.balanceOf(routerAddress)).to.equal(0);
        });
    });

    describe("Remove Yield Asset", function () {
        it("Should remove yield asset with zero weight and zero balance", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await router.connect(manager).addYieldAsset(
                vaultAddress, await usdc.getAddress(), vaultAddress, ASSET_TYPE.ERC4626
            );

            // Weight is 0 by default, can remove immediately
            await router.connect(manager).removeYieldAsset(vaultAddress);

            expect(await router.getYieldAssetCount()).to.equal(0);
        });

        it("Should emit YieldAssetRemoved event", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await router.connect(manager).addYieldAsset(
                vaultAddress, await usdc.getAddress(), vaultAddress, ASSET_TYPE.ERC4626
            );

            await expect(router.connect(manager).removeYieldAsset(vaultAddress))
                .to.emit(router, "YieldAssetRemoved")
                .withArgs(vaultAddress);
        });

        it("Should revert if asset not found", async function () {
            const { router, manager, yieldVault } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await expect(
                router.connect(manager).removeYieldAsset(vaultAddress)
            ).to.be.revertedWithCustomError(router, "AssetNotFound")
             .withArgs(vaultAddress);
        });

        it("Should revert if asset still has weight", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            const vaultAddress = await yieldVault.getAddress();
            
            await router.connect(manager).addYieldAsset(
                vaultAddress, await usdc.getAddress(), vaultAddress, ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);

            await expect(
                router.connect(manager).removeYieldAsset(vaultAddress)
            ).to.be.revertedWithCustomError(router, "AssetStillActive")
             .withArgs(vaultAddress, 10000);
        });
    });

    describe("View Functions", function () {
        it("Should return all yield assets with weights", async function () {
            const { router, manager, yieldVault, yieldVault2, usdc } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            const vault1Address = await yieldVault.getAddress();
            const vault2Address = await yieldVault2.getAddress();
            
            await router.connect(manager).addYieldAsset(vault1Address, usdcAddress, vault1Address, ASSET_TYPE.ERC4626);
            await router.connect(manager).addYieldAsset(vault2Address, usdcAddress, vault2Address, ASSET_TYPE.ERC4626);
            await router.connect(manager).updateWeights([6000, 4000]);

            const [tokens, weights] = await router.getAllYieldAssets();
            
            expect(tokens.length).to.equal(2);
            expect(weights.length).to.equal(2);
            expect(tokens[0]).to.equal(vault1Address);
            expect(tokens[1]).to.equal(vault2Address);
            expect(weights[0]).to.equal(6000);
            expect(weights[1]).to.equal(4000);
        });

        it("Should return zero weight for non-existent asset", async function () {
            const { router } = await loadFixture(usdlFixture);
            
            expect(await router.getYieldAssetWeight(ethers.ZeroAddress)).to.equal(0);
        });
    });
});
