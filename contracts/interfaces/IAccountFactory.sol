// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @dev Account factory interface for ERC-4337 account abstraction
 */
interface IAccountFactory {
    // Custom errors for factory
    error InvalidUser();
    error WalletAlreadyExists();
    error InvalidImplementation();

    /**
     * @dev Create an account and return its address
     * @param owner The owner of the account
     * @param salt Salt for address generation
     * @return account The created account address
     */
    function createAccount(address owner, uint256 salt) external returns (address account);

    /**
     * @dev Get the counterfactual address of an account
     * @param owner The owner of the account
     * @param salt Salt for address generation
     * @return The account address
     */
    function getAddress(address owner, uint256 salt) external view returns (address);
}
