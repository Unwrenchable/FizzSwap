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
      const key = process.env.RELAYER_MAPPINGS_KEY;
      let json = raw;
      if (key) {
        try {
          const crypto = require('crypto');
          const parts = raw.split(':');
          if (parts.length === 2) {
            const iv = Buffer.from(parts[0], 'base64');
            const encrypted = Buffer.from(parts[1], 'base64');
            const hash = crypto.createHash('sha256').update(String(key)).digest();
            const decipher = crypto.createDecipheriv('aes-256-cbc', hash, iv);
            json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
          }
        } catch (e) {
            const err = e as any;
            console.warn('[Relayer] failed to decrypt mappings file, attempting to parse raw content', err?.message || String(err));
        }
      }
      relayerMappings = JSON.parse(json) as Record<string, MappingEntry>;
      console.log('[Relayer] Loaded', Object.keys(relayerMappings).length, 'mappings');
    }
  } catch (err) {
      const error = err as any;
      console.warn('[Relayer] Failed to load mappings', error);
  }
}

function saveMappings() {
  try {
    let payload = JSON.stringify(relayerMappings, null, 2);
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
          console.warn('[Relayer] Failed to encrypt mappings file, writing plaintext', ex?.message || String(ex));
      }
    }
    fs.writeFileSync(MAPPINGS_FILE, payload, 'utf8');
    try { fs.chmodSync(MAPPINGS_FILE, 0o600); } catch (e) { /* ignore chmod failures on windows */ }
  } catch (err) {
      const error = err as any;
      console.warn('[Relayer] Failed to save mappings', error);
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
        let parsed;
        try { parsed = iface.parseTransaction({ data: tx.data }); } catch { parsed = null; }
        if (!parsed || !parsed.args) return;
        const secretHex = parsed.args[1];
        let preimage = '';
        try { preimage = ethers.toUtf8String(secretHex); } catch { preimage = secretHex; }
        // Do NOT log secrets/preimages. Log only that a preimage was extracted (redacted).
        console.log('[Relayer] Extracted preimage for swap (REDACTED)');

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
import { MultiChainDEX } from "./chain-adapter";
import { RouteAggregator } from "./route-aggregator";
import { SolanaAdapter } from "./adapters/solana-adapter";

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
    results.sort((a, b) => (BigInt(b.quote.outputAmount) > BigInt(a.quote.outputAmount) ? 1 : -1));

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

// -------------------------
// Bitcoin HTLC helper endpoints
// -------------------------
import { buildHtlcScript, htlcP2wshAddress } from './adapters/bitcoin-adapter';
import * as btcLib from 'bitcoinjs-lib';

const BITCOIN_ESPLORA =
  process.env.BITCOIN_ESPLORA_URL ||
  (process.env.BITCOIN_NETWORK === 'testnet'
    ? 'https://blockstream.info/testnet/api'
    : 'https://blockstream.info/api');

const btcNetwork =
  process.env.BITCOIN_NETWORK === 'testnet'
    ? btcLib.networks.testnet
    : btcLib.networks.bitcoin;

const BITCOIN_DEFAULT_HTLC_TIMELOCK_SECONDS = 7200;

/**
 * POST /bitcoin/initiate-htlc
 *
 * Body: { participantPubKey, initiatorPubKey, secretHash, timelock?, evmSwapId? }
 *   - participantPubKey  hex-encoded 33-byte compressed public key of the swap recipient
 *   - initiatorPubKey   hex-encoded 33-byte compressed public key of the swap initiator
 *   - secretHash        32-byte SHA-256 hash of the atomic-swap secret (hex, no 0x prefix)
 *   - timelock          optional UNIX timestamp for refund path (defaults to now + 7200 s)
 *   - evmSwapId         optional EVM swap ID to link into the relayer mapping table
 *
 * Response: { htlcAddress, redeemScript, secretHash, timelock }
 *   The caller must send exactly `amount` satoshis to htlcAddress to fund the HTLC.
 */
app.post('/bitcoin/initiate-htlc', (req, res) => {
  const { participantPubKey, initiatorPubKey, secretHash, timelock: rawTimelock, evmSwapId } = req.body;
  if (!participantPubKey || !initiatorPubKey || !secretHash) {
    return res.status(400).json({ error: 'participantPubKey, initiatorPubKey, secretHash required' });
  }

  const secretHashClean = String(secretHash).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(secretHashClean)) {
    return res.status(400).json({ error: 'secretHash must be a 32-byte hex string (64 hex chars)' });
  }

  try {
    const timelock = rawTimelock ? Number(rawTimelock) : Math.floor(Date.now() / 1000) + BITCOIN_DEFAULT_HTLC_TIMELOCK_SECONDS;
    const redeemScript = buildHtlcScript(secretHashClean, participantPubKey, initiatorPubKey, timelock);
    const htlcAddress = htlcP2wshAddress(redeemScript, btcNetwork);

    if (evmSwapId) {
      // MappingEntry field names are shared across chains; for Bitcoin:
      //   atomicSwapPda  → P2WSH HTLC address
      //   escrowVaultPda → hex-encoded redeem script
      //   tokenMint      → 'BTC'
      relayerMappings[evmSwapId] = {
        atomicSwapPda: htlcAddress,
        escrowVaultPda: redeemScript.toString('hex'),
        tokenMint: 'BTC',
        participant: participantPubKey,
      };
      try { saveMappings(); } catch (e) { console.warn('[Relayer] failed to persist BTC mapping', e); }
    }

    return res.json({
      success: true,
      htlcAddress,
      redeemScript: redeemScript.toString('hex'),
      secretHash: secretHashClean,
      timelock,
      network: process.env.BITCOIN_NETWORK || 'mainnet',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /bitcoin/complete-htlc
 *
 * Spend a funded Bitcoin P2WSH HTLC using the secret preimage.
 * The relayer signs the spending transaction using BITCOIN_WIF.
 *
 * Body: { txid, vout, amountSats, redeemScript, secret, recipientAddress }
 *   - txid             Funding transaction ID
 *   - vout             Output index in the funding transaction
 *   - amountSats       Value of the HTLC output (satoshis)
 *   - redeemScript     Hex-encoded redeem script (from /bitcoin/initiate-htlc response)
 *   - secret           32-byte secret preimage (hex)
 *   - recipientAddress Bech32 (P2WPKH) address to receive the funds
 */
app.post('/bitcoin/complete-htlc', async (req, res) => {
  const { txid, vout, amountSats, redeemScript: redeemScriptHex, secret, recipientAddress } = req.body;
  if (!txid || vout === undefined || !amountSats || !redeemScriptHex || !secret || !recipientAddress) {
    return res.status(400).json({ error: 'txid, vout, amountSats, redeemScript, secret, recipientAddress required' });
  }

  if (!process.env.BITCOIN_WIF) return res.status(500).json({ error: 'BITCOIN_WIF not configured' });

  const { BitcoinAdapter } = require('./adapters/bitcoin-adapter');
  const adapter = new BitcoinAdapter({
    chainId: 'bitcoin',
    chainName: 'Bitcoin',
    chainType: 'bitcoin',
    rpcUrl: BITCOIN_ESPLORA,
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 8 },
  });

  const bridgeId = `${txid}:${vout}:${amountSats}:${redeemScriptHex}:${recipientAddress}`;
  try {
    const result = await adapter.completeBridge(bridgeId, String(secret).replace(/^0x/, ''));
    return res.json({ success: result.success, txHash: result.hash, error: result.error });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /bitcoin/htlc-status/:address
 *
 * Check whether a Bitcoin P2WSH HTLC address has been funded and/or spent.
 * Uses the Blockstream Esplora API (no local node required).
 */
app.get('/bitcoin/htlc-status/:address', async (req, res) => {
  const { address } = req.params;
  if (!address) return res.status(400).json({ error: 'address required' });

  const esploraFetch = (url: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      lib.get(url, (r: any) => {
        let d = '';
        r.on('data', (c: any) => (d += c));
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      }).on('error', reject);
    });

  try {
    const [addrInfo, utxos] = await Promise.all([
      esploraFetch(`${BITCOIN_ESPLORA}/address/${address}`),
      esploraFetch(`${BITCOIN_ESPLORA}/address/${address}/utxo`),
    ]);

    const funded = addrInfo?.chain_stats?.funded_txo_sum ?? 0;
    const spent = addrInfo?.chain_stats?.spent_txo_sum ?? 0;
    return res.json({
      address,
      funded_sats: funded,
      spent_sats: spent,
      balance_sats: funded - spent,
      utxos: utxos || [],
      status: spent > 0 ? 'completed' : funded > 0 ? 'funded' : 'unfunded',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// mappings inspection endpoints
app.get('/mappings', (req, res) => {
  // Protect mappings endpoint when RELAYER_API_KEY is configured
  if (RELAYER_API_KEY) {
    const key = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string);
    if (!key || key !== RELAYER_API_KEY) return res.status(401).json({ error: 'Unauthorized - valid x-api-key required' });
  }
  res.json({ count: Object.keys(relayerMappings).length, mappings: relayerMappings });
});

app.delete('/mappings/:id', (req, res) => {
  // Protect mappings deletion when RELAYER_API_KEY is configured
  if (RELAYER_API_KEY) {
    const key = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string);
    if (!key || key !== RELAYER_API_KEY) return res.status(401).json({ error: 'Unauthorized - valid x-api-key required' });
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// FizzChain hub endpoints
//
// FizzChain is the user's own custom blockchain — a multichain in itself —
// using hybrid PoW + PoS consensus with the FIZZ native token as the hub
// currency routing swaps across EVM, Solana, and Bitcoin.
// ─────────────────────────────────────────────────────────────────────────────
import { fizzChainState } from './fizz-chain/state';
import { mine, computeMerkleRoot, verifyPoW } from './fizz-chain/pow';
import { FIZZ_CHAIN_ID, CONSENSUS_PARAMS as FIZZ_CONSENSUS } from './fizz-chain/genesis';

/**
 * GET /fizz-chain/info
 * Returns FizzChain metadata: height, consensus params, validator count, pools.
 */
app.get('/fizz-chain/info', (_req, res) => {
  res.json(fizzChainState.chainInfo());
});

/**
 * GET /fizz-chain/block/latest
 * Returns the most recently finalized block.
 */
app.get('/fizz-chain/block/latest', (_req, res) => {
  res.json(fizzChainState.latestBlock);
});

/**
 * GET /fizz-chain/block/:height
 * Returns the block at a specific height.
 */
app.get('/fizz-chain/block/:height', (req, res) => {
  const h = Number(req.params.height);
  if (isNaN(h) || h < 0) return res.status(400).json({ error: 'height must be a non-negative integer' });
  const block = fizzChainState.blocks[h];
  if (!block) return res.status(404).json({ error: `Block ${h} not found` });
  res.json(block);
});

/**
 * GET /fizz-chain/balance/:address
 * Returns the FIZZ balance of a FizzChain address.
 * Optionally pass ?token=WETH to query a non-native token balance.
 */
app.get('/fizz-chain/balance/:address', (req, res) => {
  const { address } = req.params;
  const token = (req.query.token as string) || 'FIZZ';
  if (token === 'FIZZ') {
    return res.json({ address, token: 'FIZZ', balance: fizzChainState.getBalance(address).toString() });
  }
  const key = `${token}:${address}`;
  const balance = fizzChainState.balances.get(key) ?? 0n;
  return res.json({ address, token, balance: balance.toString() });
});

/**
 * GET /fizz-chain/pools
 * Returns all AMM pool states (FIZZ-paired).
 */
app.get('/fizz-chain/pools', (_req, res) => {
  const pools = fizzChainState.getPools().map(p => ({
    tokenA: p.tokenA,
    tokenB: p.tokenB,
    reserveA: p.reserveA.toString(),
    reserveB: p.reserveB.toString(),
    decimalsA: p.decimalsA,
    decimalsB: p.decimalsB,
    totalShares: p.totalShares.toString(),
  }));
  res.json({ count: pools.length, pools });
});

/**
 * GET /fizz-chain/validators
 * Returns all PoS validators with stake and activity info.
 */
app.get('/fizz-chain/validators', (_req, res) => {
  res.json(fizzChainState.validators.toJSON());
});

/**
 * POST /fizz-chain/quote
 * Get a swap quote on FizzChain without executing.
 *
 * Body: { tokenIn, tokenOut, amountIn }
 */
app.post('/fizz-chain/quote', (req, res) => {
  const { tokenIn, tokenOut, amountIn } = req.body;
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: 'tokenIn, tokenOut, amountIn required' });
  }
  try {
    const { amountOut, priceImpact, fee } = fizzChainState.getSwapQuote(tokenIn, tokenOut, amountIn);
    return res.json({
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amountOut.toString(),
      priceImpact,
      fee: fee.toString(),
      chain: FIZZ_CHAIN_ID,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/swap
 * Execute a FizzChain AMM swap.
 *
 * Body: { from, tokenIn, tokenOut, amountIn, minAmountOut? }
 */
app.post('/fizz-chain/swap', (req, res) => {
  const { from, tokenIn, tokenOut, amountIn, minAmountOut } = req.body;
  if (!from || !tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: 'from, tokenIn, tokenOut, amountIn required' });
  }
  try {
    const { amountOut, txId } = fizzChainState.swap(from, tokenIn, tokenOut, amountIn, minAmountOut || '0');
    return res.json({ success: true, txId, amountOut: amountOut.toString(), chain: FIZZ_CHAIN_ID });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/add-liquidity
 * Add liquidity to a FizzChain AMM pool.
 *
 * Body: { provider, tokenA, tokenB, amountA, amountB }
 */
app.post('/fizz-chain/add-liquidity', (req, res) => {
  const { provider, tokenA, tokenB, amountA, amountB } = req.body;
  if (!provider || !tokenA || !tokenB || !amountA || !amountB) {
    return res.status(400).json({ error: 'provider, tokenA, tokenB, amountA, amountB required' });
  }
  try {
    const { shares, txId } = fizzChainState.addLiquidity(provider, tokenA, tokenB, amountA, amountB);
    return res.json({ success: true, txId, shares: shares.toString() });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/transfer
 * Transfer FIZZ between FizzChain addresses.
 *
 * Body: { from, to, amount }
 */
app.post('/fizz-chain/transfer', (req, res) => {
  const { from, to, amount } = req.body;
  if (!from || !to || !amount) {
    return res.status(400).json({ error: 'from, to, amount required' });
  }
  try {
    const txId = fizzChainState.transfer(from, to, amount);
    return res.json({ success: true, txId });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/stake
 * Stake FIZZ to become a PoS validator (or increase an existing stake).
 *
 * Body: { address, amount, name? }
 */
app.post('/fizz-chain/stake', (req, res) => {
  const { address, amount, name } = req.body;
  if (!address || !amount) {
    return res.status(400).json({ error: 'address and amount required' });
  }
  try {
    const txId = fizzChainState.stakeForValidator(address, amount, name);
    const v = fizzChainState.validators.getValidator(address);
    return res.json({
      success: true,
      txId,
      validator: v
        ? { ...v, stake: v.stake.toString(), totalRewards: v.totalRewards.toString() }
        : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/unstake
 * Unstake FIZZ from the PoS validator registry.
 *
 * Body: { address, amount }
 */
app.post('/fizz-chain/unstake', (req, res) => {
  const { address, amount } = req.body;
  if (!address || !amount) {
    return res.status(400).json({ error: 'address and amount required' });
  }
  try {
    const txId = fizzChainState.unstakeFromValidator(address, amount);
    const v = fizzChainState.validators.getValidator(address);
    return res.json({
      success: true,
      txId,
      validator: v
        ? { ...v, stake: v.stake.toString(), totalRewards: v.totalRewards.toString() }
        : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/mine
 *
 * Two usage modes:
 *
 * Mode A — External miner submits a solved block:
 *   Body: { block: MinedBlock }   (pre-solved by an external miner)
 *
 * Mode B — Ask the relayer to mine in-process:
 *   Body: { miner: string }       (relayer runs the PoW search itself)
 *
 * In both cases the block goes through PoW verification and PoS finalization
 * before being appended to the ledger.
 *
 * Rate-limited to 2 in-process mine requests per IP per minute because PoW
 * is computationally intensive and running many concurrent searches would
 * exhaust relayer CPU.
 */
const mineRateMap = new Map<string, { count: number; resetTs: number }>();
const MINE_RATE_LIMIT = 2; // max in-process mine calls per IP per minute

app.post('/fizz-chain/mine', async (req, res) => {
  // Per-IP rate limit for the computationally expensive in-process mining path
  const ip = (req.ip || req.headers['x-forwarded-for'] || 'unknown') as string;
  const now = Date.now();
  const mineEntry = mineRateMap.get(ip) || { count: 0, resetTs: now + 60_000 };
  if (now > mineEntry.resetTs) { mineEntry.count = 0; mineEntry.resetTs = now + 60_000; }
  mineEntry.count += 1;
  mineRateMap.set(ip, mineEntry);
  if (mineEntry.count > MINE_RATE_LIMIT) {
    return res.status(429).json({ error: 'Mine rate limit exceeded — maximum 2 in-process mine calls per minute per IP' });
  }

  try {
    const { block: submittedBlock, miner: minerAddress } = req.body;

    if (submittedBlock) {
      // Mode A: validate and finalize an externally-mined block
      if (!verifyPoW(submittedBlock)) {
        return res.status(400).json({ error: 'Invalid PoW solution' });
      }
      const finalBlock = fizzChainState.submitPoW(submittedBlock);
      return res.json({ success: true, block: finalBlock });
    }

    // Mode B: mine in-process
    const miner = minerAddress || 'fizz1relayer00000000000000000000000000000000';
    const tip = fizzChainState.latestBlock;
    const txStrings = fizzChainState.mempool.map(t => JSON.stringify(t));
    const merkleRoot = computeMerkleRoot(txStrings);

    const candidate = {
      height: fizzChainState.height + 1,
      parentHash: tip.hash,
      merkleRoot,
      timestamp: Date.now(),
      difficulty: fizzChainState.currentDifficulty,
      miner,
    };

    const mined = mine(candidate);
    if (!mined) {
      return res.status(503).json({
        error: `PoW search exhausted (difficulty=${candidate.difficulty}, maxNonce=${FIZZ_CONSENSUS.maxNonce}). Retry or lower difficulty.`,
      });
    }

    const finalBlock = fizzChainState.submitPoW(mined);
    return res.json({ success: true, block: finalBlock });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/bridge-in
 * Record an inbound bridge event (tokens arriving from EVM/Solana/Bitcoin).
 * In production this is called automatically by the relayer worker after HTLC reveal.
 *
 * Body: { to, token, amount, sourceChain }
 */
app.post('/fizz-chain/bridge-in', (req, res) => {
  const { to, token, amount, sourceChain } = req.body;
  if (!to || !token || !amount || !sourceChain) {
    return res.status(400).json({ error: 'to, token, amount, sourceChain required' });
  }
  try {
    const txId = fizzChainState.bridgeIn(to, token, amount, sourceChain);
    return res.json({ success: true, txId });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /fizz-chain/bridge-out
 * Lock tokens on FizzChain to initiate a bridge to an external chain.
 *
 * Body: { from, token, amount, targetChain }
 */
app.post('/fizz-chain/bridge-out', (req, res) => {
  const { from, token, amount, targetChain } = req.body;
  if (!from || !token || !amount || !targetChain) {
    return res.status(400).json({ error: 'from, token, amount, targetChain required' });
  }
  try {
    const txId = fizzChainState.bridgeOut(from, token, amount, targetChain);
    return res.json({ success: true, txId });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});
