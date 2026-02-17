import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import completeSolanaHTLCWrapper from './solana-htlc';

const MAPPINGS_FILE = path.join(process.cwd(), 'relayer-mappings.json');
const POLL_INTERVAL_MS = Number(process.env.RELAYER_WORKER_POLL_MS || '30000');
const EVM_RPC = process.env.EVM_RPC || 'http://localhost:8545';
const FIZZDEX = process.env.FIZZDEX_ADDRESS || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const SOLANA_PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || '';

function loadMappings(): Record<string, any> {
  try {
    if (fs.existsSync(MAPPINGS_FILE)) {
      return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[Worker] failed to load mappings', e);
  }
  return {};
}

function saveMappings(m: Record<string, any>) {
  try { fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch (e) { console.warn('[Worker] failed to save mappings', e); }
}

async function tryCompleteForSwap(provider: ethers.JsonRpcProvider, swapIdHex: string, mapEntry: any) {
  const iface = new ethers.Interface(["function completeAtomicSwap(bytes32,bytes)"]);
  const topicSwapId = swapIdHex.startsWith('0x') ? swapIdHex : '0x'+swapIdHex;
  try {
    const logs = await provider.getLogs({
      address: FIZZDEX,
      fromBlock: 0,
      toBlock: 'latest'
    });
    for (const l of logs) {
      if (l.topics && l.topics[1] && l.topics[1] === topicSwapId) {
        const tx = await provider.getTransaction(l.transactionHash);
        if (!tx) continue;
        let parsed;
        try { parsed = iface.parseTransaction({ data: tx.data }); } catch { parsed = null; }
        if (parsed && parsed.args && parsed.args[1]) {
          const secretHex = parsed.args[1];
          let preimage = '';
          try { preimage = ethers.toUtf8String(secretHex); } catch { preimage = secretHex; }
          console.log('[Worker] found preimage for', swapIdHex);
          const txSig = await completeSolanaHTLCWrapper(SOLANA_RPC, SOLANA_PROGRAM_ID, process.env.RELAYER_SOLANA_KEYPAIR || '', mapEntry.atomicSwapPda, mapEntry.escrowVaultPda, mapEntry.tokenMint, preimage);
          console.log('[Worker] completed Solana HTLC, txSig', txSig);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[Worker] error checking logs for swap', swapIdHex, err?.message || err);
  }
  return false;
}

export function startWorker() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  setInterval(async () => {
    const mappings = loadMappings();
    for (const swapId of Object.keys(mappings)) {
      const entry = mappings[swapId];
      try {
        const ok = await tryCompleteForSwap(provider, swapId, entry);
        if (ok) {
          delete mappings[swapId];
          saveMappings(mappings);
        }
      } catch (e) {
        console.warn('[Worker] error processing mapping', swapId, e?.message || e);
      }
    }
  }, POLL_INTERVAL_MS);
  console.log('[Worker] started, polling every', POLL_INTERVAL_MS, 'ms');
}

export default startWorker;
