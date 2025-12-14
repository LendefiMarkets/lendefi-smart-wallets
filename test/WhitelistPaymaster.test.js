const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("WhitelistPaymaster", function () {
  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    const entryPoint = await ethers.deployContract("EntryPoint");

    // Fund EntryPoint address so it can send tx when impersonated
    await owner.sendTransaction({ to: entryPoint.target, value: ethers.parseEther("1") });

    const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
    const factory = await upgrades.deployProxy(
      SmartWalletFactory,
      [entryPoint.target, owner.address, ethers.ZeroAddress],
      {
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    );

    await factory.createAccount(user1.address, 0);
    const walletAddress = await factory.getWallet(user1.address);
    const wallet = await ethers.getContractAt("SmartWallet", walletAddress);

    const paymaster = await ethers.deployContract("WhitelistPaymaster", [entryPoint.target, owner.address]);

    const target1 = await ethers.deployContract("MockTarget");
    const target2 = await ethers.deployContract("MockTarget");

    return { entryPoint, factory, wallet, paymaster, target1, target2, owner, user1 };
  }

  function createMockUserOp(sender, callData = "0x") {
    return {
      sender,
      nonce: 0,
      initCode: "0x",
      callData,
      accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [100000, 100000]),
      preVerificationGas: 50000,
      gasFees: ethers.solidityPacked(
        ["uint128", "uint128"],
        [ethers.parseUnits("1", "gwei"), ethers.parseUnits("10", "gwei")]
      ),
      paymasterAndData: "0x",
      signature: "0x",
    };
  }

  async function impersonateEntryPoint(entryPointAddress) {
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [entryPointAddress],
    });
    return ethers.getSigner(entryPointAddress);
  }

  describe("Whitelisting", function () {
    it("allows SmartWallet.execute to a whitelisted target", async function () {
      const { entryPoint, wallet, paymaster, target1, owner } = await loadFixture(deployFixture);

      await paymaster.connect(owner).setWhitelistedContract(target1.target, true);

      const callData = wallet.interface.encodeFunctionData("execute", [target1.target, 0, "0x"]);
      const userOp = createMockUserOp(wallet.target, callData);

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      const result = await paymaster
        .connect(epSigner)
        .validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0);

      expect(result.validationData || 0).to.equal(0);
    });

    it("rejects SmartWallet.execute to a non-whitelisted target", async function () {
      const { entryPoint, wallet, paymaster, target1, owner } = await loadFixture(deployFixture);

      await paymaster.connect(owner).setWhitelistedContract(target1.target, false);

      const callData = wallet.interface.encodeFunctionData("execute", [target1.target, 0, "0x"]);
      const userOp = createMockUserOp(wallet.target, callData);

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      await expect(
        paymaster.connect(epSigner).validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0)
      )
        .to.be.revertedWithCustomError(paymaster, "TargetNotWhitelisted")
        .withArgs(target1.target);
    });

    it("allows SmartWallet.executeBatch when ALL targets are whitelisted", async function () {
      const { entryPoint, wallet, paymaster, target1, target2, owner } = await loadFixture(deployFixture);

      await paymaster.connect(owner).setWhitelistedContractsBatch([target1.target, target2.target], true);

      const callData = wallet.interface.encodeFunctionData("executeBatch", [
        [target1.target, target2.target],
        [0, 0],
        ["0x", "0x"],
      ]);
      const userOp = createMockUserOp(wallet.target, callData);

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      const result = await paymaster
        .connect(epSigner)
        .validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0);

      expect(result.validationData || 0).to.equal(0);
    });

    it("rejects SmartWallet.executeBatch if ANY target is not whitelisted", async function () {
      const { entryPoint, wallet, paymaster, target1, target2, owner } = await loadFixture(deployFixture);

      await paymaster.connect(owner).setWhitelistedContract(target1.target, true);
      await paymaster.connect(owner).setWhitelistedContract(target2.target, false);

      const callData = wallet.interface.encodeFunctionData("executeBatch", [
        [target1.target, target2.target],
        [0, 0],
        ["0x", "0x"],
      ]);
      const userOp = createMockUserOp(wallet.target, callData);

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      await expect(
        paymaster.connect(epSigner).validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0)
      )
        .to.be.revertedWithCustomError(paymaster, "TargetNotWhitelisted")
        .withArgs(target2.target);
    });

    it("rejects unknown callData selector", async function () {
      const { entryPoint, paymaster } = await loadFixture(deployFixture);

      const userOp = createMockUserOp(ethers.Wallet.createRandom().address, "0xdeadbeef");

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      await expect(
        paymaster.connect(epSigner).validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0)
      ).to.be.revertedWithCustomError(paymaster, "InvalidUserOperation");
    });
  });

  describe("Wallet registry enforcement", function () {
    it("cannot enable enforcement without setting registry", async function () {
      const { paymaster, owner } = await loadFixture(deployFixture);
      await expect(paymaster.connect(owner).setEnforceWalletRegistry(true)).to.be.revertedWithCustomError(
        paymaster,
        "WalletRegistryNotSet"
      );
    });

    it("rejects sponsorship for non-registry wallets when enforced", async function () {
      const { entryPoint, factory, wallet, paymaster, target1, owner, user1 } = await loadFixture(deployFixture);

      await paymaster.connect(owner).setWhitelistedContract(target1.target, true);
      await paymaster.connect(owner).setWalletRegistry(factory.target);
      await paymaster.connect(owner).setEnforceWalletRegistry(true);

      const callData = wallet.interface.encodeFunctionData("execute", [target1.target, 0, "0x"]);
      const userOp = createMockUserOp(user1.address, callData); // EOA, not a smart wallet

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      await expect(
        paymaster.connect(epSigner).validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0)
      )
        .to.be.revertedWithCustomError(paymaster, "InvalidWallet")
        .withArgs(user1.address);
    });

    it("allows sponsorship for registry wallets when enforced", async function () {
      const { entryPoint, factory, wallet, paymaster, target1, owner } = await loadFixture(deployFixture);

      await paymaster.connect(owner).setWhitelistedContract(target1.target, true);
      await paymaster.connect(owner).setWalletRegistry(factory.target);
      await paymaster.connect(owner).setEnforceWalletRegistry(true);

      const callData = wallet.interface.encodeFunctionData("execute", [target1.target, 0, "0x"]);
      const userOp = createMockUserOp(wallet.target, callData);

      const epSigner = await impersonateEntryPoint(entryPoint.target);
      const result = await paymaster
        .connect(epSigner)
        .validatePaymasterUserOp(userOp, ethers.keccak256("0x1234"), 0);

      expect(result.validationData || 0).to.equal(0);
    });
  });
});
