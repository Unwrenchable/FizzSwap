// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title FizzDex
 * @dev A decentralized exchange with integrated Fizz Caps game mechanics
 * Supports atomic swaps and cross-chain bridging
 */
contract FizzDex is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    
    // DEX State
    struct LiquidityPool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 totalShares;
        mapping(address => uint256) shares;
    }
    
    // Fizz Caps Game State
    struct Player {
        uint256 score;
        uint256 fizzCount;
        uint256 buzzCount;
        uint256 fizzBuzzCount;
        uint256 lastPlayTime;
        uint256 rewardBalance;
    }
    
    // Atomic Swap State
    struct AtomicSwap {
        address initiator;
        address participant;
        address token;
        uint256 amount;
        bytes32 secretHash;
        uint256 timelock;
        bool completed;
        bool refunded;
    }
    
    // Storage
    mapping(bytes32 => LiquidityPool) public pools;
    mapping(address => Player) public players;
    mapping(bytes32 => AtomicSwap) public atomicSwaps;
    
    // Game configuration
    uint256 public constant FIZZ_REWARD = 10 * 10**18; // 10 tokens
    uint256 public constant BUZZ_REWARD = 15 * 10**18; // 15 tokens
    uint256 public constant FIZZBUZZ_REWARD = 50 * 10**18; // 50 tokens
    uint256 public constant PLAY_COOLDOWN = 60; // 1 minute
    
    address public rewardToken;
    
    // Events
    event LiquidityAdded(bytes32 indexed poolId, address indexed provider, uint256 amountA, uint256 amountB, uint256 shares);
    event LiquidityRemoved(bytes32 indexed poolId, address indexed provider, uint256 amountA, uint256 amountB, uint256 shares);
    event Swap(bytes32 indexed poolId, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event FizzCapsPlayed(address indexed player, uint256 number, string result, uint256 reward);
    event AtomicSwapInitiated(bytes32 indexed swapId, address indexed initiator, address participant, uint256 amount);
    event AtomicSwapCompleted(bytes32 indexed swapId, address indexed participant);
    event AtomicSwapRefunded(bytes32 indexed swapId, address indexed initiator);
    
    constructor(address _rewardToken) {
        // Ownable's constructor sets owner to deployer (msg.sender). No explicit base args needed.
        rewardToken = _rewardToken;
    }
    
    // DEX Functions
    
    /**
     * @dev Create or get pool ID
     */
    function getPoolId(address tokenA, address tokenB) public pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encodePacked(token0, token1));
    }
    
    /**
     * @dev Add liquidity to a pool. Supports fee-on-transfer tokens and accepts tokens in any order.
     */
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB
    ) external nonReentrant returns (uint256 shares) {
        require(amountA > 0 && amountB > 0, "Invalid amounts");
        require(tokenA != tokenB, "Identical tokens");

        // canonical token ordering
        address token0 = tokenA < tokenB ? tokenA : tokenB;
        address token1 = tokenA < tokenB ? tokenB : tokenA;
        uint256 amount0 = tokenA == token0 ? amountA : amountB;
        uint256 amount1 = tokenA == token0 ? amountB : amountA;

        bytes32 poolId = getPoolId(tokenA, tokenB);
        LiquidityPool storage pool = pools[poolId];

        // Initialize pool if needed
        if (pool.tokenA == address(0)) {
            pool.tokenA = token0;
            pool.tokenB = token1;
        }

        // Read balances before transfer to support fee-on-transfer tokens
        uint256 balance0Before = IERC20(token0).balanceOf(address(this));
        uint256 balance1Before = IERC20(token1).balanceOf(address(this));

        // Transfer tokens using SafeERC20
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);

        // Actual received amounts (handles tokens that take fees on transfer)
        uint256 added0 = IERC20(token0).balanceOf(address(this)) - balance0Before;
        uint256 added1 = IERC20(token1).balanceOf(address(this)) - balance1Before;

        require(added0 > 0 && added1 > 0, "No tokens received");

        // Calculate shares based on actual received
        if (pool.totalShares == 0) {
            shares = sqrt(added0 * added1);
        } else {
            shares = min(
                (added0 * pool.totalShares) / pool.reserveA,
                (added1 * pool.totalShares) / pool.reserveB
            );
        }

        require(shares > 0, "Insufficient liquidity minted");

        pool.reserveA += added0;
        pool.reserveB += added1;
        pool.totalShares += shares;
        pool.shares[msg.sender] += shares;

        emit LiquidityAdded(poolId, msg.sender, added0, added1, shares);
    }
    
    /**
     * @dev Remove liquidity from a pool
     */
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 shares
    ) external nonReentrant returns (uint256 amountA, uint256 amountB) {
        bytes32 poolId = getPoolId(tokenA, tokenB);
        LiquidityPool storage pool = pools[poolId];

        require(pool.shares[msg.sender] >= shares, "Insufficient shares");

        amountA = (shares * pool.reserveA) / pool.totalShares;
        amountB = (shares * pool.reserveB) / pool.totalShares;

        pool.shares[msg.sender] -= shares;
        pool.totalShares -= shares;
        pool.reserveA -= amountA;
        pool.reserveB -= amountB;

        // Use SafeERC20 for outgoing transfers
        IERC20(pool.tokenA).safeTransfer(msg.sender, amountA);
        IERC20(pool.tokenB).safeTransfer(msg.sender, amountB);

        emit LiquidityRemoved(poolId, msg.sender, amountA, amountB, shares);
    }
    
    /**
     * @dev Swap tokens using constant product formula
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) external nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0, "Invalid input amount");
        require(tokenIn != tokenOut, "Identical tokens");

        bytes32 poolId = getPoolId(tokenIn, tokenOut);
        LiquidityPool storage pool = pools[poolId];

        require(pool.reserveA > 0 && pool.reserveB > 0, "Pool not initialized");

        bool isTokenA = tokenIn == pool.tokenA;
        uint256 reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
        uint256 reserveOut = isTokenA ? pool.reserveB : pool.reserveA;

        // Pull tokens first and compute actual received (supports fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualAmountIn = IERC20(tokenIn).balanceOf(address(this)) - balanceBefore;
        require(actualAmountIn > 0, "No input tokens received");

        uint256 amountInWithFee = actualAmountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);

        require(amountOut >= minAmountOut, "Slippage too high");
        require(amountOut < reserveOut, "Insufficient liquidity");

        // Update reserves with actual amounts
        if (isTokenA) {
            pool.reserveA += actualAmountIn;
            pool.reserveB -= amountOut;
        } else {
            pool.reserveB += actualAmountIn;
            pool.reserveA -= amountOut;
        }

        // Send output token
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);

        emit Swap(poolId, msg.sender, tokenIn, tokenOut, actualAmountIn, amountOut);
    }
    
    // Fizz Caps Game Functions
    
    /**
     * @dev Play the Fizz Caps game
     * @param number The number to check (1-100)
     */
    function playFizzCaps(uint256 number) external nonReentrant {
        require(number > 0 && number <= 100, "Number must be between 1 and 100");
        
        Player storage player = players[msg.sender];
        require(block.timestamp >= player.lastPlayTime + PLAY_COOLDOWN, "Cooldown active");
        
        player.lastPlayTime = block.timestamp;
        player.score++;
        
        uint256 reward = 0;
        string memory result;
        
        if (number % 15 == 0) {
            result = "FizzBuzz";
            reward = FIZZBUZZ_REWARD;
            player.fizzBuzzCount++;
        } else if (number % 3 == 0) {
            result = "Fizz";
            reward = FIZZ_REWARD;
            player.fizzCount++;
        } else if (number % 5 == 0) {
            result = "Buzz";
            reward = BUZZ_REWARD;
            player.buzzCount++;
        } else {
            result = "Miss";
        }
        
        if (reward > 0) {
            player.rewardBalance += reward;
        }
        
        emit FizzCapsPlayed(msg.sender, number, result, reward);
    }
    
    /**
     * @dev Claim accumulated rewards
     */
    function claimRewards() external nonReentrant {
        Player storage player = players[msg.sender];
        uint256 amount = player.rewardBalance;

        require(amount > 0, "No rewards to claim");

        player.rewardBalance = 0;
        IERC20(rewardToken).safeTransfer(msg.sender, amount);
    }
    
    /**
     * @dev Get player stats
     */
    function getPlayerStats(address playerAddress) external view returns (
        uint256 score,
        uint256 fizzCount,
        uint256 buzzCount,
        uint256 fizzBuzzCount,
        uint256 rewardBalance
    ) {
        Player memory player = players[playerAddress];
        return (
            player.score,
            player.fizzCount,
            player.buzzCount,
            player.fizzBuzzCount,
            player.rewardBalance
        );
    }
    
    // Atomic Swap Functions for Cross-Chain Support
    
    /**
     * @dev Initiate an atomic swap
     */
    function initiateAtomicSwap(
        address participant,
        address token,
        uint256 amount,
        bytes32 secretHash,
        uint256 timelock
    ) external nonReentrant returns (bytes32 swapId) {
        require(timelock > block.timestamp, "Invalid timelock");
        require(amount > 0, "Invalid amount");
        
        // transfer and record actual received (protect against fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = IERC20(token).balanceOf(address(this)) - balanceBefore;
        require(actualReceived > 0, "No tokens received");

        // compute swapId using the actual received amount
        swapId = keccak256(abi.encodePacked(
            msg.sender,
            participant,
            token,
            actualReceived,
            secretHash,
            timelock
        ));

        require(atomicSwaps[swapId].initiator == address(0), "Swap already exists");

        AtomicSwap storage swap = atomicSwaps[swapId];
        swap.initiator = msg.sender;
        swap.participant = participant;
        swap.token = token;
        swap.amount = actualReceived;
        swap.secretHash = secretHash;
        swap.timelock = timelock;

        emit AtomicSwapInitiated(swapId, msg.sender, participant, actualReceived);
    }
    
    /**
     * @dev Complete an atomic swap by revealing the secret
     */
    function completeAtomicSwap(bytes32 swapId, bytes calldata secret) external nonReentrant {
        AtomicSwap storage swap = atomicSwaps[swapId];
        
        require(swap.participant == msg.sender, "Not the participant");
        require(!swap.completed, "Already completed");
        require(!swap.refunded, "Already refunded");
        require(block.timestamp <= swap.timelock, "Swap expired");
        require(keccak256(secret) == swap.secretHash, "Invalid secret");
        
        swap.completed = true;
        IERC20(swap.token).safeTransfer(swap.participant, swap.amount);

        emit AtomicSwapCompleted(swapId, msg.sender);
    }
    
    /**
     * @dev Refund an atomic swap after timelock expires
     */
    function refundAtomicSwap(bytes32 swapId) external nonReentrant {
        AtomicSwap storage swap = atomicSwaps[swapId];
        
        require(swap.initiator == msg.sender, "Not the initiator");
        require(!swap.completed, "Already completed");
        require(!swap.refunded, "Already refunded");
        require(block.timestamp > swap.timelock, "Timelock not expired");
        
        swap.refunded = true;
        IERC20(swap.token).safeTransfer(swap.initiator, swap.amount);

        emit AtomicSwapRefunded(swapId, msg.sender);
    }
    
    // Utility Functions
    
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
    
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
    
    /**
     * @dev Fund the contract with reward tokens
     */
    function fundRewards(uint256 amount) external onlyOwner {
        IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);
    }
}
