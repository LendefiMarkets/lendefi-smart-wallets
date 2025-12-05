// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title IAggregatorV3Interface
/// @author Chainlink
/// @notice Chainlink AggregatorV3 interface for price feeds
interface IAggregatorV3Interface {
    /// @notice Get number of decimals in the price feed
    /// @return Number of decimals
    function decimals() external view returns (uint8);

    /// @notice Get description of the price feed
    /// @return Description string
    function description() external view returns (string memory);

    /// @notice Get version of the price feed
    /// @return Version number
    function version() external view returns (uint256);

    /// @notice Get round data for a specific round
    /// @param _roundId Round ID to fetch
    /// @return roundId The round ID
    /// @return answer The price answer
    /// @return startedAt Timestamp when round started
    /// @return updatedAt Timestamp when answer was updated
    /// @return answeredInRound The round ID when answer was computed
    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    /// @notice Get latest round data
    /// @return roundId The latest round ID
    /// @return answer The latest price answer
    /// @return startedAt Timestamp when latest round started
    /// @return updatedAt Timestamp when latest answer was updated
    /// @return answeredInRound The round ID when latest answer was computed
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
