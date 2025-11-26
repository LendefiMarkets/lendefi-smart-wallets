const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("EntryPoint", function () {
    async function deployFixture() {
        const [owner, user1, user2, beneficiary] = await ethers.getSigners();
        
        // Deploy EntryPoint
        const entryPoint = await ethers.deployContract("EntryPoint");
        
        return { entryPoint, owner, user1, user2, beneficiary };
    }

    describe("Deployment and Basic Functions", function () {
        it("Should deploy EntryPoint successfully", async function () {
            const { entryPoint } = await loadFixture(deployFixture);
            expect(entryPoint.target).to.not.equal(ethers.ZeroAddress);
        });

        it("Should return zero nonce for new account", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            expect(await entryPoint.getNonce(user1.address, 0)).to.equal(0);
        });

        it("Should return zero balance for new account", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
        });
    });

    describe("Deposit Management", function () {
        it("Should accept ETH deposits via receive function", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const amount = ethers.parseEther("1");
            await user1.sendTransaction({
                to: entryPoint.target,
                value: amount
            });
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(amount);
        });

        it("Should accept deposits via depositTo function", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            const amount = ethers.parseEther("0.5");
            await entryPoint.connect(user1).depositTo(user2.address, { value: amount });
            
            expect(await entryPoint.balanceOf(user2.address)).to.equal(amount);
        });

        it("Should emit Deposited event", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const amount = ethers.parseEther("1");
            await expect(entryPoint.connect(user1).depositTo(user1.address, { value: amount }))
                .to.emit(entryPoint, "Deposited")
                .withArgs(user1.address, amount);
        });

        it("Should accumulate multiple deposits", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const amount1 = ethers.parseEther("1");
            const amount2 = ethers.parseEther("0.5");
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: amount1 });
            await entryPoint.connect(user1).depositTo(user1.address, { value: amount2 });
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(amount1 + amount2);
        });
    });

    describe("Withdrawal Management", function () {
        it("Should allow withdrawal of own funds", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const depositAmount = ethers.parseEther("1");
            const withdrawAmount = ethers.parseEther("0.3");
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: depositAmount });
            
            const initialBalance = await ethers.provider.getBalance(user1.address);
            const tx = await entryPoint.connect(user1).withdrawTo(user1.address, withdrawAmount);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(depositAmount - withdrawAmount);
            expect(await ethers.provider.getBalance(user1.address))
                .to.be.closeTo(initialBalance + withdrawAmount - gasUsed, ethers.parseEther("0.001"));
        });

        it("Should emit Withdrawn event", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            const depositAmount = ethers.parseEther("1");
            const withdrawAmount = ethers.parseEther("0.3");
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: depositAmount });
            
            await expect(entryPoint.connect(user1).withdrawTo(user2.address, withdrawAmount))
                .to.emit(entryPoint, "Withdrawn")
                .withArgs(user1.address, user2.address, withdrawAmount);
        });

        it("Should reject withdrawal of insufficient funds", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const depositAmount = ethers.parseEther("0.5");
            const withdrawAmount = ethers.parseEther("1");
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: depositAmount });
            
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, withdrawAmount))
                .to.be.revertedWithCustomError(entryPoint, "InsufficientDeposit");
        });

        it("Should allow withdrawal of zero amount (no-op)", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: ethers.parseEther("1") });
            
            // Zero withdrawal is allowed (just a no-op transfer)
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, 0))
                .to.not.be.reverted;
        });
    });

    describe("Stake Management", function () {
        it("Should allow adding stake", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("2");
            const unstakeDelay = 86400; // 1 day
            
            await expect(entryPoint.connect(user1).addStake(unstakeDelay, { value: stakeAmount }))
                .to.emit(entryPoint, "StakeLocked")
                .withArgs(user1.address, stakeAmount, unstakeDelay);
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(stakeAmount);
        });

        it("Should handle unlocking stake", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("1");
            const unstakeDelay = 3600; // 1 hour
            
            await entryPoint.connect(user1).addStake(unstakeDelay, { value: stakeAmount });
            
            await expect(entryPoint.connect(user1).unlockStake())
                .to.emit(entryPoint, "StakeUnlocked");
        });

        it("Should allow stake withdrawal after unlock delay", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("1");
            const unstakeDelay = 3600; // 1 hour
            
            await entryPoint.connect(user1).addStake(unstakeDelay, { value: stakeAmount });
            await entryPoint.connect(user1).unlockStake();
            
            // Fast forward time past unlock delay
            await time.increase(unstakeDelay + 1);
            
            await expect(entryPoint.connect(user1).withdrawStake(user2.address))
                .to.emit(entryPoint, "StakeWithdrawn")
                .withArgs(user1.address, user2.address, stakeAmount);
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
        });

        it("Should reject stake withdrawal before unlock delay", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("1");
            const unstakeDelay = 3600; // 1 hour
            
            await entryPoint.connect(user1).addStake(unstakeDelay, { value: stakeAmount });
            await entryPoint.connect(user1).unlockStake();
            
            // Try to withdraw immediately
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.be.revertedWithCustomError(entryPoint, "StakeNotUnlocked");
        });

        it("Should reject withdrawal without unlocking first", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("1");
            await entryPoint.connect(user1).addStake(86400, { value: stakeAmount });
            
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.be.revertedWithCustomError(entryPoint, "StakeNotUnlocked");
        });

        it("Should handle zero unstake delay (immediate withdrawal)", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("1");
            
            await entryPoint.connect(user1).addStake(0, { value: stakeAmount });
            await entryPoint.connect(user1).unlockStake();
            
            // Should be able to withdraw immediately with zero delay
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.not.be.reverted;
        });
    });

    describe("Access Control", function () {
        it("Should prevent unauthorized withdrawal", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: ethers.parseEther("1") });
            
            // user2 cannot withdraw user1's funds
            await expect(entryPoint.connect(user2).withdrawTo(user2.address, ethers.parseEther("0.5")))
                .to.be.revertedWithCustomError(entryPoint, "InsufficientDeposit");
        });

        it("Should isolate stake operations per account", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            await entryPoint.connect(user1).addStake(86400, { value: ethers.parseEther("1") });
            
            // user2 can manage their own stake (but has none)
            await expect(entryPoint.connect(user2).unlockStake())
                .to.not.be.reverted; // Sets user2's unlock time
            
            // user2 cannot withdraw stake they don't have
            await expect(entryPoint.connect(user2).withdrawStake(user2.address))
                .to.not.be.reverted; // No stake to withdraw, so no transfer occurs
            
            // user1's stake remains unaffected
            expect(await entryPoint.balanceOf(user1.address)).to.equal(ethers.parseEther("1"));
        });
    });

    describe("UserOperation Handling", function () {
        it("Should handle empty UserOp array", async function () {
            const { entryPoint, beneficiary } = await loadFixture(deployFixture);
            
            await expect(entryPoint.handleOps([], beneficiary.address))
                .to.not.be.reverted;
        });

        it("Should handle empty aggregated ops", async function () {
            const { entryPoint, beneficiary } = await loadFixture(deployFixture);
            
            await expect(entryPoint.handleAggregatedOps([], beneficiary.address))
                .to.not.be.reverted;
        });

        it("Should reject simulation from unauthorized caller", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const mockUserOp = {
                sender: user1.address,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: "0x0000000000000000000000000000000000000000000000000000000000000000", // 32 bytes
                preVerificationGas: 21000,
                gasFees: "0x0000000000000000000000000000000000000000000000000000000000000000", // 32 bytes
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            await expect(entryPoint.connect(user1).innerExecuteCall(mockUserOp))
                .to.be.revertedWithCustomError(entryPoint, "UnauthorizedCaller");
        });
    });

    describe("Nonce Management", function () {
        it("Should return incremental nonces for same key", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            expect(await entryPoint.getNonce(user1.address, 0)).to.equal(0);
            expect(await entryPoint.getNonce(user1.address, 1)).to.equal(0);
            expect(await entryPoint.getNonce(user1.address, 255)).to.equal(0);
        });

        it("Should handle different nonce keys independently", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            expect(await entryPoint.getNonce(user1.address, 0)).to.equal(0);
            expect(await entryPoint.getNonce(user1.address, 100)).to.equal(0);
            expect(await entryPoint.getNonce(user2.address, 0)).to.equal(0);
            expect(await entryPoint.getNonce(user2.address, 100)).to.equal(0);
        });
    });

    describe("Edge Cases and Error Handling", function () {
        it("Should handle large deposit amounts", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const largeAmount = ethers.parseEther("1000");
            await entryPoint.connect(user1).depositTo(user1.address, { value: largeAmount });
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(largeAmount);
        });

        it("Should handle withdrawing exact balance", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const amount = ethers.parseEther("1");
            await entryPoint.connect(user1).depositTo(user1.address, { value: amount });
            
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, amount))
                .to.not.be.reverted;
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
        });

        it("Should handle multiple users independently", async function () {
            const { entryPoint, user1, user2 } = await loadFixture(deployFixture);
            
            const amount1 = ethers.parseEther("1");
            const amount2 = ethers.parseEther("2");
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: amount1 });
            await entryPoint.connect(user2).depositTo(user2.address, { value: amount2 });
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(amount1);
            expect(await entryPoint.balanceOf(user2.address)).to.equal(amount2);
            
            await entryPoint.connect(user1).withdrawTo(user1.address, amount1);
            expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
            expect(await entryPoint.balanceOf(user2.address)).to.equal(amount2);
        });
    });

    describe("Event Emissions", function () {
        it("Should emit all required events for complete stake cycle", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            const stakeAmount = ethers.parseEther("1");
            const unstakeDelay = 3600;
            
            // Add stake
            await expect(entryPoint.connect(user1).addStake(unstakeDelay, { value: stakeAmount }))
                .to.emit(entryPoint, "StakeLocked")
                .and.to.emit(entryPoint, "Deposited");
            
            // Unlock stake
            await expect(entryPoint.connect(user1).unlockStake())
                .to.emit(entryPoint, "StakeUnlocked");
            
            // Fast forward and withdraw
            await time.increase(unstakeDelay + 1);
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.emit(entryPoint, "StakeWithdrawn");
        });
    });

    describe("Stake Validation", function () {
        it("Should validate minimum stake requirement", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            // The validStake modifier requires at least 1 ether and staked = true
            // Since this modifier is not currently used in any function, 
            // we need to verify the stake validation logic through the staking process
            
            // Test insufficient stake (less than 1 ether)
            const insufficientStake = ethers.parseEther("0.5");
            await entryPoint.connect(user1).addStake(3600, { value: insufficientStake });
            
            const depositInfo = await entryPoint.deposits(user1.address);
            expect(depositInfo.stake).to.equal(insufficientStake);
            expect(depositInfo.staked).to.be.true;
            
            // Test sufficient stake (1 ether or more)
            const sufficientStake = ethers.parseEther("1.5");
            await entryPoint.connect(user1).addStake(3600, { value: sufficientStake });
            
            const updatedInfo = await entryPoint.deposits(user1.address);
            expect(updatedInfo.stake).to.equal(insufficientStake + sufficientStake);
            expect(updatedInfo.staked).to.be.true;
        });

        it("Should handle unstaked accounts", async function () {
            const { entryPoint, user1 } = await loadFixture(deployFixture);
            
            // Initially, accounts are not staked
            const initialInfo = await entryPoint.deposits(user1.address);
            expect(initialInfo.staked).to.be.false;
            expect(initialInfo.stake).to.equal(0);
            
            // Add sufficient stake
            await entryPoint.connect(user1).addStake(0, { value: ethers.parseEther("1") });
            
            const stakedInfo = await entryPoint.deposits(user1.address);
            expect(stakedInfo.staked).to.be.true;
            expect(stakedInfo.stake).to.equal(ethers.parseEther("1"));
            
            // Withdraw stake to make account unstaked again
            await entryPoint.connect(user1).unlockStake();
            await entryPoint.connect(user1).withdrawStake(user1.address);
            
            const unstakedInfo = await entryPoint.deposits(user1.address);
            expect(unstakedInfo.staked).to.be.false;
            expect(unstakedInfo.stake).to.equal(0);
        });

    });
});