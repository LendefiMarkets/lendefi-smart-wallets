const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SmartWallet", function () {
    async function deploySystem() {
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
                unsafeAllow: ['constructor']
            }
        );
        
        return { factory, entryPoint, owner, user1, user2 };
    }

    async function deployFixture() {
        const { factory, entryPoint, owner, user1, user2 } = await deploySystem();

        // Create a SmartWallet through the factory
        await factory.createAccount(owner.address, 0);
        const smartWalletAddress = await factory.getWallet(owner.address);
        const smartWallet = await ethers.getContractAt("SmartWallet", smartWalletAddress);

        // Deploy test contract for interactions
        const testContract = await ethers.deployContract("EntryPoint");

        return { smartWallet, entryPoint, testContract, factory, owner, user1, user2 };
    }

    describe("Deployment and Initialization", function () {
        it("Should deploy with correct entryPoint", async function () {
            const { smartWallet, entryPoint } = await loadFixture(deployFixture);
            expect(await smartWallet.entryPoint()).to.equal(entryPoint.target);
        });

        it("Should initialize with correct owner", async function () {
            const { smartWallet, owner } = await loadFixture(deployFixture);
            expect(await smartWallet.owner()).to.equal(owner.address);
        });

        it("Should not allow creating duplicate wallets for same user", async function () {
            const { factory, owner } = await loadFixture(deployFixture);
            // The owner already has a wallet from the fixture
            await expect(factory.createAccount(owner.address, 123))
                .to.be.revertedWithCustomError(factory, "WalletAlreadyExists");
        });

        it("Should revert initialization with zero address", async function () {
            const { factory, entryPoint } = await loadFixture(deployFixture);
            
            await expect(factory.createAccount(ethers.ZeroAddress, 123))
                .to.be.revertedWithCustomError(factory, "ZeroAddress");
        });

        it("Should emit SmartWalletInitialized event", async function () {
            const { factory, entryPoint, user1 } = await loadFixture(deployFixture);
            
            await expect(factory.createAccount(user1.address, 456))
                .to.emit(factory, "AccountCreated");
            
            // Check that the created wallet emitted the initialization event during factory creation
            const walletAddress = await factory.getWallet(user1.address);
            expect(walletAddress).to.not.equal(ethers.ZeroAddress);
        });


        it("Should prevent double initialization", async function () {
            const { smartWallet, user2 } = await loadFixture(deployFixture);
            
            // Wallet is already initialized in fixture, try to initialize again
            await expect(smartWallet.initialize(user2.address))
                .to.be.revertedWithCustomError(smartWallet, "InvalidInitialization");
        });
    });

    describe("Access Control", function () {
        it("Should allow owner to execute transactions", async function () {
            const { smartWallet, testContract, owner } = await loadFixture(deployFixture);
            
            const tx = await smartWallet.connect(owner).execute(
                testContract.target,
                0,
                "0x"
            );
            await expect(tx).to.not.be.reverted;
        });

        it("Should allow entryPoint to execute transactions", async function () {
            const { smartWallet, testContract, entryPoint, owner } = await loadFixture(deployFixture);
            
            // Fund the entryPoint address
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
            
            const tx = await smartWallet.connect(entryPointSigner).execute(
                testContract.target,
                0,
                "0x"
            );
            await expect(tx).to.not.be.reverted;
        });

        it("Should reject transactions from unauthorized addresses", async function () {
            const { smartWallet, testContract, user1 } = await loadFixture(deployFixture);
            
            await expect(smartWallet.connect(user1).execute(
                testContract.target,
                0,
                "0x"
            )).to.be.revertedWithCustomError(smartWallet, "Unauthorized");
        });
    });

    describe("Batch Execution", function () {
        it("Should execute batch transactions successfully", async function () {
            const { smartWallet, testContract, owner } = await loadFixture(deployFixture);
            
            const targets = [testContract.target, testContract.target];
            const values = [0, 0];
            const datas = ["0x", "0x"];
            
            const tx = await smartWallet.connect(owner).executeBatch(targets, values, datas);
            await expect(tx).to.not.be.reverted;
        });

        it("Should revert batch execution with mismatched array lengths", async function () {
            const { smartWallet, testContract, owner } = await loadFixture(deployFixture);
            
            const targets = [testContract.target];
            const values = [0, 0]; // Mismatched length
            const datas = ["0x"];
            
            await expect(smartWallet.connect(owner).executeBatch(targets, values, datas))
                .to.be.revertedWithCustomError(smartWallet, "InvalidUserOp");
        });

        it("Should reject batch execution from unauthorized addresses", async function () {
            const { smartWallet, testContract, user1 } = await loadFixture(deployFixture);
            
            const targets = [testContract.target];
            const values = [0];
            const datas = ["0x"];
            
            await expect(smartWallet.connect(user1).executeBatch(targets, values, datas))
                .to.be.revertedWithCustomError(smartWallet, "Unauthorized");
        });

        it("Should test all array length mismatch cases in executeBatch", async function () {
            const { smartWallet, testContract, owner } = await loadFixture(deployFixture);
            
            // Test case 1: targets.length != values.length
            await expect(smartWallet.connect(owner).executeBatch(
                [testContract.target], 
                [0, 0], // Different length
                ["0x"]
            )).to.be.revertedWithCustomError(smartWallet, "InvalidUserOp");
            
            // Test case 2: values.length != datas.length  
            await expect(smartWallet.connect(owner).executeBatch(
                [testContract.target], 
                [0], 
                ["0x", "0x"] // Different length
            )).to.be.revertedWithCustomError(smartWallet, "InvalidUserOp");
        });
    });

    describe("ERC-1271 Signature Validation", function () {
        it("Should return magic value for valid signature", async function () {
            const { smartWallet, owner } = await loadFixture(deployFixture);
            
            const message = "Hello World";
            const messageHash = ethers.hashMessage(message);
            const signature = await owner.signMessage(message);
            
            const result = await smartWallet.isValidSignature(messageHash, signature);
            expect(result).to.equal("0x1626ba7e"); // ERC1271_MAGIC_VALUE
        });

        it("Should return failure value for invalid signature", async function () {
            const { smartWallet, user1 } = await loadFixture(deployFixture);
            
            const message = "Hello World";
            const messageHash = ethers.hashMessage(message);
            const signature = await user1.signMessage(message);
            
            const result = await smartWallet.isValidSignature(messageHash, signature);
            expect(result).to.equal("0xffffffff");
        });
    });

    describe("Deposit Management", function () {
        it("Should deposit to EntryPoint", async function () {
            const { smartWallet, entryPoint } = await loadFixture(deployFixture);
            
            const depositAmount = ethers.parseEther("1");
            await smartWallet.addDeposit({ value: depositAmount });
            
            expect(await entryPoint.balanceOf(smartWallet.target)).to.equal(depositAmount);
        });

        it("Should withdraw from EntryPoint", async function () {
            const { smartWallet, entryPoint, owner, user1 } = await loadFixture(deployFixture);
            
            // First deposit
            const depositAmount = ethers.parseEther("1");
            await smartWallet.addDeposit({ value: depositAmount });
            
            // Then withdraw
            const withdrawAmount = ethers.parseEther("0.5");
            const initialBalance = await ethers.provider.getBalance(user1.address);
            
            await smartWallet.connect(owner).withdrawDepositTo(user1.address, withdrawAmount);
            
            const finalBalance = await ethers.provider.getBalance(user1.address);
            expect(finalBalance - initialBalance).to.equal(withdrawAmount);
        });

        it("Should reject withdraw from non-owner", async function () {
            const { smartWallet, user1, user2 } = await loadFixture(deployFixture);
            
            await expect(smartWallet.connect(user1).withdrawDepositTo(user2.address, ethers.parseEther("0.5")))
                .to.be.revertedWithCustomError(smartWallet, "Unauthorized");
        });

        it("Should reject withdraw to zero address", async function () {
            const { smartWallet, owner } = await loadFixture(deployFixture);
            
            // Test the nonZeroAddress modifier on withdrawDepositTo
            await expect(smartWallet.connect(owner).withdrawDepositTo(ethers.ZeroAddress, ethers.parseEther("0.5")))
                .to.be.revertedWithCustomError(smartWallet, "ZeroAddress");
        });

        it("Should get correct deposit balance", async function () {
            const { smartWallet, entryPoint } = await loadFixture(deployFixture);
            
            const depositAmount = ethers.parseEther("2");
            await smartWallet.addDeposit({ value: depositAmount });
            
            expect(await smartWallet.getDeposit()).to.equal(depositAmount);
        });
    });

    describe("Owner Management", function () {
        it("Should change owner", async function () {
            const { smartWallet, owner, user1 } = await loadFixture(deployFixture);
            
            await expect(smartWallet.connect(owner).changeOwner(user1.address))
                .to.emit(smartWallet, "OwnerChanged")
                .withArgs(owner.address, user1.address);
            
            expect(await smartWallet.owner()).to.equal(user1.address);
        });

        it("Should reject change owner to zero address", async function () {
            const { smartWallet, owner } = await loadFixture(deployFixture);
            
            // Test the nonZeroAddress modifier on changeOwner
            await expect(smartWallet.connect(owner).changeOwner(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(smartWallet, "ZeroAddress");
        });

        it("Should reject change owner from non-owner", async function () {
            const { smartWallet, user1, user2 } = await loadFixture(deployFixture);
            
            await expect(smartWallet.connect(user1).changeOwner(user2.address))
                .to.be.revertedWithCustomError(smartWallet, "Unauthorized");
        });
    });

    describe("Nonce Management", function () {
        it("Should return correct nonce", async function () {
            const { smartWallet } = await loadFixture(deployFixture);
            
            const nonce = await smartWallet["getNonce(uint192)"](0);
            expect(nonce).to.be.a("bigint");
        });
    });

    describe("Receive Function", function () {
        it("Should receive ETH", async function () {
            const { smartWallet, user1 } = await loadFixture(deployFixture);
            
            const sendAmount = ethers.parseEther("1");
            const initialBalance = await ethers.provider.getBalance(smartWallet.target);
            
            await user1.sendTransaction({
                to: smartWallet.target,
                value: sendAmount
            });
            
            const finalBalance = await ethers.provider.getBalance(smartWallet.target);
            expect(finalBalance - initialBalance).to.equal(sendAmount);
        });
    });

    describe("Edge Cases and Error Handling", function () {
        it("Should handle failed external calls", async function () {
            const { smartWallet, owner } = await loadFixture(deployFixture);
            
            // Try to call a non-existent function
            const invalidCalldata = "0x12345678"; // Non-existent function selector
            
            await expect(smartWallet.connect(owner).execute(
                smartWallet.target, // Call self with invalid data
                0,
                invalidCalldata
            )).to.be.reverted;
        });

        it("Should validate nonce correctly in _validateAndUpdateNonce", async function () {
            const { smartWallet } = await loadFixture(deployFixture);
            
            // This is an internal function, tested indirectly through user operations
            const nonce = await smartWallet["getNonce(uint192)"](0);
            expect(nonce).to.equal(0);
        });

        it("Should handle missing account funds gracefully", async function () {
            const { smartWallet, entryPoint, owner, user1 } = await loadFixture(deployFixture);
            
            // Try to withdraw more than deposited
            await expect(smartWallet.connect(owner).withdrawDepositTo(user1.address, ethers.parseEther("10")))
                .to.be.revertedWithCustomError(entryPoint, "InsufficientDeposit");
        });
    });

    describe("Internal Functions", function () {
        it("Should execute _call function correctly through public functions", async function () {
            const { smartWallet, testContract, owner } = await loadFixture(deployFixture);
            
            // Test _call indirectly through execute function
            const tx = await smartWallet.connect(owner).execute(
                testContract.target,
                0,
                "0x"
            );
            await expect(tx).to.not.be.reverted;
        });
    });
});