// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LendefiStaking
 * @notice DeFi staking contract for Lendefi token
 * @dev Users stake LDFI tokens to earn gas sponsorship tiers
 *
 * Tier Structure:
 * - NONE:     0 tokens staked         → 0% gas subsidy
 * - BASIC:    >= 1,000 LDFI staked    → 50% gas subsidy
 * - PREMIUM:  >= 10,000 LDFI staked   → 90% gas subsidy
 * - ULTIMATE: >= 100,000 LDFI staked  → 100% gas subsidy
 */
contract LendefiStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Enums ============

    enum Tier {
        NONE,
        BASIC,
        PREMIUM,
        ULTIMATE
    }

    // ============ Structs ============

    struct StakeInfo {
        uint256 amount; // Total staked amount
        uint256 stakedAt; // Timestamp of first stake
        uint256 lastStakeTime; // Timestamp of last stake action
        uint256 gasUsedThisMonth; // Gas used in current month
        uint256 lastResetTime; // Last monthly reset timestamp
    }

    // ============ State Variables ============

    /// @notice The Lendefi token being staked
    IERC20 public immutable stakingToken;

    /// @notice Minimum staking period before unstaking (default: 7 days)
    uint256 public minStakePeriod = 7 days;

    /// @notice Tier thresholds (in token wei, assuming 18 decimals)
    uint256 public basicThreshold = 1_000 * 1e18; // 1,000 LDFI
    uint256 public premiumThreshold = 10_000 * 1e18; // 10,000 LDFI
    uint256 public ultimateThreshold = 100_000 * 1e18; // 100,000 LDFI

    /// @notice Monthly gas limits per tier
    uint256 public gasLimitBasic = 500_000;
    uint256 public gasLimitPremium = 2_000_000;
    uint256 public gasLimitUltimate = 10_000_000;

    /// @notice User stakes
    mapping(address => StakeInfo) public stakes;

    /// @notice Authorized paymaster contracts that can record gas usage
    mapping(address => bool) public authorizedPaymasters;

    /// @notice Total tokens staked across all users
    uint256 public totalStaked;

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

    // ============ Constructor ============

    /**
     * @param _stakingToken Address of the LDFI token
     */
    constructor(IERC20 _stakingToken) Ownable(msg.sender) {
        if (address(_stakingToken) == address(0)) revert ZeroAddress();
        stakingToken = _stakingToken;
    }

    // ============ External Functions ============

    /**
     * @notice Stake tokens to earn gas sponsorship tier
     * @param amount Amount of tokens to stake
     */
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        StakeInfo storage info = stakes[msg.sender];

        // Transfer tokens from user
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        // Update stake info
        if (info.amount == 0) {
            info.stakedAt = block.timestamp;
            info.lastResetTime = block.timestamp;
        }
        info.amount += amount;
        info.lastStakeTime = block.timestamp;
        totalStaked += amount;

        Tier newTier = getTier(msg.sender);
        emit Staked(msg.sender, amount, info.amount, newTier);
    }

    /**
     * @notice Unstake tokens
     * @param amount Amount to unstake
     */
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        StakeInfo storage info = stakes[msg.sender];
        if (info.amount < amount) revert InsufficientStake();

        // Check minimum stake period
        if (block.timestamp < info.lastStakeTime + minStakePeriod) {
            revert StakePeriodNotMet();
        }

        // Update stake info
        info.amount -= amount;
        totalStaked -= amount;

        // Transfer tokens back to user
        stakingToken.safeTransfer(msg.sender, amount);

        Tier newTier = getTier(msg.sender);
        emit Unstaked(msg.sender, amount, info.amount, newTier);
    }

    /**
     * @notice Record gas usage for a user (called by paymaster)
     * @param user User address
     * @param gasUsed Gas amount used
     */
    function recordGasUsage(address user, uint256 gasUsed) external {
        if (!authorizedPaymasters[msg.sender]) revert NotAuthorizedPaymaster();

        StakeInfo storage info = stakes[user];

        // Reset monthly usage if needed
        _resetMonthlyUsageIfNeeded(user);

        info.gasUsedThisMonth += gasUsed;
        emit GasUsageRecorded(user, gasUsed, info.gasUsedThisMonth);
    }

    // ============ View Functions ============

    /**
     * @notice Get user's current tier based on staked amount
     * @param user User address
     * @return Tier enum value
     */
    function getTier(address user) public view returns (Tier) {
        uint256 staked = stakes[user].amount;

        if (staked >= ultimateThreshold) return Tier.ULTIMATE;
        if (staked >= premiumThreshold) return Tier.PREMIUM;
        if (staked >= basicThreshold) return Tier.BASIC;
        return Tier.NONE;
    }

    /**
     * @notice Get subsidy percentage for a tier
     * @param tier Tier enum
     * @return Subsidy percentage (0-100)
     */
    function getSubsidyPercentage(Tier tier) public pure returns (uint256) {
        if (tier == Tier.ULTIMATE) return 100;
        if (tier == Tier.PREMIUM) return 90;
        if (tier == Tier.BASIC) return 50;
        return 0;
    }

    /**
     * @notice Get monthly gas limit for a tier
     * @param tier Tier enum
     * @return Gas limit
     */
    function getMonthlyGasLimit(Tier tier) public view returns (uint256) {
        if (tier == Tier.ULTIMATE) return gasLimitUltimate;
        if (tier == Tier.PREMIUM) return gasLimitPremium;
        if (tier == Tier.BASIC) return gasLimitBasic;
        return 0;
    }

    /**
     * @notice Check if user has enough gas allowance remaining
     * @param user User address
     * @param gasNeeded Gas amount needed
     * @return hasAllowance True if user has enough gas remaining
     * @return remainingGas Remaining gas this month
     */
    function checkGasAllowance(address user, uint256 gasNeeded)
        external
        view
        returns (bool hasAllowance, uint256 remainingGas)
    {
        StakeInfo storage info = stakes[user];
        Tier tier = getTier(user);

        if (tier == Tier.NONE) {
            return (false, 0);
        }

        uint256 monthlyLimit = getMonthlyGasLimit(tier);
        uint256 used = info.gasUsedThisMonth;

        // Check if monthly reset is due
        if (block.timestamp >= info.lastResetTime + 30 days) {
            used = 0;
        }

        remainingGas = monthlyLimit > used ? monthlyLimit - used : 0;
        hasAllowance = remainingGas >= gasNeeded;
    }

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
    function getUserInfo(address user)
        external
        view
        returns (
            uint256 staked,
            Tier tier,
            uint256 subsidyPercent,
            uint256 gasUsed,
            uint256 gasLimit,
            uint256 canUnstakeAt
        )
    {
        StakeInfo storage info = stakes[user];
        tier = getTier(user);

        staked = info.amount;
        subsidyPercent = getSubsidyPercentage(tier);
        gasUsed = info.gasUsedThisMonth;
        gasLimit = getMonthlyGasLimit(tier);
        canUnstakeAt = info.lastStakeTime + minStakePeriod;
    }

    /**
     * @notice Get tokens needed to reach next tier
     * @param user User address
     * @return tokensNeeded Amount needed for next tier (0 if at max)
     * @return nextTier The next tier
     */
    function getTokensToNextTier(address user) external view returns (uint256 tokensNeeded, Tier nextTier) {
        uint256 staked = stakes[user].amount;

        if (staked >= ultimateThreshold) {
            return (0, Tier.ULTIMATE);
        }
        if (staked >= premiumThreshold) {
            return (ultimateThreshold - staked, Tier.ULTIMATE);
        }
        if (staked >= basicThreshold) {
            return (premiumThreshold - staked, Tier.PREMIUM);
        }
        return (basicThreshold - staked, Tier.BASIC);
    }

    // ============ Admin Functions ============

    /**
     * @notice Authorize a paymaster to record gas usage
     * @param paymaster Paymaster address
     */
    function authorizePaymaster(address paymaster) external onlyOwner {
        if (paymaster == address(0)) revert ZeroAddress();
        authorizedPaymasters[paymaster] = true;
        emit PaymasterAuthorized(paymaster);
    }

    /**
     * @notice Revoke paymaster authorization
     * @param paymaster Paymaster address
     */
    function revokePaymaster(address paymaster) external onlyOwner {
        authorizedPaymasters[paymaster] = false;
        emit PaymasterRevoked(paymaster);
    }

    /**
     * @notice Update tier thresholds
     * @param basic Basic tier threshold
     * @param premium Premium tier threshold
     * @param ultimate Ultimate tier threshold
     */
    function setTierThresholds(uint256 basic, uint256 premium, uint256 ultimate) external onlyOwner {
        if (basic >= premium || premium >= ultimate) revert InvalidThresholds();

        basicThreshold = basic;
        premiumThreshold = premium;
        ultimateThreshold = ultimate;

        emit TierThresholdsUpdated(basic, premium, ultimate);
    }

    /**
     * @notice Update gas limits per tier
     * @param basic Basic tier gas limit
     * @param premium Premium tier gas limit
     * @param ultimate Ultimate tier gas limit
     */
    function setGasLimits(uint256 basic, uint256 premium, uint256 ultimate) external onlyOwner {
        gasLimitBasic = basic;
        gasLimitPremium = premium;
        gasLimitUltimate = ultimate;

        emit GasLimitsUpdated(basic, premium, ultimate);
    }

    /**
     * @notice Update minimum stake period
     * @param newPeriod New minimum period in seconds
     */
    function setMinStakePeriod(uint256 newPeriod) external onlyOwner {
        uint256 oldPeriod = minStakePeriod;
        minStakePeriod = newPeriod;
        emit MinStakePeriodUpdated(oldPeriod, newPeriod);
    }

    /**
     * @notice Emergency withdraw of stuck tokens (not staking tokens)
     * @param token Token address
     * @param to Recipient
     * @param amount Amount
     */
    function emergencyWithdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == address(stakingToken)) {
            // Can only withdraw excess (not staked tokens)
            uint256 balance = stakingToken.balanceOf(address(this));
            uint256 excess = balance > totalStaked ? balance - totalStaked : 0;
            if (amount > excess) revert InsufficientStake();
        }
        token.safeTransfer(to, amount);
    }

    // ============ Internal Functions ============

    /**
     * @dev Reset monthly gas usage if 30 days have passed
     */
    function _resetMonthlyUsageIfNeeded(address user) internal {
        StakeInfo storage info = stakes[user];

        if (block.timestamp >= info.lastResetTime + 30 days) {
            info.gasUsedThisMonth = 0;
            info.lastResetTime = block.timestamp;
            emit MonthlyGasReset(user);
        }
    }
}
