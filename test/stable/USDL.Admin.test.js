const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture } = require("./helpers/setup");

describe("USDL - Admin Functions", function () {

    describe("Pause/Unpause", function () {
        it("Should pause the contract", async function () {
            const { usdl, pauser } = await loadFixture(usdlFixture);
            
            await usdl.connect(pauser).pause();

            expect(await usdl.paused()).to.be.true;
        });

        it("Should unpause the contract", async function () {
            const { usdl, pauser } = await loadFixture(usdlFixture);
            
            await usdl.connect(pauser).pause();
            await usdl.connect(pauser).unpause();

            expect(await usdl.paused()).to.be.false;
        });

        it("Should revert pause if not pauser", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).pause()
            ).to.be.reverted;
        });

        it("Should revert unpause if not pauser", async function () {
            const { usdl, pauser, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(pauser).pause();

            await expect(
                usdl.connect(user1).unpause()
            ).to.be.reverted;
        });
    });

    describe("Blacklist", function () {
        it("Should blacklist address", async function () {
            const { usdl, blacklister, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(blacklister).blacklist(user1.address);

            expect(await usdl.blacklisted(user1.address)).to.be.true;
        });

        it("Should emit Blacklisted event", async function () {
            const { usdl, blacklister, user1 } = await loadFixture(usdlFixture);

            await expect(usdl.connect(blacklister).blacklist(user1.address))
                .to.emit(usdl, "Blacklisted")
                .withArgs(user1.address);
        });

        it("Should unblacklist address", async function () {
            const { usdl, blacklister, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(blacklister).blacklist(user1.address);
            await usdl.connect(blacklister).unblacklist(user1.address);

            expect(await usdl.blacklisted(user1.address)).to.be.false;
        });

        it("Should emit UnBlacklisted event", async function () {
            const { usdl, blacklister, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(blacklister).blacklist(user1.address);

            await expect(usdl.connect(blacklister).unblacklist(user1.address))
                .to.emit(usdl, "UnBlacklisted")
                .withArgs(user1.address);
        });

        it("Should revert blacklist if zero address", async function () {
            const { usdl, blacklister } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(blacklister).blacklist(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert unblacklist if zero address", async function () {
            const { usdl, blacklister } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(blacklister).unblacklist(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if not blacklister", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).blacklist(user2.address)
            ).to.be.reverted;
        });

        it("Blacklisted user cannot transfer", async function () {
            const { usdl, usdc, blacklister, user1, user2 } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            
            // Deposit first
            await usdc.connect(user1).approve(usdlAddress, ethers.parseUnits("1000", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address);
            
            // Blacklist
            await usdl.connect(blacklister).blacklist(user1.address);

            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });
    });

    describe("Treasury", function () {
        it("Should set treasury", async function () {
            const { usdl, owner, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).setTreasury(user1.address);

            expect(await usdl.treasury()).to.equal(user1.address);
        });

        it("Should emit TreasuryUpdated event", async function () {
            const { usdl, owner, treasury, user1 } = await loadFixture(usdlFixture);

            await expect(usdl.connect(owner).setTreasury(user1.address))
                .to.emit(usdl, "TreasuryUpdated")
                .withArgs(treasury.address, user1.address);
        });

        it("Should revert if zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).setTreasury(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if not admin", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).setTreasury(user2.address)
            ).to.be.reverted;
        });
    });

    describe("Redemption Fee", function () {
        it("Should set redemption fee", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).setRedemptionFee(50);

            expect(await usdl.redemptionFeeBps()).to.equal(50);
        });

        it("Should emit RedemptionFeeUpdated event", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(usdl.connect(owner).setRedemptionFee(50))
                .to.emit(usdl, "RedemptionFeeUpdated")
                .withArgs(10, 50);
        });

        it("Should allow zero fee", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).setRedemptionFee(0);

            expect(await usdl.redemptionFeeBps()).to.equal(0);
        });

        it("Should allow max fee (5%)", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            
            await usdl.connect(owner).setRedemptionFee(500);

            expect(await usdl.redemptionFeeBps()).to.equal(500);
        });

        it("Should revert if fee too high", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).setRedemptionFee(600)
            ).to.be.revertedWithCustomError(usdl, "InvalidFee")
             .withArgs(600);
        });

        it("Should revert if not admin", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).setRedemptionFee(50)
            ).to.be.reverted;
        });
    });

    describe("Emergency Withdraw", function () {
        it("Should withdraw tokens", async function () {
            const { usdl, usdc, owner, treasury } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            const amount = ethers.parseUnits("1000", 6);
            
            await usdc.mint(usdlAddress, amount);
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            
            await usdl.connect(owner).emergencyWithdraw(await usdc.getAddress(), treasury.address, amount);
            
            const treasuryAfter = await usdc.balanceOf(treasury.address);
            expect(treasuryAfter - treasuryBefore).to.equal(amount);
        });

        it("Should emit EmergencyWithdraw event", async function () {
            const { usdl, usdc, owner, treasury } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            const amount = ethers.parseUnits("1000", 6);
            const usdcAddress = await usdc.getAddress();
            
            await usdc.mint(usdlAddress, amount);

            await expect(usdl.connect(owner).emergencyWithdraw(usdcAddress, treasury.address, amount))
                .to.emit(usdl, "EmergencyWithdraw")
                .withArgs(usdcAddress, treasury.address, amount);
        });

        it("Should revert if token is zero address", async function () {
            const { usdl, owner, treasury } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).emergencyWithdraw(ethers.ZeroAddress, treasury.address, 1000)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if recipient is zero address", async function () {
            const { usdl, usdc, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).emergencyWithdraw(await usdc.getAddress(), ethers.ZeroAddress, 1000)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if amount is zero", async function () {
            const { usdl, usdc, owner, treasury } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).emergencyWithdraw(await usdc.getAddress(), treasury.address, 0)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert if not admin", async function () {
            const { usdl, usdc, user1, treasury } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).emergencyWithdraw(await usdc.getAddress(), treasury.address, 1000)
            ).to.be.reverted;
        });
    });

    describe("Rescue Donated Tokens", function () {
        it("Should rescue excess USDC", async function () {
            const { usdl, usdc, owner, user1, treasury } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            
            // Deposit
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Donate USDC
            const donationAmount = ethers.parseUnits("500", 6);
            await usdc.mint(usdlAddress, donationAmount);
            
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await usdl.connect(owner).rescueDonatedTokens(treasury.address);
            const treasuryAfter = await usdc.balanceOf(treasury.address);

            expect(treasuryAfter - treasuryBefore).to.equal(donationAmount);
        });

        it("Should emit DonatedTokensRescued event", async function () {
            const { usdl, usdc, owner, user1, treasury } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            
            // Deposit
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Donate
            const donationAmount = ethers.parseUnits("500", 6);
            await usdc.mint(usdlAddress, donationAmount);

            await expect(usdl.connect(owner).rescueDonatedTokens(treasury.address))
                .to.emit(usdl, "DonatedTokensRescued")
                .withArgs(treasury.address, donationAmount);
        });

        it("Should not rescue tracked assets", async function () {
            const { usdl, usdc, owner, user1, treasury } = await loadFixture(usdlFixture);
            const usdlAddress = await usdl.getAddress();
            
            // Deposit - funds stay in contract if no yield asset
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(usdlAddress, depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);

            // No donation - rescue should have nothing to rescue
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await usdl.connect(owner).rescueDonatedTokens(treasury.address);
            const treasuryAfter = await usdc.balanceOf(treasury.address);

            expect(treasuryAfter).to.equal(treasuryBefore);
        });

        it("Should revert if recipient is zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(owner).rescueDonatedTokens(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert if not admin", async function () {
            const { usdl, user1, treasury } = await loadFixture(usdlFixture);

            await expect(
                usdl.connect(user1).rescueDonatedTokens(treasury.address)
            ).to.be.reverted;
        });
    });
});
