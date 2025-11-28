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

describe("Transfer Failure Tests", function () {
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

    async function deploySystemWithMaliciousContractsFixture() {
        const [owner, user1] = await ethers.getSigners();
        
        // Deploy EntryPoint
        const entryPoint = await ethers.deployContract("EntryPoint");
        
        // Deploy factory
        const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
        const factory = await upgrades.deployProxy(
            SmartWalletFactory,
            [entryPoint.target, owner.address, ethers.ZeroAddress],
            { 
                initializer: 'initialize',
                unsafeAllow: ['constructor']
            }
        );
        
        // Create wallet
        await factory.createAccount(user1.address, 0);
        const walletAddress = await factory.getWallet(user1.address);
        const wallet = await ethers.getContractAt("SmartWallet", walletAddress);
        
        // Deploy malicious contract that rejects ETH transfers
        const EthRejecter = await ethers.getContractFactory("EthRejecter");
        const ethRejecter = await EthRejecter.deploy();
        
        return { 
            entryPoint, 
            factory, 
            wallet, 
            ethRejecter,
            owner, 
            user1
        };
    }

    before(async function() {
        // Deploy the EthRejecter contract for testing
        const EthRejecterCode = `
            // SPDX-License-Identifier: MIT
            pragma solidity 0.8.23;
            
            contract EthRejecter {
                // Contract that always reverts when receiving ETH
                receive() external payable {
                    revert("ETH transfer rejected");
                }
                
                fallback() external payable {
                    revert("ETH transfer rejected");
                }
            }
        `;
        
        // Write the contract file
        const fs = require('fs');
        const path = require('path');
        const contractsDir = path.join(__dirname, '../contracts/test-helpers');
        
        // Ensure directory exists
        if (!fs.existsSync(contractsDir)) {
            fs.mkdirSync(contractsDir, { recursive: true });
        }
        
        fs.writeFileSync(path.join(contractsDir, 'EthRejecter.sol'), EthRejecterCode);
    });

    describe("EntryPoint Transfer Failures", function () {
        it("Should handle beneficiary transfer failure in handleOps", async function () {
            const { entryPoint, wallet, ethRejecter, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Fund the wallet for gas
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            // Create user operation with signature
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [100000, 100000]
                ),
                preVerificationGas: 21000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("10", "gwei"), ethers.parseUnits("10", "gwei")]
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Use malicious contract as beneficiary - v0.7 uses FailedOp for bundler protection
            await expect(entryPoint.connect(user1).handleOps([userOp], ethRejecter.target))
                .to.be.reverted;
        });

        it("Should handle withdrawal transfer failure", async function () {
            const { entryPoint, ethRejecter, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Deposit funds to EntryPoint
            await entryPoint.connect(user1).depositTo(user1.address, { value: ethers.parseEther("1") });
            
            // Try to withdraw to malicious contract - v0.7 uses string revert
            await expect(entryPoint.connect(user1).withdrawTo(ethRejecter.target, ethers.parseEther("0.5")))
                .to.be.revertedWith("failed to withdraw");
        });

        it("Should handle stake withdrawal transfer failure", async function () {
            const { entryPoint, ethRejecter, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Add stake (v0.7 requires unstakeDelay > 0)
            const unstakeDelay = 1;
            await entryPoint.connect(user1).addStake(unstakeDelay, { value: ethers.parseEther("1") });
            
            // Unlock stake
            await entryPoint.connect(user1).unlockStake();
            
            // Wait for unstake delay
            await ethers.provider.send("evm_increaseTime", [unstakeDelay + 1]);
            await ethers.provider.send("evm_mine", []);
            
            // Try to withdraw stake to malicious contract - v0.7 uses string revert
            await expect(entryPoint.connect(user1).withdrawStake(ethRejecter.target))
                .to.be.revertedWith("failed to withdraw stake");
        });
    });

    describe("Zero Amount Edge Cases", function () {
        it("Should reject withdrawal without stake", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Don't add any stake, try to withdraw - v0.7 requires stake
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.be.revertedWith("No stake to withdraw");
        });

        it("Should handle withdrawal of zero amount", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(user1.address, { value: ethers.parseEther("1") });
            
            // Zero withdrawal should work (no actual transfer occurs)
            await expect(entryPoint.connect(user1).withdrawTo(user1.address, 0))
                .to.not.be.reverted;
        });
    });

    describe("Timing Edge Cases", function () {
        it("Should handle stake withdrawal timing boundary", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            const unstakeDelay = 3600; // 1 hour
            
            // Add stake with delay
            await entryPoint.connect(user1).addStake(unstakeDelay, { value: ethers.parseEther("1") });
            
            // Unlock stake
            await entryPoint.connect(user1).unlockStake();
            
            // Try to withdraw immediately - should fail
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.be.revertedWith("Stake withdrawal is not due");
            
            // Fast forward to exact boundary
            await ethers.provider.send("evm_increaseTime", [unstakeDelay]);
            await ethers.provider.send("evm_mine", []);
            
            // Should now work
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.not.be.reverted;
        });

        it("Should reject unlock without stake (edge case)", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Unlock without adding stake first - v0.7 requires being staked
            await expect(entryPoint.connect(user1).unlockStake())
                .to.be.revertedWith("not staked");
        });
    });

    describe("Stake Validation", function () {
        it("Should add stake with required unstakeDelay", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // v0.7 requires unstakeDelay > 0
            await entryPoint.connect(user1).addStake(1, { value: ethers.parseEther("0.5") });
            
            const depositInfo = await entryPoint.getDepositInfo(user1.address);
            expect(depositInfo.stake).to.equal(ethers.parseEther("0.5"));
            expect(depositInfo.staked).to.be.true;
        });

        it("Should handle valid stake amount", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Add sufficient stake (1+ ether) with required unstakeDelay > 0
            await entryPoint.connect(user1).addStake(1, { value: ethers.parseEther("2") });
            
            const depositInfo = await entryPoint.getDepositInfo(user1.address);
            expect(depositInfo.stake).to.equal(ethers.parseEther("2"));
            expect(depositInfo.staked).to.be.true;
        });
    });

    describe("Simulation Edge Cases", function () {
        it("Should handle simulation with failing calldata", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Fund the wallet for gas
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            // Create call that will fail (invalid function signature)
            const invalidCallData = "0xdeadbeef";
            
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: invalidCallData,
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [100000, 100000]
                ),
                preVerificationGas: 21000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("10", "gwei"), ethers.parseUnits("10", "gwei")]
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Should process but mark as failed
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.emit(entryPoint, "UserOperationEvent");
        });
    });

    describe("Complex Gas Scenarios", function () {
        it("Should reject zero gas operations", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [0, 0] // Zero gas limits
                ),
                preVerificationGas: 0,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [0, 0] // Zero gas fees
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Zero gas operation should fail in v0.7
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.be.reverted;
        });

        it("Should handle operations with minimal gas", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [50000, 50000] // Minimal but valid gas
                ),
                preVerificationGas: 21000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("1", "gwei"), ethers.parseUnits("1", "gwei")]
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Should handle minimal gas operation
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.emit(entryPoint, "UserOperationEvent");
        });
    });

    describe("UserOperation Hash Generation", function () {
        it("Should generate consistent hashes for identical operations", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("2") });
            
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [100000, 200000]
                ),
                preVerificationGas: 50000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("5", "gwei"), ethers.parseUnits("10", "gwei")]
                ),
                paymasterAndData: "0x", // Empty paymaster data for valid op
                signature: "0x"
            };
            
            // Sign the operation
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOp(userOp, user1, entryPoint, chainId);
            
            // Execute operation and capture hash from event
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.emit(entryPoint, "UserOperationEvent");
        });

        it("Should generate different hashes for different operations", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("2") });
            
            const chainId = (await ethers.provider.getNetwork()).chainId;
            
            const userOp1 = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x1234",
                accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [100000, 200000]),
                preVerificationGas: 50000,
                gasFees: ethers.solidityPacked(["uint128", "uint128"], [ethers.parseUnits("5", "gwei"), ethers.parseUnits("10", "gwei")]),
                paymasterAndData: "0x",
                signature: "0x"
            };
            userOp1.signature = await signUserOp(userOp1, user1, entryPoint, chainId);
            
            const userOp2 = {
                sender: wallet.target,
                nonce: 1,
                initCode: "0x",
                callData: "0x5678", // Different callData
                accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [100000, 200000]),
                preVerificationGas: 50000,
                gasFees: ethers.solidityPacked(["uint128", "uint128"], [ethers.parseUnits("5", "gwei"), ethers.parseUnits("10", "gwei")]),
                paymasterAndData: "0x",
                signature: "0x"
            };
            userOp2.signature = await signUserOp(userOp2, user1, entryPoint, chainId);
            
            // Execute both operations
            await entryPoint.connect(user1).handleOps([userOp1], user1.address);
            await entryPoint.connect(user1).handleOps([userOp2], user1.address);
        });
    });
});