import { expect } from 'chai';
import { SolanaAdapter } from '../src/adapters/solana-adapter';

describe('SolanaAdapter on-chain executeSwap (validation)', function () {
  it('throws if swapAccounts missing when attempting on-chain swap', async function () {
    const cfg = {
      chainId: 'local-sol',
      chainName: 'Local Sol',
      chainType: 'solana' as const,
      rpcUrl: 'https://api.devnet.solana.com',
      nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
      swapProgramId: 'DUMMYPROGRAM11111111111111111111111111111111'
    };

    // set a fake relayer keypair so adapter will attempt on-chain path
    process.env.RELAYER_SOLANA_KEYPAIR = JSON.stringify(Array.from((await (await import('@solana/web3.js')).Keypair.generate().secretKey)));

    const adapter = new SolanaAdapter(cfg as any);
    await adapter.connect();
    try {
      await adapter.executeSwap('TOKEN_A', 'TOKEN_B', '1000', '0', 1);
      throw new Error('expected missing swapAccounts error');
    } catch (err: any) {
      expect(String(err)).to.match(/swapAccounts configuration required/);
    }
  });
});
