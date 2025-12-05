const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, ASSET_TYPE } = require("./helpers/setup");

describe("USDL - Bridge (CCIP)", function () {

    // Helper to setup with deposit
    async function setupWithDeposit() {
        const fixture = await usdlFixture();
        const { usdl, usdc, user1 } = fixture;
        const usdlAddress = await usdl.getAddress();
        
        // Deposit
        const depositAmount = ethers.parseUnits("1000", 6);
        await usdc.connect(user1).approve(usdlAddress, depositAmount);
        await usdl.connect(user1).deposit(depositAmount, user1.address);
        
        return { ...fixture, depositAmount };
    }

    describe("Bridge Mint", function () {
        it("Should mint shares to user", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);
            const amount = ethers.parseUnits("1000", 6);
            
            // Use explicit signature for IBurnMintERC20.mint(address,uint256)
            await usdl.connect(bridge)["mint(address,uint256)"](user1.address, amount);

            expect(await usdl.balanceOf(user1.address)).to.equal(amount);
        });

        it("Should emit BridgeMint event", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);
            const amount = ethers.parseUnits("1000", 6);

            await expect(usdl.connect(bridge)["mint(address,uint256)"](user1.address, amount))
                .to.emit(usdl, "BridgeMint")
                .withArgs(bridge.address, user1.address, amount);
        });

        it("Should revert if recipient is zero address", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](ethers.ZeroAddress, 1000)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if amount is zero", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](user1.address, 0)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert if recipient is contract itself", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();

            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](usdlAddress, 1000)
            ).to.be.revertedWithCustomError(usdl, "InvalidRecipient")
             .withArgs(usdlAddress);
        });

        it("Should revert if recipient is blacklisted", async function () {
            const { usdl, bridge, user1, blacklister } = await loadFixture(usdlFixture);
            
            await usdl.connect(blacklister).blacklist(user1.address);

            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](user1.address, 1000)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });

        it("Should revert if caller does not have BRIDGE_ROLE", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1)["mint(address,uint256)"](user2.address, 1000)
            ).to.be.reverted;
        });

        it("Should revert when paused", async function () {
            const { usdl, bridge, user1, pauser } = await loadFixture(usdlFixture);
            
            await usdl.connect(pauser).pause();

            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](user1.address, 1000)
            ).to.be.reverted;
        });
    });

    describe("Bridge Burn (with account)", function () {
        it("Should burn shares from user", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);
            const mintAmount = ethers.parseUnits("1000", 6);
            const burnAmount = ethers.parseUnits("500", 6);
            
            await usdl.connect(bridge)["mint(address,uint256)"](user1.address, mintAmount);
            await usdl.connect(bridge)["burn(address,uint256)"](user1.address, burnAmount);

            expect(await usdl.balanceOf(user1.address)).to.equal(mintAmount - burnAmount);
        });

        it("Should emit BridgeBurn event", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);
            const amount = ethers.parseUnits("1000", 6);
            
            await usdl.connect(bridge)["mint(address,uint256)"](user1.address, amount);

            await expect(usdl.connect(bridge)["burn(address,uint256)"](user1.address, amount))
                .to.emit(usdl, "BridgeBurn")
                .withArgs(bridge.address, user1.address, amount);
        });

        it("Should revert if account is zero address", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge)["burn(address,uint256)"](ethers.ZeroAddress, 1000)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if amount is zero", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge)["burn(address,uint256)"](user1.address, 0)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert if caller does not have BRIDGE_ROLE", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1)["burn(address,uint256)"](user1.address, 1000)
            ).to.be.reverted;
        });
    });

    describe("Bridge Burn (self)", function () {
        it("Should burn shares from caller", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);
            const mintAmount = ethers.parseUnits("1000", 6);
            const burnAmount = ethers.parseUnits("500", 6);
            
            await usdl.connect(bridge)["mint(address,uint256)"](bridge.address, mintAmount);
            await usdl.connect(bridge)["burn(uint256)"](burnAmount);

            expect(await usdl.balanceOf(bridge.address)).to.equal(mintAmount - burnAmount);
        });

        it("Should revert if amount is zero", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge)["burn(uint256)"](0)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });
    });

    describe("Bridge BurnFrom", function () {
        it("Should burn shares using allowance", async function () {
            const { usdl, usdc, bridge, user1, depositAmount } = await loadFixture(setupWithDeposit);
            const burnAmount = ethers.parseUnits("500", 6);
            
            await usdl.connect(user1).approve(bridge.address, burnAmount);
            const balanceBefore = await usdl.balanceOf(user1.address);
            
            await usdl.connect(bridge).burnFrom(user1.address, burnAmount);

            expect(await usdl.balanceOf(user1.address)).to.equal(balanceBefore - burnAmount);
        });

        it("Should emit BridgeBurn event", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);
            const amount = ethers.parseUnits("1000", 6);
            
            await usdl.connect(bridge)["mint(address,uint256)"](user1.address, amount);
            await usdl.connect(user1).approve(bridge.address, amount);

            await expect(usdl.connect(bridge).burnFrom(user1.address, amount))
                .to.emit(usdl, "BridgeBurn")
                .withArgs(bridge.address, user1.address, amount);
        });

        it("Should revert if account is zero address", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge).burnFrom(ethers.ZeroAddress, 1000)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if amount is zero", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(bridge).burnFrom(user1.address, 0)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });
    });

    describe("Ghost Share Accounting", function () {
        it("Bridge mint should not inflate share price (ghost shares)", async function () {
            const { usdl, usdc, bridge, user1, user2, depositAmount } = await loadFixture(setupWithDeposit);
            
            const sharePriceBefore = await usdl.sharePrice();

            // Bridge mints to user2 (ghost shares - don't affect totalShares)
            await usdl.connect(bridge)["mint(address,uint256)"](user2.address, ethers.parseUnits("1000", 6));

            const sharePriceAfter = await usdl.sharePrice();
            
            // Ghost share pattern: totalShares is NOT updated, so share price stays same
            expect(sharePriceAfter).to.equal(sharePriceBefore);
        });

        it("Bridge burn should not affect totalAssets", async function () {
            const { usdl, bridge, user1, depositAmount } = await loadFixture(setupWithDeposit);
            
            const totalAssetsBefore = await usdl.totalAssets();

            // Burn user1's shares via bridge
            const burnAmount = ethers.parseUnits("500", 6);
            await usdl.connect(user1).approve(bridge.address, burnAmount);
            await usdl.connect(bridge).burnFrom(user1.address, burnAmount);

            const totalAssetsAfter = await usdl.totalAssets();
            
            // totalAssets should remain unchanged (ghost share pattern)
            expect(totalAssetsAfter).to.equal(totalAssetsBefore);
        });
    });

    describe("Bridge Role Management", function () {
        it("Should grant bridge role", async function () {
            const { usdl, owner, user1, roles } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).grantBridgeRole(user1.address);

            expect(await usdl.hasRole(roles.BRIDGE_ROLE, user1.address)).to.be.true;
        });

        it("Should revert grant if zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).grantBridgeRole(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revoke bridge role", async function () {
            const { usdl, owner, bridge, roles } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).revokeBridgeRole(bridge.address);

            expect(await usdl.hasRole(roles.BRIDGE_ROLE, bridge.address)).to.be.false;
        });

        it("Should revert revoke if zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).revokeBridgeRole(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Bridge should not work after role revoked", async function () {
            const { usdl, owner, bridge, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).revokeBridgeRole(bridge.address);

            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](user1.address, 1000)
            ).to.be.reverted;
        });
    });

    describe("CCIP Admin", function () {
        it("Should return CCIP admin", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            expect(await usdl.getCCIPAdmin()).to.equal(owner.address);
        });

        it("Should set CCIP admin", async function () {
            const { usdl, owner, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).setCCIPAdmin(user1.address);

            expect(await usdl.getCCIPAdmin()).to.equal(user1.address);
        });

        it("Should emit CCIPAdminTransferred event", async function () {
            const { usdl, owner, user1 } = await loadFixture(usdlFixture);

            await expect(usdl.connect(owner).setCCIPAdmin(user1.address))
                .to.emit(usdl, "CCIPAdminTransferred")
                .withArgs(owner.address, user1.address);
        });

        it("Should revert if zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).setCCIPAdmin(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if not admin", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).setCCIPAdmin(user1.address)
            ).to.be.reverted;
        });
    });
});
