// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title IAccountFactory
 * @dev Interface for SmartWallet factory
 */
interface IAccountFactory {
    // Custom errors
    error InvalidUser();
    error WalletAlreadyExists();
    error InvalidImplementation();

    // Functions
    function createAccount(address owner, uint256 salt) external returns (address);
    function getAddress(address owner, uint256 salt) external view returns (address);
    function isLendefiWallet(address wallet) external view returns (bool);
    function userToWallet(address user) external view returns (address);
}
