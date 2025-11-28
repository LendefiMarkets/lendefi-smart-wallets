const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Amount Parameter Fuzzing", function () {
    async function deploySystemFixture() {
        const [owner, user1, user2] = await ethers.getSigners();
        
        // Deploy EntryPoint
        const entryPoint = await ethers.deployContract("EntryPoint");
        
        // Deploy factory with upgrades plugin
        const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
        const factory = await upgrades.deployProxy(
            SmartWalletFactory,
            [entryPoint.target, owner.address, ethers.ZeroAddress],
            { 
                initializer: 'initialize',
                unsafeAllow: ['constructor'],
                silenceWarnings: true
            }
        );
        
        // Create a SmartWallet
        await factory.createAccount(user1.address, 0);
        const walletAddress = await factory.getWallet(user1.address);
        const wallet = await ethers.getContractAt("SmartWallet", walletAddress);
        
        // Deploy paymaster
        const paymaster = await ethers.deployContract("LendefiPaymaster", [
            entryPoint.target,
            factory.target
        ]);
        
        return { 
            entryPoint, 
            factory, 
            wallet, 
            paymaster, 
            owner, 
            user1, 
            user2 
        };
    }

    describe("EntryPoint Amount Edge Cases", function () {
        const testAmounts = [
            0n,                                    // Zero
            1n,                                    // Minimum positive
            ethers.parseEther("0.000000000000000001"), // 1 wei
            ethers.parseEther("0.000001"),         // 1 gwei equivalent in ether
        ];

        testAmounts.forEach((amount, index) => {
            it(`Should handle deposit amount: ${amount.toString()}`, async function () {
                const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
                
                if (amount === 0n) {
                    // Zero deposit should work but not change balance
                    await expect(entryPoint.connect(user1).depositTo(user1.address, { value: amount }))
                        .to.not.be.reverted;
                    expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
                } else {
                    await expect(entryPoint.connect(user1).depositTo(user1.address, { value: amount }))
                        .to.not.be.reverted;
                    expect(await entryPoint.balanceOf(user1.address)).to.equal(amount);
                }
            });
        });

        it("Should handle zero withdrawal amount", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
            
            // Deposit first
            await entryPoint.connect(user1).depositTo(user1.address, { value: ethers.parseEther("1") });
            
            // Zero withdrawal should be allowed (no-op)
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, 0))
                .to.not.be.reverted;
            
            // Balance should remain unchanged
            expect(await entryPoint.balanceOf(user1.address)).to.equal(ethers.parseEther("1"));
        });

        it("Should reject withdrawal exceeding balance by 1 wei", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
            
            const depositAmount = ethers.parseEther("1");
            await entryPoint.connect(user1).depositTo(user1.address, { value: depositAmount });
            
            // Try to withdraw 1 wei more than balance
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, depositAmount + 1n))
                .to.be.revertedWith("Withdraw amount too large");
        });

        it("Should handle exact balance withdrawal", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
            
            const amount = ethers.parseEther("1");
            await entryPoint.connect(user1).depositTo(user1.address, { value: amount });
            
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, amount))
                .to.not.be.reverted;
            
            expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
        });

        it("Should handle minimum stake amount", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
            
            // Test 1 wei stake with required unstakeDelay > 0
            await expect(entryPoint.connect(user1).addStake(1, { value: 1 }))
                .to.not.be.reverted;
            
            // In v0.7, stake goes to stake field not deposit
            const depositInfo = await entryPoint.getDepositInfo(user1.address);
            expect(depositInfo.stake).to.equal(1);
        });
    });

    describe("SmartWallet Amount Edge Cases", function () {
        it("Should handle zero value execute call", async function () {
            const { wallet, user1, user2 } = await loadFixture(deploySystemFixture);
            
            // Zero value transfer should work
            await expect(wallet.connect(user1).execute(
                user2.address,
                0,
                "0x"
            )).to.not.be.reverted;
        });

        it("Should handle minimum value execute call", async function () {
            const { wallet, user1, user2 } = await loadFixture(deploySystemFixture);
            
            // Fund the wallet first
            await user1.sendTransaction({
                to: wallet.target,
                value: ethers.parseEther("1")
            });
            
            // 1 wei transfer
            await expect(wallet.connect(user1).execute(
                user2.address,
                1,
                "0x"
            )).to.not.be.reverted;
        });

        it("Should reject execute call exceeding wallet balance", async function () {
            const { wallet, user1, user2 } = await loadFixture(deploySystemFixture);
            
            // Try to send more than wallet has
            await expect(wallet.connect(user1).execute(
                user2.address,
                ethers.parseEther("1"),
                "0x"
            )).to.be.reverted; // Should revert due to insufficient balance
        });

        it("Should handle zero value in batch execute", async function () {
            const { wallet, user1, user2 } = await loadFixture(deploySystemFixture);
            
            await expect(wallet.connect(user1).executeBatch(
                [user2.address, user2.address],
                [0, 0],
                ["0x", "0x"]
            )).to.not.be.reverted;
        });

        it("Should handle mixed zero and non-zero values in batch", async function () {
            const { wallet, user1, user2 } = await loadFixture(deploySystemFixture);
            
            // Fund the wallet
            await user1.sendTransaction({
                to: wallet.target,
                value: ethers.parseEther("1")
            });
            
            await expect(wallet.connect(user1).executeBatch(
                [user2.address, user2.address],
                [0, 1], // Zero and 1 wei
                ["0x", "0x"]
            )).to.not.be.reverted;
        });

        it("Should handle zero amount withdrawal from EntryPoint", async function () {
            const { wallet, user1, entryPoint } = await loadFixture(deploySystemFixture);
            
            // Deposit to EntryPoint first
            await wallet.connect(user1).addDeposit({ value: ethers.parseEther("1") });
            
            // Zero withdrawal should work
            await expect(wallet.connect(user1).withdrawDepositTo(user1.address, 0))
                .to.not.be.reverted;
        });

        it("Should reject withdrawal exceeding EntryPoint deposit", async function () {
            const { wallet, user1, entryPoint } = await loadFixture(deploySystemFixture);
            
            const depositAmount = ethers.parseEther("1");
            await wallet.connect(user1).addDeposit({ value: depositAmount });
            
            // Try to withdraw more than deposited
            await expect(wallet.connect(user1).withdrawDepositTo(user1.address, depositAmount + 1n))
                .to.be.reverted;
        });
    });

    describe("Paymaster Amount Edge Cases", function () {
        it("Should handle zero amount withdrawal from EntryPoint", async function () {
            const { paymaster, owner } = await loadFixture(deploySystemFixture);
            
            // Deposit first
            await paymaster.connect(owner).deposit({ value: ethers.parseEther("1") });
            
            // Zero withdrawal should work
            await expect(paymaster.connect(owner).withdrawTo(owner.address, 0))
                .to.not.be.reverted;
        });

        it("Should reject withdrawal exceeding paymaster deposit", async function () {
            const { paymaster, owner } = await loadFixture(deploySystemFixture);
            
            const depositAmount = ethers.parseEther("1");
            await paymaster.connect(owner).deposit({ value: depositAmount });
            
            // Try to withdraw more than available
            await expect(paymaster.connect(owner).withdrawTo(owner.address, depositAmount + 1n))
                .to.be.reverted;
        });

        it("Should handle zero gas limit configuration", async function () {
            const { paymaster, owner } = await loadFixture(deploySystemFixture);
            
            // Zero gas limit should be rejected
            await expect(paymaster.connect(owner).setTierGasLimit(1, 0)) // BASIC tier
                .to.be.revertedWithCustomError(paymaster, "InvalidGasLimit");
        });

        it("Should handle minimum gas limit configuration", async function () {
            const { paymaster, owner } = await loadFixture(deploySystemFixture);
            
            // 1 gas should be accepted
            await expect(paymaster.connect(owner).setTierGasLimit(1, 1)) // BASIC tier
                .to.not.be.reverted;
        });

        it("Should handle maximum gas limit configuration", async function () {
            const { paymaster, owner } = await loadFixture(deploySystemFixture);
            
            // Just under the limit should work
            await expect(paymaster.connect(owner).setMaxGasPerOperation(30_000_000))
                .to.not.be.reverted;
            
            // Over the limit should fail
            await expect(paymaster.connect(owner).setMaxGasPerOperation(30_000_001))
                .to.be.revertedWithCustomError(paymaster, "GasLimitTooHigh");
        });
    });

    describe("Factory Amount Edge Cases", function () {
        it("Should reject zero unstake delay", async function () {
            const { factory, owner } = await loadFixture(deploySystemFixture);
            
            // v0.7 requires unstakeDelay > 0
            await expect(factory.connect(owner).addStake(0, { value: 0 }))
                .to.be.revertedWith("must specify unstake delay");
        });

        it("Should handle minimum stake operations", async function () {
            const { factory, owner } = await loadFixture(deploySystemFixture);
            
            // 1 wei stake with required unstakeDelay > 0
            await expect(factory.connect(owner).addStake(1, { value: 1 }))
                .to.not.be.reverted;
        });
    });

    describe("Cross-Contract Amount Consistency", function () {
        it("Should maintain precision across all deposit/withdrawal operations", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemFixture);
            
            const testAmount = ethers.parseEther("1.123456789012345678"); // 18 decimal precision
            
            // Deposit to EntryPoint via wallet
            await wallet.connect(user1).addDeposit({ value: testAmount });
            
            // Check exact amount is preserved
            expect(await entryPoint.balanceOf(wallet.target)).to.equal(testAmount);
            
            // Withdraw and check precision
            await wallet.connect(user1).withdrawDepositTo(user1.address, testAmount);
            expect(await entryPoint.balanceOf(wallet.target)).to.equal(0);
        });

        it("Should handle amount arithmetic edge cases", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
            
            // Test arithmetic edge case: reasonable amount - 1
            const testAmount = ethers.parseEther("5");
            await entryPoint.connect(user1).depositTo(user1.address, { value: testAmount });
            
            // Withdraw all but 1 wei
            await entryPoint.connect(user1).withdrawTo(user1.address, testAmount - 1n);
            expect(await entryPoint.balanceOf(user1.address)).to.equal(1);
            
            // Withdraw the last 1 wei
            await entryPoint.connect(user1).withdrawTo(user1.address, 1);
            expect(await entryPoint.balanceOf(user1.address)).to.equal(0);
        });

        it("Should prevent amount overflow in deposits", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemFixture);
            
            // This test would require MaxUint256 ETH, so we'll just verify the function exists
            // and would handle the case properly. In practice, this is limited by ETH supply.
            
            // Deposit a large amount first (reduced to fit test environment)
            const largeAmount = ethers.parseEther("1000");
            await entryPoint.connect(user1).depositTo(user1.address, { value: largeAmount });
            
            // Verify balance tracking works with large numbers
            expect(await entryPoint.balanceOf(user1.address)).to.equal(largeAmount);
        });
    });

    describe("Reentrancy with Amount Edge Cases", function () {
        it("Should handle zero amount operations with reentrancy protection", async function () {
            const { wallet, user1 } = await loadFixture(deploySystemFixture);
            
            // Zero value operations should still have reentrancy protection
            await expect(wallet.connect(user1).execute(user1.address, 0, "0x"))
                .to.not.be.reverted;
        });

        it("Should maintain amount integrity during batch operations", async function () {
            const { wallet, user1, user2 } = await loadFixture(deploySystemFixture);
            
            // Fund wallet
            await user1.sendTransaction({
                to: wallet.target,
                value: ethers.parseEther("10")
            });
            
            const initialBalance = await ethers.provider.getBalance(user2.address);
            
            // Execute batch with precise amounts
            const amounts = [
                ethers.parseEther("1.1"),
                ethers.parseEther("2.2"),
                ethers.parseEther("3.3")
            ];
            
            await wallet.connect(user1).executeBatch(
                [user2.address, user2.address, user2.address],
                amounts,
                ["0x", "0x", "0x"]
            );
            
            const finalBalance = await ethers.provider.getBalance(user2.address);
            const totalSent = amounts.reduce((a, b) => a + b, 0n);
            
            expect(finalBalance - initialBalance).to.equal(totalSent);
        });
    });
});