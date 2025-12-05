const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture } = require("./helpers/setup");

describe("USDL - ERC20 Transfers", function () {

    // Helper to setup with deposit
    async function setupWithDeposit() {
        const fixture = await usdlFixture();
        const { usdl, usdc, user1 } = fixture;
        const usdlAddress = await usdl.getAddress();
        
        const depositAmount = ethers.parseUnits("1000", 6);
        await usdc.connect(user1).approve(usdlAddress, depositAmount);
        await usdl.connect(user1).deposit(depositAmount, user1.address);
        
        return { ...fixture, depositAmount };
    }

    describe("Transfer", function () {
        it("Should transfer tokens", async function () {
            const { usdl, user1, user2, depositAmount } = await loadFixture(setupWithDeposit);
            const transferAmount = ethers.parseUnits("100", 6);
            
            await usdl.connect(user1).transfer(user2.address, transferAmount);

            expect(await usdl.balanceOf(user2.address)).to.equal(transferAmount);
            expect(await usdl.balanceOf(user1.address)).to.equal(depositAmount - transferAmount);
        });

        it("Should emit Transfer event", async function () {
            const { usdl, user1, user2 } = await loadFixture(setupWithDeposit);
            const transferAmount = ethers.parseUnits("100", 6);

            await expect(usdl.connect(user1).transfer(user2.address, transferAmount))
                .to.emit(usdl, "Transfer")
                .withArgs(user1.address, user2.address, transferAmount);
        });

        it("Should revert when paused", async function () {
            const { usdl, user1, user2, pauser } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(pauser).pause();

            await expect(
                usdl.connect(user1).transfer(user2.address, 100)
            ).to.be.reverted;
        });
    });

    describe("TransferFrom", function () {
        it("Should transfer with allowance", async function () {
            const { usdl, user1, user2, depositAmount } = await loadFixture(setupWithDeposit);
            const transferAmount = ethers.parseUnits("100", 6);
            
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("200", 6));
            await usdl.connect(user2).transferFrom(user1.address, user2.address, transferAmount);

            expect(await usdl.balanceOf(user2.address)).to.equal(transferAmount);
        });

        it("Should decrease allowance after transfer", async function () {
            const { usdl, user1, user2 } = await loadFixture(setupWithDeposit);
            const allowanceAmount = ethers.parseUnits("200", 6);
            const transferAmount = ethers.parseUnits("100", 6);
            
            await usdl.connect(user1).approve(user2.address, allowanceAmount);
            await usdl.connect(user2).transferFrom(user1.address, user2.address, transferAmount);

            expect(await usdl.allowance(user1.address, user2.address)).to.equal(allowanceAmount - transferAmount);
        });

        it("Should not decrease unlimited allowance", async function () {
            const { usdl, user1, user2 } = await loadFixture(setupWithDeposit);
            const transferAmount = ethers.parseUnits("100", 6);
            
            await usdl.connect(user1).approve(user2.address, ethers.MaxUint256);
            await usdl.connect(user2).transferFrom(user1.address, user2.address, transferAmount);

            expect(await usdl.allowance(user1.address, user2.address)).to.equal(ethers.MaxUint256);
        });

        it("Should emit Transfer event", async function () {
            const { usdl, user1, user2 } = await loadFixture(setupWithDeposit);
            const transferAmount = ethers.parseUnits("100", 6);
            
            await usdl.connect(user1).approve(user2.address, transferAmount);

            await expect(usdl.connect(user2).transferFrom(user1.address, user2.address, transferAmount))
                .to.emit(usdl, "Transfer")
                .withArgs(user1.address, user2.address, transferAmount);
        });
    });

    describe("Approve", function () {
        it("Should set allowance", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            const allowanceAmount = ethers.parseUnits("1000", 6);
            
            await usdl.connect(user1).approve(user2.address, allowanceAmount);

            expect(await usdl.allowance(user1.address, user2.address)).to.equal(allowanceAmount);
        });

        it("Should emit Approval event", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            const allowanceAmount = ethers.parseUnits("1000", 6);

            await expect(usdl.connect(user1).approve(user2.address, allowanceAmount))
                .to.emit(usdl, "Approval")
                .withArgs(user1.address, user2.address, allowanceAmount);
        });

        it("Should overwrite previous allowance", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("1000", 6));
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("500", 6));

            expect(await usdl.allowance(user1.address, user2.address)).to.equal(ethers.parseUnits("500", 6));
        });

        it("Should revert when paused", async function () {
            const { usdl, user1, user2, pauser } = await loadFixture(usdlFixture);
            
            await usdl.connect(pauser).pause();

            await expect(
                usdl.connect(user1).approve(user2.address, 1000)
            ).to.be.reverted;
        });
    });

    describe("Balance and Supply", function () {
        it("Should return correct balance", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            expect(await usdl.balanceOf(user1.address)).to.equal(depositAmount);
        });

        it("Should return correct total supply", async function () {
            const { usdl, depositAmount } = await loadFixture(setupWithDeposit);
            expect(await usdl.totalSupply()).to.equal(depositAmount);
        });

        it("Should track raw shares separately", async function () {
            const { usdl, user1, depositAmount } = await loadFixture(setupWithDeposit);
            
            // Initially 1:1
            expect(await usdl.sharesOf(user1.address)).to.equal(depositAmount);
            expect(await usdl.totalShares()).to.equal(depositAmount);
        });
    });

    describe("Blacklist Effects on Transfers", function () {
        it("Should revert transfer from blacklisted sender", async function () {
            const { usdl, user1, user2, blacklister, depositAmount } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(blacklister).blacklist(user1.address);

            await expect(
                usdl.connect(user1).transfer(user2.address, 100)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });

        it("Should revert transfer to blacklisted recipient", async function () {
            const { usdl, user1, user2, blacklister } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(blacklister).blacklist(user2.address);

            await expect(
                usdl.connect(user1).transfer(user2.address, 100)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user2.address);
        });

        it("Should revert transferFrom involving blacklisted owner", async function () {
            const { usdl, owner, user1, user2, blacklister } = await loadFixture(setupWithDeposit);
            
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("500", 6));
            await usdl.connect(blacklister).blacklist(user1.address);

            await expect(
                usdl.connect(user2).transferFrom(user1.address, user2.address, 100)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted")
             .withArgs(user1.address);
        });
    });
});
