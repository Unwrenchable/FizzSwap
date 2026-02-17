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
      let raw = fs.readFileSync(MAPPINGS_FILE, 'utf8');
      const key = process.env.RELAYER_MAPPINGS_KEY;
      if (key) {
        try {
          const crypto = require('crypto');
          const parts = raw.split(':');
          if (parts.length === 2) {
            const iv = Buffer.from(parts[0], 'base64');
            const encrypted = Buffer.from(parts[1], 'base64');
            const hash = crypto.createHash('sha256').update(String(key)).digest();
            const decipher = crypto.createDecipheriv('aes-256-cbc', hash, iv);
            raw = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
          }
        } catch (e) {
          const ex = e as any;
          console.warn('[Worker] failed to decrypt mappings file', ex?.message || String(ex));
        }
      }
      return JSON.parse(raw);
    }
  } catch (e) {
    const ex = e as any;
    console.warn('[Worker] failed to load mappings', ex);
  }
  return {};
}

function saveMappings(m: Record<string, any>) {
  try {
    let payload = JSON.stringify(m, null, 2);
    const key = process.env.RELAYER_MAPPINGS_KEY;
    if (key) {
      try {
        const crypto = require('crypto');
        const iv = crypto.randomBytes(16);
        const hash = crypto.createHash('sha256').update(String(key)).digest();
        const cipher = crypto.createCipheriv('aes-256-cbc', hash, iv);
        const encrypted = Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()]);
        payload = `${iv.toString('base64')}:${encrypted.toString('base64')}`;
      } catch (e) {
        const ex = e as any;
        console.warn('[Worker] failed to encrypt mappings file, writing plaintext', ex?.message || String(ex));
      }
    }
    fs.writeFileSync(MAPPINGS_FILE, payload, 'utf8');
    try { fs.chmodSync(MAPPINGS_FILE, 0o600); } catch (e) { }
  } catch (e) {
    const ex = e as any;
    console.warn('[Worker] failed to save mappings', ex);
  }
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
          // Do NOT log or persist the plaintext preimage. Proceed to complete counterpart HTLC.
          console.log('[Worker] found preimage for swap (REDACTED)');
          const txSig = await completeSolanaHTLCWrapper(SOLANA_RPC, SOLANA_PROGRAM_ID, process.env.RELAYER_SOLANA_KEYPAIR || '', mapEntry.atomicSwapPda, mapEntry.escrowVaultPda, mapEntry.tokenMint, preimage);
          console.log('[Worker] completed Solana HTLC, txSig', txSig);
          return true;
        }
      }
    }
  } catch (err) {
    const e = err as any;
    console.warn('[Worker] error checking logs for swap', swapIdHex, e?.message || String(e));
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
        const ex = e as any;
        console.warn('[Worker] error processing mapping', swapId, ex?.message || String(ex));
      }
    }
  }, POLL_INTERVAL_MS);
  console.log('[Worker] started, polling every', POLL_INTERVAL_MS, 'ms');
}

export default startWorker;
