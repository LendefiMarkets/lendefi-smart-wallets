const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("Deploy Sequence Test", function () {
    async function deploySystem() {
        const [owner, user1, user2] = await ethers.getSigners();
        
        // Deploy EntryPoint
        const entryPoint = await ethers.deployContract("EntryPoint");
        
        // Deploy factory with upgrades plugin
        const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
        const factory = await upgrades.deployProxy(
            SmartWalletFactory,
            [entryPoint.target, owner.address, ethers.ZeroAddress],
            { 
                initializer: 'initialize',
                unsafeAllow: ['constructor']
            }
        );
        
        return { factory, entryPoint, owner, user1, user2 };
    }

    it("Should deploy EntryPoint correctly", async function () {
        const { entryPoint } = await deploySystem();
        expect(entryPoint.target).to.not.equal(ethers.ZeroAddress);
        expect(await entryPoint.balanceOf(ethers.ZeroAddress)).to.equal(0);
    });

    it("Should deploy factory with proxy correctly", async function () {
        const { factory, entryPoint, owner } = await deploySystem();
        expect(factory.target).to.not.equal(ethers.ZeroAddress);
        expect(await factory.entryPoint()).to.equal(entryPoint.target);
        expect(await factory.owner()).to.equal(owner.address);
    });

    it("Should create SmartWallet through factory", async function () {
        const { factory, entryPoint, owner } = await deploySystem();
        
        await factory.createAccount(owner.address, 123);
        const walletAddress = await factory.getWallet(owner.address);
        
        expect(walletAddress).to.not.equal(ethers.ZeroAddress);
        expect(await factory.isValidWallet(walletAddress)).to.be.true;
        
        const smartWallet = await ethers.getContractAt("SmartWallet", walletAddress);
        expect(await smartWallet.owner()).to.equal(owner.address);
        expect(await smartWallet.entryPoint()).to.equal(entryPoint.target);
    });

    it("Should deploy paymaster correctly", async function () {
        const { factory, entryPoint, owner } = await deploySystem();
        
        const paymaster = await ethers.deployContract("LendefiPaymaster", [entryPoint.target, factory.target]);
        
        expect(paymaster.target).to.not.equal(ethers.ZeroAddress);
        expect(await paymaster.entryPoint()).to.equal(entryPoint.target);
        expect(await paymaster.smartWalletFactory()).to.equal(factory.target);
        expect(await paymaster.owner()).to.equal(owner.address);
    });

    it("Should complete full system deployment", async function () {
        const { factory, entryPoint, owner, user1 } = await deploySystem();
        
        // Deploy paymaster
        const paymaster = await ethers.deployContract("LendefiPaymaster", [entryPoint.target, factory.target]);
        
        // Create wallet
        await factory.createAccount(user1.address, 456);
        const walletAddress = await factory.getWallet(user1.address);
        const smartWallet = await ethers.getContractAt("SmartWallet", walletAddress);
        
        // Fund paymaster
        await paymaster.deposit({ value: ethers.parseEther("1") });
        
        // Grant subscription
        await paymaster.grantSubscription(user1.address, 1, 3600); // BASIC tier
        
        // Verify everything works
        expect(await smartWallet.owner()).to.equal(user1.address);
        expect(await paymaster.hasActiveSubscription(user1.address)).to.be.true;
        expect(await paymaster.getDeposit()).to.equal(ethers.parseEther("1"));
    });
});