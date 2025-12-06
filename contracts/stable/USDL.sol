// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IGetCCIPAdmin} from "../interfaces/IGetCCIPAdmin.sol";
import {IBurnMintERC20} from "../interfaces/IBurnMintERC20.sol";
import {IYieldRouter} from "../interfaces/IYieldRouter.sol";
import {IUSDL} from "../interfaces/IUSDL.sol";

/**
 * @title USDL - Yield-Bearing USD Vault
 * @author Lendefi Markets
 * @notice ERC-4626 vault that accepts USDC deposits and delegates yield management to YieldRouter
 * @dev Users deposit USDC, receive USDL shares. Share price increases as yield accrues from underlying protocols.
 *
 *      Architecture:
 *      - USDL: ERC20/ERC4626 vault, rebasing mechanism, access control, CCIP bridge
 *      - YieldRouter: Yield asset management, protocol routing, Chainlink Automation
 *
 *      Key mechanisms:
 *      - Internal Accounting: totalDepositedAssets tracks user deposits
 *      - Rebase Index: Increases with yield accrual, distributing gains proportionally
 *      - Router Integration: All yield operations delegated to YieldRouter
 *
 * @custom:security-contact security@lendefimarkets.com
 */
/// @custom:oz-upgrades
contract USDL is
    IERC165,
    IGetCCIPAdmin,
    IBurnMintERC20,
    IERC4626,
    IUSDL,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ============ Constants ============

    /// @notice Basis points divisor (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Minimum deposit amount in USDC (1 USDC with 6 decimals)
    uint256 public constant MIN_DEPOSIT = 1e6;

    /// @notice Maximum redemption fee in basis points (5%)
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice Precision for rebase index (1e6 for 6 decimal token)
    uint256 public constant REBASE_INDEX_PRECISION = 1e6;

    /// @notice Minimum hold time in blocks to prevent flash loan/sandwich attacks
    uint256 public constant MIN_HOLD_BLOCKS = 5;

    /// @dev AccessControl Role Constants
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");

    // ============ Storage Variables ============

    /// @notice Deployed version (increments on each upgrade)
    uint256 public version;

    /// @notice CCIP admin address for token admin registry
    address public ccipAdmin;

    /// @notice Blacklisted addresses (for compliance)
    mapping(address account => bool isBlacklisted) public blacklisted;

    /// @notice Treasury address for fees
    address public treasury;

    /// @notice Underlying asset address (USDC)
    address public assetAddress;

    /// @notice Redemption fee in basis points (e.g., 10 = 0.1%)
    uint256 public redemptionFeeBps;

    /// @notice Total assets deposited by users (internal accounting)
    uint256 public totalDepositedAssets;

    /// @notice Rebase index for yield distribution (starts at 1e6, increases with yield)
    uint256 public rebaseIndex;

    /// @notice Yield router for protocol interactions
    IYieldRouter public yieldRouter;

    // ============ ERC20 Storage (owned, not inherited) ============

    /// @notice Token name
    string private _name;

    /// @notice Token symbol
    string private _symbol;

    /// @notice Raw share balances (not rebased)
    mapping(address => uint256) private _shares;

    /// @notice Total raw shares (not rebased)
    uint256 private _totalShares;

    /// @notice Allowances (stored in REBASED units for UX consistency)
    mapping(address => mapping(address => uint256)) private _allowances;

    /// @notice Last deposit block number for each account
    mapping(address => uint256) public lastDepositBlock;

    /// @notice Storage gap for future upgrades
    uint256[39] private __gap;

    // ============ Events ============

    event CCIPAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);
    event Upgrade(address indexed sender, address indexed implementation);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event RedemptionFeeUpdated(uint256 indexed oldFeeBps, uint256 indexed newFeeBps);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 indexed amount);
    event RebaseIndexUpdated(uint256 indexed oldIndex, uint256 indexed newIndex);
    event TotalDepositedAssetsUpdated(uint256 indexed oldAmount, uint256 indexed newAmount);
    event BridgeMint(address indexed caller, address indexed account, uint256 indexed amount);
    event BridgeBurn(address indexed caller, address indexed account, uint256 indexed amount);
    event YieldRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event DonatedTokensRescued(address indexed to, uint256 indexed amount);

    // ============ Errors ============

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient(address recipient);
    error AddressBlacklisted(address account);
    error BelowMinimumDeposit(uint256 amount, uint256 minimum);
    error InvalidFee(uint256 fee);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error MinHoldPeriodNotReached(uint256 currentBlock, uint256 unlockBlock);
    error RouterNotSet();

    // ============ Modifiers ============

    modifier nonZeroAmount(uint256 amount) {
        if (amount == 0) revert ZeroAmount();
        _;
    }

    modifier nonZeroAddress(address addr) {
        if (addr == address(0)) revert ZeroAddress();
        _;
    }

    modifier notBlacklisted(address account) {
        if (blacklisted[account]) revert AddressBlacklisted(account);
        _;
    }

    modifier routerConfigured() {
        if (address(yieldRouter) == address(0)) revert RouterNotSet();
        _;
    }

    // ============ Constructor ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    /**
     * @notice Initialize the USDL vault
     * @param _multisig Owner/admin address (Multisig)
     * @param _usdc USDC token address (underlying asset)
     * @param _treasury Treasury address for fees
     */
    function initialize(address _multisig, address _usdc, address _treasury) external initializer {
        if (_multisig == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        _name = "Lendefi USD";
        _symbol = "USDL";

        __Pausable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(PAUSER_ROLE, _multisig);
        _grantRole(UPGRADER_ROLE, _multisig);
        _grantRole(BLACKLISTER_ROLE, _multisig);

        version = 4;
        ccipAdmin = _multisig;
        treasury = _treasury;
        assetAddress = _usdc;
        redemptionFeeBps = 10; // 0.1%
        rebaseIndex = REBASE_INDEX_PRECISION; // 1:1 initially
    }

    // ============ Admin Functions ============

    /**
     * @notice Set the yield router address
     * @param router YieldRouter contract address
     */
    function setYieldRouter(address router) external nonZeroAddress(router) onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldRouter = address(yieldRouter);

        // Revoke old router's role if exists
        if (oldRouter != address(0)) {
            _revokeRole(ROUTER_ROLE, oldRouter);
        }

        yieldRouter = IYieldRouter(router);
        _grantRole(ROUTER_ROLE, router);

        // Approve router to spend USDC
        IERC20(assetAddress).approve(router, type(uint256).max);

        emit YieldRouterUpdated(oldRouter, router);
    }

    /**
     * @notice Grant bridge role (for CCIP Token Pool)
     * @param bridge Address to grant BRIDGE_ROLE to
     */
    function grantBridgeRole(address bridge) external nonZeroAddress(bridge) onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(BRIDGE_ROLE, bridge);
    }

    /**
     * @notice Revoke bridge role
     * @param bridge Address to revoke BRIDGE_ROLE from
     */
    function revokeBridgeRole(address bridge) external nonZeroAddress(bridge) onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(BRIDGE_ROLE, bridge);
    }

    /**
     * @notice Set CCIP admin address
     * @param newAdmin New CCIP admin address
     */
    function setCCIPAdmin(address newAdmin) external nonZeroAddress(newAdmin) onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAdmin = ccipAdmin;
        ccipAdmin = newAdmin;
        emit CCIPAdminTransferred(oldAdmin, newAdmin);
    }

    /**
     * @notice Set treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external nonZeroAddress(newTreasury) onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Set redemption fee
     * @param newFeeBps New redemption fee in basis points (max MAX_FEE_BPS = 5%)
     */
    function setRedemptionFee(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee(newFeeBps);

        uint256 oldFeeBps = redemptionFeeBps;
        redemptionFeeBps = newFeeBps;
        emit RedemptionFeeUpdated(oldFeeBps, newFeeBps);
    }

    /**
     * @notice Blacklist an address
     * @param account Address to blacklist
     */
    function blacklist(address account) external nonZeroAddress(account) onlyRole(BLACKLISTER_ROLE) {
        blacklisted[account] = true;
        emit Blacklisted(account);
    }

    /**
     * @notice Remove address from blacklist
     * @param account Address to remove from blacklist
     */
    function unblacklist(address account) external nonZeroAddress(account) onlyRole(BLACKLISTER_ROLE) {
        blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @notice Emergency withdraw tokens
     * @param token Token address to withdraw
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonZeroAddress(token)
        nonZeroAddress(to)
        nonZeroAmount(amount)
    {
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /**
     * @notice Rescue USDC tokens sent directly to this contract (donations)
     * @param to Address to receive rescued tokens
     * @dev Since all deposited USDC is transferred to the router immediately,
     *      any USDC balance in this contract is considered donated/excess
     */
    function rescueDonatedTokens(address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonZeroAddress(to) {
        IERC20 usdc = IERC20(assetAddress);
        uint256 balance = usdc.balanceOf(address(this));

        // Any USDC in this contract is excess (all deposits go to router)
        if (balance > 0) {
            usdc.safeTransfer(to, balance);
            emit DonatedTokensRescued(to, balance);
        }
    }

    // ============ Router Callback Functions ============

    /**
     * @inheritdoc IUSDL
     */
    function updateRebaseIndex(uint256 newIndex) external override onlyRole(ROUTER_ROLE) {
        uint256 oldIndex = rebaseIndex;
        rebaseIndex = newIndex;
        emit RebaseIndexUpdated(oldIndex, newIndex);
    }

    /**
     * @inheritdoc IUSDL
     */
    function updateTotalDepositedAssets(uint256 newTotal) external override onlyRole(ROUTER_ROLE) {
        uint256 oldAmount = totalDepositedAssets;
        totalDepositedAssets = newTotal;
        emit TotalDepositedAssetsUpdated(oldAmount, newTotal);
    }

    // ============ CCIP Bridge Functions ============

    /**
     * @notice Mint shares for CCIP bridge (Ghost Share pattern)
     * @param account Address receiving the newly minted shares
     * @param amount Amount of RAW SHARES to mint
     */
    function mint(address account, uint256 amount)
        external
        whenNotPaused
        onlyRole(BRIDGE_ROLE)
        notBlacklisted(account)
    {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (account == address(this)) revert InvalidRecipient(account);

        _mintSharesCCIP(account, amount);
        emit BridgeMint(msg.sender, account, amount);
    }

    /**
     * @notice Burn shares for CCIP bridge (Ghost Share pattern)
     * @param account Address to burn from
     * @param amount Amount of RAW SHARES to burn
     */
    function burn(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _burnSharesCCIP(account, amount);
        emit BridgeBurn(msg.sender, account, amount);
    }

    /**
     * @notice Burn shares from caller's balance
     * @param amount Amount of RAW SHARES to burn
     */
    function burn(uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        if (amount == 0) revert ZeroAmount();

        _burnSharesCCIP(msg.sender, amount);
        emit BridgeBurn(msg.sender, msg.sender, amount);
    }

    /**
     * @notice Burn shares from account using allowance
     * @param account Address to burn from
     * @param amount Amount of RAW SHARES to burn
     */
    function burnFrom(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 rebasedAmount = _toRebasedAmount(amount, Math.Rounding.Ceil);
        _spendAllowance(account, msg.sender, rebasedAmount);

        _burnSharesCCIP(account, amount);
        emit BridgeBurn(msg.sender, account, amount);
    }

    // ============ ERC4626 Deposit/Withdraw ============

    /**
     * @notice Deposit USDC to receive shares
     * @param assets Amount of USDC to deposit
     * @param receiver Address receiving the shares
     * @return shares Number of rebased shares minted
     */
    function deposit(uint256 assets, address receiver)
        public
        nonReentrant
        whenNotPaused
        routerConfigured
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        returns (uint256 shares)
    {
        if (assets < MIN_DEPOSIT) {
            revert BelowMinimumDeposit(assets, MIN_DEPOSIT);
        }
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert InvalidRecipient(receiver);

        uint256 rawShares = _convertToShares(assets, Math.Rounding.Floor);
        if (rawShares == 0) revert ZeroAmount();

        // Transfer USDC from sender to this contract
        IERC20(assetAddress).safeTransferFrom(msg.sender, address(this), assets);

        // Update internal accounting
        totalDepositedAssets += assets;

        // Transfer to router and deposit to protocols
        IERC20(assetAddress).safeTransfer(address(yieldRouter), assets);
        yieldRouter.depositToProtocols(assets);

        // Mint shares
        _mintShares(receiver, rawShares);
        lastDepositBlock[receiver] = block.number;
        shares = _toRebasedAmount(rawShares, Math.Rounding.Floor);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /**
     * @notice Mint shares by depositing USDC
     * @param shares Number of rebased shares to mint
     * @param receiver Address receiving the shares
     * @return assets Amount of USDC deposited
     */
    function mint(uint256 shares, address receiver)
        public
        nonReentrant
        whenNotPaused
        routerConfigured
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert InvalidRecipient(receiver);

        uint256 rawShares = _toRawShares(shares, Math.Rounding.Ceil);
        assets = _convertToAssets(rawShares, Math.Rounding.Ceil);

        if (assets < MIN_DEPOSIT) {
            revert BelowMinimumDeposit(assets, MIN_DEPOSIT);
        }

        // Transfer USDC from sender
        IERC20(assetAddress).safeTransferFrom(msg.sender, address(this), assets);

        // Update internal accounting
        totalDepositedAssets += assets;

        // Transfer to router and deposit to protocols
        IERC20(assetAddress).safeTransfer(address(yieldRouter), assets);
        yieldRouter.depositToProtocols(assets);

        // Mint shares
        _mintShares(receiver, rawShares);
        lastDepositBlock[receiver] = block.number;

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /**
     * @notice Withdraw USDC by burning shares
     * @param assets Amount of USDC to withdraw
     * @param receiver Address receiving the USDC
     * @param owner Address whose shares are being burned
     * @return shares Number of rebased shares burned
     */
    function withdraw(uint256 assets, address receiver, address owner)
        public
        nonReentrant
        whenNotPaused
        routerConfigured
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        notBlacklisted(owner)
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (block.number < lastDepositBlock[owner] + MIN_HOLD_BLOCKS) {
            revert MinHoldPeriodNotReached(block.number, lastDepositBlock[owner] + MIN_HOLD_BLOCKS);
        }
        if (assets > totalDepositedAssets) {
            revert InsufficientLiquidity(assets, totalDepositedAssets);
        }

        uint256 rawShares = _convertToShares(assets, Math.Rounding.Ceil);
        shares = _toRebasedAmount(rawShares, Math.Rounding.Ceil);

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        uint256 fee = (assets * redemptionFeeBps) / BASIS_POINTS;
        uint256 netAssets = assets - fee;

        // Update internal accounting
        totalDepositedAssets -= assets;

        // Redeem from router
        yieldRouter.redeemFromProtocols(assets);

        // Burn shares
        _burnShares(owner, rawShares);

        // Transfer fee to treasury
        if (fee > 0) {
            IERC20(assetAddress).safeTransfer(treasury, fee);
        }

        // Transfer to receiver
        IERC20(assetAddress).safeTransfer(receiver, netAssets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /**
     * @notice Redeem shares for USDC
     * @param shares Amount of rebased shares to redeem
     * @param receiver Address receiving the USDC
     * @param owner Address whose shares are being redeemed
     * @return assets Amount of USDC returned
     */
    function redeem(uint256 shares, address receiver, address owner)
        public
        nonReentrant
        whenNotPaused
        routerConfigured
        notBlacklisted(msg.sender)
        notBlacklisted(receiver)
        notBlacklisted(owner)
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (block.number < lastDepositBlock[owner] + MIN_HOLD_BLOCKS) {
            revert MinHoldPeriodNotReached(block.number, lastDepositBlock[owner] + MIN_HOLD_BLOCKS);
        }

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        uint256 rawShares = _toRawShares(shares, Math.Rounding.Floor);
        assets = _convertToAssets(rawShares, Math.Rounding.Floor);

        uint256 deposited = totalDepositedAssets;
        if (assets > deposited) {
            assets = deposited;
        }

        // Update internal accounting
        totalDepositedAssets -= assets;

        // Redeem from router - use actual amount received
        uint256 redeemed = yieldRouter.redeemFromProtocols(assets);

        // Calculate fee based on what we actually received
        uint256 fee = (redeemed * redemptionFeeBps) / BASIS_POINTS;
        uint256 netAssets = redeemed - fee;

        // Burn shares
        _burnShares(owner, rawShares);

        // Transfer fee to treasury
        if (fee > 0) {
            IERC20(assetAddress).safeTransfer(treasury, fee);
        }

        // Transfer to receiver
        IERC20(assetAddress).safeTransfer(receiver, netAssets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    // ============ ERC20 Functions ============

    function transfer(address to, uint256 value) public override whenNotPaused returns (bool) {
        _transferShares(msg.sender, to, _toRawShares(value, Math.Rounding.Floor));
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override whenNotPaused returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transferShares(from, to, _toRawShares(value, Math.Rounding.Floor));
        return true;
    }

    function approve(address spender, uint256 value) public override whenNotPaused returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    // ============ View Functions ============

    /// @inheritdoc IGetCCIPAdmin
    function getCCIPAdmin() external view override returns (address) {
        return ccipAdmin;
    }

    /// @inheritdoc IUSDL
    function asset() public view override(IERC4626, IUSDL) returns (address) {
        return assetAddress;
    }

    function totalAssets() public view override returns (uint256) {
        return totalDepositedAssets;
    }

    function totalSupply() public view override returns (uint256) {
        return _toRebasedAmount(_totalShares, Math.Rounding.Floor);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _toRebasedAmount(_shares[account], Math.Rounding.Floor);
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function sharesOf(address account) public view returns (uint256) {
        return _shares[account];
    }

    function totalShares() public view returns (uint256) {
        return _totalShares;
    }

    function previewDeposit(uint256 assets) public view override returns (uint256) {
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Floor);
        return _toRebasedAmount(rawShares, Math.Rounding.Floor);
    }

    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 rawShares = _toRawShares(shares, Math.Rounding.Ceil);
        return _convertToAssets(rawShares, Math.Rounding.Ceil);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Ceil);
        return _toRebasedAmount(rawShares, Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 rawShares = _toRawShares(shares, Math.Rounding.Floor);
        uint256 assets = _convertToAssets(rawShares, Math.Rounding.Floor);
        uint256 fee = (assets * redemptionFeeBps) / BASIS_POINTS;
        return assets - fee;
    }

    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 rawShares = _convertToShares(assets, Math.Rounding.Floor);
        return _toRebasedAmount(rawShares, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 rawShares = _toRawShares(shares, Math.Rounding.Floor);
        return _convertToAssets(rawShares, Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 rawShares = _shares[owner];
        return _convertToAssets(rawShares, Math.Rounding.Floor);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return balanceOf(owner);
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function getRebaseIndex() external view returns (uint256) {
        return rebaseIndex;
    }

    function sharePrice() external view returns (uint256 price) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e6;
        price = (totalAssets() * 1e6) / supply;
    }

    function getPrice() external view returns (uint256 price) {
        price = previewRedeem(1e6);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC20).interfaceId 
            || interfaceId == type(IERC4626).interfaceId
            || interfaceId == type(IERC165).interfaceId 
            || interfaceId == type(IAccessControl).interfaceId
            || interfaceId == type(IGetCCIPAdmin).interfaceId 
            || interfaceId == type(IBurnMintERC20).interfaceId
            || interfaceId == type(IUSDL).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // ============ Pure Functions ============

    function maxDeposit(address) public pure override returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) public pure override returns (uint256) {
        return type(uint256).max;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ============ Internal Functions ============

    function _mintShares(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        _shares[account] += rawShares;
        _totalShares += rawShares;

        uint256 rebasedAmount = _toRebasedAmount(rawShares, Math.Rounding.Floor);
        emit Transfer(address(0), account, rebasedAmount);
    }

    function _burnShares(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        uint256 accountShares = _shares[account];
        if (accountShares < rawShares) {
            revert ERC20InsufficientBalance(account, accountShares, rawShares);
        }

        unchecked {
            _shares[account] = accountShares - rawShares;
        }
        _totalShares -= rawShares;

        uint256 rebasedAmount = _toRebasedAmount(rawShares, Math.Rounding.Floor);
        emit Transfer(account, address(0), rebasedAmount);
    }

    function _mintSharesCCIP(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        _shares[account] += rawShares;
        // NOTE: Do NOT increment _totalShares for CCIP mints

        uint256 rebasedAmount = _toRebasedAmount(rawShares, Math.Rounding.Floor);
        emit Transfer(address(0), account, rebasedAmount);
    }

    function _burnSharesCCIP(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();

        uint256 accountShares = _shares[account];
        if (accountShares < rawShares) {
            revert ERC20InsufficientBalance(account, accountShares, rawShares);
        }

        unchecked {
            _shares[account] = accountShares - rawShares;
        }
        // NOTE: Do NOT decrement _totalShares for CCIP burns

        uint256 rebasedAmount = _toRebasedAmount(rawShares, Math.Rounding.Floor);
        emit Transfer(account, address(0), rebasedAmount);
    }

    function _transferShares(address from, address to, uint256 rawShares) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (blacklisted[from]) revert AddressBlacklisted(from);
        if (blacklisted[to]) revert AddressBlacklisted(to);

        uint256 fromShares = _shares[from];
        if (fromShares < rawShares) {
            revert ERC20InsufficientBalance(from, fromShares, rawShares);
        }

        unchecked {
            _shares[from] = fromShares - rawShares;
        }
        _shares[to] += rawShares;
        lastDepositBlock[to] = block.number;

        uint256 rebasedAmount = _toRebasedAmount(rawShares, Math.Rounding.Floor);
        emit Transfer(from, to, rebasedAmount);
    }

    function _approve(address owner, address spender, uint256 value) internal {
        if (owner == address(0)) revert ZeroAddress();
        if (spender == address(0)) revert ZeroAddress();
        _allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 currentAllowance = _allowances[owner][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _allowances[owner][spender] = currentAllowance - value;
            }
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {
        if (newImplementation == address(0)) revert ZeroAddress();
        ++version;
        emit Upgrade(msg.sender, newImplementation);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view returns (uint256 shares) {
        uint256 supply = _totalShares;
        uint256 depositedAssets = totalDepositedAssets;

        if (supply == 0 || depositedAssets == 0) {
            return assets;
        }

        return assets.mulDiv(supply, depositedAssets, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view returns (uint256 assets) {
        uint256 supply = _totalShares;
        uint256 depositedAssets = totalDepositedAssets;

        if (supply == 0 || depositedAssets == 0) {
            return shares;
        }

        return shares.mulDiv(depositedAssets, supply, rounding);
    }

    function _toRawShares(uint256 rebasedAmount, Math.Rounding rounding) internal view returns (uint256 rawShares) {
        if (rebaseIndex == 0) return rebasedAmount;
        return rebasedAmount.mulDiv(REBASE_INDEX_PRECISION, rebaseIndex, rounding);
    }

    function _toRebasedAmount(uint256 rawShares, Math.Rounding rounding) internal view returns (uint256 rebasedAmount) {
        if (rebaseIndex == 0) return rawShares;
        return rawShares.mulDiv(rebaseIndex, REBASE_INDEX_PRECISION, rounding);
    }
}
