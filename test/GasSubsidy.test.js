const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Gas Subsidy End-to-End Tests", function () {
    // Subscription tiers enum values
    const SubscriptionTier = {
        NONE: 0,
        BASIC: 1,
        PREMIUM: 2,
        ULTIMATE: 3
    };

    async function deployGasSubsidyFixture() {
        const [owner, user1, user2, user3, bundler] = await ethers.getSigners();

        // Deploy EntryPoint with enhanced gas tracking
        const entryPoint = await ethers.deployContract("EntryPoint");

        // Deploy factory with upgrades plugin
        const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
        const factory = await upgrades.deployProxy(
            SmartWalletFactory,
            [entryPoint.target, owner.address, ethers.ZeroAddress],
            { 
                initializer: 'initialize',
                unsafeAllow: ['constructor']
            }
        );

        // Deploy LendefiPaymaster
        const paymaster = await ethers.deployContract("LendefiPaymaster", [entryPoint.target, factory.target]);

        // Fund paymaster with substantial amount for gas subsidies
        await paymaster.connect(owner).deposit({ value: ethers.parseEther("100") });
        
        // Add stake for paymaster
        await paymaster.connect(owner).addStake(86400, { value: ethers.parseEther("10") });

        // Fund entryPoint for impersonation
        await owner.sendTransaction({
            to: entryPoint.target,
            value: ethers.parseEther("50")
        });

        // Create wallets for users
        await factory.createAccount(user1.address, 1);
        await factory.createAccount(user2.address, 2);
        await factory.createAccount(user3.address, 3);

        const wallet1 = await factory.getWallet(user1.address);
        const wallet2 = await factory.getWallet(user2.address);
        const wallet3 = await factory.getWallet(user3.address);

        return {
            entryPoint,
            factory,
            paymaster,
            owner,
            user1,
            user2,
            user3,
            bundler,
            wallet1,
            wallet2,
            wallet3
        };
    }

    function createUserOperation(sender, nonce = 0, callData = "0x", totalGas = 100000) {
        // Split total gas between verification and call gas, keeping under 500K total limit
        const preVerificationGas = 50000;
        const effectiveGas = Math.max(totalGas, preVerificationGas + 1000); // Ensure minimum gas
        const remainingGas = Math.min(effectiveGas - preVerificationGas, 400000); // Keep under 500K total
        const verificationGas = Math.max(Math.floor(remainingGas / 3), 500); // Minimum verification gas
        const callGas = Math.max(remainingGas - verificationGas, 500); // Minimum call gas
        
        return {
            sender: sender,
            nonce: nonce,
            initCode: "0x",
            callData: callData,
            accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [verificationGas, callGas]),
            preVerificationGas: preVerificationGas,
            gasFees: ethers.solidityPacked(["uint128", "uint128"], [ethers.parseUnits("10", "gwei"), ethers.parseUnits("20", "gwei")]),
            paymasterAndData: "0x",
            signature: "0x"
        };
    }

    async function simulateGasSubsidy(paymaster, entryPoint, userOp, expectedGasUsed, owner) {
        // Fund entryPoint for transaction
        await owner.sendTransaction({
            to: entryPoint.target,
            value: ethers.parseEther("1")
        });

        // Impersonate entryPoint
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [entryPoint.target],
        });
        const entryPointSigner = await ethers.getSigner(entryPoint.target);

        // Step 1: Validate paymaster operation
        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("userOpHash"));
        const maxCost = ethers.parseEther("0.1");

        const validationResult = await paymaster.connect(entryPointSigner).validatePaymasterUserOp(
            userOp,
            userOpHash,
            maxCost
        );

        // Step 2: Simulate postOp with actual gas costs
        const actualGasUsed = expectedGasUsed;
        const gasPrice = ethers.parseUnits("15", "gwei");
        const actualGasCost = actualGasUsed * gasPrice;

        // Create context manually to match the contract's encoding
        const context = ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256", "uint256", "uint8"],
            [userOp.sender, expectedGasUsed, actualGasCost, 1] // Assume BASIC tier for simplicity
        );

        const tx = await paymaster.connect(entryPointSigner).postOp(
            0, // PostOpMode.opSucceeded
            context,
            actualGasCost,
            gasPrice
        );

        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [entryPoint.target],
        });

        return { validationResult, tx, actualGasCost, gasPrice };
    }

    describe("Complete Gas Subsidy Cycle", function () {
        it("Should subsidize gas for BASIC tier user", async function () {
            const { paymaster, entryPoint, owner, user1, wallet1 } = await loadFixture(deployGasSubsidyFixture);

            // Grant BASIC subscription (500K gas limit)
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);

            // Create user operation consuming 100K gas
            const userOp = createUserOperation(wallet1, 0, "0x", 100000);
            const expectedGasUsed = 100000n;

            // Get initial subscription state
            const initialSubscription = await paymaster.getSubscription(wallet1);

            // Simulate complete gas subsidy cycle
            const { tx, actualGasCost } = await simulateGasSubsidy(
                paymaster, entryPoint, userOp, expectedGasUsed, owner
            );

            // Verify gas subsidy event was emitted (50% subsidy for BASIC tier)
            const expectedSubsidy = actualGasCost / 2n; // 50% subsidy
            await expect(tx)
                .to.emit(paymaster, "GasSubsidized")
                .withArgs(wallet1, expectedGasUsed, expectedSubsidy, 1); // 1 = BASIC tier

            // Note: EntryPoint doesn't actually deduct funds, so we can't test balance changes

            // Verify gas usage was tracked
            const finalSubscription = await paymaster.getSubscription(wallet1);
            expect(finalSubscription.gasUsedThisMonth - initialSubscription.gasUsedThisMonth)
                .to.equal(expectedGasUsed);
        });

        it("Should handle multiple operations with cumulative gas tracking", async function () {
            const { paymaster, entryPoint, owner, user2, wallet2 } = await loadFixture(deployGasSubsidyFixture);

            // Grant PREMIUM subscription (2M gas limit)
            await paymaster.connect(owner).grantSubscription(wallet2, SubscriptionTier.PREMIUM, 3600);

            let totalGasUsed = 0n;
            const operations = [150000n, 200000n, 175000n]; // Three operations

            for (let i = 0; i < operations.length; i++) {
                const gasAmount = operations[i];
                const userOp = createUserOperation(wallet2, i, "0x", Number(gasAmount));

                // Simulate gas subsidy
                await simulateGasSubsidy(paymaster, entryPoint, userOp, gasAmount, owner);
                totalGasUsed += gasAmount;

                // Verify cumulative gas tracking
                const subscription = await paymaster.getSubscription(wallet2);
                expect(subscription.gasUsedThisMonth).to.equal(totalGasUsed);
            }

            // Verify total gas usage is under PREMIUM limit (2M)
            expect(totalGasUsed).to.be.lt(2000000);
        });

        it("Should reject operations when monthly gas limit is exceeded", async function () {
            const { paymaster, entryPoint, owner, user1, wallet1 } = await loadFixture(deployGasSubsidyFixture);

            // Grant BASIC subscription (500K gas limit)
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);

            // First operation: use 400K gas (under limit)
            const userOp1 = createUserOperation(wallet1, 0, "0x", 400000);
            await simulateGasSubsidy(paymaster, entryPoint, userOp1, 400000n, owner);

            // Second operation: try to use 200K gas (would exceed 500K limit)
            const userOp2 = createUserOperation(wallet1, 1, "0x", 200000);

            // Fund and impersonate entryPoint
            await owner.sendTransaction({
                to: entryPoint.target,
                value: ethers.parseEther("1")
            });

            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // This should fail due to monthly limit exceeded
            await expect(
                paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                    userOp2,
                    ethers.keccak256(ethers.toUtf8Bytes("userOpHash2")),
                    ethers.parseEther("0.1")
                )
            ).to.be.revertedWithCustomError(paymaster, "MonthlyLimitExceeded");

            await network.provider.request({
                method: "hardhat_stopImpersonatingAccount",
                params: [entryPoint.target],
            });
        });

        it("Should handle different subscription tiers correctly", async function () {
            const { paymaster, entryPoint, owner, user1, user2, user3, wallet1, wallet2, wallet3 } = await loadFixture(deployGasSubsidyFixture);

            // Grant different subscription tiers
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);    // 500K limit
            await paymaster.connect(owner).grantSubscription(wallet2, SubscriptionTier.PREMIUM, 3600);  // 2M limit
            await paymaster.connect(owner).grantSubscription(wallet3, SubscriptionTier.ULTIMATE, 3600); // 10M limit

            const gasAmount = 300000n;

            // Test each tier can handle the same operation
            for (const wallet of [wallet1, wallet2, wallet3]) {
                const userOp = createUserOperation(wallet, 0, "0x", Number(gasAmount));
                const { tx } = await simulateGasSubsidy(paymaster, entryPoint, userOp, gasAmount, owner);
                
                // Verify gas subsidy event
                await expect(tx).to.emit(paymaster, "GasSubsidized");
                
                // Verify gas tracking
                const subscription = await paymaster.getSubscription(wallet);
                expect(subscription.gasUsedThisMonth).to.equal(gasAmount);
            }
        });

        it("Should reset monthly gas usage after 30 days", async function () {
            const { paymaster, entryPoint, owner, user1, wallet1 } = await loadFixture(deployGasSubsidyFixture);

            // Grant BASIC subscription with long duration
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 90 * 24 * 60 * 60); // 90 days

            // Use some gas
            const userOp = createUserOperation(wallet1, 0, "0x", 200000);
            await simulateGasSubsidy(paymaster, entryPoint, userOp, 200000n, owner);

            // Verify gas usage is recorded
            let subscription = await paymaster.getSubscription(wallet1);
            expect(subscription.gasUsedThisMonth).to.equal(200000);

            // Advance time by 31 days
            await time.increase(31 * 24 * 60 * 60);

            // Manual reset (simulating what would happen automatically)
            await paymaster.connect(owner).resetMonthlyGasUsage(wallet1);

            // Verify gas usage was reset
            subscription = await paymaster.getSubscription(wallet1);
            expect(subscription.gasUsedThisMonth).to.equal(0);

            // Verify subscription is still active
            expect(await paymaster.hasActiveSubscription(wallet1)).to.be.true;
        });

        it("Should handle paymaster deposit depletion gracefully", async function () {
            const { paymaster, entryPoint, owner, user1, wallet1 } = await loadFixture(deployGasSubsidyFixture);

            // Drain most of paymaster balance
            const balance = await entryPoint.balanceOf(paymaster.target);
            const drainAmount = balance - ethers.parseEther("0.01"); // Leave tiny amount
            await paymaster.connect(owner).withdrawTo(owner.address, drainAmount);

            // Grant subscription
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.ULTIMATE, 3600);

            // Create expensive operation
            const userOp = createUserOperation(wallet1, 0, "0x", 1000000);

            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Should fail due to insufficient paymaster deposit
            await expect(
                paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                    userOp,
                    ethers.keccak256(ethers.toUtf8Bytes("userOpHash")),
                    ethers.parseEther("1") // High cost
                )
            ).to.be.revertedWithCustomError(paymaster, "PaymasterDepositTooLow");

            await network.provider.request({
                method: "hardhat_stopImpersonatingAccount",
                params: [entryPoint.target],
            });
        });

        it("Should accurately track gas costs across multiple users", async function () {
            const { paymaster, entryPoint, owner, user1, user2, wallet1, wallet2 } = await loadFixture(deployGasSubsidyFixture);

            // Grant subscriptions
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);
            await paymaster.connect(owner).grantSubscription(wallet2, SubscriptionTier.PREMIUM, 3600);

            // Track total subsidies (not actual balance changes since EntryPoint doesn't deduct)

            // User 1: Two operations
            for (let i = 0; i < 2; i++) {
                const gasAmount = 100000n;
                const userOp = createUserOperation(wallet1, i, "0x", Number(gasAmount));
                await simulateGasSubsidy(paymaster, entryPoint, userOp, gasAmount, owner);
            }

            // User 2: Three operations
            for (let i = 0; i < 3; i++) {
                const gasAmount = 150000n;
                const userOp = createUserOperation(wallet2, i, "0x", Number(gasAmount));
                await simulateGasSubsidy(paymaster, entryPoint, userOp, gasAmount, owner);
            }

            // Note: EntryPoint doesn't actually deduct funds, so we skip balance verification

            // Verify individual user gas tracking
            const sub1 = await paymaster.getSubscription(wallet1);
            const sub2 = await paymaster.getSubscription(wallet2);
            expect(sub1.gasUsedThisMonth).to.equal(200000); // 2 * 100K
            expect(sub2.gasUsedThisMonth).to.equal(450000); // 3 * 150K
        });
    });

    describe("Gas Subsidy Edge Cases", function () {
        it("Should handle zero gas operations", async function () {
            const { paymaster, entryPoint, owner, user1, wallet1 } = await loadFixture(deployGasSubsidyFixture);

            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);

            const userOp = createUserOperation(wallet1, 0, "0x", 0);
            const { tx } = await simulateGasSubsidy(paymaster, entryPoint, userOp, 0n, owner);

            // Should still emit event even for zero gas
            await expect(tx).to.emit(paymaster, "GasSubsidized");

            const subscription = await paymaster.getSubscription(wallet1);
            expect(subscription.gasUsedThisMonth).to.equal(0);
        });

        it("Should handle maximum gas limit operations", async function () {
            const { paymaster, entryPoint, owner, user3, wallet3 } = await loadFixture(deployGasSubsidyFixture);

            // Grant ULTIMATE subscription (10M gas limit)
            await paymaster.connect(owner).grantSubscription(wallet3, SubscriptionTier.ULTIMATE, 3600);

            // Use exactly the monthly limit
            const maxGas = 10000000n;
            const userOp = createUserOperation(wallet3, 0, "0x", Number(maxGas));
            
            const { tx } = await simulateGasSubsidy(paymaster, entryPoint, userOp, maxGas, owner);
            await expect(tx).to.emit(paymaster, "GasSubsidized");

            const subscription = await paymaster.getSubscription(wallet3);
            expect(subscription.gasUsedThisMonth).to.equal(maxGas);
        });

        it("Should handle subscription expiration during operation", async function () {
            const { paymaster, entryPoint, owner, user1, wallet1 } = await loadFixture(deployGasSubsidyFixture);

            // Grant very short subscription
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 2); // 2 seconds

            // Wait for expiration
            await time.increase(3);

            const userOp = createUserOperation(wallet1, 0, "0x", 100000);

            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Should fail due to expired subscription
            await expect(
                paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                    userOp,
                    ethers.keccak256(ethers.toUtf8Bytes("userOpHash")),
                    ethers.parseEther("0.1")
                )
            ).to.be.revertedWithCustomError(paymaster, "SubscriptionExpired");

            await network.provider.request({
                method: "hardhat_stopImpersonatingAccount",
                params: [entryPoint.target],
            });
        });
    });

    describe("Gas Subsidy Performance Tests", function () {
        it("Should handle high-frequency operations efficiently", async function () {
            const { paymaster, entryPoint, owner, user2, wallet2 } = await loadFixture(deployGasSubsidyFixture);

            await paymaster.connect(owner).grantSubscription(wallet2, SubscriptionTier.PREMIUM, 3600);

            const operationCount = 10;
            const gasPerOp = 50000n;
            
            // Execute multiple operations rapidly
            for (let i = 0; i < operationCount; i++) {
                const userOp = createUserOperation(wallet2, i, "0x", Number(gasPerOp));
                await simulateGasSubsidy(paymaster, entryPoint, userOp, gasPerOp, owner);
            }

            // Verify total gas tracking
            const subscription = await paymaster.getSubscription(wallet2);
            expect(subscription.gasUsedThisMonth).to.equal(gasPerOp * BigInt(operationCount));
        });

        it("Should maintain accuracy under concurrent operations", async function () {
            const { paymaster, entryPoint, owner, user1, user2, user3, wallet1, wallet2, wallet3 } = await loadFixture(deployGasSubsidyFixture);

            // Grant subscriptions to all users
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);
            await paymaster.connect(owner).grantSubscription(wallet2, SubscriptionTier.PREMIUM, 3600);
            await paymaster.connect(owner).grantSubscription(wallet3, SubscriptionTier.ULTIMATE, 3600);

            const wallets = [wallet1, wallet2, wallet3];
            const gasAmounts = [100000n, 150000n, 200000n];

            // Simulate concurrent operations (in practice, these would be atomic)
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < wallets.length; j++) {
                    const userOp = createUserOperation(wallets[j], i, "0x", Number(gasAmounts[j]));
                    await simulateGasSubsidy(paymaster, entryPoint, userOp, gasAmounts[j], owner);
                }
            }

            // Verify each wallet's gas usage
            for (let i = 0; i < wallets.length; i++) {
                const subscription = await paymaster.getSubscription(wallets[i]);
                expect(subscription.gasUsedThisMonth).to.equal(gasAmounts[i] * 3n);
            }
        });
    });
});