const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usdlFixture } = require("./helpers/setup");

// Helper to compute interface ID from function signatures (XOR of all selectors)
function computeInterfaceId(signatures) {
    let interfaceId = 0n;
    for (const sig of signatures) {
        const selector = ethers.keccak256(ethers.toUtf8Bytes(sig)).slice(0, 10);
        interfaceId ^= BigInt(selector);
    }
    return "0x" + interfaceId.toString(16).padStart(8, "0");
}

// Standard interface IDs (well-known)
const IERC165_ID = "0x01ffc9a7";
const IERC20_ID = "0x36372b07";
const IACCESS_CONTROL_ID = "0x7965db0b";

// IERC4626 functions (excluding ERC20 functions, just the vault-specific ones)
const IERC4626_FUNCTIONS = [
    "asset()",
    "totalAssets()",
    "convertToShares(uint256)",
    "convertToAssets(uint256)",
    "maxDeposit(address)",
    "previewDeposit(uint256)",
    "deposit(uint256,address)",
    "maxMint(address)",
    "previewMint(uint256)",
    "mint(uint256,address)",
    "maxWithdraw(address)",
    "previewWithdraw(uint256)",
    "withdraw(uint256,address,address)",
    "maxRedeem(address)",
    "previewRedeem(uint256)",
    "redeem(uint256,address,address)"
];

// IGetCCIPAdmin has just one function
const IGET_CCIP_ADMIN_FUNCTIONS = ["getCCIPAdmin()"];

// IBurnMintERC20 extends IERC20, just the additional functions for interface ID
// The interface ID is just for the NEW functions, not inherited ones
const IBURN_MINT_ERC20_FUNCTIONS = [
    "mint(address,uint256)",
    "burn(uint256)",
    "burn(address,uint256)",
    "burnFrom(address,uint256)"
];

describe("USDL - Interface Support", function () {

    describe("ERC165 supportsInterface", function () {
        it("Should support IERC20 interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.supportsInterface(IERC20_ID)).to.be.true;
        });

        it("Should support IERC4626 interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const IERC4626_ID = computeInterfaceId(IERC4626_FUNCTIONS);
            expect(await usdl.supportsInterface(IERC4626_ID)).to.be.true;
        });

        it("Should support IERC165 interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.supportsInterface(IERC165_ID)).to.be.true;
        });

        it("Should support IAccessControl interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.supportsInterface(IACCESS_CONTROL_ID)).to.be.true;
        });

        it("Should support IGetCCIPAdmin interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const IGET_CCIP_ADMIN_ID = computeInterfaceId(IGET_CCIP_ADMIN_FUNCTIONS);
            expect(await usdl.supportsInterface(IGET_CCIP_ADMIN_ID)).to.be.true;
        });

        it("Should support IBurnMintERC20 interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            const IBURN_MINT_ERC20_ID = computeInterfaceId(IBURN_MINT_ERC20_FUNCTIONS);
            expect(await usdl.supportsInterface(IBURN_MINT_ERC20_ID)).to.be.true;
        });

        it("Should return false for unsupported interface", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            // Random interface ID
            expect(await usdl.supportsInterface("0xffffffff")).to.be.false;
        });
    });

    describe("ERC20 Metadata", function () {
        it("Should return correct name", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.name()).to.equal("Lendefi USD");
        });

        it("Should return correct symbol", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.symbol()).to.equal("USDL");
        });

        it("Should return correct decimals", async function () {
            const { usdl } = await loadFixture(usdlFixture);
            expect(await usdl.decimals()).to.equal(6);
        });
    });

    describe("ERC4626 Asset", function () {
        it("Should return underlying asset", async function () {
            const { usdl, usdc } = await loadFixture(usdlFixture);
            expect(await usdl.asset()).to.equal(await usdc.getAddress());
        });
    });
});
