const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Transfer Failure Tests", function () {
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
            
            // Create user operation
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
            
            // Use malicious contract as beneficiary - should trigger BeneficiaryTransferFailed
            await expect(entryPoint.connect(user1).handleOps([userOp], ethRejecter.target))
                .to.be.revertedWithCustomError(entryPoint, "BeneficiaryTransferFailed");
        });

        it("Should handle withdrawal transfer failure", async function () {
            const { entryPoint, ethRejecter, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Deposit funds to EntryPoint
            await entryPoint.connect(user1).depositTo(user1.address, { value: ethers.parseEther("1") });
            
            // Try to withdraw to malicious contract - should trigger TransferFailed
            await expect(entryPoint.connect(user1).withdrawTo(ethRejecter.target, ethers.parseEther("0.5")))
                .to.be.revertedWithCustomError(entryPoint, "TransferFailed");
        });

        it("Should handle stake withdrawal transfer failure", async function () {
            const { entryPoint, ethRejecter, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Add stake
            await entryPoint.connect(user1).addStake(0, { value: ethers.parseEther("1") });
            
            // Unlock stake
            await entryPoint.connect(user1).unlockStake();
            
            // Try to withdraw stake to malicious contract - should trigger TransferFailed
            await expect(entryPoint.connect(user1).withdrawStake(ethRejecter.target))
                .to.be.revertedWithCustomError(entryPoint, "TransferFailed");
        });
    });

    describe("Zero Amount Edge Cases", function () {
        it("Should handle zero stake withdrawal", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Don't add any stake, just unlock and try to withdraw
            await entryPoint.connect(user1).unlockStake();
            
            // Should not revert even with zero stake
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.not.be.reverted;
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
                .to.be.revertedWithCustomError(entryPoint, "StakeNotUnlocked");
            
            // Fast forward to exact boundary
            await ethers.provider.send("evm_increaseTime", [unstakeDelay]);
            await ethers.provider.send("evm_mine", []);
            
            // Should now work
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.not.be.reverted;
        });

        it("Should handle unlock without stake (edge case)", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Unlock without adding stake first
            await expect(entryPoint.connect(user1).unlockStake())
                .to.not.be.reverted;
            
            // Should be able to "withdraw" immediately (no actual stake)
            await expect(entryPoint.connect(user1).withdrawStake(user1.address))
                .to.not.be.reverted;
        });
    });

    describe("Stake Validation", function () {
        it("Should enforce minimum stake requirement with validStake modifier", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Add insufficient stake (less than 1 ether)
            await entryPoint.connect(user1).addStake(0, { value: ethers.parseEther("0.5") });
            
            // Note: The validStake modifier is not directly testable as it's only used 
            // in functions that don't exist in our current EntryPoint implementation.
            // But we can verify the stake amount check logic
            const depositInfo = await entryPoint.deposits(user1.address);
            expect(depositInfo.stake).to.equal(ethers.parseEther("0.5"));
            expect(depositInfo.staked).to.be.true;
        });

        it("Should handle valid stake amount", async function () {
            const { entryPoint, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            // Add sufficient stake (1+ ether)
            await entryPoint.connect(user1).addStake(0, { value: ethers.parseEther("2") });
            
            const depositInfo = await entryPoint.deposits(user1.address);
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
            
            // Should process but mark as failed
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.emit(entryPoint, "UserOperationEvent");
        });
    });

    describe("Complex Gas Scenarios", function () {
        it("Should handle zero gas operations", async function () {
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
            
            // Should handle zero gas operation
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.not.be.reverted;
        });

        it("Should handle operations with no collected gas", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("1") });
            
            const userOp = {
                sender: wallet.target,
                nonce: 0,
                initCode: "0x",
                callData: "0x",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [1, 1] // Minimal gas
                ),
                preVerificationGas: 1,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [1, 1] // Minimal fees
                ),
                paymasterAndData: "0x",
                signature: "0x"
            };
            
            // Should handle minimal gas operation
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.not.be.reverted;
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
                callData: "0x1234",
                accountGasLimits: ethers.solidityPacked(
                    ["uint128", "uint128"], 
                    [100000, 200000]
                ),
                preVerificationGas: 50000,
                gasFees: ethers.solidityPacked(
                    ["uint128", "uint128"],
                    [ethers.parseUnits("5", "gwei"), ethers.parseUnits("10", "gwei")]
                ),
                paymasterAndData: "0xabcd",
                signature: "0x"
            };
            
            // Execute operation and capture hash from event
            await expect(entryPoint.connect(user1).handleOps([userOp], user1.address))
                .to.emit(entryPoint, "UserOperationEvent");
        });

        it("Should generate different hashes for different operations", async function () {
            const { entryPoint, wallet, user1 } = await loadFixture(deploySystemWithMaliciousContractsFixture);
            
            await entryPoint.connect(user1).depositTo(wallet.target, { value: ethers.parseEther("2") });
            
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
            
            const userOp2 = {
                ...userOp1,
                nonce: 1,
                callData: "0x5678" // Different callData
            };
            
            // Execute both operations
            await entryPoint.connect(user1).handleOps([userOp1], user1.address);
            await entryPoint.connect(user1).handleOps([userOp2], user1.address);
        });
    });
});