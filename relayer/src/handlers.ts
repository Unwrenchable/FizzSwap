import { ethers } from 'ethers';
import { SolanaAdapter } from '../../src/adapters/solana-adapter';

export async function executeRouteHandler(body: any) {
  const { chainId, chainType, inputToken, outputToken, amount, minOutput, chains } = body;
  if (!chainId || !chainType || !inputToken || !outputToken || !amount) {
    throw { status: 400, message: 'chainId, chainType, inputToken, outputToken, amount required' };
  }

  try {
    if (chainType === 'evm') {
      const cfg = (chains || []).find((c: any) => c.chainId === chainId) || {};
      const rpc = cfg.rpcUrl || process.env.EVM_RPC || 'http://localhost:8545';
      const dexAddr = cfg.fizzDexAddress || process.env.FIZZDEX_ADDRESS || '';
      const pk = process.env.RELAYER_PRIVATE_KEY;
      if (!pk) throw { status: 500, message: 'RELAYER_PRIVATE_KEY not configured' };

      const providerLocal = new ethers.JsonRpcProvider(rpc);
      const signer = new ethers.Wallet(pk, providerLocal);
      const swapAbi = ["function swap(address,address,uint256,uint256) external returns (uint256)"];
      const c = new ethers.Contract(dexAddr, swapAbi, signer);
      const tx = await c.swap(inputToken, outputToken, amount, minOutput || '0');
      const receipt = await tx.wait();
      return { success: true, tx: tx.hash, receipt };
    }

    if (chainType === 'solana') {
      const cfg = (chains || []).find((c: any) => c.chainId === chainId) || {
        chainId,
        chainName: chainId,
        chainType: 'solana',
        rpcUrl: process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
        nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
      };

      // allow per-request overrides for Solana on-chain swap execution
      const { swapProgramId, swapAccounts } = body as any;
      if (swapProgramId) cfg.swapProgramId = swapProgramId;
      if (swapAccounts) cfg.swapAccounts = swapAccounts;

      const adapter: any = new SolanaAdapter(cfg as any);
      await adapter.connect();
      const result = await adapter.executeSwap(inputToken, outputToken, amount, minOutput || '0', 1);
      return { success: true, tx: result.hash, result };
    }

    throw { status: 400, message: 'Unsupported chainType' };
  } catch (err: any) {
    if (err && err.status) throw err;
    throw { status: 500, message: err?.message || String(err) };
  }
}
