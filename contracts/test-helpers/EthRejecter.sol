// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

contract EthRejecter {
    // Contract that always reverts when receiving ETH
    receive() external payable {
        revert("ETH transfer rejected");
    }

    fallback() external payable {
        revert("ETH transfer rejected");
    }
}
