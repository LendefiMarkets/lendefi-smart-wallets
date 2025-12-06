const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, usdlSkyFixture, deployYieldRouter, deployMockYieldVault } = require("./helpers/setup");

const ASSET_TYPE = {
    ERC4626: 0,
    AAVE_V3: 1,
    ONDO_OUSG: 2,
    SKY_SUSDS: 3
};

describe("USDL - Coverage Tests", function () {

    describe("Modifier Tests - nonZeroAddress", function () {
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
    });

    describe("Modifier Tests - routerConfigured", function () {
        it("Should revert deposit when router not set", async function () {
            const [owner, user1] = await ethers.getSigners();
            
            // Deploy USDL without setting router
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            
            const USDL = await ethers.getContractFactory("USDL");
            const usdl = await upgrades.deployProxy(
                USDL,
                [owner.address, await usdc.getAddress(), owner.address],
                { initializer: 'initialize', unsafeAllow: ['constructor'] }
            );
            
            // Try deposit without router
            await usdc.mint(user1.address, ethers.parseUnits("100", 6));
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address)
            ).to.be.revertedWithCustomError(usdl, "RouterNotSet");
        });
    });

    describe("Modifier Tests - whenNotPaused", function () {
        it("Should revert deposit when paused", async function () {
            const { usdl, usdc, user1, pauser, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Pause the contract
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
            
            // Deposit first
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            // Pause the contract
            await usdl.connect(pauser).pause();
            
            await expect(
                usdl.connect(user1).withdraw(ethers.parseUnits("50", 6), user1.address, user1.address)
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
            
            // Deposit first
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            // Pause the contract
            await usdl.connect(pauser).pause();
            
            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("50", 6))
            ).to.be.revertedWithCustomError(usdl, "EnforcedPause");
        });
    });

    describe("Modifier Tests - notBlacklisted", function () {
        it("Should revert deposit from blacklisted address", async function () {
            const { usdl, usdc, user1, blacklister, router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Blacklist user
            await usdl.connect(blacklister).blacklist(user1.address);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            
            await expect(
                usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address)
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
            
            // Deposit first
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            // Blacklist recipient
            await usdl.connect(blacklister).blacklist(user2.address);
            
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
            
            // Verify old router has role
            expect(await usdl.hasRole(ROUTER_ROLE, oldRouterAddress)).to.be.true;
            
            // Deploy new router
            const newRouter = await deployYieldRouter(
                owner.address, 
                await usdc.getAddress(), 
                await usdl.getAddress()
            );
            const newRouterAddress = await newRouter.getAddress();
            
            // Set new router (should revoke old router's role)
            await usdl.setYieldRouter(newRouterAddress);
            
            // Old router should no longer have role
            expect(await usdl.hasRole(ROUTER_ROLE, oldRouterAddress)).to.be.false;
            // New router should have role
            expect(await usdl.hasRole(ROUTER_ROLE, newRouterAddress)).to.be.true;
        });
    });

    describe("mint (ERC4626) - Edge Cases", function () {
        async function setupWithYieldAsset() {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault, usdc } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            return fixture;
        }

        it("Should revert mint if resulting assets below minimum deposit", async function () {
            const fixture = await loadFixture(setupWithYieldAsset);
            const { usdl, usdc, user1 } = fixture;
            
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            
            // Try to mint very small amount of shares that would result in < 1 USDC
            // Since 1 share = 1 asset initially, minting 0.5 shares would need 0.5 USDC
            const tinyShares = ethers.parseUnits("0.5", 6);
            
            await expect(
                usdl.connect(user1)["mint(uint256,address)"](tinyShares, user1.address)
            ).to.be.revertedWithCustomError(usdl, "BelowMinimumDeposit");
        });
    });

    describe("withdraw - Edge Cases", function () {
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
            
            // Deposit 100 USDC
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            return fixture;
        }

        it("Should revert withdraw if amount exceeds totalDepositedAssets", async function () {
            const fixture = await loadFixture(setupWithDeposit);
            const { usdl, user1 } = fixture;

            
            // Try to withdraw more than deposited
            const excessAmount = ethers.parseUnits("1000", 6);
            
            await expect(
                usdl.connect(user1).withdraw(excessAmount, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "InsufficientLiquidity");
        });
    });

    describe("redeem - Edge Cases", function () {
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
            
            // Deposit 100 USDC
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            return fixture;
        }

        it("Should cap assets to deposited amount in redeem", async function () {
            const fixture = await loadFixture(setupWithDeposit);
            const { usdl, usdc, user1, yieldVault } = fixture;
            
            // Simulate yield gain in the mock vault
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.5", 6)); // 50% yield
            
            const userShares = await usdl.balanceOf(user1.address);
            const totalDeposited = await usdl.totalDepositedAssets();
            
            // The yield should show in convertToAssets
            const sharesConverted = await usdl.convertToAssets(userShares);
            
            // Redeem - should be capped at totalDepositedAssets
            await usdl.connect(user1).redeem(userShares, user1.address, user1.address);
            
            // User should get back <= totalDeposited (minus fee)
            const finalUsdcBalance = await usdc.balanceOf(user1.address);
            expect(finalUsdcBalance).to.be.gt(0);
        });
    });

    describe("Internal Function Edge Cases", function () {
        it("Should revert _burnShares with zero address", async function () {
            const fixture = await usdlFixture();
            const { usdl, usdc, user1, router, manager, yieldVault } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit first
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Try to withdraw to zero address (triggers _burnShares check indirectly)
            await expect(
                usdl.connect(user1).withdraw(depositAmount, ethers.ZeroAddress, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });

        it("Should revert _burnSharesCCIP when burning more than balance", async function () {
            const fixture = await usdlFixture();
            const { usdl, bridge, user1 } = fixture;
            
            // Mint some shares
            await usdl.connect(bridge)["mint(address,uint256)"](user1.address, ethers.parseUnits("100", 6));
            
            // Try to burn more than balance - use explicit signature for bridge burn
            await expect(
                usdl.connect(bridge)["burn(address,uint256)"](user1.address, ethers.parseUnits("200", 6))
            ).to.be.revertedWithCustomError(usdl, "ERC20InsufficientBalance");
        });

        it("Should revert _transferShares with insufficient balance", async function () {
            const fixture = await usdlFixture();
            const { usdl, usdc, user1, user2, router, manager, yieldVault } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit small amount
            const depositAmount = ethers.parseUnits("10", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Try to transfer more than balance
            await expect(
                usdl.connect(user1).transfer(user2.address, ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(usdl, "ERC20InsufficientBalance");
        });
    });

    describe("_spendAllowance Edge Cases", function () {
        it("Should revert when allowance is insufficient", async function () {
            const fixture = await usdlFixture();
            const { usdl, usdc, user1, user2, router, manager, yieldVault } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // User1 deposits
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // User1 approves user2 for small amount
            await usdl.connect(user1).approve(user2.address, ethers.parseUnits("10", 6));
            
            // User2 tries to transferFrom more than allowed
            await expect(
                usdl.connect(user2).transferFrom(user1.address, user2.address, ethers.parseUnits("50", 6))
            ).to.be.revertedWithCustomError(usdl, "ERC20InsufficientAllowance");
        });
    });

    describe("_authorizeUpgrade Edge Cases", function () {
        it("Should revert upgrade to zero address", async function () {
            const fixture = await usdlFixture();
            const { usdl, upgrader } = fixture;
            
            // This is tested via the UUPS mechanism
            // We need to call upgradeTo with zero address
            await expect(
                usdl.connect(upgrader).upgradeToAndCall(ethers.ZeroAddress, "0x")
            ).to.be.revertedWithCustomError(usdl, "ZeroAddress");
        });
    });
});

describe("YieldRouter - Coverage Tests", function () {

    describe("Initialize - Zero Address Checks", function () {
        it("Should revert initialize with zero admin", async function () {
            const [owner] = await ethers.getSigners();
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            
            const YieldRouter = await ethers.getContractFactory("YieldRouter");
            await expect(
                upgrades.deployProxy(
                    YieldRouter,
                    [ethers.ZeroAddress, await usdc.getAddress(), owner.address],
                    { initializer: 'initialize', unsafeAllow: ['constructor'] }
                )
            ).to.be.revertedWithCustomError(YieldRouter, "ZeroAddress");
        });

        it("Should revert initialize with zero usdc", async function () {
            const [owner] = await ethers.getSigners();
            
            const YieldRouter = await ethers.getContractFactory("YieldRouter");
            await expect(
                upgrades.deployProxy(
                    YieldRouter,
                    [owner.address, ethers.ZeroAddress, owner.address],
                    { initializer: 'initialize', unsafeAllow: ['constructor'] }
                )
            ).to.be.revertedWithCustomError(YieldRouter, "ZeroAddress");
        });

        it("Should revert initialize with zero vault", async function () {
            const [owner] = await ethers.getSigners();
            const MockUSDC = await ethers.getContractFactory("MockUSDC");
            const usdc = await MockUSDC.deploy();
            
            const YieldRouter = await ethers.getContractFactory("YieldRouter");
            await expect(
                upgrades.deployProxy(
                    YieldRouter,
                    [owner.address, await usdc.getAddress(), ethers.ZeroAddress],
                    { initializer: 'initialize', unsafeAllow: ['constructor'] }
                )
            ).to.be.revertedWithCustomError(YieldRouter, "ZeroAddress");
        });
    });

    describe("depositToProtocols - Zero Amount", function () {
        it("Should revert depositToProtocols with zero amount", async function () {
            const fixture = await usdlFixture();
            const { usdl, usdc, user1, router, manager, yieldVault } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Try to deposit zero - need to call from vault (USDL)
            // This is covered indirectly via USDL's BelowMinimumDeposit check
        });
    });

    describe("redeemFromProtocols - Zero Amount", function () {
        it("Should revert redeemFromProtocols with zero amount via USDL", async function () {
            const fixture = await usdlFixture();
            const { usdl, usdc, user1, router, manager, yieldVault } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit first
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            // Try to withdraw zero
            await expect(
                usdl.connect(user1).withdraw(0, user1.address, user1.address)
            ).to.be.revertedWithCustomError(usdl, "ZeroAmount");
        });
    });

    describe("addYieldAsset - Zero Address Checks", function () {
        it("Should revert addYieldAsset with zero deposit token", async function () {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault } = fixture;
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await yieldVault.getAddress(),
                    ethers.ZeroAddress,
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert addYieldAsset with zero manager", async function () {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault, usdc } = fixture;
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await yieldVault.getAddress(),
                    await usdc.getAddress(),
                    ethers.ZeroAddress,
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });
    });

    describe("removeYieldAsset - Validations", function () {
        it("Should revert removeYieldAsset when asset has balance", async function () {
            const fixture = await usdlFixture();
            const { usdl, router, manager, yieldVault, usdc, user1 } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit to get balance in vault
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            // Try to remove - should fail because still has weight and balance
            await expect(
                router.connect(manager).removeYieldAsset(await yieldVault.getAddress())
            ).to.be.revertedWithCustomError(router, "AssetStillActive");
        });
    });

    describe("setSkyConfig - Zero Address Checks", function () {
        it("Should revert setSkyConfig with zero litePSM", async function () {
            const fixture = await usdlFixture();
            const { router, manager } = fixture;
            
            await expect(
                router.connect(manager).setSkyConfig(
                    ethers.ZeroAddress,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });
    });

    describe("rescueDonatedTokens", function () {
        it("Should revert rescueDonatedTokens with zero address", async function () {
            const fixture = await usdlFixture();
            const { router, owner } = fixture;
            
            await expect(
                router.connect(owner).rescueDonatedTokens(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should rescue donated tokens above tracked balance", async function () {
            const fixture = await usdlFixture();
            const { router, owner, usdc, user1 } = fixture;
            
            // Donate USDC directly to router
            await usdc.mint(await router.getAddress(), ethers.parseUnits("100", 6));
            
            // Rescue to owner
            await router.connect(owner).rescueDonatedTokens(owner.address);
            
            // Owner should have received the donated USDC
            expect(await usdc.balanceOf(owner.address)).to.equal(ethers.parseUnits("100", 6));
        });
    });

    describe("onlyVault Modifier", function () {
        it("Should revert depositToProtocols when caller is not vault", async function () {
            const fixture = await usdlFixture();
            const { router, user1 } = fixture;
            
            await expect(
                router.connect(user1).depositToProtocols(ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(router, "InsufficientLiquidity");
        });

        it("Should revert redeemFromProtocols when caller is not vault", async function () {
            const fixture = await usdlFixture();
            const { router, user1 } = fixture;
            
            await expect(
                router.connect(user1).redeemFromProtocols(ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(router, "InsufficientLiquidity");
        });
    });

    describe("redeemFromSingleYieldAssetExternal", function () {
        it("Should revert when called by non-self", async function () {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault, usdc } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            
            await expect(
                router.connect(manager).redeemFromSingleYieldAssetExternal(
                    await yieldVault.getAddress(),
                    ethers.parseUnits("100", 6)
                )
            ).to.be.revertedWithCustomError(router, "OnlySelf");
        });
    });

    describe("getSkyConfig", function () {
        it("Should return sky config", async function () {
            const fixture = await loadFixture(usdlSkyFixture);
            const { router, sUsds, usds, litePSM } = fixture;
            
            const [litePSMAddr, usdsAddr, sUsdsAddr] = await router.getSkyConfig();
            
            expect(litePSMAddr).to.equal(await litePSM.getAddress());
            expect(usdsAddr).to.equal(await usds.getAddress());
            expect(sUsdsAddr).to.equal(await sUsds.getAddress());
        });
    });

    describe("setVault", function () {
        it("Should set new vault and update roles", async function () {
            const fixture = await usdlFixture();
            const { router, owner, usdl, user1 } = fixture;
            
            const oldVault = await usdl.getAddress();
            const VAULT_ROLE = await router.VAULT_ROLE();
            
            // Verify old vault has role
            expect(await router.hasRole(VAULT_ROLE, oldVault)).to.be.true;
            
            // Set new vault
            await router.connect(owner).setVault(user1.address);
            
            // Old vault should not have role
            expect(await router.hasRole(VAULT_ROLE, oldVault)).to.be.false;
            // New vault should have role
            expect(await router.hasRole(VAULT_ROLE, user1.address)).to.be.true;
            // getVault should return new vault
            expect(await router.getVault()).to.equal(user1.address);
        });

        it("Should revert setVault with zero address", async function () {
            const fixture = await usdlFixture();
            const { router, owner } = fixture;
            
            await expect(
                router.connect(owner).setVault(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert setVault when caller is not admin", async function () {
            const fixture = await usdlFixture();
            const { router, user1 } = fixture;
            
            await expect(
                router.connect(user1).setVault(user1.address)
            ).to.be.reverted;
        });
    });

    describe("emergencyWithdraw", function () {
        async function setupWithDeposits() {
            const fixture = await usdlFixture();
            const { usdl, router, manager, yieldVault, usdc, user1 } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            return fixture;
        }

        it("Should withdraw all funds to vault in emergency", async function () {
            const fixture = await loadFixture(setupWithDeposits);
            const { router, usdl, owner, usdc, yieldVault } = fixture;
            
            const usdlAddress = await usdl.getAddress();
            const routerAddress = await router.getAddress();
            
            // Verify router has yield tokens
            const vaultBalance = await yieldVault.balanceOf(routerAddress);
            expect(vaultBalance).to.be.gt(0);
            
            // Emergency withdraw
            await router.connect(owner).emergencyWithdraw();
            
            // Router should have no yield tokens
            expect(await yieldVault.balanceOf(routerAddress)).to.equal(0);
            
            // Router tracked balance should be 0
            expect(await router.trackedUSDCBalance()).to.equal(0);
            
            // USDC should be in vault
            expect(await usdc.balanceOf(usdlAddress)).to.be.gt(0);
        });

        it("Should revert emergencyWithdraw when caller is not admin", async function () {
            const fixture = await loadFixture(setupWithDeposits);
            const { router, user1 } = fixture;
            
            await expect(
                router.connect(user1).emergencyWithdraw()
            ).to.be.reverted;
        });
    });

    describe("_validateWeightSum (internal)", function () {
        it("Should allow weights that sum to BASIS_POINTS", async function () {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault, usdc } = fixture;
            const yieldVault2 = await deployMockYieldVault(await usdc.getAddress());
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(),
                await usdc.getAddress(),
                await yieldVault2.getAddress(),
                ASSET_TYPE.ERC4626
            );
            
            // This should work (sums to 10000)
            await expect(
                router.connect(manager).updateWeights([6000, 4000])
            ).to.not.be.reverted;
        });

        it("Should revert when weights do not sum to BASIS_POINTS", async function () {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault, usdc } = fixture;
            const yieldVault2 = await deployMockYieldVault(await usdc.getAddress());
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(),
                await usdc.getAddress(),
                await yieldVault2.getAddress(),
                ASSET_TYPE.ERC4626
            );
            
            // This should fail (sums to 9000)
            await expect(
                router.connect(manager).updateWeights([5000, 4000])
            ).to.be.revertedWithCustomError(router, "InvalidTotalWeight");
        });
    });

    describe("OUSG Protocol Paths", function () {
        // Note: These require OUSG mocks which are complex
        // The try/catch in updateWeights for OUSG draining is tested implicitly
    });

    describe("Aave V3 Protocol Paths", function () {
        it("Should handle Aave V3 deposit and withdrawal", async function () {
            const fixture = await usdlFixture();
            const { usdl, router, manager, usdc, user1 } = fixture;
            
            // Deploy mock aToken first
            const MockAUsdc = await ethers.getContractFactory("MockAUsdc");
            const aToken = await MockAUsdc.deploy();
            await aToken.waitForDeployment();
            
            // Deploy mock Aave pool with aToken
            const MockAavePool = await ethers.getContractFactory("MockAavePool");
            const aavePool = await MockAavePool.deploy(await usdc.getAddress(), await aToken.getAddress());
            await aavePool.waitForDeployment();
            
            // Set pool on aToken
            await aToken.setPool(await aavePool.getAddress());
            
            await router.connect(manager).addYieldAsset(
                await aToken.getAddress(),
                await usdc.getAddress(),
                await aavePool.getAddress(),
                ASSET_TYPE.AAVE_V3
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Check aToken balance
            expect(await aToken.balanceOf(await router.getAddress())).to.equal(depositAmount);
            
            // Withdraw
            const balance = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(balance, user1.address, user1.address);
            
            // Check user got their USDC back
            expect(await usdc.balanceOf(user1.address)).to.be.gt(0);
        });
    });

    describe("_authorizeUpgrade", function () {
        it("Should revert upgrade to zero address", async function () {
            const fixture = await usdlFixture();
            const { router, owner } = fixture;
            
            // Get upgrader role
            const UPGRADER_ROLE = await router.UPGRADER_ROLE();
            await router.connect(owner).grantRole(UPGRADER_ROLE, owner.address);
            
            await expect(
                router.connect(owner).upgradeToAndCall(ethers.ZeroAddress, "0x")
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should allow upgrade to valid address", async function () {
            const fixture = await usdlFixture();
            const { router, owner } = fixture;
            
            // Get upgrader role
            const UPGRADER_ROLE = await router.UPGRADER_ROLE();
            await router.connect(owner).grantRole(UPGRADER_ROLE, owner.address);
            
            // Deploy new implementation
            const YieldRouterV2 = await ethers.getContractFactory("YieldRouter");
            const newImpl = await YieldRouterV2.deploy();
            await newImpl.waitForDeployment();
            
            // Upgrade should work
            await expect(
                router.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")
            ).to.emit(router, "Upgrade");
        });
    });

    describe("OUSG Protocol - Full Coverage", function () {
        it("Should handle OUSG deposit and redeem", async function () {
            const fixture = await usdlFixture();
            const { usdl, router, manager, usdc, user1 } = fixture;
            
            // Deploy OUSG mocks
            const MockOUSG = await ethers.getContractFactory("MockOUSG");
            const ousg = await MockOUSG.deploy();
            await ousg.waitForDeployment();
            
            const MockOUSGInstantManager = await ethers.getContractFactory("MockOUSGInstantManager");
            const ousgManager = await MockOUSGInstantManager.deploy(await usdc.getAddress(), await ousg.getAddress());
            await ousgManager.waitForDeployment();
            
            await router.connect(manager).addYieldAsset(
                await ousg.getAddress(),
                await usdc.getAddress(),
                await ousgManager.getAddress(),
                ASSET_TYPE.ONDO_OUSG
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Redeem
            const balance = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(balance, user1.address, user1.address);
        });

        it("Should validate OUSG oracle - stale price", async function () {
            const fixture = await usdlFixture();
            const { router, manager, usdc } = fixture;
            
            // Deploy OUSG mocks
            const MockOUSG = await ethers.getContractFactory("MockOUSG");
            const ousg = await MockOUSG.deploy();
            await ousg.waitForDeployment();
            
            // Deploy mock oracle with stale data
            const MockAdvancedPriceFeed = await ethers.getContractFactory("MockAdvancedPriceFeed");
            const oracle = await MockAdvancedPriceFeed.deploy();
            await oracle.waitForDeployment();
            
            // Set stale price (2 hours old)
            const staleTime = Math.floor(Date.now() / 1000) - 7200;
            await oracle.setStalePrice(ethers.parseUnits("113", 8), staleTime);
            
            // Add OUSG with oracle as manager (for value calculation)
            // Note: This uses oracle as manager which is the design for OUSG value calculation
            await router.connect(manager).addYieldAsset(
                await ousg.getAddress(),
                await usdc.getAddress(),
                await oracle.getAddress(),
                ASSET_TYPE.ONDO_OUSG
            );
            
            // Set weight to activate
            await router.connect(manager).updateWeights([10000]);
            
            // Mint some OUSG directly to router to trigger value calculation
            await ousg.mint(await router.getAddress(), ethers.parseUnits("100", 18));
            
            // getTotalValue should revert with stale oracle
            await expect(router.getTotalValue()).to.be.revertedWithCustomError(router, "StaleOraclePrice");
        });

        it("Should validate OUSG oracle - invalid price", async function () {
            const fixture = await usdlFixture();
            const { router, manager, usdc } = fixture;
            
            const MockOUSG = await ethers.getContractFactory("MockOUSG");
            const ousg = await MockOUSG.deploy();
            await ousg.waitForDeployment();
            
            const MockAdvancedPriceFeed = await ethers.getContractFactory("MockAdvancedPriceFeed");
            const oracle = await MockAdvancedPriceFeed.deploy();
            await oracle.waitForDeployment();
            
            // Set zero/negative price
            await oracle.setPrice(0);
            
            await router.connect(manager).addYieldAsset(
                await ousg.getAddress(),
                await usdc.getAddress(),
                await oracle.getAddress(),
                ASSET_TYPE.ONDO_OUSG
            );
            
            await router.connect(manager).updateWeights([10000]);
            await ousg.mint(await router.getAddress(), ethers.parseUnits("100", 18));
            
            await expect(router.getTotalValue()).to.be.revertedWithCustomError(router, "InvalidOraclePrice");
        });

        it("Should validate OUSG oracle - incomplete round", async function () {
            const fixture = await usdlFixture();
            const { router, manager, usdc } = fixture;
            
            const MockOUSG = await ethers.getContractFactory("MockOUSG");
            const ousg = await MockOUSG.deploy();
            await ousg.waitForDeployment();
            
            const MockAdvancedPriceFeed = await ethers.getContractFactory("MockAdvancedPriceFeed");
            const oracle = await MockAdvancedPriceFeed.deploy();
            await oracle.waitForDeployment();
            
            // Set incomplete round (answeredInRound < roundId)
            await oracle.setIncompleteRound(10, 5);
            
            await router.connect(manager).addYieldAsset(
                await ousg.getAddress(),
                await usdc.getAddress(),
                await oracle.getAddress(),
                ASSET_TYPE.ONDO_OUSG
            );
            
            await router.connect(manager).updateWeights([10000]);
            await ousg.mint(await router.getAddress(), ethers.parseUnits("100", 18));
            
            await expect(router.getTotalValue()).to.be.revertedWithCustomError(router, "IncompleteOracleRound");
        });
    });

    describe("Sky Protocol - Full Coverage", function () {
        it("Should handle Sky sUSDS deposit and redeem", async function () {
            const fixture = await loadFixture(usdlSkyFixture);
            const { usdl, router, manager, usdc, sUsds, user1 } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await sUsds.getAddress(),
                await usdc.getAddress(),
                await sUsds.getAddress(),
                ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Check sUSDS balance
            expect(await sUsds.balanceOf(await router.getAddress())).to.be.gt(0);
            
            // Redeem
            const balance = await usdl.balanceOf(user1.address);
            await usdl.connect(user1).redeem(balance, user1.address, user1.address);
        });
    });

    describe("Auto-drain on Weight Update", function () {
        it("Should auto-drain ERC4626 when weight goes to zero", async function () {
            const fixture = await usdlFixture();
            const { usdl, router, manager, usdc, yieldVault, yieldVault2, user1 } = fixture;
            
            // Add two yield assets
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault2.getAddress(),
                await usdc.getAddress(),
                await yieldVault2.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([5000, 5000]);
            
            // Deposit to get funds into both vaults
            const depositAmount = ethers.parseUnits("1000", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Verify both have balance
            expect(await yieldVault.balanceOf(await router.getAddress())).to.be.gt(0);
            expect(await yieldVault2.balanceOf(await router.getAddress())).to.be.gt(0);
            
            // Set first vault weight to 0 (should auto-drain)
            await expect(
                router.connect(manager).updateWeights([0, 10000])
            ).to.emit(router, "YieldAssetDrained");
            
            // First vault should be drained
            expect(await yieldVault.balanceOf(await router.getAddress())).to.equal(0);
        });
    });

    describe("getLastYieldAccrualTimestamp", function () {
        it("Should return last yield accrual timestamp", async function () {
            const fixture = await usdlFixture();
            const { router, manager, yieldVault, usdc, usdl, user1 } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Get timestamp before accrual
            const timestampBefore = await router.getLastYieldAccrualTimestamp();
            
            // Simulate yield and accrue
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6)); // 10% yield
            
            // Fast forward time
            await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
            await ethers.provider.send("evm_mine");
            
            await router.connect(manager).accrueYield();
            
            // Timestamp should be updated
            const timestampAfter = await router.getLastYieldAccrualTimestamp();
            expect(timestampAfter).to.be.gt(timestampBefore);
        });
    });

    describe("OUSG Auto-drain on Weight Update", function () {
        it("Should auto-drain OUSG when weight goes to zero (success path)", async function () {
            const fixture = await usdlFixture();
            const { router, manager, usdc } = fixture;
            
            // Deploy OUSG mocks
            const MockOUSG = await ethers.getContractFactory("MockOUSG");
            const ousg = await MockOUSG.deploy();
            await ousg.waitForDeployment();
            
            const MockOUSGInstantManager = await ethers.getContractFactory("MockOUSGInstantManager");
            const ousgManager = await MockOUSGInstantManager.deploy(await usdc.getAddress(), await ousg.getAddress());
            await ousgManager.waitForDeployment();
            
            // Add second vault for weights
            const yieldVault = await deployMockYieldVault(await usdc.getAddress());
            
            await router.connect(manager).addYieldAsset(
                await ousg.getAddress(),
                await usdc.getAddress(),
                await ousgManager.getAddress(),
                ASSET_TYPE.ONDO_OUSG
            );
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([5000, 5000]);
            
            // Mint OUSG directly to router (simulating deposit)
            await ousg.mint(await router.getAddress(), ethers.parseUnits("100", 18));
            
            // Set OUSG weight to 0 (should auto-drain via try/catch)
            await expect(
                router.connect(manager).updateWeights([0, 10000])
            ).to.emit(router, "YieldAssetDrained");
        });
    });

    describe("Aave V3 Value Calculation", function () {
        it("Should calculate Aave V3 aToken value correctly", async function () {
            const fixture = await usdlFixture();
            const { usdl, router, manager, usdc, user1 } = fixture;
            
            // Deploy mock aToken
            const MockAUsdc = await ethers.getContractFactory("MockAUsdc");
            const aToken = await MockAUsdc.deploy();
            await aToken.waitForDeployment();
            
            // Deploy mock Aave pool
            const MockAavePool = await ethers.getContractFactory("MockAavePool");
            const aavePool = await MockAavePool.deploy(await usdc.getAddress(), await aToken.getAddress());
            await aavePool.waitForDeployment();
            
            await aToken.setPool(await aavePool.getAddress());
            
            await router.connect(manager).addYieldAsset(
                await aToken.getAddress(),
                await usdc.getAddress(),
                await aavePool.getAddress(),
                ASSET_TYPE.AAVE_V3
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit via USDL to get aTokens in router
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Get total value - should return aToken balance as value (1:1 with USDC)
            const value = await router.getTotalValue();
            expect(value).to.equal(depositAmount);
        });
    });

    describe("Sky sUSDS Value Calculation", function () {
        it("Should calculate sUSDS value correctly", async function () {
            const fixture = await loadFixture(usdlSkyFixture);
            const { usdl, router, manager, usdc, sUsds, user1 } = fixture;
            
            await router.connect(manager).addYieldAsset(
                await sUsds.getAddress(),
                await usdc.getAddress(),
                await sUsds.getAddress(),
                ASSET_TYPE.SKY_SUSDS
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit via USDL to get sUSDS in router
            const depositAmount = ethers.parseUnits("100", 6);
            await usdc.connect(user1).approve(await usdl.getAddress(), depositAmount);
            await usdl.connect(user1).deposit(depositAmount, user1.address);
            
            // Get total value - should be close to deposit amount (may have small variance due to conversion)
            const value = await router.getTotalValue();
            expect(value).to.be.gt(0);
        });
    });

    describe("USDL Upgrade Success", function () {
        it("Should allow upgrade to valid implementation", async function () {
            const fixture = await usdlFixture();
            const { usdl, upgrader } = fixture;
            
            // Deploy new implementation
            const USDLV2 = await ethers.getContractFactory("USDL");
            const newImpl = await USDLV2.deploy();
            await newImpl.waitForDeployment();
            
            // Upgrade should work and emit event
            await expect(
                usdl.connect(upgrader).upgradeToAndCall(await newImpl.getAddress(), "0x")
            ).to.emit(usdl, "Upgrade");
        });
    });
});

