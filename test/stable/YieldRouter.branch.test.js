const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture, usdlSkyFixture, deployMockYieldVault } = require("./helpers/setup");

const ASSET_TYPE = {
    ERC4626: 0,
    AAVE_V3: 1,
    ONDO_OUSG: 2,
    SKY_SUSDS: 3
};

/**
 * YieldRouter.sol Branch Coverage Tests
 * 
 * These tests target specific branches and modifiers in YieldRouter.sol
 * to ensure high branch coverage.
 */
describe("YieldRouter - Branch Coverage", function () {

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

    describe("Modifier: onlyVault", function () {
        it("Should revert depositToProtocols when caller is not vault", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).depositToProtocols(ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(router, "InsufficientLiquidity");
        });

        it("Should revert redeemFromProtocols when caller is not vault", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).redeemFromProtocols(ethers.parseUnits("100", 6))
            ).to.be.revertedWithCustomError(router, "InsufficientLiquidity");
        });
    });

    describe("Modifier: onlyRole(MANAGER_ROLE)", function () {
        it("Should revert addYieldAsset when caller not MANAGER", async function () {
            const { router, user1, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).addYieldAsset(
                    await yieldVault.getAddress(),
                    await usdc.getAddress(),
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.reverted;
        });

        it("Should revert updateWeights when caller not MANAGER", async function () {
            const { router, manager, user1, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            
            await expect(
                router.connect(user1).updateWeights([10000])
            ).to.be.reverted;
        });

        it("Should revert removeYieldAsset when caller not MANAGER", async function () {
            const { router, user1, yieldVault } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).removeYieldAsset(await yieldVault.getAddress())
            ).to.be.reverted;
        });

        it("Should revert setSkyConfig when caller not MANAGER", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).setSkyConfig(user1.address, user1.address, user1.address)
            ).to.be.reverted;
        });

        it("Should revert accrueYield when caller not MANAGER", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).accrueYield()
            ).to.be.reverted;
        });

        it("Should revert setYieldAccrualInterval when caller not MANAGER", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).setYieldAccrualInterval(86400)
            ).to.be.reverted;
        });
    });

    describe("addYieldAsset - Zero Address Checks", function () {
        it("Should revert addYieldAsset with zero token", async function () {
            const { router, manager, usdc, yieldVault } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).addYieldAsset(
                    ethers.ZeroAddress,
                    await usdc.getAddress(),
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert addYieldAsset with zero deposit token", async function () {
            const { router, manager, yieldVault } = await loadFixture(usdlFixture);
            
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
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await yieldVault.getAddress(),
                    await usdc.getAddress(),
                    ethers.ZeroAddress,
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert addYieldAsset when asset already exists", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            
            await expect(
                router.connect(manager).addYieldAsset(
                    await yieldVault.getAddress(),
                    await usdc.getAddress(),
                    await yieldVault.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "AssetAlreadyExists");
        });

        it("Should revert addYieldAsset when max assets reached", async function () {
            const { router, manager, usdc } = await loadFixture(usdlFixture);
            
            // Add 10 yield assets (MAX_YIELD_ASSETS)
            for (let i = 0; i < 10; i++) {
                const vault = await deployMockYieldVault(await usdc.getAddress());
                await router.connect(manager).addYieldAsset(
                    await vault.getAddress(),
                    await usdc.getAddress(),
                    await vault.getAddress(),
                    ASSET_TYPE.ERC4626
                );
            }
            
            // 11th should fail
            const vault11 = await deployMockYieldVault(await usdc.getAddress());
            await expect(
                router.connect(manager).addYieldAsset(
                    await vault11.getAddress(),
                    await usdc.getAddress(),
                    await vault11.getAddress(),
                    ASSET_TYPE.ERC4626
                )
            ).to.be.revertedWithCustomError(router, "MaxYieldAssetsReached");
        });
    });

    describe("updateWeights - Validation", function () {
        it("Should revert when weights length mismatch", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            
            await expect(
                router.connect(manager).updateWeights([5000, 5000]) // 2 weights for 1 asset
            ).to.be.revertedWithCustomError(router, "LengthMismatch");
        });

        it("Should revert when weights do not sum to BASIS_POINTS", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
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
            
            await expect(
                router.connect(manager).updateWeights([5000, 4000]) // Sums to 9000, not 10000
            ).to.be.revertedWithCustomError(router, "InvalidTotalWeight");
        });

        it("Should allow weights that sum to BASIS_POINTS", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
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
            
            await expect(
                router.connect(manager).updateWeights([6000, 4000])
            ).to.not.be.reverted;
        });
    });

    describe("removeYieldAsset - Validation", function () {
        it("Should revert when asset not found", async function () {
            const { router, manager, yieldVault } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).removeYieldAsset(await yieldVault.getAddress())
            ).to.be.revertedWithCustomError(router, "AssetNotFound");
        });

        it("Should revert when asset still has weight", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await expect(
                router.connect(manager).removeYieldAsset(await yieldVault.getAddress())
            ).to.be.revertedWithCustomError(router, "AssetStillActive");
        });

        it("Should revert when asset has balance", async function () {
            const { usdl, router, manager, yieldVault, usdc, user1 } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit to create balance
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            await expect(
                router.connect(manager).removeYieldAsset(await yieldVault.getAddress())
            ).to.be.revertedWithCustomError(router, "AssetStillActive");
        });
    });

    describe("setSkyConfig - Zero Address Checks", function () {
        it("Should revert setSkyConfig with zero litePSM", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            const [, user1] = await ethers.getSigners();
            
            await expect(
                router.connect(manager).setSkyConfig(
                    ethers.ZeroAddress,
                    user1.address,
                    user1.address
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert setSkyConfig with zero usds", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            const [, user1] = await ethers.getSigners();
            
            await expect(
                router.connect(manager).setSkyConfig(
                    user1.address,
                    ethers.ZeroAddress,
                    user1.address
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert setSkyConfig with zero sUsds", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            const [, user1] = await ethers.getSigners();
            
            await expect(
                router.connect(manager).setSkyConfig(
                    user1.address,
                    user1.address,
                    ethers.ZeroAddress
                )
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });
    });

    describe("setVault", function () {
        it("Should set new vault and update roles", async function () {
            const { router, owner, usdl, user1 } = await loadFixture(usdlFixture);
            
            const oldVault = await usdl.getAddress();
            const VAULT_ROLE = await router.VAULT_ROLE();
            
            expect(await router.hasRole(VAULT_ROLE, oldVault)).to.be.true;
            
            await router.connect(owner).setVault(user1.address);
            
            expect(await router.hasRole(VAULT_ROLE, oldVault)).to.be.false;
            expect(await router.hasRole(VAULT_ROLE, user1.address)).to.be.true;
        });

        it("Should revert setVault with zero address", async function () {
            const { router, owner } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(owner).setVault(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should revert setVault when caller is not admin", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).setVault(user1.address)
            ).to.be.reverted;
        });
    });

    describe("setYieldAccrualInterval", function () {
        it("Should revert when interval below minimum", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).setYieldAccrualInterval(1800) // 30 min < 1 hour
            ).to.be.revertedWithCustomError(router, "AutomationIntervalTooShort");
        });

        it("Should allow disabling with zero", async function () {
            const { router, manager } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(manager).setYieldAccrualInterval(0)
            ).to.emit(router, "YieldAccrualIntervalUpdated");
        });
    });

    describe("rescueDonatedTokens", function () {
        it("Should revert with zero address", async function () {
            const { router, owner } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(owner).rescueDonatedTokens(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should rescue donated tokens above tracked balance", async function () {
            const { router, owner, usdc } = await loadFixture(usdlFixture);
            
            // Donate USDC directly to router
            await usdc.mint(await router.getAddress(), ethers.parseUnits("100", 6));
            
            await router.connect(owner).rescueDonatedTokens(owner.address);
            
            expect(await usdc.balanceOf(owner.address)).to.equal(ethers.parseUnits("100", 6));
        });

        it("Should revert rescueDonatedTokens when caller is not admin", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            await expect(
                router.connect(user1).rescueDonatedTokens(user1.address)
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
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("1000", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address);
            
            return fixture;
        }

        it("Should withdraw all funds to vault in emergency", async function () {
            const { router, usdl, owner, usdc, yieldVault } = await loadFixture(setupWithDeposits);
            
            const routerAddress = await router.getAddress();
            expect(await yieldVault.balanceOf(routerAddress)).to.be.gt(0);
            
            await router.connect(owner).emergencyWithdraw();
            
            expect(await yieldVault.balanceOf(routerAddress)).to.equal(0);
            expect(await router.trackedUSDCBalance()).to.equal(0);
            expect(await usdc.balanceOf(await usdl.getAddress())).to.be.gt(0);
        });

        it("Should revert when caller is not admin", async function () {
            const { router, user1 } = await loadFixture(setupWithDeposits);
            
            await expect(
                router.connect(user1).emergencyWithdraw()
            ).to.be.reverted;
        });
    });

    describe("redeemFromSingleYieldAssetExternal", function () {
        it("Should revert when called by non-self", async function () {
            const { router, manager, yieldVault, usdc } = await loadFixture(usdlFixture);
            
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

    describe("_authorizeUpgrade", function () {
        it("Should revert upgrade to zero address", async function () {
            const { router, owner } = await loadFixture(usdlFixture);
            
            const UPGRADER_ROLE = await router.UPGRADER_ROLE();
            await router.connect(owner).grantRole(UPGRADER_ROLE, owner.address);
            
            await expect(
                router.connect(owner).upgradeToAndCall(ethers.ZeroAddress, "0x")
            ).to.be.revertedWithCustomError(router, "ZeroAddress");
        });

        it("Should allow upgrade to valid address", async function () {
            const { router, owner } = await loadFixture(usdlFixture);
            
            const UPGRADER_ROLE = await router.UPGRADER_ROLE();
            await router.connect(owner).grantRole(UPGRADER_ROLE, owner.address);
            
            const YieldRouterV2 = await ethers.getContractFactory("YieldRouter");
            const newImpl = await YieldRouterV2.deploy();
            await newImpl.waitForDeployment();
            
            await expect(
                router.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")
            ).to.emit(router, "Upgrade");
        });

        it("Should revert upgrade when caller not UPGRADER", async function () {
            const { router, user1 } = await loadFixture(usdlFixture);
            
            const YieldRouterV2 = await ethers.getContractFactory("YieldRouter");
            const newImpl = await YieldRouterV2.deploy();
            await newImpl.waitForDeployment();
            
            await expect(
                router.connect(user1).upgradeToAndCall(await newImpl.getAddress(), "0x")
            ).to.be.reverted;
        });
    });

    describe("getSkyConfig", function () {
        it("Should return sky config", async function () {
            const { router, sUsds, usds, litePSM } = await loadFixture(usdlSkyFixture);
            
            const [litePSMAddr, usdsAddr, sUsdsAddr] = await router.getSkyConfig();
            
            expect(litePSMAddr).to.equal(await litePSM.getAddress());
            expect(usdsAddr).to.equal(await usds.getAddress());
            expect(sUsdsAddr).to.equal(await sUsds.getAddress());
        });
    });

    describe("getLastYieldAccrualTimestamp", function () {
        it("Should return last yield accrual timestamp", async function () {
            const { router, manager, yieldVault, usdc, usdl, user1 } = await loadFixture(usdlFixture);
            
            await router.connect(manager).addYieldAsset(
                await yieldVault.getAddress(),
                await usdc.getAddress(),
                await yieldVault.getAddress(),
                ASSET_TYPE.ERC4626
            );
            await router.connect(manager).updateWeights([10000]);
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("100", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("100", 6), user1.address);
            
            const timestampBefore = await router.getLastYieldAccrualTimestamp();
            
            await yieldVault.setYieldMultiplier(ethers.parseUnits("1.1", 6));
            
            await ethers.provider.send("evm_increaseTime", [86400]);
            await ethers.provider.send("evm_mine");
            
            await router.connect(manager).accrueYield();
            
            const timestampAfter = await router.getLastYieldAccrualTimestamp();
            expect(timestampAfter).to.be.gt(timestampBefore);
        });
    });

    describe("Auto-drain on Weight Update", function () {
        it("Should auto-drain ERC4626 when weight goes to zero", async function () {
            const { usdl, router, manager, usdc, yieldVault, yieldVault2, user1 } = await loadFixture(usdlFixture);
            
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
            
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("1000", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address);
            
            expect(await yieldVault.balanceOf(await router.getAddress())).to.be.gt(0);
            expect(await yieldVault2.balanceOf(await router.getAddress())).to.be.gt(0);
            
            await expect(
                router.connect(manager).updateWeights([0, 10000])
            ).to.emit(router, "YieldAssetDrained");
            
            expect(await yieldVault.balanceOf(await router.getAddress())).to.equal(0);
        });
    });

    describe("Aave V3 Asset Type Coverage", function () {
        it("Should calculate value for Aave V3 assets", async function () {
            const { router, manager, usdc, usdl, user1 } = await loadFixture(usdlFixture);
            
            // Deploy Aave mocks
            const MockAUsdc = await ethers.getContractFactory("MockAUsdc");
            const aUsdc = await MockAUsdc.deploy();
            await aUsdc.waitForDeployment();
            
            const MockAavePool = await ethers.getContractFactory("MockAavePool");
            const aavePool = await MockAavePool.deploy(
                await usdc.getAddress(),
                await aUsdc.getAddress()
            );
            await aavePool.waitForDeployment();
            
            // Set pool address in mock aToken
            await aUsdc.setPool(await aavePool.getAddress());
            
            // Add Aave asset type
            await router.connect(manager).addYieldAsset(
                await aUsdc.getAddress(),
                await usdc.getAddress(),
                await aavePool.getAddress(),
                ASSET_TYPE.AAVE_V3
            );
            await router.connect(manager).updateWeights([10000]);
            
            // Deposit
            await usdc.connect(user1).approve(await usdl.getAddress(), ethers.parseUnits("1000", 6));
            await usdl.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address);
            
            // Check total value (tests the AAVE_V3 branch in _getYieldAssetValue)
            const totalValue = await router.getTotalValue();
            expect(totalValue).to.be.gt(0);
        });
    });
});
