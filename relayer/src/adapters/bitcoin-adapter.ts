/**
 * Bitcoin Chain Adapter
 *
 * Implements IChainAdapter for Bitcoin using P2WSH HTLCs for atomic swaps.
 * Networking is handled via the Blockstream Esplora REST API (no local node required).
 *
 * Required config extras (passed in ChainConfig or env):
 *   - BITCOIN_WIF            WIF-encoded relayer private key
 *   - BITCOIN_NETWORK        "mainnet" | "testnet" (default: "mainnet")
 *   - BITCOIN_ESPLORA_URL    Blockstream API base (auto-detected by network if absent)
 */

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import {
  ChainConfig,
  IChainAdapter,
  SwapQuote,
  TokenInfo,
  TransactionResult,
} from "../chain-adapter";

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

// ─── constants ───────────────────────────────────────────────────────────────

/** Default HTLC refund timelock: 2 hours from initiation. */
const DEFAULT_HTLC_TIMELOCK_SECONDS = 7200;

/** Flat fee deducted from the HTLC output when building a claim transaction (satoshis). */
const DEFAULT_HTLC_SPEND_FEE_SATS = 1000n;

/** Bridge fee: 0.3% (numerator/denominator for integer arithmetic). */
const BRIDGE_FEE_NUMERATOR = 3n;
const BRIDGE_FEE_DENOMINATOR = 1000n;

// ─── internal helpers ────────────────────────────────────────────────────────

/** Minimal fetch via Node built-in http/https (no extra deps). */
function esploraGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      })
      .on("error", reject);
  });
}

function esploraPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Build a standard Bitcoin atomic-swap HTLC redeem script (P2WSH).
 *
 * Script layout:
 *   OP_IF
 *     OP_SHA256 <secretHash> OP_EQUALVERIFY
 *     <participantPubKey> OP_CHECKSIG
 *   OP_ELSE
 *     <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *     <initiatorPubKey> OP_CHECKSIG
 *   OP_ENDIF
 */
export function buildHtlcScript(
  secretHashHex: string,
  participantPubKeyHex: string,
  initiatorPubKeyHex: string,
  locktimeUnix: number
): Buffer {
  const secretHash = Buffer.from(secretHashHex.replace(/^0x/, ""), "hex");
  if (secretHash.length !== 32)
    throw new Error("secretHash must be 32 bytes (SHA-256 of secret)");

  const participantPubKey = Buffer.from(participantPubKeyHex, "hex");
  const initiatorPubKey = Buffer.from(initiatorPubKeyHex, "hex");

  // Encode locktime as minimal-push script number
  const locktimeBuf = bitcoin.script.number.encode(locktimeUnix);

  return Buffer.from(bitcoin.script.compile([
    bitcoin.opcodes.OP_IF,
    bitcoin.opcodes.OP_SHA256,
    secretHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    participantPubKey,
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_ELSE,
    locktimeBuf,
    bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoin.opcodes.OP_DROP,
    initiatorPubKey,
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_ENDIF,
  ]));
}

/** Derive the P2WSH address from an HTLC redeem script. */
export function htlcP2wshAddress(
  redeemScript: Buffer,
  network: bitcoin.Network
): string {
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: redeemScript, network }, network });
  if (!p2wsh.address) throw new Error("Could not derive P2WSH address");
  return p2wsh.address;
}

// ─── BitcoinAdapter ──────────────────────────────────────────────────────────

export class BitcoinAdapter implements IChainAdapter {
  private config: ChainConfig;
  private network: bitcoin.Network;
  private esploraBase: string;
  private wif?: string;
  private _connected = false;

  constructor(config: ChainConfig) {
    this.config = config;
    const cfg: any = config;

    const isTestnet =
      cfg.testnet === true ||
      process.env.BITCOIN_NETWORK === "testnet";

    this.network = isTestnet
      ? bitcoin.networks.testnet
      : bitcoin.networks.bitcoin;

    this.esploraBase =
      cfg.esploraUrl ||
      process.env.BITCOIN_ESPLORA_URL ||
      (isTestnet
        ? "https://blockstream.info/testnet/api"
        : "https://blockstream.info/api");

    this.wif = cfg.wif || process.env.BITCOIN_WIF;
  }

  // ── IChainAdapter ── //

  getChainInfo(): ChainConfig {
    return this.config;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async getWalletAddress(): Promise<string> {
    const keyPair = this._keyPair();
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: this.network,
    });
    if (!address) throw new Error("Could not derive P2WPKH address");
    return address;
  }

  async getBalance(tokenAddress?: string): Promise<string> {
    const address = await this.getWalletAddress();
    const data = await esploraGet(`${this.esploraBase}/address/${address}`);
    const funded: number = data?.chain_stats?.funded_txo_sum ?? 0;
    const spent: number = data?.chain_stats?.spent_txo_sum ?? 0;
    return String(funded - spent); // satoshis
  }

  async getSwapQuote(
    inputToken: string,
    outputToken: string,
    amount: string
  ): Promise<SwapQuote> {
    // Bitcoin does not have native AMM pools. For cross-chain BTC ↔ wrapped-BTC
    // pairs the quote reflects a 1:1 rate minus the 0.3% bridge fee.
    const amountIn = BigInt(amount);
    if (amountIn <= 0n) throw new Error("Invalid amount");

    const fee = amountIn * BRIDGE_FEE_NUMERATOR / BRIDGE_FEE_DENOMINATOR;
    const amountOut = amountIn - fee;

    const tokenInfo = (addr: string): TokenInfo => ({
      address: addr,
      symbol: addr.toLowerCase().includes("btc") ? "BTC" : addr.slice(0, 6),
      name: "Bitcoin",
      decimals: 8,
    });

    return {
      inputToken: tokenInfo(inputToken),
      outputToken: tokenInfo(outputToken),
      inputAmount: amount,
      outputAmount: amountOut.toString(),
      priceImpact: 0,
      fee: fee.toString(),
      route: [this.config.chainId],
      estimatedGas: "0",
    };
  }

  async executeSwap(
    _inputToken: string,
    _outputToken: string,
    _amount: string,
    _minOutputAmount: string,
    _slippage: number
  ): Promise<TransactionResult> {
    // Native on-chain Bitcoin swaps are not supported; use initiateBridge + completeBridge
    // for cross-chain atomic swaps with any EVM/Solana counterpart.
    throw new Error(
      "Native BTC swap not supported — use the Bitcoin HTLC bridge flow instead"
    );
  }

  async addLiquidity(
    _tokenA: string,
    _tokenB: string,
    _amountA: string,
    _amountB: string
  ): Promise<TransactionResult> {
    throw new Error("addLiquidity not supported on Bitcoin");
  }

  async removeLiquidity(
    _tokenA: string,
    _tokenB: string,
    _lpTokenAmount: string
  ): Promise<TransactionResult> {
    throw new Error("removeLiquidity not supported on Bitcoin");
  }

  async playFizzCaps(_number: number): Promise<TransactionResult> {
    throw new Error("playFizzCaps not supported on Bitcoin");
  }

  async claimRewards(): Promise<TransactionResult> {
    throw new Error("claimRewards not supported on Bitcoin");
  }

  async getPlayerStats(_address: string): Promise<any> {
    throw new Error("getPlayerStats not supported on Bitcoin");
  }

  /**
   * Initiate a Bitcoin HTLC (Hash Time-Locked Contract).
   *
   * Creates a P2WSH address for the HTLC. The caller must fund this address
   * with exactly `amount` satoshis in a separate on-chain transaction.
   *
   * Returns metadata needed to later call completeBridge:
   *   - meta.htlcAddress   — P2WSH address to fund
   *   - meta.redeemScript  — hex-encoded redeem script
   *   - meta.secretHash    — SHA-256 of the secret (hex)
   *   - meta.timelock      — Unix timestamp of the refund timelock
   */
  async initiateBridge(
    targetChain: string,
    token: string,
    amount: string,
    recipientAddress: string
  ): Promise<TransactionResult> {
    const keyPair = this._keyPair();
    const initiatorPubKey = Buffer.from(keyPair.publicKey).toString("hex");

    // recipientAddress must be a hex-encoded 33-byte compressed public key (starts with 02 or 03).
    // This is required to embed the participant's key in the HTLC spend condition.
    if (
      recipientAddress.length !== 66 ||
      !/^(02|03)[0-9a-fA-F]{64}$/.test(recipientAddress)
    ) {
      throw new Error(
        "recipientAddress for Bitcoin initiateBridge must be a hex-encoded 33-byte compressed public key (e.g. 02... or 03...)"
      );
    }
    const participantPubKey = recipientAddress;

    const secret = crypto.randomBytes(32);
    const secretHashBuf = crypto.createHash("sha256").update(secret).digest();
    const secretHashHex = secretHashBuf.toString("hex");

    const locktime = Math.floor(Date.now() / 1000) + DEFAULT_HTLC_TIMELOCK_SECONDS;

    const redeemScript = buildHtlcScript(
      secretHashHex,
      participantPubKey,
      initiatorPubKey,
      locktime
    );
    const htlcAddress = htlcP2wshAddress(redeemScript, this.network);

    // IMPORTANT: The plaintext secret is NOT included in the return value.
    // In production the initiator must securely share the secret with the
    // counterparty (e.g. encrypted off-chain message) AFTER the counterpart
    // HTLC is confirmed on the target chain.
    return {
      hash: htlcAddress, // The P2WSH address acts as the "transaction" identifier at this stage
      success: true,
      meta: {
        htlcAddress,
        redeemScript: redeemScript.toString("hex"),
        secretHash: secretHashHex,
        timelock: locktime,
        amount,
        targetChain,
      },
    };
  }

  /**
   * Complete a Bitcoin HTLC by spending it with the secret preimage.
   *
   * bridgeId format: "<txid>:<vout>:<amountSats>:<redeemScriptHex>:<recipientAddress>"
   * proof: hex-encoded secret preimage (32 bytes)
   *
   * Builds and broadcasts a P2WPKH-spending transaction that reveals the preimage.
   */
  async completeBridge(
    bridgeId: string,
    proof: string
  ): Promise<TransactionResult> {
    const parts = bridgeId.split(":");
    if (parts.length < 5) {
      throw new Error(
        'bridgeId must be "txid:vout:amountSats:redeemScriptHex:recipientAddress"'
      );
    }
    const [txid, voutStr, amountSatsStr, redeemScriptHex, recipientAddress] = parts;
    const vout = parseInt(voutStr, 10);
    const amountSatsBigInt = BigInt(amountSatsStr);
    const redeemScript = Buffer.from(redeemScriptHex, "hex");
    const secret = Buffer.from(proof.replace(/^0x/, ""), "hex");

    const keyPair = this._keyPair();

    // Build the P2WSH spending transaction
    const psbt = new bitcoin.Psbt({ network: this.network });

    // fee: 1000 sat flat (conservative; production should use fee-rate estimation)
    const FEE_SATS = DEFAULT_HTLC_SPEND_FEE_SATS;
    const outputSats = amountSatsBigInt - FEE_SATS;
    if (outputSats <= 0n) throw new Error("HTLC amount insufficient to cover fee");

    const p2wsh = bitcoin.payments.p2wsh({
      redeem: { output: redeemScript, network: this.network },
      network: this.network,
    });

    const p2wshOutput = p2wsh.output;
    if (!p2wshOutput) throw new Error("Could not derive P2WSH output script from redeem script");

    psbt.addInput({
      hash: txid,
      index: vout,
      sequence: 0xfffffffe, // allow nLockTime
      witnessUtxo: {
        script: Buffer.from(p2wshOutput),
        value: amountSatsBigInt,
      },
      witnessScript: redeemScript,
    });

    const { output: recipientScript } = bitcoin.payments.p2wpkh({
      address: recipientAddress,
      network: this.network,
    });
    if (!recipientScript) throw new Error("Invalid recipient address");

    psbt.addOutput({ script: Buffer.from(recipientScript), value: outputSats });

    // Sign with participant key (relayer's WIF must match the participant pubkey in the HTLC)
    psbt.signInput(0, keyPair);

    // Custom finalizer: build the P2WSH witness stack for the OP_IF (claim) branch:
    // [<sig>, <secret>, <0x01>, <redeemScript>]
    psbt.finalizeInput(0, (_inputIndex: number, input: any) => {
      if (!input.partialSig || input.partialSig.length === 0) {
        throw new Error("No partial signature found — signing must complete before finalizing");
      }
      const sig: Buffer = input.partialSig[0].signature;
      const witness: Buffer[] = [
        sig,
        secret,
        Buffer.from([0x01]), // truthy value selects the OP_IF branch
        redeemScript,
      ];
      return {
        finalScriptSig: Buffer.alloc(0),
        finalScriptWitness: encodeWitness(witness),
      };
    });

    const rawHex = psbt.extractTransaction().toHex();
    const txHash = await esploraPost(`${this.esploraBase}/tx`, rawHex);

    return { hash: txHash, success: true };
  }

  async signMessage(message: string): Promise<string> {
    const keyPair = this._keyPair();
    const hash = crypto.createHash("sha256").update(message).digest();
    const sig = keyPair.sign(hash);
    return Buffer.from(sig).toString("hex");
  }

  async verifySignature(
    message: string,
    signature: string,
    pubkeyHex: string
  ): Promise<boolean> {
    const hash = crypto.createHash("sha256").update(message).digest();
    const sig = Buffer.from(signature, "hex");
    const pubkey = Buffer.from(pubkeyHex, "hex");
    return ecc.verify(hash, pubkey, sig);
  }

  // ── helpers ── //

  private _keyPair() {
    const wif = this.wif;
    if (!wif) throw new Error("BITCOIN_WIF not configured for Bitcoin adapter");
    return ECPair.fromWIF(wif, this.network);
  }
}

/** Encode a witness stack as the compact-size-prefixed byte vector used in Bitcoin transactions. */
function encodeWitness(items: Buffer[]): Buffer {
  const chunks: Buffer[] = [varInt(items.length)];
  for (const item of items) {
    chunks.push(varInt(item.length));
    chunks.push(item);
  }
  return Buffer.concat(chunks);
}

function varInt(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}
