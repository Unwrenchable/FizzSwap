import { ethers } from "hardhat";

async function main() {
  console.log("🚀 Deploying FizzDex to EVM chain...\n");

  // Deploy FizzToken first
  console.log("📝 Deploying FizzToken...");
  const initialSupply = ethers.parseEther("1000000000"); // 1 billion tokens
  const FizzToken = await ethers.getContractFactory("FizzToken");
  const fizzToken = await FizzToken.deploy(initialSupply);
  await fizzToken.waitForDeployment();
  const fizzTokenAddress = await fizzToken.getAddress();
  
  console.log(`✅ FizzToken deployed to: ${fizzTokenAddress}`);
  console.log(`   Initial supply: 1,000,000,000 FIZZ\n`);

  // Deploy FizzDex
  console.log("📝 Deploying FizzDex...");
  const FizzDex = await ethers.getContractFactory("FizzDex");
  const fizzDex = await FizzDex.deploy(fizzTokenAddress);
  await fizzDex.waitForDeployment();
  const fizzDexAddress = await fizzDex.getAddress();
  
  console.log(`✅ FizzDex deployed to: ${fizzDexAddress}\n`);

  // Fund the DEX with reward tokens
  console.log("💰 Funding FizzDex with reward tokens...");
  const rewardAmount = ethers.parseEther("100000000"); // 100 million tokens for rewards
  await fizzToken.approve(fizzDexAddress, rewardAmount);
  await fizzDex.fundRewards(rewardAmount);
  
  console.log(`✅ Funded FizzDex with 100,000,000 FIZZ tokens\n`);

  // Print deployment summary
  console.log("📋 Deployment Summary:");
  console.log("================================");
  console.log(`FizzToken:  ${fizzTokenAddress}`);
  console.log(`FizzDex:    ${fizzDexAddress}`);
  console.log("================================\n");

  console.log("🎯 Next Steps:");
  console.log("1. Verify contracts on block explorer");
  console.log("2. Update environment variables:");
  console.log(`   FIZZDEX_CONTRACT_ADDRESS=${fizzDexAddress}`);
  console.log(`   FIZZ_TOKEN_ADDRESS=${fizzTokenAddress}`);
  console.log("3. Create initial liquidity pools");
  console.log("4. Set up cross-chain bridges\n");

  // Save deployment info
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    fizzToken: fizzTokenAddress,
    fizzDex: fizzDexAddress,
    deployer: (await ethers.getSigners())[0].address,
    timestamp: new Date().toISOString(),
  };

  console.log("💾 Deployment Info:");
  console.log(JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
