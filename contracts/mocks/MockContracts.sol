// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockPriceFeed
 * @notice Mock Chainlink price feed for testing USDLRebasingCCIP
 */
contract MockPriceFeed {
    int256 public price;
    uint256 public updatedAt;
    uint8 public constant decimals = 8;

    constructor() {
        // Default to $1.00 (1e8 with 8 decimals)
        price = 1e8;
        updatedAt = block.timestamp;
    }

    /**
     * @notice Set the price and update timestamp to current block
     * @param _price The price to set (8 decimals)
     */
    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
    }

    /**
     * @notice Set price with a custom timestamp (for testing staleness)
     * @param _price The price to set (8 decimals)
     * @param _updatedAt The timestamp to use
     */
    function setStalePrice(int256 _price, uint256 _updatedAt) external {
        price = _price;
        updatedAt = _updatedAt;
    }

    /**
     * @notice Chainlink AggregatorV3Interface compatible function
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 _updatedAt, uint80 answeredInRound)
    {
        return (1, price, block.timestamp, updatedAt, 1);
    }
}

/**
 * @title MockUSDC
 * @notice Simple mock USDC token for testing
 */
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @notice Mint tokens to an address
     * @param to The recipient address
     * @param amount The amount to mint
     */
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /**
     * @notice Burn tokens from an address
     * @param from The address to burn from
     * @param amount The amount to burn
     */
    function burn(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    /**
     * @notice Transfer tokens
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /**
     * @notice Approve spender
     */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @notice Transfer tokens from another account
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");

        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }

        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockERC4626Vault
 * @notice Mock ERC4626 vault for testing yield generation
 * @dev Matches the Solidity test mock behavior exactly
 */
contract MockERC4626Vault {
    MockUSDC public depositToken;
    string public constant name = "Mock Yield Vault";
    string public constant symbol = "mvUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    uint256 public yieldMultiplier = 1e6; // 1e6 = 1x (no yield), 1.1e6 = 10% yield
    uint256 public usdcReserve;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address _depositToken) {
        depositToken = MockUSDC(_depositToken);
    }

    /**
     * @notice Simulate yield by setting a multiplier and minting extra USDC
     * @param _multiplier The yield multiplier with 6 decimals (1e6 = 100%, 1.1e6 = 110%)
     */
    function setYieldMultiplier(uint256 _multiplier) external {
        yieldMultiplier = _multiplier;
        if (_multiplier > 1e6) {
            uint256 yieldAmount = (usdcReserve * (_multiplier - 1e6)) / 1e6;
            depositToken.mint(address(this), yieldAmount);
            usdcReserve += yieldAmount;
        }
    }

    /**
     * @notice Deposit assets and receive shares
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(depositToken.transferFrom(msg.sender, address(this), assets), "Transfer failed");
        usdcReserve += assets;
        shares = assets; // 1:1 on deposit
        balanceOf[receiver] += shares;
        totalSupply += shares;

        emit Deposit(msg.sender, receiver, assets, shares);
        emit Transfer(address(0), receiver, shares);
    }

    /**
     * @notice Redeem shares for assets
     */
    function redeem(uint256 shares, address receiver, address _owner) external returns (uint256 assets) {
        if (msg.sender != _owner) {
            require(allowance[_owner][msg.sender] >= shares, "Insufficient allowance");
            allowance[_owner][msg.sender] -= shares;
        }
        require(balanceOf[_owner] >= shares, "Insufficient shares");

        balanceOf[_owner] -= shares;
        totalSupply -= shares;
        assets = (shares * yieldMultiplier) / 1e6;

        if (usdcReserve >= assets) {
            usdcReserve -= assets;
            require(depositToken.transfer(receiver, assets), "Transfer failed");
        } else {
            // Mint extra if needed (shouldn't happen in normal usage)
            depositToken.mint(receiver, assets);
        }

        emit Withdraw(msg.sender, receiver, _owner, assets, shares);
        emit Transfer(_owner, address(0), shares);
    }

    /**
     * @notice Convert assets to shares (for deposit preview)
     */
    function convertToShares(uint256 assets) external view returns (uint256) {
        // Handle max uint to prevent overflow
        if (assets == type(uint256).max) {
            return type(uint256).max;
        }
        return (assets * 1e6) / yieldMultiplier;
    }

    /**
     * @notice Convert shares to assets (for redemption preview)
     */
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * yieldMultiplier) / 1e6;
    }

    /**
     * @notice Preview deposit
     */
    function previewDeposit(uint256 assets) external view returns (uint256) {
        return (assets * 1e6) / yieldMultiplier;
    }

    /**
     * @notice Preview redeem
     */
    function previewRedeem(uint256 shares) external view returns (uint256) {
        return (shares * yieldMultiplier) / 1e6;
    }

    /**
     * @notice Total assets in the vault
     */
    function totalAssets() external view returns (uint256) {
        return usdcReserve;
    }

    /**
     * @notice Approve spender
     */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @notice Transfer shares
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /**
     * @notice Transfer shares from another account
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /**
     * @notice Max deposit
     */
    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    /**
     * @notice Max redeem
     */
    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    /**
     * @notice Get the underlying asset address
     */
    function asset() external view returns (address) {
        return address(depositToken);
    }
}

/**
 * @title MockUSDS
 * @notice Mock USDS token for testing Sky protocol integration
 * @dev USDS has 18 decimals, 1:1 with USDC via LitePSM
 */
contract MockUSDS {
    string public constant name = "USDS Stablecoin";
    string public constant symbol = "USDS";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");

        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }

        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockLitePSMWrapper
 * @notice Mock Sky LitePSM wrapper for testing USDC <-> USDS swaps
 * @dev Simulates 1:1 swap between USDC (6 decimals) and USDS (18 decimals)
 */
contract MockLitePSMWrapper {
    MockUSDC public usdc;
    MockUSDS public usds;

    constructor(address _usdc, address _usds) {
        usdc = MockUSDC(_usdc);
        usds = MockUSDS(_usds);
    }

    /**
     * @notice Sell USDC (gem) for USDS at 1:1 rate
     * @param usr Recipient of USDS
     * @param gemAmt Amount of USDC to sell (6 decimals)
     * @return usdsAmt Amount of USDS received (18 decimals)
     */
    function sellGem(address usr, uint256 gemAmt) external returns (uint256 usdsAmt) {
        // Transfer USDC from sender
        require(usdc.transferFrom(msg.sender, address(this), gemAmt), "USDC transfer failed");

        // Mint USDS to recipient (scale 6 decimals to 18 decimals)
        usdsAmt = gemAmt * 1e12;
        usds.mint(usr, usdsAmt);
    }

    /**
     * @notice Buy USDC (gem) with USDS at 1:1 rate
     * @param usr Recipient of USDC
     * @param gemAmt Amount of USDC to buy (6 decimals)
     * @return usdsAmt Amount of USDS spent (18 decimals)
     */
    function buyGem(address usr, uint256 gemAmt) external returns (uint256 usdsAmt) {
        // Calculate USDS needed (scale 6 decimals to 18 decimals)
        usdsAmt = gemAmt * 1e12;

        // Transfer USDS from sender and burn
        require(usds.transferFrom(msg.sender, address(this), usdsAmt), "USDS transfer failed");
        usds.burn(address(this), usdsAmt);

        // Mint USDC to recipient (in real PSM this would be from reserves)
        usdc.mint(usr, gemAmt);
    }

    /**
     * @notice Get the gem (USDC) address
     */
    function gem() external view returns (address) {
        return address(usdc);
    }
}

/**
 * @title MockSUsds
 * @notice Mock sUSDS ERC-4626 vault for testing Sky savings rate
 * @dev Simulates yield accrual on USDS deposits
 */
contract MockSUsds {
    MockUSDS public usdsToken;
    string public constant name = "Savings USDS";
    string public constant symbol = "sUSDS";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    uint256 public yieldMultiplier = 1e18; // 1e18 = 1x (no yield), 1.05e18 = 5% yield
    uint256 public usdsReserve;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address _usds) {
        usdsToken = MockUSDS(_usds);
    }

    /**
     * @notice Simulate yield by setting a multiplier
     * @param _multiplier The yield multiplier with 18 decimals (1e18 = 100%, 1.05e18 = 105%)
     */
    function setYieldMultiplier(uint256 _multiplier) external {
        yieldMultiplier = _multiplier;
        if (_multiplier > 1e18) {
            uint256 yieldAmount = (usdsReserve * (_multiplier - 1e18)) / 1e18;
            usdsToken.mint(address(this), yieldAmount);
            usdsReserve += yieldAmount;
        }
    }

    /**
     * @notice Deposit USDS and receive sUSDS shares
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(usdsToken.transferFrom(msg.sender, address(this), assets), "Transfer failed");
        usdsReserve += assets;
        shares = assets; // 1:1 on deposit
        balanceOf[receiver] += shares;
        totalSupply += shares;

        emit Deposit(msg.sender, receiver, assets, shares);
        emit Transfer(address(0), receiver, shares);
    }

    /**
     * @notice Redeem sUSDS shares for USDS
     */
    function redeem(uint256 shares, address receiver, address _owner) external returns (uint256 assets) {
        if (msg.sender != _owner) {
            require(allowance[_owner][msg.sender] >= shares, "Insufficient allowance");
            allowance[_owner][msg.sender] -= shares;
        }
        require(balanceOf[_owner] >= shares, "Insufficient shares");

        balanceOf[_owner] -= shares;
        totalSupply -= shares;
        assets = (shares * yieldMultiplier) / 1e18;

        if (usdsReserve >= assets) {
            usdsReserve -= assets;
            require(usdsToken.transfer(receiver, assets), "Transfer failed");
        } else {
            usdsToken.mint(receiver, assets);
        }

        emit Withdraw(msg.sender, receiver, _owner, assets, shares);
        emit Transfer(_owner, address(0), shares);
    }

    /**
     * @notice Withdraw assets (USDS) from vault
     */
    function withdraw(uint256 assets, address receiver, address _owner) external returns (uint256 shares) {
        shares = (assets * 1e18) / yieldMultiplier;
        if (msg.sender != _owner) {
            require(allowance[_owner][msg.sender] >= shares, "Insufficient allowance");
            allowance[_owner][msg.sender] -= shares;
        }
        require(balanceOf[_owner] >= shares, "Insufficient shares");

        balanceOf[_owner] -= shares;
        totalSupply -= shares;

        if (usdsReserve >= assets) {
            usdsReserve -= assets;
            require(usdsToken.transfer(receiver, assets), "Transfer failed");
        } else {
            usdsToken.mint(receiver, assets);
        }

        emit Withdraw(msg.sender, receiver, _owner, assets, shares);
        emit Transfer(_owner, address(0), shares);
    }

    /**
     * @notice Convert assets to shares (for deposit preview)
     */
    function convertToShares(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / yieldMultiplier;
    }

    /**
     * @notice Convert shares to assets (for redemption preview)
     */
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * yieldMultiplier) / 1e18;
    }

    /**
     * @notice Total assets in the vault
     */
    function totalAssets() external view returns (uint256) {
        return usdsReserve;
    }

    /**
     * @notice Get the underlying asset (USDS) address
     */
    function asset() external view returns (address) {
        return address(usdsToken);
    }

    /**
     * @notice Alias for asset() - for compatibility with ISUsds interface
     */
    function usds() external view returns (address) {
        return address(usdsToken);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }
}

/**
 * @title MockAavePool
 * @notice Mock Aave V3 Pool for testing
 */
contract MockAavePool {
    MockUSDC public usdc;
    address public aToken;

    constructor(address _usdc, address _aToken) {
        usdc = MockUSDC(_usdc);
        aToken = _aToken;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(usdc), "Invalid asset");
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        MockAUsdc(aToken).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(usdc), "Invalid asset");
        MockAUsdc(aToken).burn(msg.sender, amount);
        usdc.mint(to, amount);
        return amount;
    }

    function getReserveData(address)
        external
        view
        returns (
            uint256,
            uint128,
            uint128,
            uint128,
            uint128,
            uint128,
            uint40,
            uint16,
            address,
            address,
            address,
            address,
            uint128,
            uint128,
            uint128
        )
    {
        return (0, 0, 0, 0, 0, 0, 0, 0, aToken, address(0), address(0), address(0), 0, 0, 0);
    }
}

/**
 * @title MockAUsdc
 * @notice Mock Aave aUSDC token
 */
contract MockAUsdc {
    string public constant name = "Aave USDC";
    string public constant symbol = "aUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    address public pool;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        pool = address(0); // Set later
    }

    function setPool(address _pool) external {
        pool = _pool;
    }

    function mint(address to, uint256 amount) external {
        // Allow minting from pool or if pool not set
        if (pool != address(0)) {
            require(msg.sender == pool, "Only pool");
        }
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (pool != address(0)) {
            require(msg.sender == pool, "Only pool");
        }
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockOUSG
 * @notice Mock OUSG token for testing
 */
contract MockOUSG {
    string public constant name = "OUSG Token";
    string public constant symbol = "OUSG";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockOUSGManager
 * @notice Mock Ondo OUSG redemption manager
 */
contract MockOUSGManager {
    MockUSDC public usdc;
    MockOUSG public ousg;
    uint256 public redemptionRate = 1e18; // 1:1 rate

    constructor(address _usdc, address _ousg) {
        usdc = MockUSDC(_usdc);
        ousg = MockOUSG(_ousg);
    }

    function setRedemptionRate(uint256 _rate) external {
        redemptionRate = _rate;
    }

    function requestRedemption(uint256 ousgAmount) external returns (bytes32) {
        ousg.burn(msg.sender, ousgAmount);
        uint256 usdcAmount = (ousgAmount * redemptionRate) / 1e18;
        // Scale from 18 decimals to 6
        usdcAmount = usdcAmount / 1e12;
        usdc.mint(msg.sender, usdcAmount);
        return bytes32(uint256(1));
    }

    function claimRedemption(bytes32) external {
        // Already claimed in requestRedemption for simplicity
    }
}

/**
 * @title MockOndoOracle
 * @notice Mock Ondo Oracle for testing
 * @dev Returns price with 18 decimals via getAssetPrice()
 */
contract MockOndoOracle {
    uint256 public price;

    constructor() {
        price = 1e18; // $1.00 with 18 decimals
    }

    function setPrice(uint256 _price) external {
        price = _price;
    }

    function getAssetPrice(
        address /* token */
    )
        external
        view
        returns (uint256)
    {
        return price;
    }
}

/**
 * @title MockOUSGInstantManager
 * @notice Mock Ondo OUSG instant subscription/redemption manager
 * @dev Implements the new subscribe/redeem interface with 3 parameters
 */
contract MockOUSGInstantManager {
    MockUSDC public usdc;
    MockOUSG public ousg;
    MockOndoOracle public oracle;
    uint256 public instantRate = 1e18;

    constructor(address _usdc, address _ousg, address _oracle) {
        usdc = MockUSDC(_usdc);
        ousg = MockOUSG(_ousg);
        oracle = MockOndoOracle(_oracle);
    }

    /**
     * @notice Subscribe to OUSG by depositing USDC
     * @param depositToken Token to deposit (must be USDC)
     * @param depositAmount Amount of USDC to deposit
     * @param minimumRwaReceived Minimum OUSG to receive (not enforced in mock)
     * @return rwaAmountOut Amount of OUSG minted
     */
    function subscribe(address depositToken, uint256 depositAmount, uint256 minimumRwaReceived)
        external
        returns (uint256 rwaAmountOut)
    {
        require(depositToken == address(usdc), "Only USDC accepted");
        // Transfer USDC from caller
        require(usdc.transferFrom(msg.sender, address(this), depositAmount), "USDC transfer failed");
        // Mint OUSG (scale 6 decimals to 18)
        rwaAmountOut = depositAmount * 1e12;
        require(rwaAmountOut >= minimumRwaReceived, "Slippage exceeded");
        ousg.mint(msg.sender, rwaAmountOut);
    }

    /**
     * @notice Redeem OUSG for USDC
     * @param rwaAmount Amount of OUSG to redeem
     * @param receivingToken Token to receive (must be USDC)
     * @param minimumTokenReceived Minimum tokens to receive (not enforced in mock)
     * @return receiveTokenAmount Amount of USDC received
     */
    function redeem(uint256 rwaAmount, address receivingToken, uint256 minimumTokenReceived)
        external
        returns (uint256 receiveTokenAmount)
    {
        require(receivingToken == address(usdc), "Only USDC supported");
        ousg.burn(msg.sender, rwaAmount);
        receiveTokenAmount = (rwaAmount * instantRate) / 1e18;
        receiveTokenAmount = receiveTokenAmount / 1e12; // Scale back to 6 decimals
        require(receiveTokenAmount >= minimumTokenReceived, "Slippage exceeded");
        usdc.mint(msg.sender, receiveTokenAmount);
    }

    /**
     * @notice Get the Ondo oracle address for price data
     */
    function ondoOracle() external view returns (address) {
        return address(oracle);
    }

    /**
     * @notice Get the OUSG token address (rwaToken)
     */
    function rwaToken() external view returns (address) {
        return address(ousg);
    }

    // Legacy mint/redeem for backward compatibility with existing tests
    function mint(uint256 usdcAmount) external returns (uint256) {
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "USDC transfer failed");
        uint256 ousgAmount = usdcAmount * 1e12;
        ousg.mint(msg.sender, ousgAmount);
        return ousgAmount;
    }
}

/**
 * @title MockAdvancedPriceFeed
 * @notice Mock Chainlink price feed with configurable round data
 */
contract MockAdvancedPriceFeed {
    int256 public price;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    uint8 public constant decimals = 8;

    constructor() {
        price = 1e8; // $1.00
        updatedAt = block.timestamp;
        roundId = 1;
        answeredInRound = 1;
    }

    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
    }

    function setStalePrice(int256 _price, uint256 _updatedAt) external {
        price = _price;
        updatedAt = _updatedAt;
    }

    function setIncompleteRound(uint80 _roundId, uint80 _answeredInRound) external {
        roundId = _roundId;
        answeredInRound = _answeredInRound;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, price, block.timestamp, updatedAt, answeredInRound);
    }
}
