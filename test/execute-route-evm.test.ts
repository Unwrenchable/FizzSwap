import { expect } from "chai";
import { ethers } from "hardhat";

describe('Execute route EVM end-to-end', function () {
  it('relayer wallet can perform swap after funding and approval', async function () {
    const [owner, user1] = await ethers.getSigners();

    const FizzToken = await ethers.getContractFactory("FizzToken");
    const tokenA = await FizzToken.deploy(ethers.parseEther("1000000"));
    const tokenB = await FizzToken.deploy(ethers.parseEther("1000000"));

    const FizzDex = await ethers.getContractFactory("FizzDex");
    const fizzToken = await FizzToken.deploy(ethers.parseEther("1000000000"));
    const dex = await FizzDex.deploy(await fizzToken.getAddress());

    // add liquidity from user1
    const amount = ethers.parseEther("1000");
    await tokenA.transfer(user1.address, amount);
    await tokenB.transfer(user1.address, amount);

    await tokenA.connect(user1).approve(await dex.getAddress(), amount);
    await tokenB.connect(user1).approve(await dex.getAddress(), amount);
    await dex.connect(user1).addLiquidity(await tokenA.getAddress(), await tokenB.getAddress(), amount, amount);

    // create relayer wallet and fund it with ETH
    const relayer = ethers.Wallet.createRandom();
    process.env.RELAYER_PRIVATE_KEY = relayer.privateKey;

    // fund relayer with ETH from owner
    await owner.sendTransaction({ to: relayer.address, value: ethers.parseEther('1') });

    // transfer some tokenA to relayer
    const sendAmt = ethers.parseEther('10');
    await tokenA.transfer(relayer.address, sendAmt);

    // connect relayer signer to the provider
    const relayerSigner = relayer.connect(ethers.provider);

    // approve dex to spend tokenA from relayer
    const tokenAWithRelayer = tokenA.connect(relayerSigner);
    await tokenAWithRelayer.approve(await dex.getAddress(), sendAmt);

    // get tokenB balance before
    const before = await tokenB.balanceOf(relayer.address);

    // execute swap: relayer calls swap on dex
    const dexWithRelayer = dex.connect(relayerSigner);
    const tx = await dexWithRelayer.swap(await tokenA.getAddress(), await tokenB.getAddress(), ethers.parseEther('1'), 0);
    await tx.wait();

    const after = await tokenB.balanceOf(relayer.address);
    expect(after).to.be.gt(before);
  });
});
