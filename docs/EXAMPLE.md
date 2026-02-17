/**
 * Example: How to use FizzDex with multiple chains
 */

import { ethers } from 'ethers';
import {
  MultiChainDEX,
  ChainAdapterFactory,
  EVMAdapter,
  SecurityUtils
} from '../src';

async function main() {
  console.log('🌐 FizzDex Multi-Chain Example\n');

  // Initialize the multi-chain DEX
  const dex = new MultiChainDEX();

  // ========================================
  // 1. Add Ethereum Network
  // ========================================
  console.log('1️⃣ Adding Ethereum...');
  await dex.addChain({
    chainId: '1',
    chainName: 'Ethereum Mainnet',
    chainType: 'evm',
    rpcUrl: process.env.ETH_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18
    },
    explorerUrl: 'https://etherscan.io'
  });

  // ========================================
  // 2. Add Polygon Network
  // ========================================
  console.log('2️⃣ Adding Polygon...');
  await dex.addChain({
    chainId: '137',
    chainName: 'Polygon',
    chainType: 'evm',
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    nativeCurrency: {
      name: 'MATIC',
      symbol: 'MATIC',
      decimals: 18
    },
    explorerUrl: 'https://polygonscan.com'
  });

  // ========================================
  // 3. Add Base Network
  // ========================================
  console.log('3️⃣ Adding Base...');
  await dex.addChain({
    chainId: '8453',
    chainName: 'Base',
    chainType: 'evm',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18
    },
    explorerUrl: 'https://basescan.org'
  });

  console.log('\n✅ All chains connected!\n');

  // ========================================
  // 4. Get wallet address on Ethereum
  // ========================================
  const ethAdapter = dex.getAdapter('1');
  const walletAddress = await ethAdapter.getWalletAddress();
  console.log(`👛 Wallet Address: ${walletAddress}\n`);

  // ========================================
  // 5. Check balances across chains
  // ========================================
  console.log('💰 Checking balances...');
  for (const chain of dex.getConnectedChains()) {
    const adapter = dex.getAdapter(chain.chainId);
    const balance = await adapter.getBalance();
    console.log(`   ${chain.chainName}: ${ethers.formatEther(balance)} ${chain.nativeCurrency.symbol}`);
  }
  console.log();

  // ========================================
  // 6. Get swap quote on Ethereum
  // ========================================
  console.log('📊 Getting swap quote...');
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum
  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI on Ethereum
  const amount = '1000000000'; // 1000 USDC (6 decimals)

  try {
    const quote = await ethAdapter.getSwapQuote(USDC, DAI, amount);
    console.log(`   Input: ${quote.inputAmount} ${quote.inputToken.symbol}`);
    console.log(`   Output: ${quote.outputAmount} ${quote.outputToken.symbol}`);
    console.log(`   Price Impact: ${quote.priceImpact.toFixed(2)}%`);
    console.log(`   Fee: ${quote.fee} ${quote.inputToken.symbol}`);
    console.log(`   Estimated Gas: ${quote.estimatedGas}\n`);

    // Calculate safe slippage
    const safeSlippage = SecurityUtils.calculateSafeSlippage(quote.priceImpact);
    console.log(`💡 Recommended slippage: ${safeSlippage}%\n`);

    // ========================================
    // 7. Execute swap (uncomment to actually swap)
    // ========================================
    /*
    console.log('🔄 Executing swap...');
    const minOutput = (BigInt(quote.outputAmount) * BigInt(10000 - safeSlippage * 100) / BigInt(10000)).toString();
    
    const result = await ethAdapter.executeSwap(
      USDC,
      DAI,
      amount,
      minOutput,
      safeSlippage
    );
    
    if (result.success) {
      console.log(`✅ Swap successful!`);
      console.log(`   Transaction: ${result.hash}`);
      console.log(`   Block: ${result.blockNumber}`);
      console.log(`   Gas Used: ${result.gasUsed}\n`);
    } else {
      console.log(`❌ Swap failed: ${result.error}\n`);
    }
    */
  } catch (error) {
    console.log(`⚠️  Could not get quote (pool may not exist): ${error}\n`);
  }

  // ========================================
  // 8. Play Fizz Caps game
  // ========================================
  console.log('🎮 Playing Fizz Caps game...');
  const playerStats = await ethAdapter.getPlayerStats(walletAddress);
  console.log(`   Current Score: ${playerStats.score}`);
  console.log(`   Fizz Count: ${playerStats.fizzCount}`);
  console.log(`   Buzz Count: ${playerStats.buzzCount}`);
  console.log(`   FizzBuzz Count: ${playerStats.fizzBuzzCount}`);
  console.log(`   Pending Rewards: ${ethers.formatEther(playerStats.rewardBalance)} FIZZ\n`);

  // Play a round (uncomment to actually play)
  /*
  const gameNumber = 15; // FizzBuzz!
  console.log(`🎯 Playing number: ${gameNumber}`);
  const gameResult = await ethAdapter.playFizzCaps(gameNumber);
  
  if (gameResult.success) {
    console.log(`✅ Game played successfully!`);
    console.log(`   Transaction: ${gameResult.hash}\n`);
  }
  */

  // ========================================
  // 9. Cross-chain swap example
  // ========================================
  console.log('🌉 Cross-chain swap capabilities:');
  console.log('   Bridge tokens from Ethereum to Polygon');
  console.log('   Bridge tokens from Polygon to Base');
  console.log('   Unified liquidity across all chains\n');

  // ========================================
  // 10. Get aggregated stats
  // ========================================
  console.log('📊 Getting aggregated stats across all chains...');
  const stats = await dex.getAggregatedStats(walletAddress);
  console.log(`   Total Rewards: ${ethers.formatEther(stats.totalRewards)} FIZZ`);
  console.log(`   Active Chains: ${Object.keys(stats.chains).length}`);
  console.log();

  console.log('✅ Example completed!\n');
  console.log('💡 Tips:');
  console.log('   - Always verify addresses before trading');
  console.log('   - Set appropriate slippage tolerance');
  console.log('   - Start with small amounts for testing');
  console.log('   - Monitor gas prices on each chain');
  console.log('   - Join the Atomic Fizz Caps community for updates!\n');
}

// Run the example
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
