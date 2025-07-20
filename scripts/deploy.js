const { ethers, upgrades } = require("hardhat");

async function main() {
  console.log("Deploying Lendefi Smart Wallet Infrastructure...");

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)));

  // Deploy EntryPoint first (or use existing one)
  console.log("\n1. Deploying EntryPoint...");
  const EntryPoint = await ethers.getContractFactory("EntryPoint");
  const entryPoint = await EntryPoint.deploy();
  await entryPoint.waitForDeployment();
  console.log("EntryPoint deployed to:", await entryPoint.getAddress());

  // Deploy SmartWalletFactory with upgrades
  console.log("\n2. Deploying SmartWalletFactory (upgradeable)...");
  const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
  const factory = await upgrades.deployProxy(
    SmartWalletFactory,
    [await entryPoint.getAddress(), deployer.address, ethers.ZeroAddress],
    { 
      initializer: 'initialize',
      unsafeAllow: ['constructor']
    }
  );
  await factory.waitForDeployment();
  console.log("SmartWalletFactory deployed to:", await factory.getAddress());
  console.log("Implementation address:", await factory.getImplementation());

  // Deploy LendefiPaymaster
  console.log("\n3. Deploying LendefiPaymaster...");
  const LendefiPaymaster = await ethers.getContractFactory("LendefiPaymaster");
  const paymaster = await LendefiPaymaster.deploy(await entryPoint.getAddress(), await factory.getAddress());
  await paymaster.waitForDeployment();
  console.log("LendefiPaymaster deployed to:", await paymaster.getAddress());

  // Fund the paymaster with some ETH for gas subsidies
  console.log("\n4. Funding Paymaster...");
  const fundAmount = ethers.parseEther("1.0"); // 1 ETH
  const tx = await paymaster.deposit({ value: fundAmount });
  await tx.wait();
  console.log("Paymaster funded with 1 ETH");

  // Create a test smart wallet
  console.log("\n5. Creating test smart wallet...");
  const testUser = deployer.address;
  const salt = 12345;
  
  const createTx = await factory.createAccount(testUser, salt);
  const receipt = await createTx.wait();
  
  // Get the wallet address from the event
  const event = receipt.logs?.find(log => {
    try {
      const parsed = factory.interface.parseLog(log);
      return parsed.name === "AccountCreated";
    } catch {
      return false;
    }
  });
  const walletAddress = event ? factory.interface.parseLog(event).args.account : await factory.getWallet(testUser);
  
  console.log("Test wallet created for user:", testUser);
  console.log("Wallet address:", walletAddress);

  // Grant premium subscription to the test user  
  console.log("\n6. Granting premium subscription...");
  const oneYear = 365 * 24 * 60 * 60; // 1 year in seconds
  const grantTx = await paymaster.grantSubscription(
    walletAddress, // Grant to the wallet address, not user address
    2, // PREMIUM tier
    oneYear
  );
  await grantTx.wait();
  console.log("Premium subscription granted to test wallet");

  // Verify subscription
  const subscription = await paymaster.getSubscription(walletAddress);
  console.log("Subscription details:");
  console.log("- Tier:", subscription.tier.toString());
  console.log("- Expires at:", new Date(Number(subscription.expiresAt) * 1000).toISOString());
  console.log("- Monthly gas limit:", subscription.monthlyGasLimit.toString());

  console.log("\n✅ Deployment completed successfully!");
  console.log("\nContract addresses:");
  console.log("- EntryPoint:", await entryPoint.getAddress());
  console.log("- SmartWalletFactory:", await factory.getAddress());
  console.log("- SmartWallet Implementation:", await factory.getImplementation());
  console.log("- LendefiPaymaster:", await paymaster.getAddress());
  console.log("- Test Wallet:", walletAddress);

  console.log("\nNext steps:");
  console.log("1. Verify contracts on Etherscan");
  console.log("2. Set up bundler infrastructure");
  console.log("3. Integrate with frontend wallet creation flow");
  console.log("4. Configure gas subsidy parameters");

  // Save deployment info
  const network = await ethers.provider.getNetwork();
  const deploymentInfo = {
    network: {
      name: network.name,
      chainId: Number(network.chainId)
    },
    contracts: {
      entryPoint: await entryPoint.getAddress(),
      smartWalletFactory: await factory.getAddress(),
      smartWalletImplementation: await factory.getImplementation(),
      lendefiPaymaster: await paymaster.getAddress()
    },
    testWallet: {
      user: testUser,
      wallet: walletAddress,
      salt: salt
    },
    deployedAt: new Date().toISOString(),
    deployer: deployer.address
  };

  console.log("\nDeployment info saved to deployments.json");
  require("fs").writeFileSync(
    "./deployments.json",
    JSON.stringify(deploymentInfo, null, 2)
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });