const { ethers, upgrades, network } = require("hardhat");

/**
 * USDL Deployment Script
 * 
 * Deploys the USDL vault contract (upgradeable proxy)
 * 
 * Environment Variables Required:
 * - PRIVATE_KEY: Deployer private key
 * - USDC_ADDRESS: USDC token address on target network
 * - TREASURY_ADDRESS: Treasury address for fees
 * - MULTISIG_ADDRESS: (Optional) Admin multisig address (defaults to deployer)
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-usdl.js --network <network>
 * 
 * Example:
 *   USDC_ADDRESS=0xA0b8... TREASURY_ADDRESS=0x... npx hardhat run scripts/deploy-usdl.js --network mainnet
 */

// Network-specific USDC addresses
const USDC_ADDRESSES = {
    mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    sepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle's testnet USDC
    polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Native USDC on Polygon
    arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC on Arbitrum
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Native USDC on Base
    avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Native USDC on Avalanche
    bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC on BSC
    hardhat: null, // Will be deployed as mock
    localhost: null,
};

async function main() {
    console.log("=".repeat(60));
    console.log("USDL Vault Deployment Script");
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
    let usdcAddress = process.env.USDC_ADDRESS || USDC_ADDRESSES[network.name];
    const treasuryAddress = process.env.TREASURY_ADDRESS || multisig;

    // For local/hardhat networks, deploy mock USDC if not provided
    if (!usdcAddress && (network.name === "hardhat" || network.name === "localhost")) {
        console.log("Deploying Mock USDC for local testing...");
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        const mockUsdc = await MockUSDC.deploy();
        await mockUsdc.waitForDeployment();
        usdcAddress = await mockUsdc.getAddress();
        console.log("Mock USDC deployed to:", usdcAddress);
        console.log("");
    }

    // Validate addresses
    if (!usdcAddress) {
        throw new Error("USDC_ADDRESS not provided and no default for this network");
    }
    if (!ethers.isAddress(usdcAddress)) {
        throw new Error(`Invalid USDC address: ${usdcAddress}`);
    }
    if (!ethers.isAddress(treasuryAddress)) {
        throw new Error(`Invalid treasury address: ${treasuryAddress}`);
    }
    if (!ethers.isAddress(multisig)) {
        throw new Error(`Invalid multisig address: ${multisig}`);
    }

    console.log("Configuration:");
    console.log("- Multisig/Admin:", multisig);
    console.log("- USDC Address:", usdcAddress);
    console.log("- Treasury Address:", treasuryAddress);
    console.log("");

    // Deploy USDL (upgradeable proxy)
    console.log("Deploying USDL vault (upgradeable proxy)...");
    const USDL = await ethers.getContractFactory("USDL");
    
    const usdl = await upgrades.deployProxy(
        USDL,
        [multisig, usdcAddress, treasuryAddress],
        {
            initializer: "initialize",
            kind: "uups",
        }
    );
    await usdl.waitForDeployment();
    
    const usdlAddress = await usdl.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(usdlAddress);
    
    console.log("");
    console.log("✅ USDL Deployment Complete!");
    console.log("=".repeat(60));
    console.log("Contract Addresses:");
    console.log("- USDL Proxy:", usdlAddress);
    console.log("- USDL Implementation:", implementationAddress);
    console.log("");
    
    // Verify initial state
    console.log("Verifying initial state...");
    const name = await usdl.name();
    const symbol = await usdl.symbol();
    const decimals = await usdl.decimals();
    const version = await usdl.version();
    const asset = await usdl.asset();
    const redemptionFee = await usdl.redemptionFeeBps();
    
    console.log("- Name:", name);
    console.log("- Symbol:", symbol);
    console.log("- Decimals:", decimals.toString());
    console.log("- Version:", version.toString());
    console.log("- Underlying Asset:", asset);
    console.log("- Redemption Fee:", redemptionFee.toString(), "bps (", (Number(redemptionFee) / 100).toFixed(2), "%)");
    console.log("");
    
    // Output for next steps
    console.log("=".repeat(60));
    console.log("Next Steps:");
    console.log("1. Deploy YieldRouter using deploy-yield-router.js");
    console.log("2. Call usdl.setYieldRouter(routerAddress) to link them");
    console.log("3. Configure yield assets on the router");
    console.log("4. Verify contracts on Etherscan");
    console.log("");
    console.log("Environment variables for YieldRouter deployment:");
    console.log(`  USDL_ADDRESS=${usdlAddress}`);
    console.log("");
    
    // Return addresses for programmatic use
    return {
        usdl: usdlAddress,
        implementation: implementationAddress,
        usdc: usdcAddress,
        treasury: treasuryAddress,
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
