import { expect } from "chai";
import { ethers } from "hardhat";
import { EvmAdapter } from "../src/adapters/evm-adapter";

describe("EvmAdapter (integration)", function () {
  it("should get a swap quote from deployed FizzDex", async function () {
    const [owner, user1] = await ethers.getSigners();

    const FizzToken = await ethers.getContractFactory("FizzToken");
    const tokenA = await FizzToken.deploy(ethers.parseEther("1000000"));
    const tokenB = await FizzToken.deploy(ethers.parseEther("1000000"));

    const FizzDex = await ethers.getContractFactory("FizzDex");
    const fizzToken = await FizzToken.deploy(ethers.parseEther("1000000000"));
    const dex = await FizzDex.deploy(await fizzToken.getAddress());

    // add liquidity
    const amount = ethers.parseEther("1000");
    await tokenA.transfer(user1.address, amount);
    await tokenB.transfer(user1.address, amount);

    await tokenA.connect(user1).approve(await dex.getAddress(), amount);
    await tokenB.connect(user1).approve(await dex.getAddress(), amount);
    await dex.connect(user1).addLiquidity(await tokenA.getAddress(), await tokenB.getAddress(), amount, amount);

    // adapter
    const cfg = {
      chainId: 'local-evm',
      chainName: 'Local EVM',
      chainType: 'evm' as const,
      rpcUrl: 'http://localhost:8545',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
    };

    const adapter = new EvmAdapter(cfg, (ethers as any).provider);
    await adapter.connect();
    // ensure adapter uses the local hardhat provider and test signer
    if ((ethers as any).provider._isProvider) {
      // set signer from test environment if PRIVATE_KEY not configured
      if (!process.env.PRIVATE_KEY) {
        // attach a signer using the first test account
        const signer = (ethers as any).provider.getSigner(0);
        (adapter as any).signer = signer;
      }
    }
    adapter.setContract(await dex.getAddress());

    // Use test signer private key if available in hardhat
    if (process.env.PRIVATE_KEY) {
      // already using signer
    }

    const quote = await adapter.getSwapQuote(await tokenA.getAddress(), await tokenB.getAddress(), ethers.parseEther("1").toString());
    expect(BigInt(quote.outputAmount) > 0n).to.be.true;
  });
});