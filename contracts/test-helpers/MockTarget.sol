// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

contract MockTarget {
    uint256 public value;
    address public lastCaller;

    event ValueSet(uint256 newValue);
    event Received(address sender, uint256 amount);

    function setValue(uint256 _value) external {
        value = _value;
        lastCaller = msg.sender;
        emit ValueSet(_value);
    }

    function getValue() external view returns (uint256) {
        return value;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
