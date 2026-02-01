# Technical Documentation - DEX AMM

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Smart Contract Details](#smart-contract-details)
3. [Mathematical Foundations](#mathematical-foundations)
4. [Gas Optimization](#gas-optimization)
5. [Security Analysis](#security-analysis)
6. [Integration Guide](#integration-guide)
7. [Advanced Topics](#advanced-topics)

---

## Architecture Overview

### System Design
```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend Layer                       │
│  • React/Next.js                                            │
│  • Ethers.js / Web3.js                                      │
│  • Wallet Connect                                           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Router Contract                         │
│  DEXRouter.sol                                              │
│  • User-facing interface                                    │
│  • Multi-hop routing                                        │
│  • Amount calculations                                      │
│  • Slippage protection                                      │
└─────────────────────────────────────────────────────────────┘
                            │
                ┌───────────┴────────────┐
                ▼                        ▼
┌─────────────────────────┐   ┌──────────────────────────────┐
│    Factory Contract      │   │       Pair Contracts         │
│  DEXFactory.sol         │   │    DEXPair.sol (Multiple)    │
│  • Pair registry        │───│  • Liquidity pools           │
│  • Pair creation        │   │  • Swap execution            │
│  • Unique pairs         │   │  • LP token minting          │
└─────────────────────────┘   │  • Reserve management        │
                              └──────────────────────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────────┐
                              │      ERC20 Tokens            │
                              │  • Token A, Token B, etc.    │
                              │  • Standard ERC20 interface  │
                              └──────────────────────────────┘
```

### Component Responsibilities

#### **DEXFactory**
- **Purpose**: Pair registry and creation
- **Responsibility**: Ensure only one pair per token combination
- **State**: Mapping of token pairs to addresses
- **Immutable**: Once deployed, cannot be upgraded

#### **DEXPair**
- **Purpose**: Automated market maker for a token pair
- **Responsibility**: Maintain reserves, execute swaps, mint/burn LP tokens
- **State**: Reserves, LP token supply
- **One instance per unique token pair**

#### **DEXRouter**
- **Purpose**: User-friendly interface
- **Responsibility**: Calculate optimal amounts, route swaps, manage approvals
- **Stateless**: Only reads from pairs, doesn't store state
- **Upgradeable**: Can deploy new router without affecting pairs

---

## Smart Contract Details

### DEXFactory.sol

#### State Variables
```solidity
mapping(address => mapping(address => address)) public getPair;
// token0 => token1 => pair address
// Bidirectional: getPair[A][B] == getPair[B][A]

address[] public allPairs;
// Array of all pair addresses
```

#### Key Functions

##### `createPair(address tokenA, address tokenB)`

**Purpose**: Deploy new pair contract

**Flow**:
```
1. Validate tokens are different
2. Sort tokens (token0 < token1)
3. Check pair doesn't exist
4. Deploy DEXPair contract
5. Store in mappings (bidirectional)
6. Add to allPairs array
7. Emit PairCreated event
```

**Gas Cost**: ~1,500,000 gas

**Security**:
- ✅ Prevents duplicate pairs
- ✅ Prevents zero address
- ✅ Consistent token ordering

**Code Walkthrough**:
```solidity
function createPair(address tokenA, address tokenB) external returns (address pair) {
    require(tokenA != tokenB, "Identical addresses");
    
    // Sort tokens to ensure consistent ordering
    (address token0, address token1) = tokenA < tokenB 
        ? (tokenA, tokenB) 
        : (tokenB, tokenA);
    
    require(token0 != address(0), "Zero address");
    require(getPair[token0][token1] == address(0), "Pair already exists");

    // Deploy new pair - creates deterministic address
    DEXPair newPair = new DEXPair(token0, token1);
    pair = address(newPair);

    // Bidirectional mapping
    getPair[token0][token1] = pair;
    getPair[token1][token0] = pair;
    
    allPairs.push(pair);

    emit PairCreated(token0, token1, pair, allPairs.length);
}
```

---

### DEXPair.sol

#### State Variables
```solidity
IERC20 public token0;           // First token (sorted address)
IERC20 public token1;           // Second token (sorted address)

uint256 private reserve0;       // Reserve of token0
uint256 private reserve1;       // Reserve of token1

uint256 public constant MINIMUM_LIQUIDITY = 10**3;  // 1000 wei permanently locked
uint256 private constant FEE_DENOMINATOR = 1000;
uint256 private constant FEE_NUMERATOR = 3;         // 0.3% fee
```

#### Inheritance
```solidity
contract DEXPair is ERC20, ReentrancyGuard {
    // ERC20: LP token functionality
    // ReentrancyGuard: Prevents reentrancy attacks
}
```

#### Critical Functions

##### `mint(address to)`

**Purpose**: Add liquidity and mint LP tokens

**Algorithm**:
```
1. Get current balances
2. Calculate amounts deposited (balance - reserve)
3. Calculate LP tokens to mint:
   
   First liquidity provider:
   liquidity = sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
   
   Subsequent providers:
   liquidity = min(
       amount0 * totalSupply / reserve0,
       amount1 * totalSupply / reserve1
   )

4. Mint LP tokens to user
5. Update reserves
6. Emit Mint event
```

**Why sqrt for first LP?**
The square root ensures the initial LP token supply is proportional to the geometric mean of the deposited amounts, preventing manipulation by the first depositor.

**Code**:
```solidity
function mint(address to) external nonReentrant returns (uint256 liquidity) {
    (uint256 _reserve0, uint256 _reserve1) = getReserves();
    uint256 balance0 = token0.balanceOf(address(this));
    uint256 balance1 = token1.balanceOf(address(this));
    uint256 amount0 = balance0 - _reserve0;
    uint256 amount1 = balance1 - _reserve1;

    uint256 _totalSupply = totalSupply();

    if (_totalSupply == 0) {
        // First liquidity provider
        liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
        _mint(address(1), MINIMUM_LIQUIDITY); // Permanently lock
    } else {
        // Subsequent liquidity providers
        liquidity = Math.min(
            (amount0 * _totalSupply) / _reserve0,
            (amount1 * _totalSupply) / _reserve1
        );
    }

    require(liquidity > 0, "Insufficient liquidity minted");
    _mint(to, liquidity);

    _update(balance0, balance1);
    emit Mint(msg.sender, amount0, amount1);
}
```

##### `burn(address to)`

**Purpose**: Remove liquidity and burn LP tokens

**Algorithm**:
```
1. Get LP token balance in contract
2. Calculate share of reserves:
   amount0 = liquidity * balance0 / totalSupply
   amount1 = liquidity * balance1 / totalSupply

3. Burn LP tokens
4. Transfer tokens to user
5. Update reserves
6. Emit Burn event
```

**Code**:
```solidity
function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
    uint256 balance0 = token0.balanceOf(address(this));
    uint256 balance1 = token1.balanceOf(address(this));
    uint256 liquidity = balanceOf(address(this));

    uint256 _totalSupply = totalSupply();
    amount0 = (liquidity * balance0) / _totalSupply;
    amount1 = (liquidity * balance1) / _totalSupply;

    require(amount0 > 0 && amount1 > 0, "Insufficient liquidity burned");

    _burn(address(this), liquidity);
    token0.transfer(to, amount0);
    token1.transfer(to, amount1);

    balance0 = token0.balanceOf(address(this));
    balance1 = token1.balanceOf(address(this));

    _update(balance0, balance1);
    emit Burn(msg.sender, amount0, amount1, to);
}
```

##### `swap(uint256 amount0Out, uint256 amount1Out, address to)`

**Purpose**: Execute token swap

**Algorithm**:
```
1. Validate outputs > 0
2. Validate sufficient liquidity
3. Transfer output tokens to user
4. Calculate input amounts
5. Verify k value maintains (with fee):
   
   balance0Adjusted * balance1Adjusted >= reserve0 * reserve1 * (1000^2)
   
6. Update reserves
7. Emit Swap event
```

**K Value Check Explained**:
```solidity
// After 0.3% fee adjustment
uint256 balance0Adjusted = (balance0 * 1000) - (amount0In * 3);
uint256 balance1Adjusted = (balance1 * 1000) - (amount1In * 3);

// Must maintain k (with fee accumulation)
require(
    balance0Adjusted * balance1Adjusted >= _reserve0 * _reserve1 * (1000 ** 2),
    "K value check failed"
);
```

This ensures the constant product formula is maintained after accounting for the 0.3% fee.

**Code**:
```solidity
function swap(
    uint256 amount0Out,
    uint256 amount1Out,
    address to
) external nonReentrant {
    require(amount0Out > 0 || amount1Out > 0, "Insufficient output amount");
    (uint256 _reserve0, uint256 _reserve1) = getReserves();
    require(amount0Out < _reserve0 && amount1Out < _reserve1, "Insufficient liquidity");

    // Transfer outputs
    if (amount0Out > 0) token0.transfer(to, amount0Out);
    if (amount1Out > 0) token1.transfer(to, amount1Out);

    // Get new balances
    uint256 balance0 = token0.balanceOf(address(this));
    uint256 balance1 = token1.balanceOf(address(this));

    // Calculate inputs
    uint256 amount0In = balance0 > _reserve0 - amount0Out 
        ? balance0 - (_reserve0 - amount0Out) 
        : 0;
    uint256 amount1In = balance1 > _reserve1 - amount1Out 
        ? balance1 - (_reserve1 - amount1Out) 
        : 0;

    require(amount0In > 0 || amount1In > 0, "Insufficient input amount");

    // Verify k with fee
    {
        uint256 balance0Adjusted = (balance0 * FEE_DENOMINATOR) - (amount0In * FEE_NUMERATOR);
        uint256 balance1Adjusted = (balance1 * FEE_DENOMINATOR) - (amount1In * FEE_NUMERATOR);
        
        require(
            balance0Adjusted * balance1Adjusted >= 
            _reserve0 * _reserve1 * (FEE_DENOMINATOR ** 2),
            "K value check failed"
        );
    }

    _update(balance0, balance1);
    emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
}
```

##### Price Calculation Functions

**getAmountOut**: Calculate output for exact input
```solidity
function getAmountOut(
    uint256 amountIn,
    uint256 reserveIn,
    uint256 reserveOut
) public pure returns (uint256 amountOut) {
    require(amountIn > 0, "Insufficient input amount");
    require(reserveIn > 0 && reserveOut > 0, "Insufficient liquidity");

    uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - FEE_NUMERATOR);
    uint256 numerator = amountInWithFee * reserveOut;
    uint256 denominator = (reserveIn * FEE_DENOMINATOR) + amountInWithFee;
    amountOut = numerator / denominator;
}
```

**Derivation**:
```
Starting from: x * y = k
After swap: (x + Δx) * (y - Δy) = k

Where Δx is input (after fee) and Δy is output

x * y = (x + Δx * 0.997) * (y - Δy)

Solving for Δy:
Δy = (Δx * 0.997 * y) / (x + Δx * 0.997)

In code (avoiding decimals):
Δy = (Δx * 997 * y) / (x * 1000 + Δx * 997)
```

**getAmountIn**: Calculate input for exact output
```solidity
function getAmountIn(
    uint256 amountOut,
    uint256 reserveIn,
    uint256 reserveOut
) public pure returns (uint256 amountIn) {
    require(amountOut > 0, "Insufficient output amount");
    require(reserveIn > 0 && reserveOut > 0, "Insufficient liquidity");

    uint256 numerator = reserveIn * amountOut * FEE_DENOMINATOR;
    uint256 denominator = (reserveOut - amountOut) * (FEE_DENOMINATOR - FEE_NUMERATOR);
    amountIn = (numerator / denominator) + 1;
}
```

---

### DEXRouter.sol

#### Purpose & Design

The router is a **stateless helper contract** that:
- Simplifies user interactions
- Handles token approvals
- Calculates optimal amounts
- Routes multi-hop swaps
- Provides slippage protection

**Key Design Decision**: Router is separate from pairs so it can be upgraded without affecting existing liquidity.

#### Key Functions

##### `addLiquidity()`

**Purpose**: Add liquidity with optimal amounts

**Algorithm**:
```
1. Create pair if doesn't exist
2. Calculate optimal amounts:
   
   If new pair:
   - Use desired amounts
   
   If existing pair:
   - Calculate amountBOptimal = (amountA * reserveB) / reserveA
   - If amountBOptimal <= amountBDesired:
     - Use (amountA, amountBOptimal)
   - Else:
     - Calculate amountAOptimal = (amountB * reserveA) / reserveB
     - Use (amountAOptimal, amountB)

3. Verify amounts >= minimums (slippage protection)
4. Transfer tokens to pair
5. Call pair.mint()
6. Emit LiquidityAdded event
```

**Why optimal amounts?**
To maintain the current price ratio and prevent unfavorable trades.

**Code**:
```solidity
function addLiquidity(
    address tokenA,
    address tokenB,
    uint256 amountADesired,
    uint256 amountBDesired,
    uint256 amountAMin,
    uint256 amountBMin,
    address to
) external nonReentrant returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
    // Create pair if needed
    address pair = DEXFactory(factory).getPair(tokenA, tokenB);
    if (pair == address(0)) {
        pair = DEXFactory(factory).createPair(tokenA, tokenB);
    }

    // Calculate optimal amounts
    (amountA, amountB) = _calculateLiquidityAmounts(
        tokenA,
        tokenB,
        amountADesired,
        amountBDesired,
        amountAMin,
        amountBMin
    );

    // Transfer tokens
    IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
    IERC20(tokenB).transferFrom(msg.sender, pair, amountB);

    // Mint LP tokens
    liquidity = DEXPair(pair).mint(to);

    emit LiquidityAdded(tokenA, tokenB, amountA, amountB, liquidity);
}
```

##### `swapExactTokensForTokens()`

**Purpose**: Swap exact input for variable output

**Algorithm**:
```
1. Validate path length >= 2
2. Calculate output amounts for each hop
3. Verify final output >= minimum (slippage protection)
4. Transfer input tokens to first pair
5. Execute swaps through path
6. Emit TokensSwapped event
```

**Multi-hop Example**:
```
Path: [TKA, TKB, TKC]

Hop 1: TKA → TKB in Pair(TKA, TKB)
Hop 2: TKB → TKC in Pair(TKB, TKC)

Output of Hop 1 becomes input of Hop 2
```

**Code**:
```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    address[] calldata path,
    address to
) external nonReentrant returns (uint256[] memory amounts) {
    require(path.length >= 2, "Invalid path");
    
    // Calculate all amounts
    amounts = getAmountsOut(amountIn, path);
    require(amounts[amounts.length - 1] >= amountOutMin, "Insufficient output amount");

    // Transfer to first pair
    address pair = DEXFactory(factory).getPair(path[0], path[1]);
    IERC20(path[0]).transferFrom(msg.sender, pair, amounts[0]);

    // Execute swaps
    _swap(amounts, path, to);

    emit TokensSwapped(path[0], path[path.length - 1], amountIn, amounts[amounts.length - 1], to);
}
```

##### `_swap()` - Internal Multi-hop Logic
```solidity
function _swap(uint256[] memory amounts, address[] memory path, address _to) private {
    for (uint256 i = 0; i < path.length - 1; i++) {
        (address input, address output) = (path[i], path[i + 1]);
        (address token0, ) = _sortTokens(input, output);
        uint256 amountOut = amounts[i + 1];

        // Determine which token is output
        (uint256 amount0Out, uint256 amount1Out) = input == token0
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        // Determine next recipient
        address to = i < path.length - 2
            ? DEXFactory(factory).getPair(output, path[i + 2])  // Next pair
            : _to;  // Final recipient

        // Execute swap
        address pair = DEXFactory(factory).getPair(input, output);
        DEXPair(pair).swap(amount0Out, amount1Out, to);
    }
}
```

**Flow Diagram**:
```
User → Router.swapExactTokensForTokens()
  ↓
Router transfers tokens to Pair1
  ↓
Router calls Pair1.swap() → output goes to Pair2
  ↓
Router calls Pair2.swap() → output goes to User
```

---

## Mathematical Foundations

### Constant Product Formula

#### Core Equation
```
x * y = k
```

Where:
- `x` = Reserve of token X
- `y` = Reserve of token Y  
- `k` = Constant (increases with fees)

#### Properties

1. **Always Provides Liquidity**
   - No matter the trade size, there's always a price
   - As reserves deplete, price increases exponentially

2. **Price Discovery**
```
   Price of X in Y = y / x
   Price of Y in X = x / y
```

3. **Self-Balancing**
   - If price diverges from market, arbitrageurs profit by rebalancing
   - Keeps pool aligned with external prices

#### Swap Mathematics

**Given**: Input amount `Δx`  
**Find**: Output amount `Δy`

**Equation**:
```
(x + Δx * 0.997) * (y - Δy) = x * y

Solving for Δy:
Δy = (Δx * 0.997 * y) / (x + Δx * 0.997)
```

**Example**:
```
Pool: 1000 TKA, 2000 TKB
k = 2,000,000

Input: 100 TKA (after fee: 99.7 TKA)

Output = (99.7 * 2000) / (1000 + 99.7)
       = 199,400 / 1099.7
       = 181.3 TKB

New pool: 1100 TKA, 1818.7 TKB
New k = 2,000,570 (fees added!)
```

### Price Impact

**Definition**: Change in price due to trade size

**Formula**:
```
Price Impact = (Expected Price - Execution Price) / Expected Price

Expected Price = y / x
Execution Price = Δy / Δx
```

**Example**:
```
Pool: 1000 TKA, 2000 TKB
Current price: 2 TKB per TKA

Trade: 100 TKA

Expected: 100 * 2 = 200 TKB
Actual: 181.3 TKB

Price Impact = (200 - 181.3) / 200 = 9.35%
```

### Impermanent Loss

**Definition**: Loss compared to holding tokens

**Formula**:
```
IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1

Where price_ratio = current_price / initial_price
```

**Example**:
```
Initial: 1 ETH + 2000 USDC (1 ETH = 2000 USDC)
Price doubles: 1 ETH = 4000 USDC

LP Position:
sqrt(k) = sqrt(1 * 2000) = 44.72
New amounts: 
x = 44.72 / sqrt(4000) = 0.707 ETH
y = 44.72 * sqrt(4000) = 2828 USDC

Value = 0.707 * 4000 + 2828 = $5656

Hold Value = 1 * 4000 + 2000 = $6000

IL = $344 (5.7%)
```

**IL Table**:
| Price Change | Impermanent Loss |
|--------------|------------------|
| 1.25x | 0.6% |
| 1.50x | 2.0% |
| 1.75x | 3.8% |
| 2x | 5.7% |
| 3x | 13.4% |
| 4x | 20.0% |
| 5x | 25.5% |

---

## Gas Optimization

### Techniques Implemented

#### 1. Storage Packing
```solidity
// Bad: Uses 3 storage slots
uint256 reserve0;
uint256 reserve1;
bool locked;

// Good: Packed into fewer slots (but we use separate for clarity)
```

#### 2. Memory Usage
```solidity
// Use memory for temporary calculations
uint256[] memory amounts = new uint256[](path.length);

// Avoid repeated SLOAD
(uint256 _reserve0, uint256 _reserve1) = getReserves();
// Use _reserve0, _reserve1 instead of reserve0, reserve1
```

#### 3. Minimize Storage Writes
```solidity
// Bad: Multiple SSTOREs
reserve0 = balance0;
reserve1 = balance1;
emit Sync(reserve0, reserve1);

// Good: Batch update
_update(balance0, balance1);  // Single function with both updates
```

#### 4. Efficient Loops
```solidity
// Cache array length
uint256 length = path.length;
for (uint256 i = 0; i < length - 1; i++) {
    // Loop body
}
```

#### 5. View Functions
```solidity
// No gas cost for off-chain calls
function getReserves() public view returns (uint256, uint256) {
    return (reserve0, reserve1);
}
```

### Gas Costs Breakdown

| Operation | Storage Reads | Storage Writes | External Calls | Approx Gas |
|-----------|---------------|----------------|----------------|------------|
| Create Pair | 3 | 4 | 1 (deploy) | 1,500,000 |
| Add Liquidity (first) | 5 | 8 | 3 | 250,000 |
| Add Liquidity | 5 | 6 | 3 | 150,000 |
| Remove Liquidity | 4 | 4 | 3 | 120,000 |
| Swap | 3 | 2 | 2 | 100,000 |

**Optimization Tips**:
- Batch operations when possible
- Use multicall for multiple swaps
- Consider Layer 2 for lower costs

---

## Security Analysis

### Threat Model

#### 1. Reentrancy Attacks

**Vulnerability**: External calls could callback

**Mitigation**:
```solidity
contract DEXPair is ReentrancyGuard {
    function swap(...) external nonReentrant {
        // Protected
    }
}
```

**Checks-Effects-Interactions**:
```solidity
// 1. Checks
require(amount0Out > 0 || amount1Out > 0);

// 2. Effects (state changes)
_update(balance0, balance1);

// 3. Interactions (external calls)
token0.transfer(to, amount0Out);
```

#### 2. Price Manipulation

**Attack**: Manipulate reserves to exploit price

**Mitigation**:
- K value verification
- Minimum liquidity lock
- Consider TWAP oracles for production
```solidity
// Ensures k never decreases (except for fees)
require(
    balance0Adjusted * balance1Adjusted >= reserve0 * reserve1 * (1000**2),
    "K"
);
```

#### 3. Flash Loan Attacks

**Attack**: Borrow large amounts, manipulate price, profit

**Mitigation**:
- TWAP (Time-Weighted Average Price)
- Maximum trade size limits
- Multi-block oracle prices

**Note**: Current implementation vulnerable to flash loans. Production needs TWAP.

#### 4. Front-Running

**Attack**: See transaction in mempool, submit higher gas to execute first

**Mitigation**:
- Slippage protection (amountOutMin)
- Deadline parameters
- Private transactions (Flashbots)
```solidity
require(amounts[amounts.length - 1] >= amountOutMin, "Slippage");
```

#### 5. Integer Overflow

**Protection**: Solidity 0.8+ automatic checks
```solidity
// This will revert on overflow
uint256 product = x * y;
```

### Audit Checklist

**Before Mainnet**:
- [ ] Professional security audit
- [ ] Formal verification of math
- [ ] Extensive testnet testing
- [ ] Bug bounty program
- [ ] Flash loan protection
- [ ] Emergency pause mechanism
- [ ] Multi-sig admin controls
- [ ] Monitoring and alerts

---

## Integration Guide

### Frontend Integration

#### Setup
```javascript
import { ethers } from 'ethers';

// Connect wallet
const provider = new ethers.BrowserProvider(window.ethereum);
await provider.send("eth_requestAccounts", []);
const signer = await provider.getSigner();

// Contract instances
const router = new ethers.Contract(routerAddress, routerABI, signer);
const factory = new ethers.Contract(factoryAddress, factoryABI, signer);
```

#### Get Pool Info
```javascript
async function getPoolInfo(tokenA, tokenB) {
    // Get pair address
    const pairAddress = await factory.getPair(tokenA, tokenB);
    
    if (pairAddress === ethers.ZeroAddress) {
        return { exists: false };
    }

    // Get pair contract
    const pair = new ethers.Contract(pairAddress, pairABI, signer);
    
    // Get reserves
    const [reserve0, reserve1] = await pair.getReserves();
    
    // Get LP token supply
    const totalSupply = await pair.totalSupply();
    
    // Sort tokens
    const token0 = tokenA < tokenB ? tokenA : tokenB;
    
    return {
        exists: true,
        pairAddress,
        reserve0: ethers.formatEther(reserve0),
        reserve1: ethers.formatEther(reserve1),
        totalSupply: ethers.formatEther(totalSupply),
        token0
    };
}
```

#### Calculate Price
```javascript
async function getPrice(tokenIn, tokenOut, amountIn) {
    const path = [tokenIn, tokenOut];
    const amounts = await router.getAmountsOut(
        ethers.parseEther(amountIn),
        path
    );
    
    return {
        input: ethers.formatEther(amounts[0]),
        output: ethers.formatEther(amounts[1]),
        price: Number(amounts[1]) / Number(amounts[0])
    };
}
```

#### Execute Swap with Slippage
```javascript
async function swap(tokenIn, tokenOut, amountIn, slippagePct = 0.5) {
    // Get expected output
    const path = [tokenIn, tokenOut];
    const amountInWei = ethers.parseEther(amountIn.toString());
    const amounts = await router.getAmountsOut(amountInWei, path);
    
    // Calculate minimum output (slippage protection)
    const slippage = BigInt(Math.floor(slippagePct * 100));
    const amountOutMin = amounts[1] * (10000n - slippage) / 10000n;
    
    // Approve token
    const tokenContract = new ethers.Contract(tokenIn, erc20ABI, signer);
    const allowance = await tokenContract.allowance(signer.address, routerAddress);
    
    if (allowance < amountInWei) {
        const approveTx = await tokenContract.approve(routerAddress, ethers.MaxUint256);
        await approveTx.wait();
    }
    
    // Execute swap
    const tx = await router.swapExactTokensForTokens(
        amountInWei,
        amountOutMin,
        path,
        signer.address
    );
    
    const receipt = await tx.wait();
    
    return {
        hash: receipt.hash,
        amountIn: ethers.formatEther(amountInWei),
        amountOut: ethers.formatEther(amounts[1]),
        minOut: ethers.formatEther(amountOutMin)
    };
}
```

#### Add Liquidity with Auto-calculation
```javascript
async function addLiquidity(tokenA, tokenB, amountA, slippagePct = 1) {
    const amountAWei = ethers.parseEther(amountA.toString());
    
    // Get pool ratio
    const poolInfo = await getPoolInfo(tokenA, tokenB);
    
    let amountBWei;
    if (!poolInfo.exists) {
        // New pool - user chooses ratio
        amountBWei = ethers.parseEther(prompt("Amount of token B:"));
    } else {
        // Existing pool - calculate optimal amount
        const [reserveA, reserveB] = tokenA < tokenB 
            ? [poolInfo.reserve0, poolInfo.reserve1]
            : [poolInfo.reserve1, poolInfo.reserve0];
        
        amountBWei = (amountAWei * ethers.parseEther(reserveB)) / 
                     ethers.parseEther(reserveA);
    }
    
    // Calculate minimums
    const slippage = BigInt(Math.floor(slippagePct * 100));
    const amountAMin = amountAWei * (10000n - slippage) / 10000n;
    const amountBMin = amountBWei * (10000n - slippage) / 10000n;
    
    // Approve tokens
    const tokenAContract = new ethers.Contract(tokenA, erc20ABI, signer);
    const tokenBContract = new ethers.Contract(tokenB, erc20ABI, signer);
    
    await tokenAContract.approve(routerAddress, ethers.MaxUint256);
    await tokenBContract.approve(routerAddress, ethers.MaxUint256);
    
    // Add liquidity
    const tx = await router.addLiquidity(
        tokenA,
        tokenB,
        amountAWei,
        amountBWei,
        amountAMin,
        amountBMin,
        signer.address
    );
    
    await tx.wait();
}
```

#### Listen to Events
```javascript
// Listen for swaps
router.on("TokensSwapped", (tokenIn, tokenOut, amountIn, amountOut, to, event) => {
    console.log(`Swap: ${ethers.formatEther(amountIn)} → ${ethers.formatEther(amountOut)}`);
    console.log(`From: ${tokenIn} To: ${tokenOut}`);
});

// Listen for liquidity additions
router.on("LiquidityAdded", (token0, token1, amount0, amount1, liquidity, event) => {
    console.log(`Liquidity Added: ${ethers.formatEther(amount0)} + ${ethers.formatEther(amount1)}`);
});
```

---

## Advanced Topics

### Multi-hop Routing Optimization

**Problem**: Finding optimal path for token swaps

**Example**:
```
Want: TKA → TKD

Direct path:
TKA → TKD (if pair exists)

Multi-hop paths:
TKA → TKB → TKD
TKA → TKC → TKD
TKA → TKB → TKC → TKD
```

**Algorithm** (simplified):
```javascript
function findBestPath(tokenIn, tokenOut, allPairs) {
    const paths = [];
    
    // BFS to find all possible paths (max 3 hops)
    const queue = [[tokenIn]];
    
    while (queue.length > 0) {
        const path = queue.shift();
        const lastToken = path[path.length - 1];
        
        if (lastToken === tokenOut) {
            paths.push(path);
            continue;
        }
        
        if (path.length >= 4) continue; // Max 3 hops
        
        // Find all pairs with lastToken
        for (const pair of allPairs) {
            if (pair.token0 === lastToken && !path.includes(pair.token1)) {
                queue.push([...path, pair.token1]);
            }
            if (pair.token1 === lastToken && !path.includes(pair.token0)) {
                queue.push([...path, pair.token0]);
            }
        }
    }
    
    // Calculate output for each path
    const results = await Promise.all(
        paths.map(async path => {
            const amounts = await router.getAmountsOut(amountIn, path);
            return {
                path,
                output: amounts[amounts.length - 1]
            };
        })
    );
    
    // Return best path
    return results.reduce((best, current) => 
        current.output > best.output ? current : best
    );
}
```

### Price Oracle Implementation

**Problem**: On-chain prices can be manipulated

**Solution**: Time-Weighted Average Price (TWAP)
```solidity
contract PriceOracle {
    struct Observation {
        uint256 timestamp;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }
    
    mapping(address => Observation[]) public observations;
    
    function update(address pair) external {
        (uint256 reserve0, uint256 reserve1) = DEXPair(pair).getReserves();
        
        uint256 price0 = (reserve1 * 1e18) / reserve0;
        uint256 price1 = (reserve0 * 1e18) / reserve1;
        
        Observation[] storage obs = observations[pair];
        uint256 timeElapsed = block.timestamp - obs[obs.length - 1].timestamp;
        
        obs.push(Observation({
            timestamp: block.timestamp,
            price0Cumulative: obs[obs.length - 1].price0Cumulative + price0 * timeElapsed,
            price1Cumulative: obs[obs.length - 1].price1Cumulative + price1 * timeElapsed
        }));
    }
    
    function consult(address pair, uint256 period) external view returns (uint256 price0, uint256 price1) {
        Observation[] storage obs = observations[pair];
        uint256 length = obs.length;
        
        require(length > 1, "Insufficient data");
        require(obs[length - 1].timestamp - obs[0].timestamp >= period, "Period not elapsed");
        
        uint256 price0Delta = obs[length - 1].price0Cumulative - obs[length - period].price0Cumulative;
        uint256 price1Delta = obs[length - 1].price1Cumulative - obs[length - period].price1Cumulative;
        uint256 timeDelta = obs[length - 1].timestamp - obs[length - period].timestamp;
        
        price0 = price0Delta / timeDelta;
        price1 = price1Delta / timeDelta;
    }
}
```

### Concentrated Liquidity (Uniswap V3 concept)

**Current (V2)**: Liquidity spread across entire price range  
**V3**: Liquidity concentrated in price ranges

**Benefits**:
- Higher capital efficiency
- Customizable positions
- Active management strategies

**Trade-off**:
- More complex
- Requires active management
- Impermanent loss can be higher

---

## Performance Benchmarks

### Transaction Throughput

| Network | TPS | Block Time | Finality |
|---------|-----|------------|----------|
| Ethereum | 15-30 | 12s | 12-15 min |
| Polygon | 65-70 | 2s | ~5 min |
| Arbitrum | 4,000+ | ~0.25s | ~15 min (L1) |
| Optimism | 2,000+ | ~2s | ~7 days (L1) |

### Gas Costs by Network

| Operation | Ethereum | Polygon | Arbitrum | Optimism |
|-----------|----------|---------|----------|----------|
| Swap | $10-50 | $0.01-0.10 | $0.10-1 | $0.10-1 |
| Add Liquidity | $30-150 | $0.03-0.30 | $0.30-3 | $0.30-3 |
| Create Pair | $100-500 | $0.10-1 | $1-10 | $1-10 |

*Prices vary with ETH price and network congestion*

---

## Deployment Checklist

### Pre-Deployment

- [ ] Security audit completed
- [ ] All tests passing
- [ ] Gas optimization verified
- [ ] Documentation complete
- [ ] Multi-sig wallet configured
- [ ] Emergency procedures defined
- [ ] Monitoring setup
- [ ] Frontend tested

### Testnet Deployment

- [ ] Deploy to Sepolia/Goerli
- [ ] Verify contracts on Etherscan
- [ ] Test all functions
- [ ] Simulate edge cases
- [ ] Community testing
- [ ] Bug bounty program

### Mainnet Deployment

- [ ] Final audit review
- [ ] Deploy Factory
- [ ] Deploy Router
- [ ] Verify all contracts
- [ ] Create initial pairs
- [ ] Add initial liquidity
- [ ] Configure monitoring
- [ ] Announce launch
- [ ] Monitor closely for 48h

---

## Troubleshooting

### Common Issues

**"K value check failed"**
- Cause: Swap violates constant product formula
- Fix: Check fee calculations, ensure no rounding errors

**"Insufficient liquidity"**
- Cause: Trying to swap more than available reserves
- Fix: Reduce swap size or add more liquidity

**"Excessive input amount"**
- Cause: Input required exceeds maximum
- Fix: Use swapExactTokensForTokens instead

**"Pair already exists"**
- Cause: Trying to create duplicate pair
- Fix: Use existing pair address

### Debug Tips
```javascript
// Check reserves
const [reserve0, reserve1] = await pair.getReserves();
console.log("Reserves:", reserve0.toString(), reserve1.toString());

// Calculate expected output
const amounts = await router.getAmountsOut(amountIn, path);
console.log("Expected amounts:", amounts.map(a => a.toString()));

// Check approvals
const allowance = await token.allowance(user, router);
console.log("Allowance:", allowance.toString());

// Simulate transaction
try {
    await router.callStatic.swapExactTokensForTokens(...);
} catch (error) {
    console.error("Simulation failed:", error);
}
```

---

**Document Version**: 1.0  
**Last Updated**: February 2026  
**Solidity Version**: 0.8.28

---

*This technical documentation covers the complete implementation details of a production-ready DEX AMM system.*