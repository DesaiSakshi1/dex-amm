import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("DEX - Complete Test Suite", function () {
  let factory;
  let router;
  let tokenA;
  let tokenB;
  let tokenC;
  let pair;
  let owner;
  let user1;
  let user2;

  const INITIAL_SUPPLY = ethers.parseEther("10000");
  const LIQUIDITY_AMOUNT_A = ethers.parseEther("100");
  const LIQUIDITY_AMOUNT_B = ethers.parseEther("100");

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy Factory
    const DEXFactory = await ethers.getContractFactory("DEXFactory");
    factory = await DEXFactory.deploy();
    await factory.waitForDeployment();

    // Deploy Router
    const DEXRouter = await ethers.getContractFactory("DEXRouter");
    router = await DEXRouter.deploy(await factory.getAddress());
    await router.waitForDeployment();

    // Deploy Test Tokens
    const ERC20Token = await ethers.getContractFactory("ERC20Token");
    tokenA = await ERC20Token.deploy("Token A", "TKA", INITIAL_SUPPLY);
    tokenB = await ERC20Token.deploy("Token B", "TKB", INITIAL_SUPPLY);
    tokenC = await ERC20Token.deploy("Token C", "TKC", INITIAL_SUPPLY);

    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    await tokenC.waitForDeployment();

    // Transfer tokens to users
    await tokenA.transfer(user1.address, ethers.parseEther("1000"));
    await tokenB.transfer(user1.address, ethers.parseEther("1000"));
    await tokenC.transfer(user1.address, ethers.parseEther("1000"));

    await tokenA.transfer(user2.address, ethers.parseEther("1000"));
    await tokenB.transfer(user2.address, ethers.parseEther("1000"));
  });

  describe("Factory", function () {
    it("Should create a new pair", async function () {
      const tx = await factory.createPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );
      const receipt = await tx.wait();

      const pairAddress = await factory.getPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      expect(pairAddress).to.not.equal(ethers.ZeroAddress);

      // Check event
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "PairCreated"
      );
      expect(event).to.not.be.undefined;
    });

    it("Should fail to create pair with identical tokens", async function () {
      await expect(
        factory.createPair(await tokenA.getAddress(), await tokenA.getAddress())
      ).to.be.revertedWith("Identical addresses");
    });

    it("Should fail to create duplicate pair", async function () {
      await factory.createPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      await expect(
        factory.createPair(await tokenA.getAddress(), await tokenB.getAddress())
      ).to.be.revertedWith("Pair already exists");
    });

    it("Should return correct pair count", async function () {
      await factory.createPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );
      await factory.createPair(
        await tokenA.getAddress(),
        await tokenC.getAddress()
      );

      const count = await factory.allPairsLength();
      expect(count).to.equal(2);
    });

    it("Should have bidirectional mapping", async function () {
      await factory.createPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      const pair1 = await factory.getPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );
      const pair2 = await factory.getPair(
        await tokenB.getAddress(),
        await tokenA.getAddress()
      );

      expect(pair1).to.equal(pair2);
    });
  });

  describe("Add Liquidity", function () {
    beforeEach(async function () {
      // Approve router
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);
    });

    it("Should add initial liquidity", async function () {
      const tx = await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        LIQUIDITY_AMOUNT_A,
        LIQUIDITY_AMOUNT_B,
        0,
        0,
        owner.address
      );

      await tx.wait();

      const pairAddress = await factory.getPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      const DEXPair = await ethers.getContractFactory("DEXPair");
      pair = DEXPair.attach(pairAddress);

      const lpBalance = await pair.balanceOf(owner.address);
      expect(lpBalance).to.be.gt(0);
    });

    it("Should add liquidity with correct ratio", async function () {
      // Add initial liquidity
      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        LIQUIDITY_AMOUNT_A,
        LIQUIDITY_AMOUNT_B,
        0,
        0,
        owner.address
      );

      const pairAddress = await factory.getPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      const DEXPair = await ethers.getContractFactory("DEXPair");
      pair = DEXPair.attach(pairAddress);

      const [reserve0, reserve1] = await pair.getReserves();
      expect(reserve0).to.equal(LIQUIDITY_AMOUNT_A);
      expect(reserve1).to.equal(LIQUIDITY_AMOUNT_B);
    });

    it("Should fail if amounts below minimum", async function () {
      // Add initial liquidity first
      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        LIQUIDITY_AMOUNT_A,
        LIQUIDITY_AMOUNT_B,
        0,
        0,
        owner.address
      );

      // Try to add with unrealistic minimum
      await expect(
        router.addLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          ethers.parseEther("10"),
          ethers.parseEther("10"),
          ethers.parseEther("20"), // Unrealistic minimum
          ethers.parseEther("20"),
          owner.address
        )
      ).to.be.reverted;
    });

    it("Should emit LiquidityAdded event", async function () {
      await expect(
        router.addLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          LIQUIDITY_AMOUNT_A,
          LIQUIDITY_AMOUNT_B,
          0,
          0,
          owner.address
        )
      ).to.emit(router, "LiquidityAdded");
    });
  });

  describe("Remove Liquidity", function () {
    beforeEach(async function () {
      // Add liquidity first
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);

      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        LIQUIDITY_AMOUNT_A,
        LIQUIDITY_AMOUNT_B,
        0,
        0,
        owner.address
      );

      const pairAddress = await factory.getPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      const DEXPair = await ethers.getContractFactory("DEXPair");
      pair = DEXPair.attach(pairAddress);
    });

    it("Should remove liquidity", async function () {
      const lpBalance = await pair.balanceOf(owner.address);

      // Approve LP tokens
      await pair.approve(await router.getAddress(), lpBalance);

      const balanceABefore = await tokenA.balanceOf(owner.address);
      const balanceBBefore = await tokenB.balanceOf(owner.address);

      await router.removeLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        lpBalance,
        0,
        0,
        owner.address
      );

      const balanceAAfter = await tokenA.balanceOf(owner.address);
      const balanceBAfter = await tokenB.balanceOf(owner.address);

      expect(balanceAAfter).to.be.gt(balanceABefore);
      expect(balanceBAfter).to.be.gt(balanceBBefore);
    });

    it("Should fail with insufficient LP tokens", async function () {
      const lpBalance = await pair.balanceOf(owner.address);

      await pair.approve(await router.getAddress(), lpBalance);

      await expect(
        router.removeLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          lpBalance * 2n,
          0,
          0,
          owner.address
        )
      ).to.be.reverted;
    });

    it("Should emit LiquidityRemoved event", async function () {
      const lpBalance = await pair.balanceOf(owner.address);
      await pair.approve(await router.getAddress(), lpBalance);

      await expect(
        router.removeLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          lpBalance,
          0,
          0,
          owner.address
        )
      ).to.emit(router, "LiquidityRemoved");
    });
  });

  describe("Swap Tokens", function () {
    beforeEach(async function () {
      // Add liquidity
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);

      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("1000"),
        0,
        0,
        owner.address
      );

      // Approve tokens for user1
      await tokenA.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
    });

    it("Should swap exact tokens for tokens", async function () {
      const amountIn = ethers.parseEther("10");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      const amounts = await router.getAmountsOut(amountIn, path);
      const balanceBefore = await tokenB.balanceOf(user1.address);

      await router
        .connect(user1)
        .swapExactTokensForTokens(amountIn, 0, path, user1.address);

      const balanceAfter = await tokenB.balanceOf(user1.address);

      expect(balanceAfter - balanceBefore).to.be.closeTo(amounts[1], ethers.parseEther("0.001"));
    });

    it("Should swap tokens for exact tokens", async function () {
      const amountOut = ethers.parseEther("10");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      const amounts = await router.getAmountsIn(amountOut, path);
      const balanceABefore = await tokenA.balanceOf(user1.address);
      const balanceBBefore = await tokenB.balanceOf(user1.address);

      await router
        .connect(user1)
        .swapTokensForExactTokens(amountOut, ethers.MaxUint256, path, user1.address);

      const balanceAAfter = await tokenA.balanceOf(user1.address);
      const balanceBAfter = await tokenB.balanceOf(user1.address);

      expect(balanceABefore - balanceAAfter).to.be.closeTo(amounts[0], ethers.parseEther("0.001"));
      expect(balanceBAfter - balanceBBefore).to.equal(amountOut);
    });

    it("Should fail if output below minimum", async function () {
      const amountIn = ethers.parseEther("10");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      await expect(
        router
          .connect(user1)
          .swapExactTokensForTokens(amountIn, ethers.parseEther("1000"), path, user1.address)
      ).to.be.revertedWith("Insufficient output amount");
    });

    it("Should apply 0.3% fee correctly", async function () {
      const amountIn = ethers.parseEther("100");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      const amounts = await router.getAmountsOut(amountIn, path);

      // With 0.3% fee, output should be less than input (assuming 1:1 ratio)
      expect(amounts[1]).to.be.lt(amountIn);
      
      // Fee should be approximately 0.3%
      const expectedOutput = (amountIn * 997n) / 1000n; // Rough calculation
      expect(amounts[1]).to.be.closeTo(expectedOutput, ethers.parseEther("1"));
    });

    it("Should emit TokensSwapped event", async function () {
      const amountIn = ethers.parseEther("10");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      await expect(
        router.connect(user1).swapExactTokensForTokens(amountIn, 0, path, user1.address)
      ).to.emit(router, "TokensSwapped");
    });
  });

  describe("Multi-hop Swaps", function () {
    beforeEach(async function () {
      // Add liquidity for A-B pair
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenC.approve(await router.getAddress(), ethers.MaxUint256);

      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("1000"),
        0,
        0,
        owner.address
      );

      // Add liquidity for B-C pair
      await router.addLiquidity(
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("1000"),
        0,
        0,
        owner.address
      );

      // Approve for user1
      await tokenA.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
    });

    it("Should execute multi-hop swap A -> B -> C", async function () {
      const amountIn = ethers.parseEther("10");
      const path = [
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
      ];

      const balanceCBefore = await tokenC.balanceOf(user1.address);

      await router.connect(user1).swapExactTokensForTokens(amountIn, 0, path, user1.address);

      const balanceCAfter = await tokenC.balanceOf(user1.address);

      expect(balanceCAfter).to.be.gt(balanceCBefore);
    });

    it("Should calculate correct amounts for multi-hop", async function () {
      const amountIn = ethers.parseEther("10");
      const path = [
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
      ];

      const amounts = await router.getAmountsOut(amountIn, path);

      expect(amounts.length).to.equal(3);
      expect(amounts[0]).to.equal(amountIn);
      expect(amounts[2]).to.be.gt(0);
    });
  });

  describe("Price Impact", function () {
    beforeEach(async function () {
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);

      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("1000"),
        0,
        0,
        owner.address
      );

      await tokenA.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
    });

    it("Should have minimal price impact for small swaps", async function () {
      const smallSwap = ethers.parseEther("1");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      const amounts = await router.getAmountsOut(smallSwap, path);
      const priceImpact = ((smallSwap - amounts[1]) * 10000n) / smallSwap;

      // Price impact should be small (less than 1%)
      expect(priceImpact).to.be.lt(100n);
    });

    it("Should have larger price impact for large swaps", async function () {
      const largeSwap = ethers.parseEther("500");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      const amounts = await router.getAmountsOut(largeSwap, path);

      // Output should be significantly less than input due to price impact
      expect(amounts[1]).to.be.lt(largeSwap);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle very small amounts", async function () {
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);

      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("1000"),
        0,
        0,
        owner.address
      );

      await tokenA.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);

      const tinyAmount = ethers.parseUnits("1", 9); // 1 Gwei
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      // Should not revert
      await router.connect(user1).swapExactTokensForTokens(tinyAmount, 0, path, user1.address);
    });

    it("Should maintain k constant (with fee)", async function () {
      await tokenA.approve(await router.getAddress(), ethers.MaxUint256);
      await tokenB.approve(await router.getAddress(), ethers.MaxUint256);

      await router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("1000"),
        0,
        0,
        owner.address
      );

      const pairAddress = await factory.getPair(
        await tokenA.getAddress(),
        await tokenB.getAddress()
      );

      const DEXPair = await ethers.getContractFactory("DEXPair");
      pair = DEXPair.attach(pairAddress);

      const [reserve0Before, reserve1Before] = await pair.getReserves();
      const kBefore = reserve0Before * reserve1Before;

      await tokenA.connect(user1).approve(await router.getAddress(), ethers.MaxUint256);
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      await router.connect(user1).swapExactTokensForTokens(
        ethers.parseEther("10"),
        0,
        path,
        user1.address
      );

      const [reserve0After, reserve1After] = await pair.getReserves();
      const kAfter = reserve0After * reserve1After;

      // k should increase due to fees
      expect(kAfter).to.be.gt(kBefore);
    });
  });
});