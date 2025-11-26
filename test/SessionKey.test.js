const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Hardhat default account private keys (for testing only)
const HARDHAT_PRIVATE_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // account 0 (owner)
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // account 1 (user1)
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // account 2 (user2)
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // account 3 (sessionKey)
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // account 4 (beneficiary)
];

describe("Session Key Tests", function () {
    // Constants
    const SESSION_KEY_SIG = "0x00000001"; // SESSION_KEY_ECDSA
    const ONE_DAY = 24 * 60 * 60;
    const ONE_WEEK = 7 * ONE_DAY;
    const MAX_SESSION_DURATION = 30 * ONE_DAY;

    async function deploySystemFixture() {
        const [owner, user1, user2, sessionKeySigner, beneficiary] = await ethers.getSigners();
        
        // Deploy EntryPoint
        const entryPoint = await ethers.deployContract("EntryPoint");
        
        // Deploy SmartWallet implementation
        const SmartWallet = await ethers.getContractFactory("SmartWallet");
        const walletImpl = await SmartWallet.deploy(entryPoint.target);
        
        // Deploy wallet via clone
        const cloneFactory = await ethers.getContractFactory("contracts/SmartWalletFactory.sol:SmartWalletFactory");
        const factory = await upgrades.deployProxy(
            cloneFactory,
            [entryPoint.target, owner.address, ethers.ZeroAddress],
            { 
                initializer: 'initialize',
                unsafeAllow: ['constructor']
            }
        );
        
        // Update implementation to V2
        await factory.setSmartWalletImplementation(walletImpl.target);
        
        // Create a wallet for user1
        await factory.createAccount(user1.address, 0);
        const walletAddress = await factory.getWallet(user1.address);
        const wallet = await ethers.getContractAt("SmartWallet", walletAddress);
        
        // Fund wallet
        await owner.sendTransaction({ to: walletAddress, value: ethers.parseEther("10") });
        await entryPoint.connect(user1).depositTo(walletAddress, { value: ethers.parseEther("1") });
        
        // Deploy a mock target contract for testing
        const MockTarget = await ethers.getContractFactory("MockTarget");
        const mockTarget = await MockTarget.deploy();
        
        return { 
            entryPoint, 
            factory, 
            wallet, 
            walletImpl,
            mockTarget,
            owner, 
            user1, 
            user2,
            sessionKeySigner,
            beneficiary
        };
    }

    // Helper to get private key for a signer
    async function getPrivateKey(signer) {
        const signers = await ethers.getSigners();
        const signerAddress = await signer.getAddress();
        for (let i = 0; i < signers.length && i < HARDHAT_PRIVATE_KEYS.length; i++) {
            if ((await signers[i].getAddress()) === signerAddress) {
                return HARDHAT_PRIVATE_KEYS[i];
            }
        }
        throw new Error(`Private key not found for signer ${signerAddress}`);
    }

    // Helper to create session config
    async function createSessionConfig(sessionKey, targets, selectors, options = {}) {
        const now = await time.latest();
        return {
            key: sessionKey,
            validAfter: options.validAfter || now,
            validUntil: options.validUntil || now + ONE_WEEK,
            maxValuePerTx: options.maxValuePerTx || ethers.parseEther("1"),
            maxValueTotal: options.maxValueTotal || ethers.parseEther("10"),
            maxCalls: options.maxCalls || 100,
            allowedTargets: targets,
            allowedSelectors: selectors
        };
    }

    // Helper to sign user operation with session key
    async function signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId) {
        // Calculate userOpHash (same as EntryPoint)
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
        
        // Sign directly without EIP-191 prefix
        const privateKey = await getPrivateKey(sessionKeySigner);
        const signingKey = new ethers.SigningKey(privateKey);
        const sig = signingKey.sign(userOpHash);
        
        // Format: [4 bytes SESSION_KEY_SIG][20 bytes sessionKey][65 bytes signature]
        return ethers.concat([
            SESSION_KEY_SIG,
            await sessionKeySigner.getAddress(),
            sig.serialized
        ]);
    }

    // Helper to create user operation
    async function createUserOp(wallet, callData, nonce = null) {
        if (nonce === null) {
            nonce = await wallet["getNonce()"]();
        }
        
        return {
            sender: wallet.target,
            nonce: nonce,
            initCode: "0x",
            callData: callData,
            accountGasLimits: ethers.solidityPacked(
                ["uint128", "uint128"], 
                [200000, 200000]
            ),
            preVerificationGas: 50000,
            gasFees: ethers.solidityPacked(
                ["uint128", "uint128"],
                [ethers.parseUnits("10", "gwei"), ethers.parseUnits("10", "gwei")]
            ),
            paymasterAndData: "0x",
            signature: "0x"
        };
    }

    // Deploy mock target before tests
    before(async function() {
        // Deploy the MockTarget contract for testing
        const MockTargetCode = `
            // SPDX-License-Identifier: MIT
            pragma solidity 0.8.23;
            
            contract MockTarget {
                uint256 public value;
                address public lastCaller;
                
                event ValueSet(uint256 newValue);
                event Received(address sender, uint256 amount);
                
                function setValue(uint256 _value) external {
                    value = _value;
                    lastCaller = msg.sender;
                    emit ValueSet(_value);
                }
                
                function getValue() external view returns (uint256) {
                    return value;
                }
                
                receive() external payable {
                    emit Received(msg.sender, msg.value);
                }
            }
        `;
        
        // Write the contract file
        const fs = require('fs');
        const path = require('path');
        const contractsDir = path.join(__dirname, '../contracts/test-helpers');
        
        if (!fs.existsSync(contractsDir)) {
            fs.mkdirSync(contractsDir, { recursive: true });
        }
        
        fs.writeFileSync(
            path.join(contractsDir, 'MockTarget.sol'),
            MockTargetCode
        );
    });

    describe("Session Creation", function () {
        it("Should create a session key with valid parameters", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"] // setValue(uint256) selector
            );
            
            const tx = await wallet.connect(user1).createSession(config);
            const receipt = await tx.wait();
            
            // Check event was emitted
            const event = receipt.logs.find(log => {
                try {
                    return wallet.interface.parseLog(log)?.name === "SessionCreatedECDSA";
                } catch { return false; }
            });
            expect(event).to.not.be.undefined;
            
            const parsedEvent = wallet.interface.parseLog(event);
            expect(parsedEvent.args.sessionKey).to.equal(sessionKeySigner.address);
            expect(parsedEvent.args.validAfter).to.equal(config.validAfter);
            expect(parsedEvent.args.validUntil).to.equal(config.validUntil);
            
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.true;
        });

        it("Should reject session with zero address key", async function () {
            const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                ethers.ZeroAddress,
                [mockTarget.target],
                ["0x55241077"]
            );
            
            await expect(wallet.connect(user1).createSession(config))
                .to.be.revertedWithCustomError(wallet, "InvalidSessionKey");
        });

        it("Should reject session with past expiry", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const now = await time.latest();
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"],
                { validUntil: now - 100 }
            );
            
            await expect(wallet.connect(user1).createSession(config))
                .to.be.revertedWithCustomError(wallet, "InvalidValidityWindow");
        });

        it("Should reject session with empty targets", async function () {
            const { wallet, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [], // empty targets
                ["0x55241077"]
            );
            
            await expect(wallet.connect(user1).createSession(config))
                .to.be.revertedWithCustomError(wallet, "NoTargetsSpecified");
        });

        it("Should reject session creation from non-owner", async function () {
            const { wallet, mockTarget, user2, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"]
            );
            
            await expect(wallet.connect(user2).createSession(config))
                .to.be.revertedWithCustomError(wallet, "Unauthorized");
        });

        it("Should reject session exceeding max duration", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const now = await time.latest();
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"],
                { validUntil: now + MAX_SESSION_DURATION + ONE_DAY }
            );
            
            await expect(wallet.connect(user1).createSession(config))
                .to.be.revertedWithCustomError(wallet, "SessionDurationTooLong");
        });

        it("Should store session permissions correctly", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            const selector = "0x55241077";
            const targets = [mockTarget.target, beneficiary.address];
            const selectors = [selector];
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                targets,
                selectors
            );
            
            await wallet.connect(user1).createSession(config);
            
            const [storedTargets, storedSelectors] = await wallet.getSessionPermissionsECDSA(sessionKeySigner.address);
            expect(storedTargets).to.deep.equal(targets);
            expect(storedSelectors).to.deep.equal(selectors);
        });
    });

    describe("Session Revocation", function () {
        it("Should revoke a session immediately", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"]
            );
            
            await wallet.connect(user1).createSession(config);
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.true;
            
            await expect(wallet.connect(user1).revokeSession(sessionKeySigner.address))
                .to.emit(wallet, "SessionRevokedECDSA")
                .withArgs(sessionKeySigner.address);
            
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.false;
        });

        it("Should batch revoke multiple sessions", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner, user2 } = await loadFixture(deploySystemFixture);
            
            // Create two sessions
            const config1 = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"]
            );
            const config2 = await createSessionConfig(
                user2.address,
                [mockTarget.target],
                ["0x55241077"]
            );
            
            await wallet.connect(user1).createSession(config1);
            await wallet.connect(user1).createSession(config2);
            
            // Revoke both sessions separately (no batch revoke in new API)
            await wallet.connect(user1).revokeSession(sessionKeySigner.address);
            await wallet.connect(user1).revokeSession(user2.address);
            
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.false;
            expect(await wallet.isValidSessionECDSA(user2.address)).to.be.false;
        });

        it("Should reject revocation of non-existent session", async function () {
            const { wallet, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            await expect(wallet.connect(user1).revokeSession(sessionKeySigner.address))
                .to.be.revertedWithCustomError(wallet, "SessionNotFound");
        });
    });

    describe("Session Validation", function () {
        it("Should validate session before validAfter", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const now = await time.latest();
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"],
                { validAfter: now + ONE_DAY }
            );
            
            await wallet.connect(user1).createSession(config);
            
            // Session should not be valid yet
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.false;
            
            // Advance time
            await time.increase(ONE_DAY + 1);
            
            // Now it should be valid
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.true;
        });

        it("Should invalidate session after validUntil", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const now = await time.latest();
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"],
                { validUntil: now + ONE_DAY }
            );
            
            await wallet.connect(user1).createSession(config);
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.true;
            
            // Advance past expiry
            await time.increase(ONE_DAY + 1);
            
            expect(await wallet.isValidSessionECDSA(sessionKeySigner.address)).to.be.false;
        });

        it("Should return correct session info", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"],
                {
                    maxValuePerTx: ethers.parseEther("0.5"),
                    maxValueTotal: ethers.parseEther("5"),
                    maxCalls: 50
                }
            );
            
            await wallet.connect(user1).createSession(config);
            
            const session = await wallet.getSessionECDSA(sessionKeySigner.address);
            expect(session.key).to.equal(sessionKeySigner.address);
            expect(session.maxValuePerTx).to.equal(ethers.parseEther("0.5"));
            expect(session.maxValueTotal).to.equal(ethers.parseEther("5"));
            expect(session.maxCalls).to.equal(50);
            expect(session.valueUsed).to.equal(0);
            expect(session.callsUsed).to.equal(0);
            expect(session.revoked).to.be.false;
        });
    });

    describe("Session Key Execution via EntryPoint", function () {
        it("Should execute allowed call with session key", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            // Create session allowing setValue calls
            const selector = "0x55241077"; // setValue(uint256)
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                [selector]
            );
            await wallet.connect(user1).createSession(config);
            
            // Create callData for wallet.execute(mockTarget, 0, setValue(42))
            const innerCallData = mockTarget.interface.encodeFunctionData("setValue", [42]);
            const callData = wallet.interface.encodeFunctionData("execute", [
                mockTarget.target,
                0,
                innerCallData
            ]);
            
            // Create and sign user operation with session key
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            // Execute via EntryPoint
            await entryPoint.handleOps([userOp], beneficiary.address);
            
            // Verify the call was executed
            expect(await mockTarget.value()).to.equal(42);
            expect(await mockTarget.lastCaller()).to.equal(wallet.target);
        });

        it("Should reject call to unauthorized target", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary, user2 } = await loadFixture(deploySystemFixture);
            
            // Create session allowing only mockTarget
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            // Try to call a different target (user2's address)
            const callData = wallet.interface.encodeFunctionData("execute", [
                user2.address, // unauthorized target
                ethers.parseEther("0.1"),
                "0x"
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });

        it("Should reject call with unauthorized selector", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            // Create session allowing only setValue
            const setValueSelector = "0x55241077";
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                [setValueSelector]
            );
            await wallet.connect(user1).createSession(config);
            
            // Try to call getValue (different selector)
            const getValueSelector = "0x20965255"; // getValue()
            const innerCallData = mockTarget.interface.encodeFunctionData("getValue");
            const callData = wallet.interface.encodeFunctionData("execute", [
                mockTarget.target,
                0,
                innerCallData
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });

        it("Should reject call exceeding per-tx value limit", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            // Create session with 0.1 ETH per-tx limit
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                [],
                { maxValuePerTx: ethers.parseEther("0.1") }
            );
            await wallet.connect(user1).createSession(config);
            
            // Try to send 0.5 ETH (exceeds limit)
            const callData = wallet.interface.encodeFunctionData("execute", [
                mockTarget.target,
                ethers.parseEther("0.5"), // exceeds 0.1 ETH limit
                "0x"
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });

        it("Should track and enforce total value limit", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            // Create session with 0.3 ETH total limit
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                [],
                { 
                    maxValuePerTx: ethers.parseEther("0.2"),
                    maxValueTotal: ethers.parseEther("0.3")
                }
            );
            await wallet.connect(user1).createSession(config);
            
            const chainId = (await ethers.provider.getNetwork()).chainId;
            
            // First call: send 0.2 ETH (should succeed)
            const callData1 = wallet.interface.encodeFunctionData("execute", [
                mockTarget.target,
                ethers.parseEther("0.2"),
                "0x"
            ]);
            const userOp1 = await createUserOp(wallet, callData1);
            userOp1.signature = await signUserOpWithSessionKey(userOp1, sessionKeySigner, entryPoint, chainId);
            await entryPoint.handleOps([userOp1], beneficiary.address);
            
            // Check usage was tracked
            const session = await wallet.getSessionECDSA(sessionKeySigner.address);
            expect(session.valueUsed).to.equal(ethers.parseEther("0.2"));
            
            // Second call: try to send 0.2 ETH more (should fail - total would be 0.4 ETH)
            const callData2 = wallet.interface.encodeFunctionData("execute", [
                mockTarget.target,
                ethers.parseEther("0.2"),
                "0x"
            ]);
            const userOp2 = await createUserOp(wallet, callData2);
            userOp2.signature = await signUserOpWithSessionKey(userOp2, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp2], beneficiary.address))
                .to.be.reverted;
        });

        it("Should track and enforce call count limit", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            // Create session with maxCalls = 2
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                [],
                { maxCalls: 2 }
            );
            await wallet.connect(user1).createSession(config);
            
            const chainId = (await ethers.provider.getNetwork()).chainId;
            
            // Make 2 calls (should succeed)
            for (let i = 0; i < 2; i++) {
                const innerCallData = mockTarget.interface.encodeFunctionData("setValue", [i]);
                const callData = wallet.interface.encodeFunctionData("execute", [
                    mockTarget.target,
                    0,
                    innerCallData
                ]);
                const userOp = await createUserOp(wallet, callData);
                userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
                await entryPoint.handleOps([userOp], beneficiary.address);
            }
            
            // Check calls used
            const session = await wallet.getSessionECDSA(sessionKeySigner.address);
            expect(session.callsUsed).to.equal(2);
            
            // Third call should fail
            const innerCallData = mockTarget.interface.encodeFunctionData("setValue", [100]);
            const callData = wallet.interface.encodeFunctionData("execute", [
                mockTarget.target,
                0,
                innerCallData
            ]);
            const userOp = await createUserOp(wallet, callData);
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });
    });

    describe("Sensitive Function Protection", function () {
        it("Should block session key from calling changeOwner", async function () {
            const { entryPoint, wallet, user1, sessionKeySigner, beneficiary, user2 } = await loadFixture(deploySystemFixture);
            
            // Create session (allowing wallet itself as target won't help)
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [wallet.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            // Try to call changeOwner
            const callData = wallet.interface.encodeFunctionData("changeOwner", [user2.address]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });

        it("Should block session key from calling createSession", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary, user2 } = await loadFixture(deploySystemFixture);
            
            // Create session
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [wallet.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            // Try to create another session
            const newSessionConfig = {
                key: user2.address,
                validAfter: 0,
                validUntil: Math.floor(Date.now() / 1000) + ONE_WEEK,
                maxValuePerTx: 0,
                maxValueTotal: 0,
                maxCalls: 0,
                allowedTargets: [mockTarget.target],
                allowedSelectors: []
            };
            const callData = wallet.interface.encodeFunctionData("createSession", [newSessionConfig]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });

        it("Should block session key from calling withdrawDepositTo", async function () {
            const { entryPoint, wallet, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [wallet.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            // Try to withdraw
            const callData = wallet.interface.encodeFunctionData("withdrawDepositTo", [
                beneficiary.address,
                ethers.parseEther("0.1")
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });
    });

    describe("Batch Execution with Session Keys", function () {
        it("Should execute batch of allowed calls", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                ["0x55241077"] // setValue
            );
            await wallet.connect(user1).createSession(config);
            
            // Create batch call
            const innerCallData1 = mockTarget.interface.encodeFunctionData("setValue", [10]);
            const innerCallData2 = mockTarget.interface.encodeFunctionData("setValue", [20]);
            
            const callData = wallet.interface.encodeFunctionData("executeBatch", [
                [mockTarget.target, mockTarget.target],
                [0, 0],
                [innerCallData1, innerCallData2]
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await entryPoint.handleOps([userOp], beneficiary.address);
            
            // Last value should be 20
            expect(await mockTarget.value()).to.equal(20);
        });

        it("Should reject batch if any call is unauthorized", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary, user2 } = await loadFixture(deploySystemFixture);
            
            // Only allow mockTarget
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            // Try batch with one unauthorized target
            const callData = wallet.interface.encodeFunctionData("executeBatch", [
                [mockTarget.target, user2.address], // user2 is not allowed
                [0, ethers.parseEther("0.1")],
                ["0x", "0x"]
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });

        it("Should enforce total value limit across batch", async function () {
            const { entryPoint, wallet, mockTarget, user1, sessionKeySigner, beneficiary } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                [],
                {
                    maxValuePerTx: ethers.parseEther("0.5"),
                    maxValueTotal: ethers.parseEther("0.5")
                }
            );
            await wallet.connect(user1).createSession(config);
            
            // Try batch totaling 0.6 ETH (3 x 0.2 ETH)
            const callData = wallet.interface.encodeFunctionData("executeBatch", [
                [mockTarget.target, mockTarget.target, mockTarget.target],
                [ethers.parseEther("0.2"), ethers.parseEther("0.2"), ethers.parseEther("0.2")],
                ["0x", "0x", "0x"]
            ]);
            
            const userOp = await createUserOp(wallet, callData);
            const chainId = (await ethers.provider.getNetwork()).chainId;
            userOp.signature = await signUserOpWithSessionKey(userOp, sessionKeySigner, entryPoint, chainId);
            
            await expect(entryPoint.handleOps([userOp], beneficiary.address))
                .to.be.reverted;
        });
    });

    describe("ERC-1271 Signature Validation", function () {
        it("Should validate owner signature via isValidSignature", async function () {
            const { wallet, user1 } = await loadFixture(deploySystemFixture);
            
            const message = "Hello, World!";
            const hash = ethers.keccak256(ethers.toUtf8Bytes(message));
            
            // Sign directly without EIP-191 prefix (as expected by wallet)
            const privateKey = await getPrivateKey(user1);
            const signingKey = new ethers.SigningKey(privateKey);
            const sig = signingKey.sign(hash);
            
            const result = await wallet.isValidSignature(hash, sig.serialized);
            expect(result).to.equal("0x1626ba7e"); // ERC1271_MAGIC_VALUE
        });

        it("Should validate session key signature via isValidSignature", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            const message = "Hello, Session Key!";
            const hash = ethers.keccak256(ethers.toUtf8Bytes(message));
            
            // Sign with session key
            const privateKey = await getPrivateKey(sessionKeySigner);
            const signingKey = new ethers.SigningKey(privateKey);
            const sig = signingKey.sign(hash);
            
            // Format signature with session key prefix
            const fullSignature = ethers.concat([
                SESSION_KEY_SIG,
                sessionKeySigner.address,
                sig.serialized
            ]);
            
            const result = await wallet.isValidSignature(hash, fullSignature);
            expect(result).to.equal("0x1626ba7e");
        });

        it("Should reject invalid session key signature", async function () {
            const { wallet, mockTarget, user1, sessionKeySigner, user2 } = await loadFixture(deploySystemFixture);
            
            const config = await createSessionConfig(
                sessionKeySigner.address,
                [mockTarget.target],
                []
            );
            await wallet.connect(user1).createSession(config);
            
            const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
            
            // Sign with wrong key (user2 instead of sessionKeySigner)
            const privateKey = await getPrivateKey(user2);
            const signingKey = new ethers.SigningKey(privateKey);
            const sig = signingKey.sign(hash);
            
            // But claim it's from sessionKeySigner
            const fullSignature = ethers.concat([
                SESSION_KEY_SIG,
                sessionKeySigner.address, // claiming to be sessionKeySigner
                sig.serialized // but signed by user2
            ]);
            
            const result = await wallet.isValidSignature(hash, fullSignature);
            expect(result).to.equal("0xffffffff"); // Invalid
        });
    });

    // ============================================
    // P256/PASSKEY SESSION KEY TESTS
    // ============================================
    describe("P256/Passkey Session Keys", function () {
        // P256 constants  
        const SESSION_KEY_P256 = "0x00000002";
        const { secp256r1 } = require("@noble/curves/p256");

        // P256 curve order (for low-S normalization)
        const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

        // Helper class for P256 signing (based on OpenZeppelin's approach)
        class P256SigningKey {
            #privateKey;

            constructor(privateKey) {
                this.privateKey = privateKey;
            }

            static random() {
                return new P256SigningKey(secp256r1.utils.randomPrivateKey());
            }

            get publicKey() {
                const publicKeyBytes = secp256r1.getPublicKey(this.privateKey, false);
                return {
                    qx: ethers.hexlify(publicKeyBytes.slice(0x01, 0x21)),
                    qy: ethers.hexlify(publicKeyBytes.slice(0x21, 0x41)),
                };
            }

            sign(digest) {
                const sig = secp256r1.sign(
                    ethers.getBytesCopy(digest), 
                    ethers.getBytesCopy(this.privateKey), 
                    { lowS: true }
                );
                return {
                    r: ethers.toBeHex(sig.r, 32),
                    s: ethers.toBeHex(sig.s, 32),
                };
            }
        }

        // Helper to create P256 session config
        async function createP256SessionConfig(keyX, keyY, targets, selectors, options = {}) {
            const now = await time.latest();
            return {
                keyX: keyX,
                keyY: keyY,
                validAfter: options.validAfter || now,
                validUntil: options.validUntil || now + ONE_WEEK,
                maxValuePerTx: options.maxValuePerTx || ethers.parseEther("1"),
                maxValueTotal: options.maxValueTotal || ethers.parseEther("10"),
                maxCalls: options.maxCalls || 100,
                allowedTargets: targets,
                allowedSelectors: selectors
            };
        }

        // Helper to sign with P256 and format signature
        function signWithP256(p256Key, hash) {
            const sig = p256Key.sign(hash);
            // Format: [4 bytes prefix][32 bytes keyX][32 bytes keyY][32 bytes r][32 bytes s]
            return ethers.concat([
                SESSION_KEY_P256,
                p256Key.publicKey.qx,
                p256Key.publicKey.qy,
                sig.r,
                sig.s
            ]);
        }

        describe("P256 Session Creation", function () {
            it("Should create a P256 session key", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    ["0x55241077"] // setValue(uint256)
                );

                const tx = await wallet.connect(user1).createSessionP256(config);
                const receipt = await tx.wait();

                // Check event was emitted
                const event = receipt.logs.find(log => {
                    try {
                        return wallet.interface.parseLog(log)?.name === "SessionCreatedP256";
                    } catch { return false; }
                });
                expect(event).to.not.be.undefined;

                // Check session is valid
                expect(await wallet.isValidSessionP256(p256Key.publicKey.qx, p256Key.publicKey.qy)).to.be.true;
            });

            it("Should reject P256 session with zero key", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const config = await createP256SessionConfig(
                    ethers.ZeroHash,
                    ethers.ZeroHash,
                    [mockTarget.target],
                    []
                );

                await expect(wallet.connect(user1).createSessionP256(config))
                    .to.be.revertedWithCustomError(wallet, "InvalidP256Key");
            });

            it("Should reject duplicate P256 session", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    []
                );

                await wallet.connect(user1).createSessionP256(config);
                
                await expect(wallet.connect(user1).createSessionP256(config))
                    .to.be.revertedWithCustomError(wallet, "SessionAlreadyActive");
            });
        });

        describe("P256 Session Revocation", function () {
            it("Should revoke a P256 session", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    []
                );

                await wallet.connect(user1).createSessionP256(config);
                expect(await wallet.isValidSessionP256(p256Key.publicKey.qx, p256Key.publicKey.qy)).to.be.true;

                await expect(wallet.connect(user1).revokeSessionP256(p256Key.publicKey.qx, p256Key.publicKey.qy))
                    .to.emit(wallet, "SessionRevokedP256");

                expect(await wallet.isValidSessionP256(p256Key.publicKey.qx, p256Key.publicKey.qy)).to.be.false;
            });
        });

        describe("P256 Signature Validation (ERC-1271)", function () {
            it("Should validate P256 session key signature", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    []
                );
                await wallet.connect(user1).createSessionP256(config);

                const message = "Hello, P256 Session Key!";
                const hash = ethers.keccak256(ethers.toUtf8Bytes(message));
                
                const fullSignature = signWithP256(p256Key, hash);
                
                const result = await wallet.isValidSignature(hash, fullSignature);
                expect(result).to.equal("0x1626ba7e");
            });

            it("Should reject invalid P256 signature", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const wrongKey = P256SigningKey.random();
                
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    []
                );
                await wallet.connect(user1).createSessionP256(config);

                const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
                
                // Sign with wrong key but claim to be p256Key
                const sig = wrongKey.sign(hash);
                const fullSignature = ethers.concat([
                    SESSION_KEY_P256,
                    p256Key.publicKey.qx, // claim to be p256Key
                    p256Key.publicKey.qy,
                    sig.r, // but signed by wrongKey
                    sig.s
                ]);
                
                const result = await wallet.isValidSignature(hash, fullSignature);
                expect(result).to.equal("0xffffffff");
            });

            it("Should reject expired P256 session signature", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const now = await time.latest();
                
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    [],
                    { validUntil: now + 100 }
                );
                await wallet.connect(user1).createSessionP256(config);

                // Time travel past expiry
                await time.increase(200);

                const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
                const fullSignature = signWithP256(p256Key, hash);
                
                const result = await wallet.isValidSignature(hash, fullSignature);
                expect(result).to.equal("0xffffffff");
            });
        });

        describe("P256 Session Execution via EntryPoint", function () {
            it("Should execute call with P256 session key", async function () {
                const { wallet, mockTarget, user1, entryPoint } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    ["0x55241077"] // setValue(uint256)
                );
                await wallet.connect(user1).createSessionP256(config);

                // Create call data
                const setValueCall = mockTarget.interface.encodeFunctionData("setValue", [12345]);
                const executeCall = wallet.interface.encodeFunctionData("execute", [
                    mockTarget.target,
                    0,
                    setValueCall
                ]);

                // Create user op
                const userOp = await createUserOp(wallet, executeCall);
                
                // Calculate userOpHash
                const network = await ethers.provider.getNetwork();
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
                            network.chainId
                        ]
                    )
                );

                // Sign with P256
                userOp.signature = signWithP256(p256Key, userOpHash);

                // Execute
                await expect(entryPoint.handleOps([userOp], user1.address))
                    .to.emit(mockTarget, "ValueSet")
                    .withArgs(12345);

                expect(await mockTarget.getValue()).to.equal(12345);
            });

            it("Should enforce P256 session target restrictions", async function () {
                const { wallet, mockTarget, user1, entryPoint, user2 } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                // Only allow calls to a different address (not mockTarget)
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [user2.address],
                    []
                );
                await wallet.connect(user1).createSessionP256(config);

                const setValueCall = mockTarget.interface.encodeFunctionData("setValue", [999]);
                const executeCall = wallet.interface.encodeFunctionData("execute", [
                    mockTarget.target, // Not in allowed targets
                    0,
                    setValueCall
                ]);

                const userOp = await createUserOp(wallet, executeCall);
                
                const network = await ethers.provider.getNetwork();
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
                            network.chainId
                        ]
                    )
                );

                userOp.signature = signWithP256(p256Key, userOpHash);

                // Should fail due to target restriction
                await expect(entryPoint.handleOps([userOp], user1.address))
                    .to.be.reverted;
            });

            it("Should enforce P256 session value limits", async function () {
                const { wallet, mockTarget, user1, entryPoint } = await loadFixture(deploySystemFixture);
                
                const p256Key = P256SigningKey.random();
                const config = await createP256SessionConfig(
                    p256Key.publicKey.qx,
                    p256Key.publicKey.qy,
                    [mockTarget.target],
                    [],
                    { maxValuePerTx: ethers.parseEther("0.1") }
                );
                await wallet.connect(user1).createSessionP256(config);

                // Try to send more than allowed
                const executeCall = wallet.interface.encodeFunctionData("execute", [
                    mockTarget.target,
                    ethers.parseEther("0.5"), // More than 0.1 limit
                    "0x"
                ]);

                const userOp = await createUserOp(wallet, executeCall);
                
                const network = await ethers.provider.getNetwork();
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
                            network.chainId
                        ]
                    )
                );

                userOp.signature = signWithP256(p256Key, userOpHash);

                await expect(entryPoint.handleOps([userOp], user1.address))
                    .to.be.reverted;
            });
        });

        describe("Multiple P256 Keys", function () {
            it("Should support multiple P256 session keys", async function () {
                const { wallet, mockTarget, user1 } = await loadFixture(deploySystemFixture);
                
                const p256Key1 = P256SigningKey.random();
                const p256Key2 = P256SigningKey.random();

                const config1 = await createP256SessionConfig(
                    p256Key1.publicKey.qx,
                    p256Key1.publicKey.qy,
                    [mockTarget.target],
                    []
                );
                const config2 = await createP256SessionConfig(
                    p256Key2.publicKey.qx,
                    p256Key2.publicKey.qy,
                    [mockTarget.target],
                    []
                );

                await wallet.connect(user1).createSessionP256(config1);
                await wallet.connect(user1).createSessionP256(config2);

                expect(await wallet.isValidSessionP256(p256Key1.publicKey.qx, p256Key1.publicKey.qy)).to.be.true;
                expect(await wallet.isValidSessionP256(p256Key2.publicKey.qx, p256Key2.publicKey.qy)).to.be.true;

                // Both should be able to sign
                const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
                
                const sig1 = signWithP256(p256Key1, hash);
                const sig2 = signWithP256(p256Key2, hash);
                
                expect(await wallet.isValidSignature(hash, sig1)).to.equal("0x1626ba7e");
                expect(await wallet.isValidSignature(hash, sig2)).to.equal("0x1626ba7e");
            });
        });
    });
});
