const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Integration Tests", function () {
    // Subscription tiers enum values
    const SubscriptionTier = {
        NONE: 0,
        BASIC: 1,
        PREMIUM: 2,
        ULTIMATE: 3
    };

    async function deployFullSystemFixture() {
        const [owner, user1, user2, user3, operator] = await ethers.getSigners();

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

        // Fund paymaster and add stake
        await paymaster.connect(owner).deposit({ value: ethers.parseEther("20") });
        await paymaster.connect(owner).addStake(86400, { value: ethers.parseEther("5") });

        // Fund entryPoint for testing
        await owner.sendTransaction({
            to: entryPoint.target,
            value: ethers.parseEther("10")
        });

        return {
            entryPoint,
            factory,
            paymaster,
            owner,
            user1,
            user2,
            user3,
            operator
        };
    }

    function createMockUserOp(sender, nonce = 0, callData = "0x") {
        return {
            sender: sender,
            nonce: nonce,
            initCode: "0x",
            callData: callData,
            accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [100000, 100000]),
            preVerificationGas: 50000,
            gasFees: ethers.solidityPacked(["uint128", "uint128"], [ethers.parseUnits("1", "gwei"), ethers.parseUnits("10", "gwei")]),
            paymasterAndData: "0x",
            signature: "0x"
        };
    }

    describe("Complete Wallet Lifecycle", function () {
        it("Should create wallet, grant subscription, and process operations", async function () {
            const { factory, paymaster, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Step 1: Create wallet
            await expect(factory.createAccount(user1.address, 123))
                .to.emit(factory, "AccountCreated");

            const walletAddress = await factory.getWallet(user1.address);
            expect(await factory.isValidWallet(walletAddress)).to.be.true;

            // Step 2: Grant subscription
            await expect(paymaster.connect(owner).grantSubscription(user1.address, SubscriptionTier.PREMIUM, 30 * 24 * 60 * 60))
                .to.emit(paymaster, "SubscriptionGranted");

            // Step 3: Verify wallet can be used with paymaster
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const wallet = SmartWallet.attach(walletAddress);
            
            expect(await wallet.owner()).to.equal(user1.address);
            expect(await paymaster.hasActiveSubscription(user1.address)).to.be.true;
        });

        it("Should handle wallet funding and withdrawals", async function () {
            const { factory, entryPoint, user1 } = await loadFixture(deployFullSystemFixture);

            // Create wallet
            await factory.createAccount(user1.address, 456);
            const walletAddress = await factory.getWallet(user1.address);
            
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const wallet = SmartWallet.attach(walletAddress);

            // Fund wallet
            await user1.sendTransaction({
                to: walletAddress,
                value: ethers.parseEther("2")
            });

            // Deposit to EntryPoint
            await wallet.connect(user1).addDeposit({ value: ethers.parseEther("1") });
            expect(await entryPoint.balanceOf(walletAddress)).to.equal(ethers.parseEther("1"));

            // Withdraw from EntryPoint
            const initialBalance = await ethers.provider.getBalance(user1.address);
            await wallet.connect(user1).withdrawDepositTo(user1.address, ethers.parseEther("0.5"));
            
            const finalBalance = await ethers.provider.getBalance(user1.address);
            expect(finalBalance).to.be.gt(initialBalance);
        });

        it("Should execute transactions through wallet", async function () {
            const { factory, user1, user2 } = await loadFixture(deployFullSystemFixture);

            // Create wallet
            await factory.createAccount(user1.address, 789);
            const walletAddress = await factory.getWallet(user1.address);
            
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const wallet = SmartWallet.attach(walletAddress);

            // Fund wallet
            await user1.sendTransaction({
                to: walletAddress,
                value: ethers.parseEther("1")
            });

            // Execute transfer through wallet
            const transferAmount = ethers.parseEther("0.1");
            const initialBalance = await ethers.provider.getBalance(user2.address);

            await wallet.connect(user1).execute(
                user2.address,
                transferAmount,
                "0x"
            );

            const finalBalance = await ethers.provider.getBalance(user2.address);
            expect(finalBalance - initialBalance).to.equal(transferAmount);
        });
    });

    describe("Paymaster Integration", function () {
        it("Should validate and process operations with different subscription tiers", async function () {
            const { factory, paymaster, entryPoint, owner, user1, user2, user3 } = await loadFixture(deployFullSystemFixture);

            // Create wallets for different users
            await factory.createAccount(user1.address, 1);
            await factory.createAccount(user2.address, 2);
            await factory.createAccount(user3.address, 3);

            const wallet1 = await factory.getWallet(user1.address);
            const wallet2 = await factory.getWallet(user2.address);
            const wallet3 = await factory.getWallet(user3.address);

            // Grant different subscription tiers to wallet addresses
            await paymaster.connect(owner).grantSubscription(wallet1, SubscriptionTier.BASIC, 3600);
            await paymaster.connect(owner).grantSubscription(wallet2, SubscriptionTier.PREMIUM, 3600);
            await paymaster.connect(owner).grantSubscription(wallet3, SubscriptionTier.ULTIMATE, 3600);

            // Verify subscriptions
            expect(await paymaster.hasActiveSubscription(wallet1)).to.be.true;
            expect(await paymaster.hasActiveSubscription(wallet2)).to.be.true;
            expect(await paymaster.hasActiveSubscription(wallet3)).to.be.true;

            // Test validation for each tier
            const userOp1 = createMockUserOp(wallet1);
            const userOp2 = createMockUserOp(wallet2);
            const userOp3 = createMockUserOp(wallet3);

            // Impersonate entryPoint for validation
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Validate operations
            for (const userOp of [userOp1, userOp2, userOp3]) {
                const result = await paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                    userOp,
                    ethers.keccak256("0x1234"),
                    ethers.parseEther("0.01")
                );
                expect(result.context).to.not.equal("0x");
                expect(result.validationData || 0).to.equal(0);
            }
        });

        it("Should enforce gas limits correctly", async function () {
            const { factory, paymaster, entryPoint, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Create wallet and grant BASIC subscription (500k gas limit)
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.BASIC, 3600);

            // Create user op that exceeds monthly limit
            const highGasUserOp = createMockUserOp(walletAddress);
            highGasUserOp.accountGasLimits = ethers.solidityPacked(["uint128", "uint128"], [600000, 600000]);

            // Impersonate entryPoint
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Should fail due to monthly limit exceeded
            await expect(paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                highGasUserOp,
                ethers.keccak256("0x1234"),
                ethers.parseEther("0.01")
            )).to.be.revertedWithCustomError(paymaster, "GasLimitExceeded");
        });

        it("Should handle subscription expiration", async function () {
            const { factory, paymaster, entryPoint, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Create wallet and grant short subscription
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.BASIC, 1); // 1 second

            // Wait for expiration
            await time.increase(2);

            const userOp = createMockUserOp(walletAddress);

            // Impersonate entryPoint
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Should fail due to expired subscription
            await expect(paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                userOp,
                ethers.keccak256("0x1234"),
                ethers.parseEther("0.01")
            )).to.be.revertedWithCustomError(paymaster, "SubscriptionExpired");
        });
    });

    describe("Factory and Wallet Integration", function () {
        it("Should handle multiple wallets with different configurations", async function () {
            const { factory, owner, user1, user2 } = await loadFixture(deployFullSystemFixture);

            // Create wallets with different salts
            await factory.createAccount(user1.address, 111);
            await factory.createAccount(user2.address, 222);

            const wallet1 = await factory.getWallet(user1.address);
            const wallet2 = await factory.getWallet(user2.address);

            // Verify wallets are different
            expect(wallet1).to.not.equal(wallet2);
            expect(await factory.isValidWallet(wallet1)).to.be.true;
            expect(await factory.isValidWallet(wallet2)).to.be.true;

            // Verify wallet ownership
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const smartWallet1 = SmartWallet.attach(wallet1);
            const smartWallet2 = SmartWallet.attach(wallet2);

            expect(await smartWallet1.owner()).to.equal(user1.address);
            expect(await smartWallet2.owner()).to.equal(user2.address);
        });

        it("Should handle factory upgrades without breaking existing wallets", async function () {
            const { factory, entryPoint, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Create wallet with current implementation
            await factory.createAccount(user1.address, 123);
            const wallet1 = await factory.getWallet(user1.address);

            // Deploy new implementation
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const newImpl = await SmartWallet.deploy(entryPoint.target);

            // Update implementation
            await factory.connect(owner).setSmartWalletImplementation(newImpl.target);

            // Create another wallet with new implementation using a different user
            const [,,,, differentUser] = await ethers.getSigners();
            await factory.createAccount(differentUser.address, 456);
            const wallet2 = await factory.getWallet(differentUser.address);

            // Both wallets should be valid
            expect(await factory.isValidWallet(wallet1)).to.be.true;
            expect(await factory.isValidWallet(wallet2)).to.be.true;

            // Old wallet should still work
            const SmartWalletContract = await ethers.getContractFactory("SmartWallet");
            const oldWallet = SmartWalletContract.attach(wallet1);
            const newWallet = SmartWalletContract.attach(wallet2);
            expect(await oldWallet.owner()).to.equal(user1.address);
            expect(await newWallet.owner()).to.equal(differentUser.address);
        });
    });

    describe("Cross-Contract Operations", function () {
        it("Should handle batch operations through wallet", async function () {
            const { factory, user1, user2, user3 } = await loadFixture(deployFullSystemFixture);

            // Create wallet
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const wallet = SmartWallet.attach(walletAddress);

            // Fund wallet
            await user1.sendTransaction({
                to: walletAddress,
                value: ethers.parseEther("2")
            });

            // Execute batch transfers
            const targets = [user2.address, user3.address];
            const values = [ethers.parseEther("0.1"), ethers.parseEther("0.2")];
            const datas = ["0x", "0x"];

            const initialBalance2 = await ethers.provider.getBalance(user2.address);
            const initialBalance3 = await ethers.provider.getBalance(user3.address);

            await wallet.connect(user1).executeBatch(targets, values, datas);

            const finalBalance2 = await ethers.provider.getBalance(user2.address);
            const finalBalance3 = await ethers.provider.getBalance(user3.address);

            expect(finalBalance2 - initialBalance2).to.equal(values[0]);
            expect(finalBalance3 - initialBalance3).to.equal(values[1]);
        });

        it("Should handle wallet interaction with external contracts", async function () {
            const { factory, user1 } = await loadFixture(deployFullSystemFixture);

            // Deploy a simple contract to interact with
            const MockContract = await ethers.getContractFactory("EntryPoint");
            const mockContract = await MockContract.deploy();

            // Create wallet
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const wallet = SmartWallet.attach(walletAddress);

            // Fund the wallet
            await user1.sendTransaction({
                to: walletAddress,
                value: ethers.parseEther("1")
            });

            // Interact with external contract through wallet
            const depositAmount = ethers.parseEther("0.1");
            const depositCalldata = mockContract.interface.encodeFunctionData("depositTo", [mockContract.target]);

            await wallet.connect(user1).execute(
                mockContract.target,
                depositAmount,
                depositCalldata
            );

            expect(await mockContract.balanceOf(mockContract.target)).to.equal(depositAmount);
        });
    });

    describe("Gas Optimization and Performance", function () {
        it("Should handle multiple operations efficiently", async function () {
            const { factory, paymaster, entryPoint, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Create wallet and grant subscription
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.PREMIUM, 3600);

            // Simulate multiple operations
            const operations = [];
            for (let i = 0; i < 5; i++) {
                operations.push(createMockUserOp(walletAddress, i));
            }

            // Impersonate entryPoint
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Process all operations
            for (let i = 0; i < operations.length; i++) {
                const userOp = operations[i];
                const result = await paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                    userOp,
                    ethers.keccak256(ethers.toUtf8Bytes(`hash${i}`)),
                    ethers.parseEther("0.001")
                );
                expect(result.validationData || 0).to.equal(0);

                // Simulate postOp
                const context = ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "uint256", "uint8"],
                    [walletAddress, 50000, ethers.parseEther("0.0005"), SubscriptionTier.PREMIUM]
                );

                await paymaster.connect(entryPointSigner).postOp(
                    0, // PostOpMode.opSucceeded
                    context,
                    ethers.parseEther("0.001"),
                    ethers.parseUnits("10", "gwei")
                );
            }

            // Verify gas usage tracking
            const subscription = await paymaster.getSubscription(walletAddress);
            expect(subscription.gasUsedThisMonth).to.be.gt(0);
        });
    });

    describe("Error Recovery and Edge Cases", function () {
        it("Should handle failed operations gracefully", async function () {
            const { factory, user1 } = await loadFixture(deployFullSystemFixture);

            // Create wallet
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const wallet = SmartWallet.attach(walletAddress);

            // Try to execute with insufficient funds
            await expect(wallet.connect(user1).execute(
                user1.address,
                ethers.parseEther("1"), // More than wallet has
                "0x"
            )).to.be.reverted;
        });

        it("Should handle invalid wallet validation in paymaster", async function () {
            const { paymaster, entryPoint, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Grant subscription to user (this test checks invalid wallet, so keep user address)

            // Create user op with invalid wallet (not created through factory)
            const userOp = createMockUserOp(user1.address); // Using EOA instead of wallet

            // Impersonate entryPoint
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Should fail due to invalid wallet
            await expect(paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                userOp,
                ethers.keccak256("0x1234"),
                ethers.parseEther("0.01")
            )).to.be.revertedWithCustomError(paymaster, "InvalidWallet");
        });

        it("Should handle paymaster deposit depletion", async function () {
            const { factory, paymaster, entryPoint, owner, user1 } = await loadFixture(deployFullSystemFixture);

            // Drain paymaster balance
            const balance = await entryPoint.balanceOf(paymaster.target);
            await paymaster.connect(owner).withdrawTo(owner.address, balance);

            // Create wallet and grant subscription
            await factory.createAccount(user1.address, 123);
            const walletAddress = await factory.getWallet(user1.address);
            await paymaster.connect(owner).grantSubscription(walletAddress, SubscriptionTier.ULTIMATE, 3600);

            const userOp = createMockUserOp(walletAddress);

            // Impersonate entryPoint
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [entryPoint.target],
            });
            const entryPointSigner = await ethers.getSigner(entryPoint.target);

            // Should fail due to insufficient paymaster deposit
            await expect(paymaster.connect(entryPointSigner).validatePaymasterUserOp(
                userOp,
                ethers.keccak256("0x1234"),
                ethers.parseEther("0.01")
            )).to.be.revertedWithCustomError(paymaster, "PaymasterDepositTooLow");
        });
    });

    describe("System State Consistency", function () {
        it("Should maintain consistent state across all components", async function () {
            const { factory, paymaster, entryPoint, owner, user1, user2 } = await loadFixture(deployFullSystemFixture);

            // Create multiple wallets
            await factory.createAccount(user1.address, 111);
            await factory.createAccount(user2.address, 222);

            const wallet1 = await factory.getWallet(user1.address);
            const wallet2 = await factory.getWallet(user2.address);

            // Grant subscriptions
            await paymaster.connect(owner).grantSubscription(user1.address, SubscriptionTier.BASIC, 3600);
            await paymaster.connect(owner).grantSubscription(user2.address, SubscriptionTier.PREMIUM, 7200);

            // Verify all components recognize the state
            expect(await factory.isValidWallet(wallet1)).to.be.true;
            expect(await factory.isValidWallet(wallet2)).to.be.true;
            expect(await paymaster.hasActiveSubscription(user1.address)).to.be.true;
            expect(await paymaster.hasActiveSubscription(user2.address)).to.be.true;

            // Verify wallet functionality
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const smartWallet1 = SmartWallet.attach(wallet1);
            const smartWallet2 = SmartWallet.attach(wallet2);

            expect(await smartWallet1.entryPoint()).to.equal(entryPoint.target);
            expect(await smartWallet2.entryPoint()).to.equal(entryPoint.target);
            expect(await smartWallet1.owner()).to.equal(user1.address);
            expect(await smartWallet2.owner()).to.equal(user2.address);

            // Verify subscriptions have correct tiers
            const sub1 = await paymaster.getSubscription(user1.address);
            const sub2 = await paymaster.getSubscription(user2.address);
            expect(sub1.tier).to.equal(SubscriptionTier.BASIC);
            expect(sub2.tier).to.equal(SubscriptionTier.PREMIUM);
        });
    });
});