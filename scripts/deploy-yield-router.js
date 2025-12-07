const { ethers, upgrades, network } = require("hardhat");

/**
 * YieldRouter Deployment Script
 * 
 * Deploys the YieldRouter contract (upgradeable proxy) and links it to USDL
 * 
 * Environment Variables Required:
 * - PRIVATE_KEY: Deployer private key
 * - USDL_ADDRESS: USDL vault address (from deploy-usdl.js)
 * - USDC_ADDRESS: USDC token address on target network
 * - MULTISIG_ADDRESS: (Optional) Admin multisig address (defaults to deployer)
 * 
 * Optional Environment Variables for Protocol Configuration:
 * - AAVE_POOL_ADDRESS: Aave V3 Pool address
 * - AAVE_AUSDC_ADDRESS: aUSDC token address
 * - SKY_LITEPSM_ADDRESS: Sky Protocol LitePSM address
 * - SKY_USDS_ADDRESS: USDS token address
 * - SKY_SUSDS_ADDRESS: sUSDS token address
 * - ONDO_INSTANT_MANAGER: Ondo InstantManager address
 * - ONDO_OUSG_ADDRESS: OUSG token address
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-yield-router.js --network <network>
 * 
 * Example:
 *   USDL_ADDRESS=0x... npx hardhat run scripts/deploy-yield-router.js --network mainnet
 */

// Network-specific USDC addresses
const USDC_ADDRESSES = {
    mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    sepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    hardhat: null,
    localhost: null,
};

// Mainnet Protocol Addresses (for reference)
const MAINNET_PROTOCOLS = {
    // Aave V3
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    aaveAUsdc: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
    
    // Sky Protocol (Maker/Spark)
    skyLitePSM: "0xf6e72Db5454dd049d0788e411b06CfAF16853042",
    skyUSDS: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
    skySUSDS: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
    
    // Ondo OUSG
    ondoInstantManager: "0x93358db73B6cd4b98D89c8F5f230E81a95c2643a",
    ondoOUSG: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92",
};

// Asset types enum (must match contracts/interfaces/IYieldProtocols.sol)
const ASSET_TYPE = {
    ERC4626: 0,
    AAVE_V3: 1,
    ONDO_OUSG: 2,
    SKY_SUSDS: 3,
};

async function main() {
    console.log("=".repeat(60));
    console.log("YieldRouter Deployment Script");
    console.log("=".repeat(60));
    console.log(`Network: ${network.name} (chainId: ${network.config.chainId})`);
    console.log("");

    // Get deployer
    const [deployer] = await ethers.getSigners();
    console.log("Deployer address:", deployer.address);
    const balance = await deployer.provider.getBalance(deployer.address);
    console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
    console.log("");

    // Configuration
    const multisig = process.env.MULTISIG_ADDRESS || deployer.address;
    const usdlAddress = process.env.USDL_ADDRESS;
    let usdcAddress = process.env.USDC_ADDRESS || USDC_ADDRESSES[network.name];

    // Validate USDL address
    if (!usdlAddress) {
        throw new Error("USDL_ADDRESS environment variable is required. Run deploy-usdl.js first.");
    }
    if (!ethers.isAddress(usdlAddress)) {
        throw new Error(`Invalid USDL address: ${usdlAddress}`);
    }

    // For local/hardhat networks, get USDC from USDL if not provided
    if (!usdcAddress && (network.name === "hardhat" || network.name === "localhost")) {
        console.log("Getting USDC address from USDL contract...");
        const usdl = await ethers.getContractAt("USDL", usdlAddress);
        usdcAddress = await usdl.asset();
        console.log("USDC from USDL:", usdcAddress);
        console.log("");
    }

    // Validate addresses
    if (!usdcAddress) {
        throw new Error("USDC_ADDRESS not provided and no default for this network");
    }
    if (!ethers.isAddress(usdcAddress)) {
        throw new Error(`Invalid USDC address: ${usdcAddress}`);
    }

    console.log("Configuration:");
    console.log("- Multisig/Admin:", multisig);
    console.log("- USDL Address:", usdlAddress);
    console.log("- USDC Address:", usdcAddress);
    console.log("");

    // Deploy YieldRouter (upgradeable proxy)
    console.log("Deploying YieldRouter (upgradeable proxy)...");
    const YieldRouter = await ethers.getContractFactory("YieldRouter");
    
    const router = await upgrades.deployProxy(
        YieldRouter,
        [multisig, usdcAddress, usdlAddress],
        {
            initializer: "initialize",
            kind: "uups",
        }
    );
    await router.waitForDeployment();
    
    const routerAddress = await router.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(routerAddress);
    
    console.log("");
    console.log("✅ YieldRouter Deployment Complete!");
    console.log("=".repeat(60));
    console.log("Contract Addresses:");
    console.log("- YieldRouter Proxy:", routerAddress);
    console.log("- YieldRouter Implementation:", implementationAddress);
    console.log("");

    // Link YieldRouter to USDL
    console.log("Linking YieldRouter to USDL...");
    const usdl = await ethers.getContractAt("USDL", usdlAddress);
    
    // Check if deployer has admin role
    const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
    const hasAdminRole = await usdl.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
    
    if (hasAdminRole) {
        const tx = await usdl.setYieldRouter(routerAddress);
        await tx.wait();
        console.log("✅ YieldRouter linked to USDL successfully!");
    } else {
        console.log("⚠️  Deployer does not have admin role on USDL.");
        console.log("   Manual action required: Call usdl.setYieldRouter(", routerAddress, ")");
    }
    console.log("");

    // Verify initial state
    console.log("Verifying initial state...");
    const version = await router.version();
    const vault = await router.vault();
    const usdc = await router.usdc();
    const yieldAccrualInterval = await router.yieldAccrualInterval();
    
    console.log("- Version:", version.toString());
    console.log("- Vault (USDL):", vault);
    console.log("- USDC:", usdc);
    console.log("- Yield Accrual Interval:", (Number(yieldAccrualInterval) / 3600).toFixed(2), "hours");
    console.log("");

    // Print mainnet protocol configuration guide
    if (network.name === "mainnet") {
        console.log("=".repeat(60));
        console.log("Mainnet Protocol Configuration Guide:");
        console.log("=".repeat(60));
        console.log("");
        console.log("After deployment, configure yield assets with the following calls:");
        console.log("");
        
        console.log("1. Aave V3 USDC (aUSDC):");
        console.log(`   router.addYieldAsset(`);
        console.log(`     "${MAINNET_PROTOCOLS.aaveAUsdc}",  // aUSDC token`);
        console.log(`     "${usdcAddress}",  // USDC deposit token`);
        console.log(`     "${MAINNET_PROTOCOLS.aavePool}",  // Aave V3 Pool`);
        console.log(`     ${ASSET_TYPE.AAVE_V3}  // AssetType.AAVE_V3`);
        console.log(`   )`);
        console.log("");
        
        console.log("2. Sky Protocol sUSDS:");
        console.log(`   router.setSkyConfig(`);
        console.log(`     "${MAINNET_PROTOCOLS.skyLitePSM}",  // LitePSM`);
        console.log(`     "${MAINNET_PROTOCOLS.skyUSDS}",  // USDS`);
        console.log(`     "${MAINNET_PROTOCOLS.skySUSDS}"  // sUSDS`);
        console.log(`   )`);
        console.log(`   router.addYieldAsset(`);
        console.log(`     "${MAINNET_PROTOCOLS.skySUSDS}",  // sUSDS token`);
        console.log(`     "${MAINNET_PROTOCOLS.skyUSDS}",  // USDS deposit token`);
        console.log(`     "${MAINNET_PROTOCOLS.skySUSDS}",  // sUSDS manager (ERC4626)`);
        console.log(`     ${ASSET_TYPE.SKY_SUSDS}  // AssetType.SKY_SUSDS`);
        console.log(`   )`);
        console.log("");
        
        console.log("3. Ondo OUSG (requires KYC/whitelist):");
        console.log(`   router.addYieldAsset(`);
        console.log(`     "${MAINNET_PROTOCOLS.ondoOUSG}",  // OUSG token`);
        console.log(`     "${usdcAddress}",  // USDC deposit token`);
        console.log(`     "${MAINNET_PROTOCOLS.ondoInstantManager}",  // Ondo InstantManager`);
        console.log(`     ${ASSET_TYPE.ONDO_OUSG}  // AssetType.ONDO_OUSG`);
        console.log(`   )`);
        console.log("   NOTE: Router address must be whitelisted with Ondo!");
        console.log("");
        
        console.log("4. Set weights (must sum to 10000 = 100%):");
        console.log(`   router.updateWeights([5000, 3000, 2000])  // 50% Aave, 30% Sky, 20% Ondo`);
        console.log("");
    }

    // Output summary
    console.log("=".repeat(60));
    console.log("Deployment Summary:");
    console.log("=".repeat(60));
    console.log("");
    console.log("Contracts Deployed:");
    console.log(`  USDL:        ${usdlAddress}`);
    console.log(`  YieldRouter: ${routerAddress}`);
    console.log("");
    console.log("Next Steps:");
    console.log("1. Add yield assets using addYieldAsset()");
    console.log("2. Set weights using updateWeights()");
    console.log("3. Register with Chainlink Automation for auto yield accrual");
    console.log("4. Verify contracts on Etherscan");
    console.log("");
    
    // Return addresses for programmatic use
    return {
        router: routerAddress,
        implementation: implementationAddress,
        usdl: usdlAddress,
        usdc: usdcAddress,
        multisig: multisig,
    };
}

// Execute
main()
    .then((result) => {
        console.log("Deployment successful!");
        process.exit(0);
    })
    .catch((error) => {
        console.error("Deployment failed:", error);
        process.exit(1);
    });
