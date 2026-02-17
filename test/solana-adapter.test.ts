import { expect } from "chai";
import { SolanaAdapter } from "../src/adapters/solana-adapter";

describe("SolanaAdapter (basic)", function () {
  it("connects and throws for unsigned operations", async function () {
    const cfg = {
      chainId: 'solana-devnet',
      chainName: 'Solana Devnet',
      chainType: 'solana' as const,
      rpcUrl: 'https://api.devnet.solana.com',
      nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 }
    };

    const adapter = new SolanaAdapter(cfg as any);
    await adapter.connect();
    expect(adapter.isConnected()).to.be.true;

    try {
      await adapter.getWalletAddress();
      throw new Error('expected error for missing keypair');
    } catch (err: any) {
      expect(String(err)).to.match(/No keypair configured/);
    }
  });

  it('returns a quote from mock pools', async function () {
    const cfg = {
      chainId: 'local-solana',
      chainName: 'Local Sol',
      chainType: 'solana' as const,
      rpcUrl: 'https://api.devnet.solana.com',
      nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
      pools: [
        { tokenA: 'TOKEN_A', tokenB: 'TOKEN_B', reserveA: '1000000000000000000000', reserveB: '2000000000000000000000' }
      ]
    };
    const adapter = new SolanaAdapter(cfg as any);
    await adapter.connect();
    const quote = await adapter.getSwapQuote('TOKEN_A', 'TOKEN_B', '1000000000000000000');
    expect(quote).to.have.property('outputAmount');
    expect(BigInt(quote.outputAmount) > 0n).to.be.true;
  });
});