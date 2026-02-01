import hre from "hardhat";
import { ethers } from "hardhat";
import fs from "fs";

async function main() {
    console.log("🚀 Starting DEX Deployment...\n");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Deploying contracts with account:", deployer.address);
    console.log("💰 Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    // Deploy Factory
    console.log("📦 Deploying DEXFactory...");
    const DEXFactory = await ethers.getContractFactory("DEXFactory");
    const factory = await DEXFactory.deploy();
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log("✅ DEXFactory deployed to:", factoryAddress);
    console.log("");

    // Deploy Router
    console.log("📦 Deploying DEXRouter...");
    const DEXRouter = await ethers.getContractFactory("DEXRouter");
    const router = await DEXRouter.deploy(factoryAddress);
    await router.waitForDeployment();
    const routerAddress = await router.getAddress();
    console.log("✅ DEXRouter deployed to:", routerAddress);
    console.log("");

    // Deploy Test Tokens
    console.log("📦 Deploying Test Tokens...");
    const ERC20Token = await ethers.getContractFactory("ERC20Token");
    
    const tokenA = await ERC20Token.deploy("Token A", "TKA", ethers.parseEther("1000000"));
    await tokenA.waitForDeployment();
    const tokenAAddress = await tokenA.getAddress();
    console.log("✅ Token A deployed to:", tokenAAddress);

    const tokenB = await ERC20Token.deploy("Token B", "TKB", ethers.parseEther("1000000"));
    await tokenB.waitForDeployment();
    const tokenBAddress = await tokenB.getAddress();
    console.log("✅ Token B deployed to:", tokenBAddress);

    const tokenC = await ERC20Token.deploy("Token C", "TKC", ethers.parseEther("1000000"));
    await tokenC.waitForDeployment();
    const tokenCAddress = await tokenC.getAddress();
    console.log("✅ Token C deployed to:", tokenCAddress);
    console.log("");

    // Create pairs
    console.log("🔗 Creating Trading Pairs...");
    
    console.log("Creating TKA/TKB pair...");
    let tx = await factory.createPair(tokenAAddress, tokenBAddress);
    await tx.wait();
    const pairAB = await factory.getPair(tokenAAddress, tokenBAddress);
    console.log("✅ TKA/TKB Pair:", pairAB);

    console.log("Creating TKB/TKC pair...");
    tx = await factory.createPair(tokenBAddress, tokenCAddress);
    await tx.wait();
    const pairBC = await factory.getPair(tokenBAddress, tokenCAddress);
    console.log("✅ TKB/TKC Pair:", pairBC);
    console.log("");

    // Add initial liquidity
    console.log("💧 Adding Initial Liquidity...");
    
    // Approve router
    await tokenA.approve(routerAddress, ethers.MaxUint256);
    await tokenB.approve(routerAddress, ethers.MaxUint256);
    await tokenC.approve(routerAddress, ethers.MaxUint256);

    console.log("Adding liquidity to TKA/TKB...");
    tx = await router.addLiquidity(
        tokenAAddress,
        tokenBAddress,
        ethers.parseEther("10000"),
        ethers.parseEther("10000"),
        0,
        0,
        deployer.address
    );
    await tx.wait();
    console.log("✅ Liquidity added to TKA/TKB");

    console.log("Adding liquidity to TKB/TKC...");
    tx = await router.addLiquidity(
        tokenBAddress,
        tokenCAddress,
        ethers.parseEther("10000"),
        ethers.parseEther("10000"),
        0,
        0,
        deployer.address
    );
    await tx.wait();
    console.log("✅ Liquidity added to TKB/TKC");
    console.log("");

    // Get reserves
    const DEXPair = await ethers.getContractFactory("DEXPair");
    const pairABContract = DEXPair.attach(pairAB);
    const pairBCContract = DEXPair.attach(pairBC);

    const [reserveAB0, reserveAB1] = await pairABContract.getReserves();
    const [reserveBC0, reserveBC1] = await pairBCContract.getReserves();

    console.log("📊 Pool Reserves:");
    console.log("TKA/TKB Pool:", ethers.formatEther(reserveAB0), "/", ethers.formatEther(reserveAB1));
    console.log("TKB/TKC Pool:", ethers.formatEther(reserveBC0), "/", ethers.formatEther(reserveBC1));
    console.log("");

    // Test swap
    console.log("🔄 Testing Swap...");
    const swapAmount = ethers.parseEther("100");
    const path = [tokenAAddress, tokenBAddress];
    const amounts = await router.getAmountsOut(swapAmount, path);
    
    console.log("Swap 100 TKA for TKB:");
    console.log("  Input:", ethers.formatEther(amounts[0]), "TKA");
    console.log("  Output:", ethers.formatEther(amounts[1]), "TKB");
    console.log("  Fee (0.3%):", ethers.formatEther(amounts[0] - amounts[1]), "tokens");
    console.log("");

    // Summary
    console.log("════════════════════════════════════════════════════════");
    console.log("🎉 DEPLOYMENT SUMMARY");
    console.log("════════════════════════════════════════════════════════");
    console.log("Network:        ", hre.network.name);
    console.log("Deployer:       ", deployer.address);
    console.log("");
    console.log("📋 Contracts:");
    console.log("DEXFactory:     ", factoryAddress);
    console.log("DEXRouter:      ", routerAddress);
    console.log("");
    console.log("🪙 Tokens:");
    console.log("Token A (TKA):  ", tokenAAddress);
    console.log("Token B (TKB):  ", tokenBAddress);
    console.log("Token C (TKC):  ", tokenCAddress);
    console.log("");
    console.log("🔗 Pairs:");
    console.log("TKA/TKB Pair:   ", pairAB);
    console.log("TKB/TKC Pair:   ", pairBC);
    console.log("════════════════════════════════════════════════════════");
    console.log("");

    // Save deployment info
    const deploymentInfo = {
        network: hre.network.name,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            factory: factoryAddress,
            router: routerAddress,
            tokenA: tokenAAddress,
            tokenB: tokenBAddress,
            tokenC: tokenCAddress,
            pairAB: pairAB,
            pairBC: pairBC
        },
        initialLiquidity: {
            "TKA/TKB": {
                tokenA: "10000",
                tokenB: "10000"
            },
            "TKB/TKC": {
                tokenB: "10000",
                tokenC: "10000"
            }
        }
    };

    fs.writeFileSync(
        "deployment-info.json",
        JSON.stringify(deploymentInfo, null, 2)
    );
    console.log("💾 Deployment info saved to deployment-info.json");
    console.log("");
    console.log("✨ Deployment completed successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });