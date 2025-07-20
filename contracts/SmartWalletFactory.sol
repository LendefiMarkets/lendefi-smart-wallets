// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { IEntryPoint } from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import { IAccountFactory } from "./interfaces/IAccountFactory.sol";
import { SmartWallet } from "./SmartWallet.sol";

/**
 * @title SmartWalletFactory
 * @dev Upgradeable factory contract for deploying SmartWallet wallets using CREATE2
 * Compliant with ERC-4337 factory requirements
 */
contract SmartWalletFactory is IAccountFactory, Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using Clones for address;

    // State variables (no longer immutable for upgradeability)
    SmartWallet public accountImplementation;
    IEntryPoint public entryPoint;
    address public paymaster;
    uint32 public version;

    // State mappings
    mapping(address user => address wallet) public userToWallet;
    mapping(address wallet => bool isValid) public isLendefiWallet;

    // Events
    event AccountCreated(address indexed account, address indexed owner, uint256 salt);
    event SmartWalletImplementationUpdated(address indexed oldImplementation, address indexed newImplementation);
    event PaymasterUpdated(address indexed oldPaymaster, address indexed newPaymaster);

    // Custom errors
    error InvalidPaymaster();
    error ZeroAddress();

    // Modifiers
    modifier nonZeroAddress(address _address) {
        if (_address == address(0)) revert ZeroAddress();
        _;
    }

    /**
     * @dev Constructor - disables initializers to prevent implementation initialization
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the factory
     * @param _entryPoint EntryPoint contract address
     * @param _owner Owner of the factory contract
     * @param _paymaster Initial paymaster address (optional)
     */
    function initialize(
        IEntryPoint _entryPoint, 
        address _owner, 
        address _paymaster
    ) external initializer nonZeroAddress(address(_entryPoint)) nonZeroAddress(_owner) {

        __Ownable_init(_owner);
        __UUPSUpgradeable_init();

        entryPoint = _entryPoint;
        paymaster = _paymaster;
        accountImplementation = new SmartWallet(_entryPoint);
        version = 1;
    }

    /**
     * @dev Create an account and return its address
     * @param accountOwner The owner of the account
     * @param salt Salt for address generation
     * @return account The created account address
     */
    function createAccount(
        address accountOwner, 
        uint256 salt
    ) external override onlyOwner nonZeroAddress(accountOwner) returns (address account) {

        // Check if wallet already exists for this owner
        if (userToWallet[accountOwner] != address(0)) revert IAccountFactory.WalletAlreadyExists();

        // Compute the counterfactual address
        account = getAddress(accountOwner, salt);

        // Check if account needs to be deployed
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(account)
        }

        if (codeSize == 0) {
            // Deploy the account using CREATE2
            account = Clones.cloneDeterministic(address(accountImplementation), _getSalt(accountOwner, salt));

            // Initialize the account
            SmartWallet(payable(account)).initialize(accountOwner);
        }

        // Update mappings
        userToWallet[accountOwner] = account;
        isLendefiWallet[account] = true;

        emit AccountCreated(account, accountOwner, salt);
        return account;
    }

    /**
     * @dev Add stake to the factory (required by ERC-4337)
     * @param unstakeDelaySec Unstake delay in seconds
     */
    function addStake(uint32 unstakeDelaySec) external payable {
        entryPoint.addStake{ value: msg.value }(unstakeDelaySec);
    }

    /**
     * @dev Unlock stake
     */
    function unlockStake() external {
        entryPoint.unlockStake();
    }

    /**
     * @dev Withdraw stake
     * @param withdrawAddress Address to withdraw stake to
     */
    function withdrawStake(
        address payable withdrawAddress
    ) external onlyOwner nonZeroAddress(withdrawAddress) {
        entryPoint.withdrawStake(withdrawAddress);
    }

    /**
     * @dev Update the SmartWallet implementation contract
     * @param newImplementation Address of the new SmartWallet implementation
     */
    function setSmartWalletImplementation(
        address newImplementation
    ) external onlyOwner nonZeroAddress(newImplementation) {

        // Verify it's a valid SmartWallet implementation by checking it has entryPoint function
        try SmartWallet(payable(newImplementation)).entryPoint() returns (IEntryPoint entryPointAddr) {
            // Valid implementation - verify entryPoint matches
            if (address(entryPointAddr) != address(entryPoint)) revert IAccountFactory.InvalidImplementation();
        } catch {
            revert IAccountFactory.InvalidImplementation();
        }

        address oldImplementation = address(accountImplementation);
        accountImplementation = SmartWallet(payable(newImplementation));

        emit SmartWalletImplementationUpdated(oldImplementation, newImplementation);
    }

    /**
     * @dev Update the paymaster address
     * @param newPaymaster Address of the new paymaster (can be zero to disable)
     */
    function setPaymaster(address newPaymaster) external onlyOwner {
        address oldPaymaster = paymaster;
        paymaster = newPaymaster;

        emit PaymasterUpdated(oldPaymaster, newPaymaster);
    }

    /**
     * @dev Get current implementation address
     * @return The current SmartWallet implementation address
     */
    function getImplementation() external view returns (address) {
        return address(accountImplementation);
    }

    /**
     * @dev Get wallet address for a user
     * @param user The user to query
     * @return wallet The user's wallet address
     */
    function getWallet(address user) external view returns (address wallet) {
        return userToWallet[user];
    }

    /**
     * @dev Check if an address is a Lendefi smart wallet
     * @param wallet The address to check
     * @return True if it's a valid Lendefi wallet
     */
    function isValidWallet(address wallet) external view returns (bool) {
        return isLendefiWallet[wallet];
    }

    /**
     * @dev Get the counterfactual address of an account
     * @param accountOwner The owner of the account
     * @param salt Salt for address generation
     * @return The account address
     */
    function getAddress(address accountOwner, uint256 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(address(accountImplementation), _getSalt(accountOwner, salt));
    }

    /**
     * @dev Override required by UUPSUpgradeable - only owner can upgrade
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner nonZeroAddress(newImplementation) {
        version++;
    }

    /**
     * @dev Generate salt for CREATE2
     * @param accountOwner Owner address
     * @param salt User provided salt
     * @return Combined salt
     */
    function _getSalt(address accountOwner, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(accountOwner, salt));
    }
}
