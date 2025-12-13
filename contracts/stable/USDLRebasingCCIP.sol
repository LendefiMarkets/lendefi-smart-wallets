// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IBurnMintERC20} from "../interfaces/IBurnMintERC20.sol";
import {IGetCCIPAdmin} from "../interfaces/IGetCCIPAdmin.sol";
import {IAggregatorV3Interface} from "../interfaces/IAggregatorV3Interface.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title USDLRebasingCCIP
/// @author Lendefi Markets
/// @notice Lightweight rebasing token for USDL on satellite chains
/// @dev Uses Chainlink price feeds to maintain 1:1 USDC peg with dynamic rebasing
contract USDLRebasingCCIP is
    Initializable,
    IERC165,
    IGetCCIPAdmin,
    IBurnMintERC20,
    PausableUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    using Math for uint256;

    /// @notice AccessControl role for CCIP bridge operations
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    /// @notice AccessControl role for authorizing upgrades
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// @notice AccessControl role for manager functions
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice Precision for rebase index (1e6 for 6 decimal token)
    uint256 public constant REBASE_INDEX_PRECISION = 1e6;
    
    // ============ Storage Variables ============
    
    /// @notice Deployed version (increments on each upgrade)
    uint256 public version;
    /// @notice Chainlink price feed contract
    IAggregatorV3Interface public priceFeed;
    /// @notice CCIP admin address for token pool registration
    address public ccipAdmin;
    /// @notice Current rebase index (updated from oracle)
    uint256 public rebaseIndex;

    // ============ ERC20 Storage (owned, not inherited) ============

    /// @notice Token name
    string private _name;
    /// @notice Token symbol
    string private _symbol;
    /// @notice Raw share balances (not rebased)
    mapping(address => uint256) private _shares;
    /// @notice Total raw shares (not rebased)
    uint256 private _totalShares;
    /// @notice Allowances (stored in REBASED amounts for UX)
    mapping(address => mapping(address => uint256)) private _allowances;

    // ============ Events ============

    /// @notice Emitted when rebase index is updated from price feed
    /// @param oldIndex Previous rebase index
    /// @param newIndex New rebase index
    event RebaseIndexUpdated(uint256 indexed oldIndex, uint256 indexed newIndex);
    /// @notice Emitted when bridge mints shares
    /// @param caller Address of CCIP bridge contract
    /// @param account Recipient of minted shares
    /// @param amount Number of shares minted
    event BridgeMint(address indexed caller, address indexed account, uint256 indexed amount);
    /// @notice Emitted when bridge burns shares
    /// @param caller Address of CCIP bridge contract
    /// @param account Address whose shares were burned
    /// @param amount Number of shares burned
    event BridgeBurn(address indexed caller, address indexed account, uint256 indexed amount);
    /// @notice Emitted when CCIP admin is transferred
    /// @param previousAdmin Previous CCIP admin address
    /// @param newAdmin New CCIP admin address
    event CCIPAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    /// @notice Emitted when contract is upgraded
    /// @param sender Address initiating the upgrade
    /// @param implementation New implementation address
    event Upgrade(address indexed sender, address indexed implementation);
    // ============ Errors ============

    /// @notice Thrown when zero address is provided
    error ZeroAddress();
    /// @notice Thrown when insufficient balance for operation
    error InsufficientBalance();
    /// @notice Thrown when insufficient allowance for operation
    error InsufficientAllowance();
    /// @notice Thrown when price is invalid
    error InvalidPrice();
    /// @notice Thrown when price is stale
    error StalePrice();

    /// @notice Disables initializers for upgradeable contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param _multisig Owner and admin address (Multisig)
    /// @param _priceFeed Chainlink price feed address (USDL price in USD)
    function initialize(address _multisig, address _priceFeed) external initializer {
        if (_multisig == address(0)) revert ZeroAddress();
        if (_priceFeed == address(0)) revert ZeroAddress();

        _name = "Lendefi USD V3 (CCIP)";
        _symbol = "USDL";

        __Pausable_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(UPGRADER_ROLE, _multisig);
        _grantRole(MANAGER_ROLE, _multisig);

        version = 1;
        ccipAdmin = _multisig;
        priceFeed = IAggregatorV3Interface(_priceFeed);
        rebaseIndex = REBASE_INDEX_PRECISION; // Start at 1.0
    }

    // ============ Admin Functions ============

    /**
     * @notice Pause the contract
     */
    function pause() external onlyRole(MANAGER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyRole(MANAGER_ROLE) {
        _unpause();
    }

    // ============ CCIP Interface (IBurnMintERC20) ============

    /**
     * @notice Mints shares for CCIP bridge
     * @param account Recipient address
     * @param amount Amount of RAW SHARES to mint
     */
    function mint(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        _mintShares(account, amount);
        emit BridgeMint(msg.sender, account, amount);
    }

    /**
     * @notice Burns shares for CCIP bridge
     * @param account Address to burn from
     * @param amount Amount of RAW SHARES to burn
     */
    function burn(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        _burnShares(account, amount);
        emit BridgeBurn(msg.sender, account, amount);
    }

    /**
     * @notice Burns shares from caller
     * @param amount Amount of RAW SHARES to burn
     */
    function burn(uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        _burnShares(msg.sender, amount);
        emit BridgeBurn(msg.sender, msg.sender, amount);
    }

    /**
     * @notice Burns shares from account using allowance
     * @param account Address to burn from
     * @param amount Amount of RAW SHARES to burn
     */
    function burnFrom(address account, uint256 amount) external whenNotPaused onlyRole(BRIDGE_ROLE) {
        // Allowance check uses rebased amount
        uint256 rebasedAmount = _toRebasedAmount(amount, Math.Rounding.Ceil);
        _spendAllowance(account, msg.sender, rebasedAmount);

        _burnShares(account, amount);
        emit BridgeBurn(msg.sender, account, amount);
    }

    /**
     * @notice Set CCIP admin address
     * @param newAdmin New CCIP admin address
     */
    function setCCIPAdmin(address newAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = ccipAdmin;
        ccipAdmin = newAdmin;
        emit CCIPAdminTransferred(oldAdmin, newAdmin);
    }

    /// @inheritdoc IGetCCIPAdmin
    function getCCIPAdmin() external view override returns (address) {
        return ccipAdmin;
    }

    /**
     * @notice Updates the rebase index based on the latest Chainlink price
     * @dev Should be called periodically or before critical operations if needed
     *      Price must be positive and not stale (< 24 hours old)
     */
    function updateRebaseIndex() public {
        (, int256 price,, uint256 updatedAt,) = priceFeed.latestRoundData();
        if (price < 1) revert InvalidPrice();
        if (block.timestamp - updatedAt > 24 hours) revert StalePrice();

        // Chainlink USD feeds are 8 decimals.
        // We want 6 decimals precision to match USDL standard.
        // index = price / 100
        // solhint-disable-next-line
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 newIndex = uint256(price) / 100;

        emit RebaseIndexUpdated(rebaseIndex, newIndex);
        rebaseIndex = newIndex;
    }

    // ============ ERC20 Functions ============

    /// @notice Transfer tokens to recipient
    /// @param to Recipient address
    /// @param amount Amount to transfer (in rebased units)
    /// @return True if transfer was successful
    function transfer(address to, uint256 amount) public whenNotPaused returns (bool) {
        _transferShares(msg.sender, to, _toRawShares(amount, Math.Rounding.Floor));
        return true;
    }

    /// @notice Transfer tokens from one account to another
    /// @param from Sender address
    /// @param to Recipient address
    /// @param amount Amount to transfer (in rebased units)
    /// @return True if transfer was successful
    function transferFrom(address from, address to, uint256 amount) public whenNotPaused returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transferShares(from, to, _toRawShares(amount, Math.Rounding.Floor));
        return true;
    }

    /// @notice Approve spender to transfer tokens
    /// @param spender Address to approve
    /// @param amount Amount to approve (in rebased units)
    /// @return True if approval was successful
    function approve(address spender, uint256 amount) public whenNotPaused returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    // ============ View Functions ============

    /// @notice Get balance of account (rebased)
    /// @param account Address to query
    /// @return Balance in rebased units
    function balanceOf(address account) public view returns (uint256) {
        return _toRebasedAmount(_shares[account], Math.Rounding.Floor);
    }

    /// @notice Get total supply of USDL (rebased)
    /// @return Total supply in rebased units
    function totalSupply() public view returns (uint256) {
        return _toRebasedAmount(_totalShares, Math.Rounding.Floor);
    }

    /// @notice Get allowance for spender
    /// @param owner Token owner
    /// @param spender Approved spender
    /// @return Allowance amount (in rebased units)
    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    /// @notice Get raw shares balance
    /// @param account Address to query
    /// @return Raw shares (not rebased)
    function sharesOf(address account) public view returns (uint256) {
        return _shares[account];
    }

    /// @notice Get total raw shares
    /// @return Total raw shares (not rebased)
    function totalShares() public view returns (uint256) {
        return _totalShares;
    }

    /// @notice Get token name
    /// @return Token name string
    function name() public view returns (string memory) {
        return _name;
    }

    /// @notice Get token symbol
    /// @return Token symbol string
    function symbol() public view returns (string memory) {
        return _symbol;
    }

    /// @notice Check if contract supports an interface
    /// @param interfaceId The interface ID to check
    /// @return True if interface is supported
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC20).interfaceId || interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IAccessControl).interfaceId || interfaceId == type(IBurnMintERC20).interfaceId
            || interfaceId == type(IGetCCIPAdmin).interfaceId || super.supportsInterface(interfaceId);
    }

    // ============ Pure Functions ============

    /// @notice Get token decimals
    /// @return Number of decimals (6)
    function decimals() public pure returns (uint8) {
        return 6;
    }

    // ============ Internal Functions ============

    /// @notice Mint raw shares for CCIP bridge
    /// @param account Recipient address
    /// @param rawShares Number of raw shares to mint
    function _mintShares(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();
        _shares[account] += rawShares;
        _totalShares += rawShares;
        emit Transfer(address(0), account, _toRebasedAmount(rawShares, Math.Rounding.Floor));
    }

    /// @notice Burn raw shares for CCIP bridge
    /// @param account Address to burn from
    /// @param rawShares Number of raw shares to burn
    function _burnShares(address account, uint256 rawShares) internal {
        if (account == address(0)) revert ZeroAddress();
        uint256 currentShares = _shares[account];
        if (currentShares < rawShares) revert InsufficientBalance();

        unchecked {
            _shares[account] = currentShares - rawShares;
        }
        _totalShares -= rawShares;
        emit Transfer(account, address(0), _toRebasedAmount(rawShares, Math.Rounding.Floor));
    }

    /// @notice Transfer raw shares from one account to another
    /// @param from Sender address
    /// @param to Recipient address
    /// @param rawShares Number of raw shares to transfer
    function _transferShares(address from, address to, uint256 rawShares) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();

        uint256 currentShares = _shares[from];
        if (currentShares < rawShares) revert InsufficientBalance();

        unchecked {
            _shares[from] = currentShares - rawShares;
        }
        _shares[to] += rawShares;

        emit Transfer(from, to, _toRebasedAmount(rawShares, Math.Rounding.Floor));
    }

    /// @notice Approve spender allowance
    /// @param owner Token owner
    /// @param spender Approved spender
    /// @param value Allowance amount (in rebased units)
    function _approve(address owner, address spender, uint256 value) internal {
        if (owner == address(0)) revert ZeroAddress();
        if (spender == address(0)) revert ZeroAddress();
        _allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    /// @notice Spend allowance from owner's account
    /// @param owner Token owner
    /// @param spender Approved spender
    /// @param value Amount to spend (in rebased units)
    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 currentAllowance = _allowances[owner][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) revert InsufficientAllowance();
            unchecked {
                _allowances[owner][spender] = currentAllowance - value;
            }
        }
    }

    /// @notice Authorize contract upgrade
    /// @param newImplementation New implementation address
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {
        if (newImplementation == address(0)) revert ZeroAddress();
        ++version;
        emit Upgrade(msg.sender, newImplementation);
    }

    /// @notice Convert rebased amount to raw shares
    /// @param rebasedAmount Amount in rebased units
    /// @param rounding Rounding direction
    /// @return Raw share amount
    function _toRawShares(uint256 rebasedAmount, Math.Rounding rounding) internal view returns (uint256) {
        if (rebaseIndex == 0) return rebasedAmount;
        return rebasedAmount.mulDiv(REBASE_INDEX_PRECISION, rebaseIndex, rounding);
    }

    /// @notice Convert raw shares to rebased amount
    /// @param rawShares Number of raw shares
    /// @param rounding Rounding direction
    /// @return Rebased amount
    function _toRebasedAmount(uint256 rawShares, Math.Rounding rounding) internal view returns (uint256) {
        if (rebaseIndex == 0) return rawShares;
        return rawShares.mulDiv(rebaseIndex, REBASE_INDEX_PRECISION, rounding);
    }
}
