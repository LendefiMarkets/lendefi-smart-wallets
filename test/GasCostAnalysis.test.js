const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Gas Cost Analysis", function () {
    async function deployFixture() {
        const [owner, user1, user2, user3] = await ethers.getSigners();

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

        return {
            factory,
            entryPoint,
            owner,
            user1,
            user2,
            user3
        };
    }

    describe("Wallet Creation Gas Costs", function () {
        it("Should measure gas cost of creating first wallet", async function () {
            const { factory, user1 } = await loadFixture(deployFixture);

            // Measure gas for first wallet creation
            const tx = await factory.createAccount(user1.address, 123);
            const receipt = await tx.wait();
            
            console.log(`First wallet creation gas used: ${receipt.gasUsed.toLocaleString()}`);
            
            // Verify wallet was created
            const walletAddress = await factory.getWallet(user1.address);
            expect(walletAddress).to.not.equal(ethers.ZeroAddress);
            expect(await factory.isValidWallet(walletAddress)).to.be.true;

            // Gas should be significantly less than full contract deployment
            expect(receipt.gasUsed).to.be.lt(210000); // Should be much less than 210k gas
        });

        it("Should measure gas cost of creating multiple wallets", async function () {
            const { factory, user1, user2, user3 } = await loadFixture(deployFixture);

            const users = [user1, user2, user3];
            const gasCosts = [];

            for (let i = 0; i < users.length; i++) {
                const tx = await factory.createAccount(users[i].address, i + 100);
                const receipt = await tx.wait();
                gasCosts.push(receipt.gasUsed);
                
                console.log(`Wallet ${i + 1} creation gas used: ${receipt.gasUsed.toLocaleString()}`);
            }

            // All wallet creations should have similar gas costs
            const maxGas = Math.max(...gasCosts.map(g => Number(g)));
            const minGas = Math.min(...gasCosts.map(g => Number(g)));
            const avgGas = gasCosts.reduce((sum, gas) => sum + Number(gas), 0) / gasCosts.length;

            console.log(`Gas cost analysis:`);
            console.log(`  Min: ${minGas.toLocaleString()}`);
            console.log(`  Max: ${maxGas.toLocaleString()}`);
            console.log(`  Avg: ${Math.round(avgGas).toLocaleString()}`);
            console.log(`  Variation: ${((maxGas - minGas) / avgGas * 100).toFixed(1)}%`);

            // Gas costs should be consistent (within 5% variation)
            expect((maxGas - minGas) / avgGas).to.be.lt(0.05);
        });

        it("Should compare wallet creation vs full deployment gas cost", async function () {
            const { factory, entryPoint, user1 } = await loadFixture(deployFixture);

            // Measure wallet creation via factory (clone)
            const cloneTx = await factory.createAccount(user1.address, 200);
            const cloneReceipt = await cloneTx.wait();
            const cloneGas = cloneReceipt.gasUsed;

            // Measure full contract deployment for comparison
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const fullDeployTx = await SmartWallet.deploy(entryPoint.target);
            const fullDeployReceipt = await fullDeployTx.deploymentTransaction().wait();
            const fullDeployGas = fullDeployReceipt.gasUsed;

            console.log(`\nGas Cost Comparison:`);
            console.log(`  Clone creation: ${cloneGas.toLocaleString()} gas`);
            console.log(`  Full deployment: ${fullDeployGas.toLocaleString()} gas`);
            console.log(`  Savings: ${(fullDeployGas - cloneGas).toLocaleString()} gas`);
            console.log(`  Efficiency: ${((Number(fullDeployGas) - Number(cloneGas)) / Number(fullDeployGas) * 100).toFixed(1)}% reduction`);

            // Clone should be significantly more efficient
            expect(Number(cloneGas)).to.be.lt(Number(fullDeployGas)); // Clone uses less gas than full deployment
            expect(Number(cloneGas)).to.be.lt(Number(fullDeployGas) * 0.3); // At least 70% savings
        });

        it("Should measure gas cost with different salt values", async function () {
            const { factory, user1 } = await loadFixture(deployFixture);

            // Test with various salt values
            const saltValues = [0, 1, 123456789, ethers.MaxUint256];
            const gasCosts = [];

            for (let i = 0; i < saltValues.length; i++) {
                // Create new user for each test
                const [, , , , ...extraUsers] = await ethers.getSigners();
                const testUser = extraUsers[i];
                
                const tx = await factory.createAccount(testUser.address, saltValues[i]);
                const receipt = await tx.wait();
                gasCosts.push(receipt.gasUsed);
                
                console.log(`Salt ${saltValues[i]} gas used: ${receipt.gasUsed.toLocaleString()}`);
            }

            // Gas costs should be very similar regardless of salt
            const maxGas = Math.max(...gasCosts.map(g => Number(g)));
            const minGas = Math.min(...gasCosts.map(g => Number(g)));
            const avgGas = gasCosts.reduce((sum, gas) => sum + Number(gas), 0) / gasCosts.length;

            console.log(`Salt variation analysis:`);
            console.log(`  Variation: ${((maxGas - minGas) / avgGas * 100).toFixed(1)}%`);

            // Should have minimal variation (salt doesn't affect gas much)
            expect((maxGas - minGas) / avgGas).to.be.lt(0.02); // Less than 2% variation
        });
    });

    describe("Wallet Operation Gas Costs", function () {
        it("Should measure gas cost of basic wallet operations", async function () {
            const { factory, user1, user2 } = await loadFixture(deployFixture);

            // Create wallet
            await factory.createAccount(user1.address, 300);
            const walletAddress = await factory.getWallet(user1.address);
            const wallet = await ethers.getContractAt("SmartWallet", walletAddress);

            // Fund the wallet
            await user1.sendTransaction({
                to: walletAddress,
                value: ethers.parseEther("1")
            });

            // Measure basic execute operation
            const executeTx = await wallet.connect(user1).execute(
                user2.address,
                ethers.parseEther("0.1"),
                "0x"
            );
            const executeReceipt = await executeTx.wait();

            console.log(`\nWallet Operation Gas Costs:`);
            console.log(`  Basic execute: ${executeReceipt.gasUsed.toLocaleString()} gas`);

            // Measure batch execute
            const batchTx = await wallet.connect(user1).executeBatch(
                [user2.address, user2.address],
                [ethers.parseEther("0.05"), ethers.parseEther("0.05")],
                ["0x", "0x"]
            );
            const batchReceipt = await batchTx.wait();

            console.log(`  Batch execute (2 ops): ${batchReceipt.gasUsed.toLocaleString()} gas`);

            // Batch should be more efficient than 2 separate executes
            const estimatedTwoSeparate = executeReceipt.gasUsed * 2n;
            const savings = estimatedTwoSeparate - batchReceipt.gasUsed;
            
            console.log(`  Estimated 2 separate: ${estimatedTwoSeparate.toLocaleString()} gas`);
            console.log(`  Batch savings: ${savings.toLocaleString()} gas`);

            expect(batchReceipt.gasUsed).to.be.lt(estimatedTwoSeparate);
        });

        it("Should measure signature validation gas cost", async function () {
            const { factory, user1 } = await loadFixture(deployFixture);

            // Create wallet
            await factory.createAccount(user1.address, 400);
            const walletAddress = await factory.getWallet(user1.address);
            const wallet = await ethers.getContractAt("SmartWallet", walletAddress);

            // Test ERC-1271 signature validation
            const message = "Test message for gas measurement";
            const messageHash = ethers.hashMessage(message);
            const signature = await user1.signMessage(message);

            const validationTx = await wallet.isValidSignature(messageHash, signature);
            
            // This is a view function, but we can estimate gas
            const gasEstimate = await wallet.isValidSignature.estimateGas(messageHash, signature);
            
            console.log(`\nSignature Validation:`);
            console.log(`  Estimated gas: ${gasEstimate.toLocaleString()}`);
            console.log(`  Result: ${validationTx}`);
            
            expect(validationTx).to.equal("0x1626ba7e"); // ERC1271_MAGIC_VALUE
        });
    });

    describe("Factory Operations Gas Costs", function () {
        it("Should measure factory management operations", async function () {
            const { factory, entryPoint, owner } = await loadFixture(deployFixture);

            // Measure paymaster update
            const paymasterTx = await factory.connect(owner).setPaymaster(owner.address);
            const paymasterReceipt = await paymasterTx.wait();

            console.log(`\nFactory Management Gas Costs:`);
            console.log(`  Set paymaster: ${paymasterReceipt.gasUsed.toLocaleString()} gas`);

            // Measure implementation update
            const SmartWallet = await ethers.getContractFactory("SmartWallet");
            const newImpl = await SmartWallet.deploy(entryPoint.target);
            
            const implTx = await factory.connect(owner).setSmartWalletImplementation(newImpl.target);
            const implReceipt = await implTx.wait();

            console.log(`  Update implementation: ${implReceipt.gasUsed.toLocaleString()} gas`);
        });
    });
});