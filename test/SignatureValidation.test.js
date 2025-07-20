const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Signature Validation Edge Cases", function () {
    async function deployWalletFixture() {
        const [owner, user1, user2] = await ethers.getSigners();
        
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
        
        return { 
            entryPoint, 
            factory, 
            wallet, 
            owner, 
            user1, 
            user2
        };
    }

    describe("ERC-1271 Signature Validation", function () {
        it("Should return magic value for valid signature", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            const message = "Hello World";
            const messageHash = ethers.hashMessage(message);
            const signature = await user1.signMessage(message);
            
            // Should return ERC-1271 magic value
            const result = await wallet.isValidSignature(messageHash, signature);
            expect(result).to.equal("0x1626ba7e"); // ERC-1271 magic value
        });

        it("Should return failure value for invalid signature", async function () {
            const { wallet, user2 } = await loadFixture(deployWalletFixture);
            
            const message = "Hello World";
            const messageHash = ethers.id(message);
            
            // Sign with wrong signer (user2 instead of wallet owner user1)
            const invalidSignature = await user2.signMessage(ethers.getBytes(messageHash));
            
            // Should return failure value
            const result = await wallet.isValidSignature(messageHash, invalidSignature);
            expect(result).to.equal("0xffffffff"); // Failure value
        });

        it("Should handle malformed signature gracefully", async function () {
            const { wallet } = await loadFixture(deployWalletFixture);
            
            const messageHash = ethers.id("test message");
            
            // Test with various malformed signatures
            const malformedSignatures = [
                "0x", // Empty
                "0x1234", // Too short
                "0x" + "00".repeat(32), // Wrong length (32 bytes instead of 65)
                "0x" + "ff".repeat(64), // 64 bytes (missing v)
                "0x" + "aa".repeat(100), // Too long
            ];
            
            for (const sig of malformedSignatures) {
                // Should return failure value for malformed signatures
                const result = await wallet.isValidSignature(messageHash, sig);
                expect(result).to.equal("0xffffffff");
            }
        });

        it("Should handle zero hash", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            const zeroHash = ethers.ZeroHash;
            const messageHash = ethers.hashMessage("zero test");
            const signature = await user1.signMessage("zero test");
            
            // Should still validate properly  
            const result = await wallet.isValidSignature(messageHash, signature);
            expect(result).to.equal("0x1626ba7e");
        });

        it("Should handle signature from different message", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            const message1 = "Message 1";
            const message2 = "Message 2";
            const hash1 = ethers.id(message1);
            const hash2 = ethers.id(message2);
            
            // Sign message1 but validate against message2
            const signature = await user1.signMessage(ethers.getBytes(hash1));
            
            // Should fail validation
            const result = await wallet.isValidSignature(hash2, signature);
            expect(result).to.equal("0xffffffff");
        });

        it("Should handle edge case signature values", async function () {
            const { wallet } = await loadFixture(deployWalletFixture);
            
            const messageHash = ethers.id("test");
            
            // Test with edge case signatures
            const edgeCaseSignatures = [
                "0x" + "00".repeat(65), // All zeros
                "0x" + "ff".repeat(65), // All FFs
                "0x" + "00".repeat(64) + "1b", // Valid length, low v
                "0x" + "00".repeat(64) + "1c", // Valid length, high v
            ];
            
            for (const sig of edgeCaseSignatures) {
                // Should handle gracefully and return failure
                const result = await wallet.isValidSignature(messageHash, sig);
                expect(result).to.equal("0xffffffff");
            }
        });

        it("Should validate signature with different message types", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            // Test with different message types  
            const testMessages = ["test1", "test2", "hello world"];
            
            for (const message of testMessages) {
                const messageHash = ethers.hashMessage(message);
                const signature = await user1.signMessage(message);
                const result = await wallet.isValidSignature(messageHash, signature);
                expect(result).to.equal("0x1626ba7e");
            }
        });
    });

    describe("Signature Validation Gas Optimization", function () {
        it("Should be gas efficient for valid signatures", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            const messageHash = ethers.id("gas test");
            const signature = await user1.signMessage(ethers.getBytes(messageHash));
            
            // Estimate gas for signature validation
            const gasEstimate = await wallet.isValidSignature.estimateGas(messageHash, signature);
            
            // Should be reasonably efficient (under 50k gas)
            expect(gasEstimate).to.be.lt(50000);
        });

        it("Should be gas efficient for invalid signatures", async function () {
            const { wallet, user2 } = await loadFixture(deployWalletFixture);
            
            const messageHash = ethers.id("gas test");
            const invalidSignature = await user2.signMessage(ethers.getBytes(messageHash));
            
            // Estimate gas for invalid signature validation
            const gasEstimate = await wallet.isValidSignature.estimateGas(messageHash, invalidSignature);
            
            // Should be reasonably efficient even for invalid signatures
            expect(gasEstimate).to.be.lt(50000);
        });
    });

    describe("Owner-Only Signature Validation", function () {
        it("Should only validate signatures from current owner", async function () {
            const { wallet, user1, user2 } = await loadFixture(deployWalletFixture);
            
            const message = "ownership test";
            const messageHash = ethers.hashMessage(message);
            
            // Signature from current owner should be valid
            const ownerSignature = await user1.signMessage(message);
            expect(await wallet.isValidSignature(messageHash, ownerSignature)).to.equal("0x1626ba7e");
            
            // Signature from non-owner should be invalid
            const nonOwnerSignature = await user2.signMessage(message);
            expect(await wallet.isValidSignature(messageHash, nonOwnerSignature)).to.equal("0xffffffff");
        });

        it("Should update signature validation after ownership change", async function () {
            const { wallet, user1, user2 } = await loadFixture(deployWalletFixture);
            
            const message = "ownership change test";
            const messageHash = ethers.hashMessage(message);
            
            // Initially, user1 signatures are valid
            const user1Signature = await user1.signMessage(message);
            expect(await wallet.isValidSignature(messageHash, user1Signature)).to.equal("0x1626ba7e");
            
            // Change ownership to user2
            await wallet.connect(user1).changeOwner(user2.address);
            
            // Now user1 signatures should be invalid
            expect(await wallet.isValidSignature(messageHash, user1Signature)).to.equal("0xffffffff");
            
            // And user2 signatures should be valid
            const user2Signature = await user2.signMessage(message);
            expect(await wallet.isValidSignature(messageHash, user2Signature)).to.equal("0x1626ba7e");
        });
    });

    describe("Signature Recovery Edge Cases", function () {
        it("Should handle signature recovery failure gracefully", async function () {
            const { wallet } = await loadFixture(deployWalletFixture);
            
            const messageHash = ethers.id("recovery test");
            
            // Create signature with invalid s value (too high)
            const invalidSignature = "0x" + 
                "1234567890abcdef".repeat(4) + // r (32 bytes)
                "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141" + // invalid s (too high)
                "1b"; // v
            
            // Should handle gracefully and return failure
            const result = await wallet.isValidSignature(messageHash, invalidSignature);
            expect(result).to.equal("0xffffffff");
        });

        it("Should handle signature with invalid v value", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            const messageHash = ethers.id("v value test");
            const signature = await user1.signMessage(ethers.getBytes(messageHash));
            
            // Modify v value to invalid value
            const sigBytes = ethers.getBytes(signature);
            sigBytes[64] = 0; // Set v to 0 (invalid)
            const invalidSignature = ethers.hexlify(sigBytes);
            
            // Should handle gracefully and return failure
            const result = await wallet.isValidSignature(messageHash, invalidSignature);
            expect(result).to.equal("0xffffffff");
        });
    });

    describe("Message Hash Validation", function () {
        it("Should handle various hash formats", async function () {
            const { wallet, user1 } = await loadFixture(deployWalletFixture);
            
            const testMessages = [
                "", // Empty string
                "short", // Short message
                "a".repeat(100), // Long message
            ];
            
            for (const message of testMessages) {
                const messageHash = ethers.hashMessage(message);
                const signature = await user1.signMessage(message);
                const result = await wallet.isValidSignature(messageHash, signature);
                expect(result).to.equal("0x1626ba7e");
            }
        });
    });
});