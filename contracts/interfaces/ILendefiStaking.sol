// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title ILendefiStaking
 * @notice Interface for Lendefi DeFi staking contract
 * @dev Users stake LDF tokens to earn gas sponsorship tiers
 */
interface ILendefiStaking {
    // ============ Enums ============

    enum Tier {
        NONE,      // 0 tokens - no subsidy
        BASIC,     // >= 1,000 LDF - 50% subsidy
        PREMIUM,   // >= 10,000 LDF - 90% subsidy
        ULTIMATE   // >= 100,000 LDF - 100% subsidy
    }

    // ============ Structs ============

    struct StakeInfo {
        uint256 amount;           // Total staked amount
        uint256 stakedAt;         // Timestamp of first stake
        uint256 lastStakeTime;    // Timestamp of last stake action
        uint256 gasUsedThisMonth; // Gas used in current month
        uint256 lastResetTime;    // Last monthly reset timestamp
    }

    // ============ Events ============

    event Staked(address indexed user, uint256 amount, uint256 totalStaked, Tier newTier);
    event Unstaked(address indexed user, uint256 amount, uint256 remaining, Tier newTier);
    event TierThresholdsUpdated(uint256 basic, uint256 premium, uint256 ultimate);
    event GasLimitsUpdated(uint256 basic, uint256 premium, uint256 ultimate);
    event MinStakePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event GasUsageRecorded(address indexed user, uint256 gasUsed, uint256 totalThisMonth);
    event MonthlyGasReset(address indexed user);
    event PaymasterAuthorized(address indexed paymaster);
    event PaymasterRevoked(address indexed paymaster);

    // ============ Errors ============

    error ZeroAmount();
    error InsufficientStake();
    error StakePeriodNotMet();
    error NotAuthorizedPaymaster();
    error InvalidThresholds();
    error ZeroAddress();

    // ============ External Functions ============

    /**
     * @notice Stake tokens to earn gas sponsorship tier
     * @param amount Amount of tokens to stake
     */
    function stake(uint256 amount) external;

    /**
     * @notice Unstake tokens
     * @param amount Amount to unstake
     */
    function unstake(uint256 amount) external;

    /**
     * @notice Record gas usage for a user (called by paymaster)
     * @param user User address
     * @param gasUsed Gas amount used
     */
    function recordGasUsage(address user, uint256 gasUsed) external;

    // ============ View Functions ============

    /**
     * @notice Get user's current tier based on staked amount
     * @param user User address
     * @return Tier enum value
     */
    function getTier(address user) external view returns (Tier);

    /**
     * @notice Get subsidy percentage for a tier
     * @param tier Tier enum
     * @return Subsidy percentage (0-100)
     */
    function getSubsidyPercentage(Tier tier) external pure returns (uint256);

    /**
     * @notice Get monthly gas limit for a tier
     * @param tier Tier enum
     * @return Gas limit
     */
    function getMonthlyGasLimit(Tier tier) external view returns (uint256);

    /**
     * @notice Check if user has enough gas allowance remaining
     * @param user User address
     * @param gasNeeded Gas amount needed
     * @return hasAllowance True if user has enough gas remaining
     * @return remainingGas Remaining gas this month
     */
    function checkGasAllowance(
        address user, 
        uint256 gasNeeded
    ) external view returns (bool hasAllowance, uint256 remainingGas);

    /**
     * @notice Get complete stake info for a user
     * @param user User address
     * @return staked Amount staked
     * @return tier Current tier
     * @return subsidyPercent Subsidy percentage
     * @return gasUsed Gas used this month
     * @return gasLimit Monthly gas limit
     * @return canUnstakeAt Timestamp when unstaking is allowed
     */
    function getUserInfo(address user) external view returns (
        uint256 staked,
        Tier tier,
        uint256 subsidyPercent,
        uint256 gasUsed,
        uint256 gasLimit,
        uint256 canUnstakeAt
    );

    /**
     * @notice Get tokens needed to reach next tier
     * @param user User address
     * @return tokensNeeded Amount needed for next tier (0 if at max)
     * @return nextTier The next tier
     */
    function getTokensToNextTier(address user) external view returns (
        uint256 tokensNeeded, 
        Tier nextTier
    );

    // ============ Admin Functions ============

    function authorizePaymaster(address paymaster) external;
    function revokePaymaster(address paymaster) external;
    function setTierThresholds(uint256 basic, uint256 premium, uint256 ultimate) external;
    function setGasLimits(uint256 basic, uint256 premium, uint256 ultimate) external;
    function setMinStakePeriod(uint256 newPeriod) external;
}
