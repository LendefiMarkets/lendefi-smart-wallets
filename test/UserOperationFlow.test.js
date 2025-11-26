const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Hardhat default account private keys (for testing only)
const HARDHAT_PRIVATE_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // account 0 (owner)
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // account 1 (user1)
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // account 2 (user2)
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // account 3 (bundler)
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // account 4 (beneficiary)
];

describe("UserOperation Flow Tests", function () {
    async function deployFullSystemFixture() {
        const [owner, user1, user2, bundler, beneficiary] = await ethers.getSigners();
        
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
            user2, 
            bundler,
            beneficiary
        };
    }

    // Helper function to sign a user operation
    // ERC-4337 expects direct ECDSA signature on userOpHash (no EIP-191 prefix)
    async function signUserOp(userOp, signer, entryPoint, chainId) {
        // Create the user operation hash (same as _getUserOpHash in EntryPoint)
        // Note: signature is NOT included per ERC-4337 spec - it would be circular
        const userOpHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["bytes32", "address", "uint256"],
                [
                    ethers.keccak256(
                        ethers.AbiCoder.defaultAbiCoder().encode(
                            ["address", "uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32"],
                            [
                                userOp.sender,
                                userOp.nonce,
                                ethers.keccak256(userOp.initCode),
                                ethers.keccak256(userOp.callData),
                                userOp.accountGasLimits,
                                userOp.preVerificationGas,
                                userOp.gasFees,
                                ethers.keccak256(userOp.paymasterAndData)
                            ]
                        )
                    ),
                    entryPoint.target,
                    chainId
                ]
            )
        );
        
        // Find the private key for this signer from Hardhat defaults
        const signerAddress = await signer.getAddress();
        const signers = await ethers.getSigners();
        let privateKey = null;
        for (let i = 0; i < signers.length && i < HARDHAT_PRIVATE_KEYS.length; i++) {
            if ((await signers[i].getAddress()) === signerAddress) {
                privateKey = HARDHAT_PRIVATE_KEYS[i];
                break;
            }
        }
        if (!privateKey) {
            throw new Error(`Private key not found for signer ${signerAddress}`);
        }
        
        // Sign the hash directly using SigningKey (no EIP-191 prefix)
        // OZ SignerECDSA uses ECDSA.tryRecover which expects raw signature
        const signingKey = new ethers.SigningKey(privateKey);
        const sig = signingKey.sign(userOpHash);
        return sig.serialized;
    }

    async function createUserOperation(wallet, target, value, callData, nonce = null) {
        if (nonce === null) {
            nonce = await wallet["getNonce()"]();
        }
        
        return {
            sender: wallet.target,
            nonce: nonce,
            initCode: "0x",
            callData: callData || "0x",
            accountGasLimits: ethers.solidityPacked(
                ["uint128", "uint128"], 
                [100000, 100000] // verificationGasLimit, callGasLimit
            ),
            preVerificationGas: 21000,
            gasFees: ethers.solidityPacked(
                ["uint128", "uint128"],
                [ethers.parseUnits("10", "gwei"), ethers.parseUnits("10", "gwei")] // maxPriorityFeePerGas, maxFeePerGas
            ),
            paymasterAndData: "0x",
            signature: "0x"
        };
    }

    async function createSignedUserOperation(wallet, signer, entryPoint, target, value, callData, nonce = null) {
        const userOp = await createUserOperation(wallet, target, value, callData, nonce);
        const chainId = (await ethers.provider.getNetwork()).chainId;
        userOp.signature = await signUserOp(userOp, signer, entryPoint, chainId);
        return userOp;
    }

    describe("UserOperation Validation", function () {
        it("Should validate user operation with correct nonce", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet for gas
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            // Create execute call data
            const executeCallData = wallet.interface.encodeFunctionData("execute", [
                user1.address, 
                ethers.parseEther("0.1"), 
                "0x"
            ]);
            
            // Create signed user operation
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, ethers.parseEther("0.1"), executeCallData);
            
            // Handle the operation - this will test _validateUserOp and _validateNonce
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.not.be.reverted;
        });

        it("Should reject user operation with invalid nonce", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet for gas
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            // Create signed user operation with wrong nonce
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x", 999);
            
            // Should revert due to InvalidNonce
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.be.revertedWithCustomError(entryPoint, "InvalidNonce");
        });

        it("Should handle nonce key extraction correctly", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet for gas
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            // Test with different nonce keys
            const key1 = 0;
            const key2 = 1;
            
            // First operation with key 0
            const nonce1 = (BigInt(key1) << 64n) | 0n; // seq = 0
            const userOp1 = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x", nonce1);
            
            await expect(entryPoint.connect(user1).handleOps([userOp1], beneficiary.address))
                .to.not.be.reverted;
            
            // Second operation with key 1 should also work (different key space)
            const nonce2 = (BigInt(key2) << 64n) | 0n; // seq = 0 for key 1
            const userOp2 = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x", nonce2);
            
            await expect(entryPoint.connect(user1).handleOps([userOp2], beneficiary.address))
                .to.not.be.reverted;
        });

        it("Should reject operation with insufficient deposit", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Don't fund the wallet - insufficient deposit
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x");
            
            // Should revert due to InsufficientDeposit
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.be.revertedWithCustomError(entryPoint, "InsufficientDeposit");
        });
    });

    describe("UserOperation Execution", function () {
        it("Should execute user operation successfully", async function () {
            const { entryPoint, wallet, user1, user2, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet
            await user1.sendTransaction({ to: wallet.target, value: ethers.parseEther("1") });
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const executeCallData = wallet.interface.encodeFunctionData("execute", [
                user2.address, 
                ethers.parseEther("0.1"), 
                "0x"
            ]);
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user2.address, ethers.parseEther("0.1"), executeCallData);
            
            const initialBalance = await ethers.provider.getBalance(user2.address);
            
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.emit(entryPoint, "UserOperationEvent");
            
            // Verify the transfer happened
            const finalBalance = await ethers.provider.getBalance(user2.address);
            expect(finalBalance - initialBalance).to.equal(ethers.parseEther("0.1"));
        });

        it("Should handle failed user operation execution", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet for gas but not for execution
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            // Try to send more ETH than wallet has
            const executeCallData = wallet.interface.encodeFunctionData("execute", [
                user1.address, 
                ethers.parseEther("10"), // More than wallet has
                "0x"
            ]);
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, ethers.parseEther("10"), executeCallData);
            
            // Operation should be processed but marked as failed
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.emit(entryPoint, "UserOperationEvent");
        });

        it("Should handle multiple user operations in batch", async function () {
            const { entryPoint, wallet, user1, user2, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet
            await user1.sendTransaction({ to: wallet.target, value: ethers.parseEther("2") });
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("2") });
            
            // Create two operations
            const executeCallData1 = wallet.interface.encodeFunctionData("execute", [
                user2.address, 
                ethers.parseEther("0.1"), 
                "0x"
            ]);
            
            const executeCallData2 = wallet.interface.encodeFunctionData("execute", [
                user2.address, 
                ethers.parseEther("0.2"), 
                "0x"
            ]);
            
            const nonce1 = await wallet["getNonce()"]();
            const nonce2 = nonce1 + 1n;
            const userOp1 = await createSignedUserOperation(wallet, user1, entryPoint, wallet.target, ethers.parseEther("0.1"), executeCallData1, nonce1);
            const userOp2 = await createSignedUserOperation(wallet, user1, entryPoint, wallet.target, ethers.parseEther("0.2"), executeCallData2, nonce2);
            
            const initialBalance = await ethers.provider.getBalance(user2.address);
            
            await expect(entryPoint.connect(user1).handleOps([userOp1, userOp2], beneficiary.address))
                .to.not.be.reverted;
            
            // Verify at least one transfer happened
            const finalBalance = await ethers.provider.getBalance(user2.address);
            expect(finalBalance).to.be.gt(initialBalance);
        });
    });

    describe("Aggregated Operations", function () {
        it("Should handle aggregated operations", async function () {
            const { entryPoint, wallet, user1, user2, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet
            await user1.sendTransaction({ to: wallet.target, value: ethers.parseEther("1") });
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const executeCallData = wallet.interface.encodeFunctionData("execute", [
                user2.address, 
                ethers.parseEther("0.1"), 
                "0x"
            ]);
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user2.address, ethers.parseEther("0.1"), executeCallData);
            
            // Create aggregated operation structure
            const opsPerAggregator = [{
                aggregator: ethers.ZeroAddress,
                userOps: [userOp],
                signature: "0x"
            }];
            
            const initialBalance = await ethers.provider.getBalance(user2.address);
            
            await expect(entryPoint.connect(user1).handleAggregatedOps(opsPerAggregator, beneficiary.address))
                .to.not.be.reverted;
            
            // Verify the transfer happened
            const finalBalance = await ethers.provider.getBalance(user2.address);
            expect(finalBalance - initialBalance).to.equal(ethers.parseEther("0.1"));
        });

        it("Should handle empty aggregated operations", async function () {
            const { entryPoint, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            await expect(entryPoint.handleAggregatedOps([], beneficiary.address))
                .to.not.be.reverted;
        });
    });

    describe("Simulation", function () {
        it("Should reject unauthorized simulation calls", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deployFullSystemFixture);
            
            const userOp = await createUserOperation(wallet, user1.address, 0, "0x");
            
            // Direct call should fail - only EntryPoint can call itself
            await expect(entryPoint.connect(user1).innerExecuteCall(userOp))
                .to.be.revertedWithCustomError(entryPoint, "UnauthorizedCaller");
        });

        it("Should simulate execution with calldata", async function () {
            const { entryPoint, wallet, user1, user2, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet
            await user1.sendTransaction({ to: wallet.target, value: ethers.parseEther("1") });
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const executeCallData = wallet.interface.encodeFunctionData("execute", [
                user2.address, 
                ethers.parseEther("0.1"), 
                "0x"
            ]);
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user2.address, ethers.parseEther("0.1"), executeCallData);
            
            // This will internally call innerExecuteCall during execution
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.not.be.reverted;
        });
    });

    describe("Gas and Prefund Calculations", function () {
        it("Should calculate required prefund correctly", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Create operation with specific gas values
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [50000, 100000] // verificationGasLimit, callGasLimit
                ),
                preVerificationGas: 21000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("5", "gwei"), ethers.parseUnits("10", "gwei")] // maxPriorityFeePerGas, maxFeePerGas
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Fund with exact calculated amount
            const totalGas = 50000 + 100000 + 21000; // 171,000
            const maxFeePerGas = ethers.parseUnits("10", "gwei");
            const requiredPrefund = BigInt(totalGas) * maxFeePerGas;
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: requiredPrefund });
            
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.not.be.reverted;
        });

        it("Should handle large gas values in prefund calculation", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [1000000, 2000000] // Large gas limits
                ),
                preVerificationGas: 100000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("100", "gwei"), ethers.parseUnits("200", "gwei")] // High gas price
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Fund with sufficient amount
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.not.be.reverted;
        });
    });

    describe("Beneficiary Compensation", function () {
        it("Should compensate beneficiary with collected gas", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            // Fund the wallet
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x");
            
            const initialBeneficiaryBalance = await ethers.provider.getBalance(beneficiary.address);
            
            await entryPoint.connect(user1).handleOps([userOp], beneficiary.address);
            
            const finalBeneficiaryBalance = await ethers.provider.getBalance(beneficiary.address);
            
            // Beneficiary should receive compensation
            expect(finalBeneficiaryBalance).to.be.gt(initialBeneficiaryBalance);
        });
    });

    describe("Edge Cases", function () {
        it("Should handle operations with empty calldata", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x");
            
            await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                .to.not.be.reverted;
        });

        it("Should handle complex nonce sequences", async function () {
            const { entryPoint, wallet, user1, beneficiary } = await loadFixture(deployFullSystemFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("2") });
            
            // Use different keys and sequences
            const operations = [
                { key: 0, seq: 0 },
                { key: 0, seq: 1 },
                { key: 1, seq: 0 },
                { key: 2, seq: 0 }
            ];
            
            for (const { key, seq } of operations) {
                const nonce = (BigInt(key) << 64n) | BigInt(seq);
                const userOp = await createSignedUserOperation(wallet, user1, entryPoint, user1.address, 0, "0x", nonce);
                
                await expect(entryPoint.connect(user1).handleOps([userOp], beneficiary.address))
                    .to.not.be.reverted;
            }
        });
    });
});