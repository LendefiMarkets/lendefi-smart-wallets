const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Deposits and Mints", function () {

    // Helper to setup yield asset
    async function setupWithYieldAsset() {
        const fixture = await usdlFixture();
        const { router, manager, yieldVault, usdc } = fixture;
        
        await router.connect(manager).addYieldAsset(
            await yieldVault.getAddress(),
            await usdc.getAddress(),
            await yieldVault.getAddress(),
            ASSET_TYPE.ERC4626
        );
        await router.connect(manager).updateWeights([10000]);
        
        return fixture;
    }

    describe("Deposit", function () {
        it("Should deposit USDC and receive shares", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(await usdl.balanceOf(user1.address)).to.equal(depositAmount);
        });

        it("Should not charge deposit fee", async function () {
            const { usdl, usdc, user1, treasury } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            const treasuryBalanceBefore = await usdc.balanceOf(treasury.address);
            
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            const shares = await usdl.connect(user1).deposit.staticCall(depositAmount, user1.address);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(shares).to.equal(depositAmount);
            expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBalanceBefore);
        });

        it("Should deposit to other receiver", async function () {
            const { usdl, usdc, user1, user2 } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user2.address);

            expect(await usdl.balanceOf(user2.address)).to.equal(depositAmount);
            expect(await usdl.balanceOf(user1.address)).to.equal(0);
        });

        it("Should emit Deposit event", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            
            await usdc.connect(user1).approve(usdlAddress, depositAmount);

            await expect(usdl.connect(user1).deposit(depositAmount, user1.address))
                .to.emit(usdl, "Deposit")
                .withArgs(user1.address, user1.address, depositAmount, depositAmount);
        });

        it("Should allocate to yield asset proportionally", async function () {
            const fixture = await loadFixture(setupWithYieldAsset);
            const { usdl, usdc, yieldVault, router, user1 } = fixture;
            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // Router holds the vault shares, not USDL
            expect(await yieldVault.balanceOf(routerAddress)).to.equal(depositAmount);
        });

        it("Should revert if below minimum deposit", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const smallAmount = ethers.parseUnits("0.5", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), smallAmount);

            await expect(
                usdl.connect(user1).deposit(smallAmount, user1.address)
            ).to.be.revertedWithCustomError(usdl, "BelowMinimumDeposit")
             .withArgs(smallAmount, ethers.parseUnits("1", 6));
        });

        it("Should accept exact minimum deposit", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const minDeposit = ethers.parseUnits("1", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), minDeposit);
            await usdl.connect(user1).deposit(minDeposit, user1.address);

            expect(await usdl.balanceOf(user1.address)).to.equal(minDeposit);
        });

        it("Should revert if receiver is zero address", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);

            await expect(
                usdl.connect(user1).deposit(depositAmount, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if receiver is the contract itself", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            
            await usdc.connect(user1).approve(usdlAddress, depositAmount);

            await expect(
                usdl.connect(user1).deposit(depositAmount, usdlAddress)
            ).to.be.revertedWithCustomError(usdl, "InvalidRecipient")
             .withArgs(usdlAddress);
        });

        it("Should revert if sender is blacklisted", async function () {
            const { usdl, usdc, user1, blacklister } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            
            await usdl.connect(blacklister).blacklist(user1.address);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);

            await expect(
                usdl.connect(user1).deposit(depositAmount, user1.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });

        it("Should revert if receiver is blacklisted", async function () {
            const { usdl, usdc, user1, user2, blacklister } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            
            await usdl.connect(blacklister).blacklist(user2.address);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);

            await expect(
                usdl.connect(user1).deposit(depositAmount, user2.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user2.address);
        });

        it("Should revert when paused", async function () {
            const { usdl, usdc, user1, pauser } = await loadFixture(usdlFixture);
            const depositAmount = ethers.parseUnits("1000", 6);
            
            await usdl.connect(pauser).pause();
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);

            await expect(
                usdl.connect(user1).deposit(depositAmount, user1.address)
            ).to.be.reverted;
        });

        it("Should handle multiple users depositing", async function () {
            const { usdl, usdc, user1, user2 } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            const amount1 = ethers.parseUnits("1000", 6);
            const amount2 = ethers.parseUnits("2000", 6);
            
            await usdc.connect(user1).approve(usdlAddress, amount1);
            await usdl.connect(user1).deposit(amount1, user1.address);

            await usdc.connect(user2).approve(usdlAddress, amount2);
            await usdl.connect(user2).deposit(amount2, user2.address);

            expect(await usdl.balanceOf(user1.address)).to.equal(amount1);
            expect(await usdl.balanceOf(user2.address)).to.equal(amount2);
            expect(await usdl.totalAssets()).to.equal(amount1 + amount2);
        });
    });

    describe("Mint (ERC4626)", function () {
        it("Should mint specified shares", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const sharesToMint = ethers.parseUnits("1000", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), sharesToMint * 2n);
            // Use explicit function signature to distinguish from IBurnMintERC20.mint(address,uint256)
            await usdl.connect(user1)["mint(uint256,address)"](sharesToMint, user1.address);

            expect(await usdl.balanceOf(user1.address)).to.equal(sharesToMint);
        });

        it("Should return assets used", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const sharesToMint = ethers.parseUnits("1000", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), sharesToMint * 2n);
            const assets = await usdl.connect(user1)["mint(uint256,address)"].staticCall(sharesToMint, user1.address);

            // No deposit fee, so assets = shares at 1:1 ratio initially
            expect(assets).to.equal(sharesToMint);
        });

        it("Should revert if shares is zero", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1)["mint(uint256,address)"](0, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert if receiver is zero address", async function () {
            const { usdl, usdc, user1 } = await loadFixture(usdlFixture);
            const sharesToMint = ethers.parseUnits("1000", 6);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), sharesToMint * 2n);

            await expect(
                usdl.connect(user1)["mint(uint256,address)"](sharesToMint, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if blacklisted", async function () {
            const { usdl, usdc, user1, blacklister } = await loadFixture(usdlFixture);
            const sharesToMint = ethers.parseUnits("1000", 6);
            
            await usdl.connect(blacklister).blacklist(user1.address);
            await usdc.connect(user1).approve(await usdl.getAddress(), sharesToMint * 2n);

            await expect(
                usdl.connect(user1)["mint(uint256,address)"](sharesToMint, user1.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });
    });

    describe("Preview Functions", function () {
        it("previewDeposit should return expected shares", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const assets = ethers.parseUnits("1000", 6);
            
            const shares = await usdl.previewDeposit(assets);
            expect(shares).to.equal(assets); // 1:1 initially
        });

        it("previewMint should return expected assets", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const shares = ethers.parseUnits("1000", 6);
            
            const assets = await usdl.previewMint(shares);
            expect(assets).to.equal(shares); // 1:1 initially
        });

        it("convertToShares should match previewDeposit", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const assets = ethers.parseUnits("1000", 6);
            
            const shares = await usdl.convertToShares(assets);
            const preview = await usdl.previewDeposit(assets);
            expect(shares).to.equal(preview);
        });

        it("convertToAssets should work correctly", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const shares = ethers.parseUnits("1000", 6);
            
            const assets = await usdl.convertToAssets(shares);
            expect(assets).to.equal(shares); // 1:1 initially
        });
    });

    describe("Proportional Allocation", function () {
        it("Should allocate to single asset at 100%", async function () {
            const fixture = await loadFixture(setupWithYieldAsset);
            const { usdl, router, usdc, yieldVault, user1 } = fixture;
            const depositAmount = ethers.parseUnits("1000", 6);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // Yield tokens are held by router, not USDL
            expect(await yieldVault.balanceOf(routerAddress)).to.equal(depositAmount);
        });

        it("Should allocate to two assets proportionally (60/40)", async function () {
            const { usdl, router, usdc, yieldVault, yieldVault2, manager, user1 } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), usdcAddress, await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(), usdcAddress, await yieldVault2.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([6000, 4000]);

            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            const vault1Balance = await yieldVault.balanceOf(routerAddress);
            const vault2Balance = await yieldVault2.balanceOf(routerAddress);
            
            // Should be approximately 60% and 40%
            expect(vault1Balance + vault2Balance).to.equal(depositAmount);
            // Allow for dust handling - last asset gets remainder
            expect(vault1Balance).to.be.closeTo(ethers.parseUnits("600", 6), 1);
        });

        it("Should skip zero-weight assets", async function () {
            const { usdl, router, usdc, yieldVault, yieldVault2, manager, user1 } = await loadFixture(usdlFixture);
            const usdcAddress = await usdc.getAddress();
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            // Add two assets but only activate one
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), usdcAddress, await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(), usdcAddress, await yieldVault2.getAddress(), ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000, 0]); // 100% to vault1, 0% to vault2

            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            expect(await yieldVault.balanceOf(routerAddress)).to.be.gt(0);
            expect(await yieldVault2.balanceOf(routerAddress)).to.equal(0);
        });

        it("Should keep USDC in router when no active assets", async function () {
            const { usdl, router, usdc, yieldVault, manager, user1 } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            // Add asset but don't set weight
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(), await usdc.getAddress(), await yieldVault.getAddress(), ASSET_TYPE.ERC4626
            );
            // Weight remains 0 by default

            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // USDC should be in router when no active assets
            expect(await usdc.balanceOf(routerAddress)).to.equal(depositAmount);
            expect(await yieldVault.balanceOf(routerAddress)).to.equal(0);
        });
    });

    describe("Max Functions", function () {
        it("maxDeposit should return max uint256", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);
            expect(await usdl.maxDeposit(user1.address)).to.equal(ethers.MaxUint256);
        });

        it("maxMint should return max uint256", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);
            expect(await usdl.maxMint(user1.address)).to.equal(ethers.MaxUint256);
        });
    });
});
