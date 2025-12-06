const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, deployYieldRouter } = require("./helpers/setup");

const ASSET_TYPE = {
    ERC4626: 0,
    AAVE_V3: 1,
    ONDO_OUSG: 2,
    SKY_SUSDS: 3
};

/**
 * USDL.sol Branch Coverage Tests
 * 
 * These tests target specific branches and modifiers in USDL.sol
 * to ensure high branch coverage.
 */
describe("USDL - Branch Coverage", function () {

    describe("Initialize - Zero Address Checks", function () {
        it("Should revert initialize with zero admin", async function () {
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            const [owner] = await ethers.getSigners();
            
            const USDL = await ethers.getContractFactory("USDL");
            await expect(
                upgrades.deployProxy(
                    USDL,
                    [ethers.ZeroAddress, await usdc.getAddress(), owner.address],
                    { initializer: 'initialize', unsafeAllow: ['constructor'] }
                )
            ).to.be.revertedWithCustomError(USDL, "ZeroAddress");
        });

        it("Should revert initialize with zero asset", async function () {
            const [owner] = await ethers.getSigners();
            
            const USDL = await ethers.getContractFactory("USDL");
            await expect(
                upgrades.deployProxy(
                    USDL,
                    [owner.address, ethers.ZeroAddress, owner.address],
                    { initializer: 'initialize', unsafeAllow: ['constructor'] }
                )
            ).to.be.revertedWithCustomError(USDL, "ZeroAddress");
        });

        it("Should revert initialize with zero treasury", async function () {
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            const [owner] = await ethers.getSigners();
            
            const USDL = await ethers.getContractFactory("USDL");
            await expect(
                upgrades.deployProxy(
                    USDL,
                    [owner.address, await usdc.getAddress(), ethers.ZeroAddress],
                    { initializer: 'initialize', unsafeAllow: ['constructor'] }
                )
            ).to.be.revertedWithCustomError(USDL, "ZeroAddress");
        });
    });

    describe("Modifier: nonZeroAddress", function () {
        it("Should revert grantBridgeRole with zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            await expect(
                usdl.connect(owner).grantBridgeRole(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert revokeBridgeRole with zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            await expect(
                usdl.connect(owner).revokeBridgeRole(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert setTreasury with zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            await expect(
                usdl.connect(owner).setTreasury(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert setYieldRouter with zero address", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            await expect(
                usdl.connect(owner).setYieldRouter(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });
    });

    describe("Modifier: routerConfigured", function () {
        it("Should revert deposit when router not set", async function () {
            const [owner, user1] = await ethers.getSigners();
            
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            
            const USDL = await ethers.getContractFactory("USDL");
            const usdl = await upgrades.deployProxy(
                USDL,
                [owner.address, await usdc.getAddress(), owner.address],
                { initializer: 'initialize', unsafeAllow: ['constructor'] }
            );
            
            await usdc.mint(user1.address, ethers.parseUnits("100", 6));
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "RouterNotSet");
        });

        it("Should revert mint when router not set", async function () {
            const [owner, user1] = await ethers.getSigners();
            
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            
            const USDL = await ethers.getContractFactory("USDL");
            const usdl = await upgrades.deployProxy(
                USDL,
                [owner.address, await usdc.getAddress(), owner.address],
                { initializer: 'initialize', unsafeAllow: ['constructor'] }
            );
            
            await usdc.mint(user1.address, ethers.parseUnits("100", 6));
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1)["mint(uint256,address)"](ethers.parseUnits("100", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "RouterNotSet");
        });
    });

    describe("Modifier: whenNotPaused", function () {
        it("Should revert deposit when paused", async function () {
            const { usdl, usdc, user1, pauser, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdl.connect(pauser).pause();
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "EnforcedPause");
        });

        it("Should revert withdraw when paused", async function () {
            const { usdl, usdc, user1, pauser, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await usdl.connect(pauser).pause();
            
            await expect(
                usdl.connect(user1).withdraw(ethers.parseUnits("50", 6), user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "EnforcedPause");
        });

        it("Should revert redeem when paused", async function () {
            const { usdl, usdc, user1, pauser, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await usdl.connect(pauser).pause();
            
            await expect(
                usdl.connect(user1).redeem(ethers.parseUnits("50", 6), user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "EnforcedPause");
        });

        it("Should revert transfer when paused", async function () {
            const { usdl, usdc, user1, user2, pauser, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await usdl.connect(pauser).pause();
            
            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("50", 6))
            ).to.be.revertedWithCustomError(usdl, "EnforcedPause");
        });
    });

    describe("Modifier: notBlacklisted", function () {
        it("Should revert deposit from blacklisted sender", async function () {
            const { usdl, usdc, user1, blacklister, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdl.connect(blacklister).blacklist(user1.address);
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted");
        });

        it("Should revert deposit to blacklisted receiver", async function () {
            const { usdl, usdc, user1, user2, blacklister, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdl.connect(blacklister).blacklist(user2.address);
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user2.address)
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted");
        });

        it("Should revert transfer to blacklisted address", async function () {
            const { usdl, usdc, user1, user2, blacklister, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await usdl.connect(blacklister).blacklist(user2.address);
            
            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("50", 6))
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted");
        });

        it("Should revert transfer from blacklisted sender", async function () {
            const { usdl, usdc, user1, user2, blacklister, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await usdl.connect(blacklister).blacklist(user1.address);
            
            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("50", 6))
            ).to.be.revertedWithCustomError(usdl, "AddressBlacklisted");
        });
    });

    describe("setYieldRouter - Replace Existing Router", function () {
        it("Should revoke old router role when setting new router", async function () {
            const { usdl, router, owner, usdc } = await loadFixture(usdlFixture);
            
            const oldRouterAddress = await router.getAddress();
            const ROUTER_ROLE = await usdl.ROUTER_ROLE();
            
            expect(await usdl.hasRole(ROUTER_ROLE, oldRouterAddress)).to.be.true;
            
            const newRouter = await deployYieldRouter(
                owner.address, 
                await usdc.getAddress(), 
                await usdl.getAddress()
            );
            
            await usdl.setYieldRouter(await newRouter.getAddress());
            
            expect(await usdl.hasRole(ROUTER_ROLE, oldRouterAddress)).to.be.false;
            expect(await usdl.hasRole(ROUTER_ROLE, await newRouter.getAddress())).to.be.true;
        });
    });

    describe("deposit/mint - Edge Cases", function () {
        it("Should revert deposit below minimum", async function () {
            const { usdl, usdc, user1, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("1", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("0.5", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "BelowMinimumDeposit");
        });

        it("Should revert mint below minimum", async function () {
            const { usdl, usdc, user1, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("1", 6));
            
            await expect(
                usdl.connect(user1)["mint(uint256,address)"](ethers.parseUnits("0.5", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "BelowMinimumDeposit");
        });
    });

    describe("withdraw/redeem - Edge Cases", function () {
        async function setupWithDeposit() {
            const fixture = await usdlFixture();
            const { usdl, router, manager, yieldVault, usdc, user1 } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            await mine(5);
            
            return fixture;
        }

        it("Should revert withdraw if amount exceeds totalDepositedAssets", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);
            
            await expect(
                usdl.connect(user1).withdraw(ethers.parseUnits("1000", 6), user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "InsufficientLiquidity");
        });

        it("Should revert withdraw with zero amount", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);
            
            await expect(
                usdl.connect(user1).withdraw(0, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert redeem with zero amount", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);
            
            await expect(
                usdl.connect(user1).redeem(0, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });

        it("Should revert withdraw to zero address", async function () {
            const { usdl, user1 } = await loadFixture(setupWithDeposit);
            
            await expect(
                usdl.connect(user1).withdraw(ethers.parseUnits("50", 6), ethers.ZeroAddress, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });
    });

    describe("Internal Functions - Edge Cases", function () {
        it("Should revert _burnSharesCCIP when burning more than balance", async function () {
            const { usdl, bridge, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(bridge)["mint(address,uint256)"](user1.address, ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(bridge)["burn(address,uint256)"](user1.address, ethers.parseUnits("200", 6))
            ).to.be.revertedWithCustomError(usdl, "ERC20InsufficientBalance");
        });

        it("Should revert transfer with insufficient balance", async function () {
            const { usdl, usdc, user1, user2, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("10", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("10", 6), user1.address);
            
            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(usdl, "ERC20InsufficientBalance");
        });

        it("Should revert transferFrom with insufficient allowance", async function () {
            const { usdl, usdc, user1, user2, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("10", 6));
            
            await expect(
                usdl.connect(user2).transferFrom(user1.address, user2.address, ethers.parseUnits("50", 6))
            ).to.be.revertedWithCustomError(usdl, "ERC20InsufficientAllowance");
        });
    });

    describe("_authorizeUpgrade", function () {
        it("Should revert upgrade to zero address", async function () {
            const { usdl, upgrader } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(upgrader).upgradeToAndCall(ethers.ZeroAddress, "0x")
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should allow upgrade to valid implementation", async function () {
            const { usdl, upgrader } = await loadFixture(usdlFixture);
            
            const USDLV2 = await ethers.getContractFactory("USDL");
            const newImpl = await USDLV2.deploy();
            await newImpl.waitForDeployment();
            
            await expect(
                usdl.connect(upgrader).upgradeToAndCall(await newImpl.getAddress(), "0x")
            ).to.emit(usdl, "Upgrade");
        });
    });

    describe("Access Control", function () {
        it("Should revert pause when caller not PAUSER", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).pause()
            ).to.be.reverted;
        });

        it("Should revert unpause when caller not PAUSER", async function () {
            const { usdl, pauser, user1 } = await loadFixture(usdlFixture);
            
            await usdl.connect(pauser).pause();
            
            await expect(
                usdl.connect(user1).unpause()
            ).to.be.reverted;
        });

        it("Should revert blacklist when caller not BLACKLISTER", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).blacklist(user2.address)
            ).to.be.reverted;
        });

        it("Should revert unblacklist when caller not BLACKLISTER", async function () {
            const { usdl, blacklister, user1, user2 } = await loadFixture(usdlFixture);
            
            await usdl.connect(blacklister).blacklist(user2.address);
            
            await expect(
                usdl.connect(user1).unblacklist(user2.address)
            ).to.be.reverted;
        });

        it("Should revert grantBridgeRole when caller not admin", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).grantBridgeRole(user2.address)
            ).to.be.reverted;
        });

        it("Should revert setTreasury when caller not admin", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).setTreasury(user2.address)
            ).to.be.reverted;
        });

        it("Should revert setRedemptionFee when caller not admin", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).setRedemptionFee(100)
            ).to.be.reverted;
        });

        it("Should revert updateRebaseIndex when caller not ROUTER", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).updateRebaseIndex(ethers.parseUnits("1.1", 6))
            ).to.be.reverted;
        });

        it("Should revert updateTotalDepositedAssets when caller not ROUTER", async function () {
            const { usdl, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1).updateTotalDepositedAssets(ethers.parseUnits("1000", 6))
            ).to.be.reverted;
        });
    });

    describe("CCIP Bridge Functions", function () {
        it("Should revert bridge mint when caller not BRIDGE", async function () {
            const { usdl, user1, user2 } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(user1)["mint(address,uint256)"](user2.address, ethers.parseUnits("100", 6))
            ).to.be.reverted;
        });

        it("Should revert bridge burn when caller not BRIDGE", async function () {
            const { usdl, bridge, user1, user2 } = await loadFixture(usdlFixture);
            
            await usdl.connect(bridge)["mint(address,uint256)"](user2.address, ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1)["burn(address,uint256)"](user2.address, ethers.parseUnits("50", 6))
            ).to.be.reverted;
        });

        it("Should revert bridge mint to zero address", async function () {
            const { usdl, bridge } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(bridge)["mint(address,uint256)"](ethers.ZeroAddress, ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });
    });

    describe("Fee Validation", function () {
        it("Should revert setRedemptionFee above MAX_FEE_BPS", async function () {
            const { usdl, owner } = await loadFixture(usdlFixture);
            
            await expect(
                usdl.connect(owner).setRedemptionFee(501) // Above MAX_FEE_BPS (500)
            ).to.be.revertedWithCustomError(usdl, "InvalidFee");
        });
    });

    describe("Redeem Edge Cases - Assets Exceeds TotalDeposited", function () {
        it("Should cap assets to totalDepositedAssets when redeeming", async function () {
            const { usdl, usdc, user1, user2, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // First user deposits
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("1000", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address);
            await mine(5);
            
            // Simulate yield by increasing vault share value
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.5", 6)); // 50% yield
            
            // Accrue yield to update rebase index 
            await router.connect(manager).accrueYield();
            
            // User shares are worth more now due to rebase
            const userBalance = await usdl.balanceOf(user1.address);
            
            // Redeem all - this should hit the cap logic if assets > deposited
            // The rebase makes shares worth more, but totalDepositedAssets is still 1000
            await usdl.connect(user1).redeem(await usdl.balanceOf(user1.address), user1.address, user1.address);
            
            // Verify redemption worked (user got USDC back)
            expect(await usdc.balanceOf(user1.address)).to.be.gt(0);
        });
    });
});
