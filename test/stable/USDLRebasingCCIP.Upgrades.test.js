const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlRebasingCCIPFixture, usdlRebasingCCIPWithBalanceFixture } = require("./helpers/rebasingSetup");

// Helper to compute interface ID from function signatures (XOR of all selectors)
function computeInterfaceId(signatures) {
    let interfaceId = 0n;
    for (const sig of signatures) {
        const selector = ethers.keccak256(ethers.toUtf8Bytes(sig)).slice(0, 10);
        interfaceId ^= BigInt(selector);
    }
    return "0x" + interfaceId.toString(16).padStart(8, "0");
}

// IGetCCIPAdmin has just one function
const IGET_CCIP_ADMIN_FUNCTIONS = ["getCCIPAdmin()"];

// IBurnMintERC20 extends IERC20, just the additional functions for interface ID
const IBURN_MINT_ERC20_FUNCTIONS = [
    "mint(address,uint256)",
    "burn(uint256)",
    "burn(address,uint256)",
    "burnFrom(address,uint256)"
];

describe("USDLRebasingCCIP - Upgrades & Interfaces", function () {

    describe("UUPS Upgrade", function () {
        it("Should upgrade to new implementation", async function () {
            const { token, owner } = await loadFixture(usdlRebasingCCIPFixture);

            // Version starts at 0
            expect(await token.version()).to.equal(0);

            // Deploy V2 implementation
            const USDLRebasingCCIPV2 = await ethers.getContractFactory("USDLRebasingCCIPV2");
            const v2Impl = await USDLRebasingCCIPV2.deploy();
            await v2Impl.waitForDeployment();
            
            // Upgrade via UUPS
            await token.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");
            
            // Version increments to 1 after upgrade
            expect(await token.version()).to.equal(1);
        });

        it("Should preserve state after upgrade", async function () {
            const { token, owner, user1, user2, initialBalance1, initialBalance2 } = 
                await loadFixture(usdlRebasingCCIPWithBalanceFixture);

            // Store pre-upgrade state
            const preUpgradeBalance1 = await token.balanceOf(user1.address);
            const preUpgradeTotalSupply = await token.totalSupply();
            const preUpgradeRebaseIndex = await token.rebaseIndex();

            // Deploy V2 and upgrade via UUPS
            const USDLRebasingCCIPV2 = await ethers.getContractFactory("USDLRebasingCCIPV2");
            const v2Impl = await USDLRebasingCCIPV2.deploy();
            await v2Impl.waitForDeployment();
            await token.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            // Verify state is preserved
            expect(await token.balanceOf(user1.address)).to.equal(preUpgradeBalance1);
            expect(await token.totalSupply()).to.equal(preUpgradeTotalSupply);
            expect(await token.rebaseIndex()).to.equal(preUpgradeRebaseIndex);
        });

        it("Should revert upgrade when caller does not have UPGRADER_ROLE", async function () {
            const { token, user1 } = await loadFixture(usdlRebasingCCIPFixture);

            const USDLRebasingCCIPV2 = await ethers.getContractFactory("USDLRebasingCCIPV2");
            const newImpl = await USDLRebasingCCIPV2.deploy();
            await newImpl.waitForDeployment();

            await expect(
                token.connect(user1).upgradeToAndCall(await newImpl.getAddress(), "0x")
            ).to.be.reverted;
        });

        it("Should revert upgrade to zero address", async function () {
            const { token, owner } = await loadFixture(usdlRebasingCCIPFixture);

            await expect(
                token.connect(owner).upgradeToAndCall(ethers.ZeroAddress, "0x")
            ).to.be.revertedWithCustomError(token, "ZeroAddress");
        });
    });

    describe("Interface Support (ERC165)", function () {
        it("Should support IBurnMintERC20 interface", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            const IBURN_MINT_ERC20_ID = computeInterfaceId(IBURN_MINT_ERC20_FUNCTIONS);
            expect(await token.supportsInterface(IBURN_MINT_ERC20_ID)).to.be.true;
        });

        it("Should support IGetCCIPAdmin interface", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            const IGET_CCIP_ADMIN_ID = computeInterfaceId(IGET_CCIP_ADMIN_FUNCTIONS);
            expect(await token.supportsInterface(IGET_CCIP_ADMIN_ID)).to.be.true;
        });

        it("Should support IAccessControl interface", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            // IAccessControl interface ID: 0x7965db0b
            const IACCESS_CONTROL_ID = "0x7965db0b";
            expect(await token.supportsInterface(IACCESS_CONTROL_ID)).to.be.true;
        });

        it("Should support IERC165 interface", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            // IERC165 interface ID: 0x01ffc9a7
            const IERC165_ID = "0x01ffc9a7";
            expect(await token.supportsInterface(IERC165_ID)).to.be.true;
        });

        it("Should return false for unsupported interface", async function () {
            const { token } = await loadFixture(usdlRebasingCCIPFixture);
            expect(await token.supportsInterface("0xffffffff")).to.be.false;
        });
    });

    describe("Role Management", function () {
        it("Should allow admin to grant roles", async function () {
            const { token, owner, user1, BRIDGE_ROLE } = await loadFixture(usdlRebasingCCIPFixture);

            await token.connect(owner).grantRole(BRIDGE_ROLE, user1.address);
            expect(await token.hasRole(BRIDGE_ROLE, user1.address)).to.be.true;
        });

        it("Should allow admin to revoke roles", async function () {
            const { token, owner, bridge, BRIDGE_ROLE } = await loadFixture(usdlRebasingCCIPFixture);

            expect(await token.hasRole(BRIDGE_ROLE, bridge.address)).to.be.true;
            await token.connect(owner).revokeRole(BRIDGE_ROLE, bridge.address);
            expect(await token.hasRole(BRIDGE_ROLE, bridge.address)).to.be.false;
        });

        it("Should revert when non-admin tries to grant roles", async function () {
            const { token, user1, user2, BRIDGE_ROLE } = await loadFixture(usdlRebasingCCIPFixture);

            await expect(
                token.connect(user1).grantRole(BRIDGE_ROLE, user2.address)
            ).to.be.reverted;
        });
    });
});
