const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Paymaster Configuration Tests", function () {
    // Subscription tiers enum values
    const SubscriptionTier = {
        NONE: 0,
        BASIC: 1,
        PREMIUM: 2,
        ULTIMATE: 3
    };

    async function deployPaymasterFixture() {
        const [owner, user1, unauthorized] = await ethers.getSigners();

        // Deploy EntryPoint
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

        return {
            paymaster,
            entryPoint,
            factory,
            owner,
            user1,
            unauthorized
        };
    }

    describe("Gas Limit Configuration", function () {
        it("Should have correct initial gas limits", async function () {
            const { paymaster } = await loadFixture(deployPaymasterFixture);

            expect(await paymaster.maxGasPerMonthBasic()).to.equal(500_000);
            expect(await paymaster.maxGasPerMonthPremium()).to.equal(2_000_000);
            expect(await paymaster.maxGasPerMonthUltimate()).to.equal(10_000_000);
            expect(await paymaster.maxGasPerOperation()).to.equal(500_000);
        });

        it("Should allow owner to update BASIC tier gas limit", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            const newLimit = 750_000;
            await expect(paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, newLimit))
                .to.emit(paymaster, "TierLimitUpdated")
                .withArgs(SubscriptionTier.BASIC, 500_000, newLimit);

            expect(await paymaster.maxGasPerMonthBasic()).to.equal(newLimit);
        });

        it("Should allow owner to update PREMIUM tier gas limit", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            const newLimit = 3_000_000;
            await expect(paymaster.connect(owner).setTierGasLimit(SubscriptionTier.PREMIUM, newLimit))
                .to.emit(paymaster, "TierLimitUpdated")
                .withArgs(SubscriptionTier.PREMIUM, 2_000_000, newLimit);

            expect(await paymaster.maxGasPerMonthPremium()).to.equal(newLimit);
        });

        it("Should allow owner to update ULTIMATE tier gas limit", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            const newLimit = 20_000_000;
            await expect(paymaster.connect(owner).setTierGasLimit(SubscriptionTier.ULTIMATE, newLimit))
                .to.emit(paymaster, "TierLimitUpdated")
                .withArgs(SubscriptionTier.ULTIMATE, 10_000_000, newLimit);

            expect(await paymaster.maxGasPerMonthUltimate()).to.equal(newLimit);
        });

        it("Should reject tier gas limit updates from non-owner", async function () {
            const { paymaster, unauthorized } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(unauthorized).setTierGasLimit(SubscriptionTier.BASIC, 1_000_000))
                .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
                
            await expect(paymaster.connect(unauthorized).setTierGasLimit(SubscriptionTier.PREMIUM, 2_000_000))
                .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
                
            await expect(paymaster.connect(unauthorized).setTierGasLimit(SubscriptionTier.ULTIMATE, 10_000_000))
                .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
        });

        it("Should reject zero gas limit", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, 0))
                .to.be.revertedWithCustomError(paymaster, "InvalidGasLimit");
        });

        it("Should reject setting limit for NONE tier", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(owner).setTierGasLimit(SubscriptionTier.NONE, 1_000_000))
                .to.be.revertedWithCustomError(paymaster, "InvalidTier");
        });

        it("Should reject invalid tier", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(owner).setTierGasLimit(99, 1_000_000)) // Invalid tier
                .to.be.reverted; // Invalid tier enum value causes revert
        });
    });

    describe("Max Gas Per Operation Configuration", function () {
        it("Should allow owner to update max gas per operation", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            const newLimit = 1_000_000;
            await expect(paymaster.connect(owner).setMaxGasPerOperation(newLimit))
                .to.emit(paymaster, "MaxGasPerOperationUpdated")
                .withArgs(500_000, newLimit);

            expect(await paymaster.maxGasPerOperation()).to.equal(newLimit);
        });

        it("Should reject max gas per operation updates from non-owner", async function () {
            const { paymaster, unauthorized } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(unauthorized).setMaxGasPerOperation(1_000_000))
                .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
        });

        it("Should reject zero max gas per operation", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(owner).setMaxGasPerOperation(0))
                .to.be.revertedWithCustomError(paymaster, "InvalidGasLimit");
        });

        it("Should reject extremely high max gas per operation", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            await expect(paymaster.connect(owner).setMaxGasPerOperation(50_000_000))
                .to.be.revertedWithCustomError(paymaster, "GasLimitTooHigh");
        });

        it("Should allow setting max gas per operation up to the limit", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            const maxAllowed = 30_000_000;
            await expect(paymaster.connect(owner).setMaxGasPerOperation(maxAllowed))
                .to.not.be.reverted;

            expect(await paymaster.maxGasPerOperation()).to.equal(maxAllowed);
        });
    });

    describe("Configuration Impact on Subscriptions", function () {
        it("Should use updated gas limits for new subscriptions", async function () {
            const { paymaster, factory, owner, user1 } = await loadFixture(deployPaymasterFixture);

            // Create wallet
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);

            // Update BASIC tier limit
            const newBasicLimit = 750_000;
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, newBasicLimit);

            // Grant subscription after limit update
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.BASIC, 3600);

            // Verify subscription uses new limit
            const subscription = await paymaster.getSubscription(walletAddress);
            expect(subscription.monthlyGasLimit).to.equal(newBasicLimit);
        });

        it("Should not affect existing subscriptions", async function () {
            const { paymaster, factory, owner, user1 } = await loadFixture(deployPaymasterFixture);

            // Create wallet
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);

            // Grant subscription with original limit
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.BASIC, 3600);
            
            const originalSubscription = await paymaster.getSubscription(walletAddress);
            const originalLimit = originalSubscription.monthlyGasLimit;

            // Update tier limit
            const newBasicLimit = 750_000;
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, newBasicLimit);

            // Verify existing subscription unchanged
            const updatedSubscription = await paymaster.getSubscription(walletAddress);
            expect(updatedSubscription.monthlyGasLimit).to.equal(originalLimit);
            expect(originalLimit).to.not.equal(newBasicLimit);
        });

        it("Should apply updated limits to subscription renewals", async function () {
            const { paymaster, factory, owner, user1 } = await loadFixture(deployPaymasterFixture);

            // Create wallet
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);

            // Grant initial subscription
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.PREMIUM, 3600);
            
            // Update PREMIUM tier limit
            const newPremiumLimit = 3_500_000;
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.PREMIUM, newPremiumLimit);

            // Revoke and re-grant subscription (simulating renewal)
            await paymaster.connect(owner).revokeSubscription(walletAddress);
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.PREMIUM, 3600);

            // Verify renewed subscription uses new limit
            const renewedSubscription = await paymaster.getSubscription(walletAddress);
            expect(renewedSubscription.monthlyGasLimit).to.equal(newPremiumLimit);
        });
    });

    describe("Multiple Configuration Updates", function () {
        it("Should handle multiple tier updates correctly", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            // Update all tiers
            const newBasic = 600_000;
            const newPremium = 2_500_000;
            const newUltimate = 15_000_000;

            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, newBasic);
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.PREMIUM, newPremium);
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.ULTIMATE, newUltimate);

            // Verify all updates
            expect(await paymaster.maxGasPerMonthBasic()).to.equal(newBasic);
            expect(await paymaster.maxGasPerMonthPremium()).to.equal(newPremium);
            expect(await paymaster.maxGasPerMonthUltimate()).to.equal(newUltimate);
        });

        it("Should emit correct events for multiple updates", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            const newBasic = 800_000;
            const newMaxGas = 2_000_000;

            // Should emit both types of events
            await expect(paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, newBasic))
                .to.emit(paymaster, "TierLimitUpdated")
                .withArgs(SubscriptionTier.BASIC, 500_000, newBasic);

            await expect(paymaster.connect(owner).setMaxGasPerOperation(newMaxGas))
                .to.emit(paymaster, "MaxGasPerOperationUpdated")
                .withArgs(500_000, newMaxGas);
        });

        it("Should maintain consistency across tier hierarchy", async function () {
            const { paymaster, owner } = await loadFixture(deployPaymasterFixture);

            // Set realistic hierarchy: Basic < Premium < Ultimate
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.BASIC, 1_000_000);
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.PREMIUM, 5_000_000);
            await paymaster.connect(owner).setTierGasLimit(SubscriptionTier.ULTIMATE, 25_000_000);

            expect(await paymaster.maxGasPerMonthBasic()).to.be.lt(await paymaster.maxGasPerMonthPremium());
            expect(await paymaster.maxGasPerMonthPremium()).to.be.lt(await paymaster.maxGasPerMonthUltimate());
        });
    });
});