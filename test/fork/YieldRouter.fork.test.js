const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");

// Mainnet constants (EIP-55 checksummed)
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8"; // Circle treasury rich account

// Sky protocol mainnet addresses
const SKY_LITE_PSM = "0xA188EEC8F81263234dA3622A406892F3D630f98c";
const SKY_USDS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
const SKY_SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

// Ondo OUSG mainnet addresses
const OUSG_INSTANT_MANAGER = "0x93358db73B6cd4b98D89c8F5f230E81a95c2643a";
const OUSG_TOKEN = "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92"; // OUSG (base token, used for IDRegistry)
const ROUSG_TOKEN = "0x54043c656F0FAd0652D9Ae2603cDF347c5578d00"; // rOUSG (rebasing OUSG)
const ONDO_ID_REGISTRY = "0xcf6958D69d535FD03BD6Df3F4fe6CDcd127D97df"; // OndoIDRegistry used by InstantManager
const ONDO_ADMIN = "0x5AE21c99FC5f1584D8Cb09a298CFFd92B5d178eF"; // Has MASTER_CONFIGURER_ROLE on ID registry

const AssetType = { ERC4626: 0, AAVE_V3: 1, ONDO_OUSG: 2, SKY_SUSDS: 3 };

// Skip reason helper to keep test output readable
const missingForkEnv = () => !process.env.ETHEREUM_RPC_URL;

// These tests hit mainnet state; keep them explicit and opt-in.
describe("[FORK] YieldRouter mainnet Aave V3 integration", function () {
    if (missingForkEnv()) {
        console.warn("Skipping fork tests: ETHEREUM_RPC_URL not set");
        return;
    }

    this.timeout(180_000); // Forking + mainnet calls can be slow

    let usdc;
    let usdl;
    let router;
    let deployer;
    let treasury;
    let user;
    let pool;
    let aUsdc;
    let routerAddress;
    let aToken;

    beforeEach(async function () {
        [deployer, treasury, user] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC);
        pool = await ethers.getContractAt("IAaveV3Pool", AAVE_V3_POOL);
        const reserveData = await pool.getReserveData(MAINNET_USDC);
        aUsdc = reserveData[8]; // aToken address

        // Fund test user with USDC via impersonation
        await deployer.sendTransaction({ to: USDC_WHALE, value: ethers.parseEther("1") });
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDC_WHALE] });
        const funder = await ethers.getSigner(USDC_WHALE);
        const fundAmount = ethers.parseUnits("10000", 6);
        await usdc.connect(funder).transfer(user.address, fundAmount);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [USDC_WHALE] });

        // Deploy USDL and YieldRouter proxies against mainnet USDC
        const USDL = await ethers.getContractFactory("USDL");
        usdl = await upgrades.deployProxy(USDL, [deployer.address, MAINNET_USDC, treasury.address], {
            initializer: "initialize",
            unsafeAllow: ["constructor"],
        });
        await usdl.waitForDeployment();

        const YieldRouter = await ethers.getContractFactory("YieldRouter");
        router = await upgrades.deployProxy(YieldRouter, [deployer.address, MAINNET_USDC, await usdl.getAddress()], {
            initializer: "initialize",
            unsafeAllow: ["constructor"],
        });
        await router.waitForDeployment();

        routerAddress = await router.getAddress();
        aToken = await ethers.getContractAt("IERC20", aUsdc);

        // Wire USDL to router
        await usdl.setYieldRouter(routerAddress);

        // Speed up upkeep cadence so tests don't need long sleeps
        await router.setYieldAccrualInterval(3600);

        // Register Aave V3 aUSDC as the single yield asset
        await router.addYieldAsset(aUsdc, MAINNET_USDC, AAVE_V3_POOL, AssetType.AAVE_V3);
        await router.updateWeights([10_000]);
    });

    it("deposits USDC, allocates to Aave, and redeems", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);

        // User deposits USDC into USDL
        await usdc.connect(user).approve(await usdl.getAddress(), depositAmount);
        await usdl.connect(user).deposit(depositAmount, user.address);

        expect(await router.pendingDeposits()).to.equal(depositAmount);

        // Advance time to satisfy upkeep interval and process allocation
        await network.provider.send("evm_increaseTime", [3600 + 5]);
        await network.provider.send("evm_mine");

        await router.performUpkeep("0x");

        expect(await router.pendingDeposits()).to.equal(0);
        expect(await aToken.balanceOf(routerAddress)).to.be.gt(0);

        // Mine additional blocks to satisfy MIN_HOLD_BLOCKS (5 blocks)
        for (let i = 0; i < 6; i++) {
            await network.provider.send("evm_mine");
        }

        // Redeem full position back to USDC
        const shares = await usdl.balanceOf(user.address);
        const usdcBefore = await usdc.balanceOf(user.address);
        await usdl.connect(user).redeem(shares, user.address, user.address);
        const usdcAfter = await usdc.balanceOf(user.address);

        expect(usdcAfter).to.be.gt(usdcBefore);
        // Allow for minor rounding; ensure at least 99.5% of deposit returned
        expect(usdcAfter - usdcBefore).to.be.gte(depositAmount * 995n / 1000n);
    });
});

// ============ Sky sUSDS Fork Tests ============

describe("[FORK] YieldRouter mainnet Sky sUSDS integration", function () {
    if (missingForkEnv()) {
        console.warn("Skipping fork tests: ETHEREUM_RPC_URL not set");
        return;
    }

    this.timeout(180_000);

    let usdc;
    let usds;
    let sUsds;
    let usdl;
    let router;
    let deployer;
    let treasury;
    let user;
    let routerAddress;

    beforeEach(async function () {
        [deployer, treasury, user] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC);
        usds = await ethers.getContractAt("IERC20", SKY_USDS);
        sUsds = await ethers.getContractAt("IERC20", SKY_SUSDS);

        // Fund test user with USDC via impersonation
        await deployer.sendTransaction({ to: USDC_WHALE, value: ethers.parseEther("1") });
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDC_WHALE] });
        const funder = await ethers.getSigner(USDC_WHALE);
        const fundAmount = ethers.parseUnits("10000", 6);
        await usdc.connect(funder).transfer(user.address, fundAmount);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [USDC_WHALE] });

        // Deploy USDL and YieldRouter proxies against mainnet USDC
        const USDL = await ethers.getContractFactory("USDL");
        usdl = await upgrades.deployProxy(USDL, [deployer.address, MAINNET_USDC, treasury.address], {
            initializer: "initialize",
            unsafeAllow: ["constructor"],
        });
        await usdl.waitForDeployment();

        const YieldRouter = await ethers.getContractFactory("YieldRouter");
        router = await upgrades.deployProxy(YieldRouter, [deployer.address, MAINNET_USDC, await usdl.getAddress()], {
            initializer: "initialize",
            unsafeAllow: ["constructor"],
        });
        await router.waitForDeployment();

        routerAddress = await router.getAddress();

        // Wire USDL to router
        await usdl.setYieldRouter(routerAddress);

        // Speed up upkeep cadence
        await router.setYieldAccrualInterval(3600);

        // Configure Sky protocol
        await router.setSkyConfig(SKY_LITE_PSM, SKY_USDS, SKY_SUSDS);

        // Register sUSDS as the yield asset (uses SKY_SUSDS type)
        // For Sky, the manager is the litePSM wrapper
        await router.addYieldAsset(SKY_SUSDS, MAINNET_USDC, SKY_LITE_PSM, AssetType.SKY_SUSDS);
        await router.updateWeights([10_000]);
    });

    it("deposits USDC, allocates to Sky sUSDS, and redeems", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);

        // User deposits USDC into USDL
        await usdc.connect(user).approve(await usdl.getAddress(), depositAmount);
        await usdl.connect(user).deposit(depositAmount, user.address);

        expect(await router.pendingDeposits()).to.equal(depositAmount);

        // Advance time to satisfy upkeep interval and process allocation
        await network.provider.send("evm_increaseTime", [3600 + 5]);
        await network.provider.send("evm_mine");

        await router.performUpkeep("0x");

        expect(await router.pendingDeposits()).to.equal(0);
        // Router should hold sUSDS tokens
        expect(await sUsds.balanceOf(routerAddress)).to.be.gt(0);

        // Mine additional blocks to satisfy MIN_HOLD_BLOCKS (5 blocks)
        for (let i = 0; i < 6; i++) {
            await network.provider.send("evm_mine");
        }

        // Redeem full position back to USDC
        const shares = await usdl.balanceOf(user.address);
        const usdcBefore = await usdc.balanceOf(user.address);
        await usdl.connect(user).redeem(shares, user.address, user.address);
        const usdcAfter = await usdc.balanceOf(user.address);

        expect(usdcAfter).to.be.gt(usdcBefore);
        // Allow for minor rounding; ensure at least 99.5% of deposit returned
        expect(usdcAfter - usdcBefore).to.be.gte(depositAmount * 995n / 1000n);
    });
});

// ============ Ondo OUSG Fork Tests ============

describe("[FORK] YieldRouter mainnet Ondo OUSG integration", function () {
    if (missingForkEnv()) {
        console.warn("Skipping fork tests: ETHEREUM_RPC_URL not set");
        return;
    }

    this.timeout(180_000);

    let usdc;
    let ousg;
    let usdl;
    let router;
    let deployer;
    let treasury;
    let user;
    let routerAddress;

    beforeEach(async function () {
        [deployer, treasury, user] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC);
        ousg = await ethers.getContractAt("IERC20", OUSG_TOKEN);

        // Fund test user with USDC via impersonation
        await deployer.sendTransaction({ to: USDC_WHALE, value: ethers.parseEther("1") });
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDC_WHALE] });
        const funder = await ethers.getSigner(USDC_WHALE);
        // OUSG has minimum deposit of 100k USDC
        const fundAmount = ethers.parseUnits("200000", 6);
        await usdc.connect(funder).transfer(user.address, fundAmount);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [USDC_WHALE] });

        // Deploy USDL and YieldRouter proxies against mainnet USDC
        const USDL = await ethers.getContractFactory("USDL");
        usdl = await upgrades.deployProxy(USDL, [deployer.address, MAINNET_USDC, treasury.address], {
            initializer: "initialize",
            unsafeAllow: ["constructor"],
        });
        await usdl.waitForDeployment();

        const YieldRouter = await ethers.getContractFactory("YieldRouter");
        router = await upgrades.deployProxy(YieldRouter, [deployer.address, MAINNET_USDC, await usdl.getAddress()], {
            initializer: "initialize",
            unsafeAllow: ["constructor"],
        });
        await router.waitForDeployment();

        routerAddress = await router.getAddress();

        // Wire USDL to router
        await usdl.setYieldRouter(routerAddress);

        // Speed up upkeep cadence
        await router.setYieldAccrualInterval(3600);

        // ========== REGISTER ROUTER IN ONDO ID REGISTRY ==========
        // The InstantManager checks ondoIDRegistry.getRegisteredID(rwaToken, msg.sender)
        // rwaToken is OUSG (0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92)
        // Impersonate the Ondo admin who has MASTER_CONFIGURER_ROLE
        await deployer.sendTransaction({ to: ONDO_ADMIN, value: ethers.parseEther("1") });
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [ONDO_ADMIN] });
        const ondoAdmin = await ethers.getSigner(ONDO_ADMIN);
        
        // Get OndoIDRegistry contract
        const ondoIDRegistry = new ethers.Contract(
            ONDO_ID_REGISTRY,
            [
                "function setUserID(address rwaToken, address[] calldata userAddresses, bytes32 newUserID) external",
                "function getRegisteredID(address rwaToken, address user) external view returns (bytes32)"
            ],
            ondoAdmin
        );

        // Register router with a non-zero userID for OUSG token
        const userID = ethers.keccak256(ethers.toUtf8Bytes("LENDEFI_YIELD_ROUTER"));
        await ondoIDRegistry.setUserID(OUSG_TOKEN, [routerAddress], userID);
        
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [ONDO_ADMIN] });

        // Register OUSG as the yield asset (we receive OUSG from subscribe())
        // For OUSG, manager is the InstantManager
        await router.addYieldAsset(OUSG_TOKEN, MAINNET_USDC, OUSG_INSTANT_MANAGER, AssetType.ONDO_OUSG);
        await router.updateWeights([10_000]);
    });

    it("deposits USDC, allocates to Ondo OUSG, and redeems", async function () {
        // OUSG has minimum deposit of 100,000 USDC
        const depositAmount = ethers.parseUnits("105000", 6);

        // User deposits USDC into USDL
        await usdc.connect(user).approve(await usdl.getAddress(), depositAmount);
        await usdl.connect(user).deposit(depositAmount, user.address);

        expect(await router.pendingDeposits()).to.equal(depositAmount);

        // Advance time to satisfy upkeep interval and process allocation
        await network.provider.send("evm_increaseTime", [3600 + 5]);
        await network.provider.send("evm_mine");

        await router.performUpkeep("0x");

        expect(await router.pendingDeposits()).to.equal(0);
        // Router should hold OUSG tokens
        expect(await ousg.balanceOf(routerAddress)).to.be.gt(0);

        // Mine additional blocks to satisfy MIN_HOLD_BLOCKS (5 blocks)
        for (let i = 0; i < 6; i++) {
            await network.provider.send("evm_mine");
        }

        // Redeem full position back to USDC
        const shares = await usdl.balanceOf(user.address);
        const usdcBefore = await usdc.balanceOf(user.address);
        await usdl.connect(user).redeem(shares, user.address, user.address);
        const usdcAfter = await usdc.balanceOf(user.address);

        expect(usdcAfter).to.be.gt(usdcBefore);
        // Allow for minor rounding and OUSG fees; ensure at least 99% of deposit returned
        expect(usdcAfter - usdcBefore).to.be.gte(depositAmount * 99n / 100n);
    });
});