import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const PORT = process.env.RELAYER_PORT ? Number(process.env.RELAYER_PORT) : 4001;
const EVM_RPC = process.env.EVM_RPC || "http://localhost:8545";
const FIZZDEX = process.env.FIZZDEX_ADDRESS || "";
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const SOLANA_PROGRAM_ID = process.env.SOLANA_PROGRAM_ID || "FizzDEXProgram11111111111111111111111111111111"; // override in .env for real deploy

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Simple API key auth for POST endpoints when RELAYER_API_KEY is set
const RELAYER_API_KEY = process.env.RELAYER_API_KEY;
app.use((req, res, next) => {
  if (req.method === 'POST' && RELAYER_API_KEY) {
    const key = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string);
    if (!key || key !== RELAYER_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized - valid x-api-key required' });
    }
  }
  next();
});

// Simple in-memory rate limiter (per IP)
const RATE_LIMIT = Number(process.env.RELAYER_RATE_LIMIT || '60'); // requests per minute per IP
const rateMap = new Map<string, { count: number; resetTs: number }>();
app.use((req, res, next) => {
  try {
    const ip = (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown') as string;
    const now = Date.now();
    const entry = rateMap.get(ip) || { count: 0, resetTs: now + 60_000 };
    if (now > entry.resetTs) {
      entry.count = 0;
      entry.resetTs = now + 60_000;
    }
    entry.count += 1;
    rateMap.set(ip, entry);
    if (entry.count > RATE_LIMIT) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  } catch (e) {
    // ignore rate limiter errors
  }
  next();
});

let provider: ethers.JsonRpcProvider | null = null;
let contract: ethers.Contract | null = null;

const ABI = [
  "event AtomicSwapInitiated(bytes32 indexed swapId, address indexed initiator, address participant, uint256 amount)",
  "event AtomicSwapCompleted(bytes32 indexed swapId, address indexed participant)",
  "function completeAtomicSwap(bytes32, bytes)"
];

// in-memory mapping for relayer-created cross-chain HTLCs (evmSwapId -> solana PDAs)
const path = require('path');
const fs = require('fs');
const MAPPINGS_FILE = path.join(process.cwd(), 'relayer-mappings.json');

type MappingEntry = { atomicSwapPda: string; escrowVaultPda: string; tokenMint: string; participant: string };
let relayerMappings: Record<string, MappingEntry> = {};

function loadMappings() {
  try {
    if (fs.existsSync(MAPPINGS_FILE)) {
      const raw = fs.readFileSync(MAPPINGS_FILE, 'utf8');
      relayerMappings = JSON.parse(raw) as Record<string, MappingEntry>;
      console.log('[Relayer] Loaded', Object.keys(relayerMappings).length, 'mappings');
    }
  } catch (err) {
    console.warn('[Relayer] Failed to load mappings', err);
  }
}

function saveMappings() {
  try {
    fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(relayerMappings, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Relayer] Failed to save mappings', err);
  }
}

loadMappings();

app.get("/status", (req, res) => {
  res.json({ running: true, rpc: EVM_RPC, fizzDex: FIZZDEX });
});

app.post("/start-listen", async (req, res) => {
  try {
    if (!FIZZDEX) return res.status(400).json({ error: "FIZZDEX_ADDRESS not set" });
    if (provider && contract) {
      return res.json({ status: "already listening" });
    }
    provider = new ethers.JsonRpcProvider(EVM_RPC);
    contract = new ethers.Contract(FIZZDEX, ABI, provider);

    contract.on("AtomicSwapInitiated", (swapId, initiator, participant, amount) => {
      console.log("[Relayer] AtomicSwapInitiated", { swapId, initiator, participant, amount: ethers.formatEther(amount) });
    });

    contract.on("AtomicSwapCompleted", async (swapId, participantAddr, event) => {
      try {
        console.log("[Relayer] AtomicSwapCompleted", { swapId, participantAddr, txHash: event.transactionHash });
        const tx = await provider!.getTransaction(event.transactionHash);
        if (!tx) return;
        const iface = new ethers.Interface(["function completeAtomicSwap(bytes32,bytes)"]);
        const parsed = iface.parseTransaction({ data: tx.data });
        const secretHex = parsed.args[1];
        let preimage = '';
        try { preimage = ethers.toUtf8String(secretHex); } catch { preimage = secretHex; }
        console.log('[Relayer] Extracted preimage from EVM completion:', preimage);

        const map = relayerMappings[swapId];
        // Only auto-complete Solana HTLCs when explicitly allowed via env
        const allowAuto = process.env.RELAYER_ALLOW_AUTOCOMPLETE === 'true';
          if (map && process.env.RELAYER_SOLANA_KEYPAIR && allowAuto) {
            console.log('[Relayer] Auto-completing mapped Solana HTLC for swapId', swapId);
            await completeSolanaHTLC(map.atomicSwapPda, map.escrowVaultPda, map.tokenMint, preimage);
            // remove mapping after successful completion
            delete relayerMappings[swapId];
            saveMappings();
          } else if (map && !allowAuto) {
            console.log('[Relayer] Mapped Solana HTLC exists but auto-complete disabled', swapId);
          }
      } catch (err: any) {
        console.warn('[Relayer] Error handling AtomicSwapCompleted:', err?.message || String(err));
      }
    });
    res.json({ status: "listening", fizzDex: FIZZDEX, rpc: EVM_RPC });
  } catch (err: any) {
    console.error('[Relayer] Failed to start listener', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// -------------------------
// Aggregate quote endpoint (multi-chain)
// -------------------------
import { MultiChainDEX } from "../src/chain-adapter";
import { RouteAggregator } from "../src/route-aggregator";
import { SolanaAdapter } from "../src/adapters/solana-adapter";

app.post('/aggregate-quote', async (req, res) => {
  const { chains, inputChainId, inputToken, outputToken, amount } = req.body;
  if (!chains || !inputChainId || !inputToken || !outputToken || !amount) {
    return res.status(400).json({ error: 'chains, inputChainId, inputToken, outputToken, amount required' });
  }

  try {
    const dex = new MultiChainDEX();

    // add each chain to the MultiChainDEX and set its contract if provided
    for (const c of chains) {
      const cfg = {
        chainId: c.chainId,
        chainName: c.chainName || c.chainId,
        chainType: c.chainType || 'evm',
        rpcUrl: c.rpcUrl,
        nativeCurrency: c.nativeCurrency || { name: 'ETH', symbol: 'ETH', decimals: 18 },
        explorerUrl: c.explorerUrl || ''
      };
      await dex.addChain(cfg as any);
      // set contract address on EVM adapters
      if (c.fizzDexAddress) {
        const adapter: any = dex.getAdapter(c.chainId);
        if (adapter && typeof adapter.setContract === 'function') {
          adapter.setContract(c.fizzDexAddress);
        }
      }
    }

    const aggregator = new RouteAggregator(dex);

    // get quotes across all connected chains
    const results: any[] = [];
    for (const cfg of dex.getConnectedChains()) {
      try {
        const adapter = dex.getAdapter(cfg.chainId);
        const quote = await adapter.getSwapQuote(inputToken, outputToken, amount);
        results.push({ chain: cfg.chainId, quote });
      } catch (err) {
        // skip
      }
    }

    // pick best by outputAmount
    results.sort((a, b) => BigInt(b.quote.outputAmount) - BigInt(a.quote.outputAmount));

    const best = results[0] || null;
    return res.json({ results, best });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// Execute a selected route (same-chain swap or simulated Solana swap)
import { executeRouteHandler } from './handlers';

app.post('/execute-route', async (req, res) => {
  try {
    const result = await executeRouteHandler(req.body);
    return res.json(result);
  } catch (err: any) {
    return res.status(err?.status || 500).json({ error: err?.message || String(err) });
  }
});

// optional helper: post a revealed secret to the EVM FizzDex (caller must provide an unlocked signer/private key via RELAYER_PRIVATE_KEY)
app.post("/submit-secret", async (req, res) => {
  const { swapId, secret, rpc } = req.body;
  if (!swapId || !secret) return res.status(400).json({ error: "swapId and secret required" });
  const rpcUrl = rpc || EVM_RPC;
  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) return res.status(400).json({ error: "RELAYER_PRIVATE_KEY not configured" });

  const signer = new ethers.Wallet(pk, new ethers.JsonRpcProvider(rpcUrl));
  const c = new ethers.Contract(FIZZDEX, ABI, signer);

  try {
    const tx = await c.completeAtomicSwap(swapId, ethers.toUtf8Bytes(secret));
    const receipt = await tx.wait();
    return res.json({ tx: tx.hash, receipt });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// -------------------------
// Solana HTLC helper endpoints (optional relayer)
// -------------------------
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import startWorker from './worker';
import { completeSolanaHTLCWrapper } from './solana-htlc';

app.post("/solana/initiate-htlc", async (req, res) => {
  const { participant, tokenMint, amount, secretHash, timelock, evmSwapId } = req.body;
  if (!participant || !tokenMint || !amount || !secretHash || !timelock) {
    return res.status(400).json({ error: "participant, tokenMint, amount, secretHash, timelock required" });
  }

  const keypairJson = process.env.RELAYER_SOLANA_KEYPAIR;
  if (!keypairJson) return res.status(500).json({ error: "RELAYER_SOLANA_KEYPAIR not configured" });

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairJson)));
  const conn = new Connection(SOLANA_RPC, "confirmed");
  const programId = new PublicKey(SOLANA_PROGRAM_ID);

  try {
    const initiator = payer.publicKey;
    const participantPk = new PublicKey(participant);
    const mintPk = new PublicKey(tokenMint);

    // derive PDAs
    const timelockBuf = Buffer.alloc(8);
    timelockBuf.writeBigInt64LE(BigInt(timelock));

    const [atomicSwapPda, atomicSwapBump] = await PublicKey.findProgramAddress([
      Buffer.from("atomic_swap"),
      initiator.toBuffer(),
      participantPk.toBuffer(),
      mintPk.toBuffer(),
      timelockBuf,
    ], programId);

    const [escrowVaultPda, escrowBump] = await PublicKey.findProgramAddress([
      Buffer.from("escrow_vault"),
      initiator.toBuffer(),
      participantPk.toBuffer(),
      mintPk.toBuffer(),
      timelockBuf,
    ], programId);

    // payer's associated token account
    const initiatorAta = await getAssociatedTokenAddress(mintPk, initiator);

    // Build instruction data (Anchor: 8-byte discriminator + args)
    const crypto = require('crypto');
    const disc = crypto.createHash('sha256').update('global:initiate_atomic_swap').digest().slice(0,8);
    const buf = Buffer.concat([
      disc,
      Buffer.from(BigInt(amount).toString(16).padStart(16, '0'), 'hex').reverse(), // u64 little endian
      Buffer.from(secretHash.replace(/^0x/, ''), 'hex'), // 32 bytes
      timelockBuf,
    ]);

    const keys = [
      { pubkey: initiator, isSigner: true, isWritable: true },
      { pubkey: participantPk, isSigner: false, isWritable: false },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: initiatorAta, isSigner: false, isWritable: true },
      { pubkey: escrowVaultPda, isSigner: false, isWritable: true },
      { pubkey: atomicSwapPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ];

    const instruction = new Transaction().add({
      keys,
      programId,
      data: buf,
    } as any);

    const txSig = await sendAndConfirmTransaction(conn, instruction, [payer], {commitment: 'confirmed'});

    // store mapping if evmSwapId provided so relayer can auto-complete counterpart
    if (evmSwapId) {
      relayerMappings[evmSwapId] = { atomicSwapPda: atomicSwapPda.toBase58(), escrowVaultPda: escrowVaultPda.toBase58(), tokenMint, participant };
      try { saveMappings(); } catch (e) { console.warn('[Relayer] failed to persist mapping', e); }
    }

    return res.json({ success: true, txSig, atomicSwapPda: atomicSwapPda.toBase58(), escrowVaultPda: escrowVaultPda.toBase58() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// helper to complete Solana HTLC using relayer keypair
async function completeSolanaHTLC(atomicSwapPda: string, escrowVaultPda: string, tokenMint: string, secret: string) {
  return completeSolanaHTLCWrapper(SOLANA_RPC, SOLANA_PROGRAM_ID, process.env.RELAYER_SOLANA_KEYPAIR || '', atomicSwapPda, escrowVaultPda, tokenMint, secret);
}

app.post('/solana/complete-htlc', async (req, res) => {
  const { atomicSwapPda, escrowVaultPda, tokenMint, secret } = req.body;
  if (!atomicSwapPda || !escrowVaultPda || !tokenMint || !secret) return res.status(400).json({ error: 'atomicSwapPda, escrowVaultPda, tokenMint, secret required' });

  try {
    const txSig = await completeSolanaHTLC(atomicSwapPda, escrowVaultPda, tokenMint, secret);
    return res.json({ success: true, txSig });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// mappings inspection endpoints
app.get('/mappings', (req, res) => {
  res.json({ count: Object.keys(relayerMappings).length, mappings: relayerMappings });
});

app.delete('/mappings/:id', (req, res) => {
  const id = req.params.id;
  if (!relayerMappings[id]) return res.status(404).json({ error: 'mapping not found' });
  delete relayerMappings[id];
  saveMappings();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`FizzDex relayer listening on http://localhost:${PORT}`);
  // start background worker to retry auto-complete for persisted mappings
  try {
    startWorker();
  } catch (e) {
    console.warn('[Relayer] failed to start worker', e);
  }
});
