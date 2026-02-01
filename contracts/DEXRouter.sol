// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DEXFactory.sol";
import "./DEXPair.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DEXRouter is ReentrancyGuard {
    address public immutable factory;

    event LiquidityAdded(
        address indexed token0,
        address indexed token1,
        uint256 amount0,
        uint256 amount1,
        uint256 liquidity
    );

    event LiquidityRemoved(
        address indexed token0,
        address indexed token1,
        uint256 amount0,
        uint256 amount1
    );

    event TokensSwapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address indexed to
    );

    constructor(address _factory) {
        require(_factory != address(0), "Invalid factory address");
        factory = _factory;
    }

    // Add liquidity to a pair
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to
    ) external nonReentrant returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        // Create pair if it doesn't exist
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

        // Transfer tokens to pair
        IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).transferFrom(msg.sender, pair, amountB);

        // Mint LP tokens
        liquidity = DEXPair(pair).mint(to);

        emit LiquidityAdded(tokenA, tokenB, amountA, amountB, liquidity);
    }

    // Remove liquidity from a pair
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to
    ) external nonReentrant returns (uint256 amountA, uint256 amountB) {
        address pair = DEXFactory(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "Pair does not exist");

        // Transfer LP tokens to pair
        IERC20(pair).transferFrom(msg.sender, pair, liquidity);

        // Burn LP tokens and receive tokens
        (uint256 amount0, uint256 amount1) = DEXPair(pair).burn(to);

        // Sort amounts
        (address token0, ) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);

        require(amountA >= amountAMin, "Insufficient amount A");
        require(amountB >= amountBMin, "Insufficient amount B");

        emit LiquidityRemoved(tokenA, tokenB, amountA, amountB);
    }

    // Swap exact tokens for tokens
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to
    ) external nonReentrant returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "Insufficient output amount");

        // Transfer input tokens to first pair
        address pair = DEXFactory(factory).getPair(path[0], path[1]);
        require(pair != address(0), "Pair does not exist");
        IERC20(path[0]).transferFrom(msg.sender, pair, amounts[0]);

        // Execute swaps
        _swap(amounts, path, to);

        emit TokensSwapped(path[0], path[path.length - 1], amountIn, amounts[amounts.length - 1], to);
    }

    // Swap tokens for exact tokens
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to
    ) external nonReentrant returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= amountInMax, "Excessive input amount");

        // Transfer input tokens to first pair
        address pair = DEXFactory(factory).getPair(path[0], path[1]);
        require(pair != address(0), "Pair does not exist");
        IERC20(path[0]).transferFrom(msg.sender, pair, amounts[0]);

        // Execute swaps
        _swap(amounts, path, to);

        emit TokensSwapped(path[0], path[path.length - 1], amounts[0], amountOut, to);
    }

    // Get amounts out for exact input
    function getAmountsOut(uint256 amountIn, address[] memory path)
        public
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "Invalid path");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = DEXFactory(factory).getPair(path[i], path[i + 1]);
            require(pair != address(0), "Pair does not exist");

            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i], path[i + 1]);
            amounts[i + 1] = DEXPair(pair).getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    // Get amounts in for exact output
    function getAmountsIn(uint256 amountOut, address[] memory path)
        public
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "Invalid path");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;

        for (uint256 i = path.length - 1; i > 0; i--) {
            address pair = DEXFactory(factory).getPair(path[i - 1], path[i]);
            require(pair != address(0), "Pair does not exist");

            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i - 1], path[i]);
            amounts[i - 1] = DEXPair(pair).getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }

    // Quote function
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        public
        pure
        returns (uint256 amountB)
    {
        require(amountA > 0, "Insufficient amount");
        require(reserveA > 0 && reserveB > 0, "Insufficient liquidity");
        amountB = (amountA * reserveB) / reserveA;
    }

    // Internal function to execute swaps
    function _swap(uint256[] memory amounts, address[] memory path, address _to) private {
        for (uint256 i = 0; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];

            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));

            address to = i < path.length - 2
                ? DEXFactory(factory).getPair(output, path[i + 2])
                : _to;

            address pair = DEXFactory(factory).getPair(input, output);
            DEXPair(pair).swap(amount0Out, amount1Out, to);
        }
    }

    // Calculate optimal liquidity amounts
    function _calculateLiquidityAmounts(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private view returns (uint256 amountA, uint256 amountB) {
        address pair = DEXFactory(factory).getPair(tokenA, tokenB);
        
        if (pair == address(0)) {
            // New pair, use desired amounts
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            // Existing pair, calculate optimal amounts
            (uint256 reserveA, uint256 reserveB) = _getReserves(tokenA, tokenB);
            uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);

            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "Insufficient B amount");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
                require(amountAOptimal <= amountADesired, "Excessive A amount");
                require(amountAOptimal >= amountAMin, "Insufficient A amount");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    // Get reserves for a token pair
    function _getReserves(address tokenA, address tokenB)
        private
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = DEXFactory(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "Pair does not exist");

        (address token0, ) = _sortTokens(tokenA, tokenB);
        (uint256 reserve0, uint256 reserve1) = DEXPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    // Sort tokens
    function _sortTokens(address tokenA, address tokenB)
        private
        pure
        returns (address token0, address token1)
    {
        require(tokenA != tokenB, "Identical addresses");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "Zero address");
    }
}