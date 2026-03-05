import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
  ChainConfig,
  IChainAdapter,
  SwapQuote,
  TokenInfo,
  TransactionResult,
} from "../chain-adapter";
import { completeSolanaHTLCWrapper } from "../solana-htlc";

export class SolanaAdapter implements IChainAdapter {
  private config: ChainConfig;
  private connection!: Connection;
  private keypair?: Keypair;

  constructor(config: ChainConfig, keypair?: Keypair) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl);
    this.keypair = keypair;
  }

  getChainInfo(): ChainConfig {
    return this.config;
  }

  async connect(): Promise<void> {
    this.connection = new Connection(this.config.rpcUrl, "confirmed");
    // load server-side relayer keypair if provided via env
    if (process.env.RELAYER_SOLANA_KEYPAIR && !this.keypair) {
      try {
        const arr = JSON.parse(process.env.RELAYER_SOLANA_KEYPAIR);
        this.keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
      } catch {
        // ignore parse errors; operations requiring signing will error later
      }
    }
  }

  async disconnect(): Promise<void> {
    // nothing to do
  }

  isConnected(): boolean {
    return !!this.connection;
  }

  async getWalletAddress(): Promise<string> {
    if (!this.keypair) throw new Error("No keypair configured for Solana adapter");
    return this.keypair.publicKey.toBase58();
  }

  async getBalance(tokenAddress?: string): Promise<string> {
    if (!this.keypair) throw new Error("No keypair configured for Solana adapter");
    const bal = await this.connection.getBalance(this.keypair.publicKey, 'confirmed');
    return bal.toString();
  }

  async getSwapQuote(inputToken: string, outputToken: string, amount: string): Promise<SwapQuote> {
    const cfg: any = this.config as any;

    // 1) on-chain poolAccounts support: caller can provide poolAccounts array of { tokenA, tokenB, vaultA, vaultB }
    if (cfg.poolAccounts && Array.isArray(cfg.poolAccounts)) {
      const pool = cfg.poolAccounts.find((p: any) => {
        const a = String(p.tokenA).toLowerCase();
        const b = String(p.tokenB).toLowerCase();
        const inT = inputToken.toLowerCase();
        const outT = outputToken.toLowerCase();
        return (a === inT && b === outT) || (a === outT && b === inT);
      });

      if (!pool) throw new Error('No on-chain pool found for provided tokens');

      // fetch token balances from the vault token accounts
      const vaultA = pool.vaultA;
      const vaultB = pool.vaultB;
      const respA = await this.connection.getTokenAccountBalance(new PublicKey(vaultA));
      const respB = await this.connection.getTokenAccountBalance(new PublicKey(vaultB));

      const reserveA = BigInt(respA.value.amount);
      const reserveB = BigInt(respB.value.amount);

      const isTokenA = pool.tokenA.toLowerCase() === inputToken.toLowerCase();
      const reserveIn = isTokenA ? reserveA : reserveB;
      const reserveOut = isTokenA ? reserveB : reserveA;

      const amountIn = BigInt(amount);
      if (amountIn <= 0n) throw new Error('Invalid amount');

      const amountInWithFee = amountIn * 997n;
      const numerator = amountInWithFee * reserveOut;
      const denominator = reserveIn * 1000n + amountInWithFee;
      const amountOut = numerator / denominator;

      const quote: SwapQuote = {
        inputToken: { address: inputToken, symbol: 'SPL', name: 'SPL Token', decimals: pool.decimalsA || 9 },
        outputToken: { address: outputToken, symbol: 'SPL', name: 'SPL Token', decimals: pool.decimalsB || 9 },
        inputAmount: amount.toString(),
        outputAmount: amountOut.toString(),
        priceImpact: reserveIn > 0n && reserveOut > 0n
          ? (() => {
              const spotOut = (amountIn * reserveOut) / reserveIn;
              return spotOut > 0n ? Math.max(0, Number((spotOut - amountOut) * 10000n / spotOut) / 100) : 0;
            })()
          : 0,
        fee: (amountIn * 3n / 1000n).toString(),
        route: [this.config.chainId],
        estimatedGas: '0'
      };

      return quote;
    }

    // 2) fallback: local in-memory pools (useful for demos and tests)
    const pools = cfg.pools;
    if (!pools || !Array.isArray(pools)) throw new Error('getSwapQuote not implemented for Solana adapter yet');

    const pool = pools.find((p: any) => {
      const a = String(p.tokenA).toLowerCase();
      const b = String(p.tokenB).toLowerCase();
      const inT = inputToken.toLowerCase();
      const outT = outputToken.toLowerCase();
      return (a === inT && b === outT) || (a === outT && b === inT);
    });

    if (!pool) throw new Error('No pool found for provided tokens');

    // Determine reserve ordering like EVM adapter
    const isTokenA = pool.tokenA.toLowerCase() === inputToken.toLowerCase();
    const reserveA = BigInt(pool.reserveA.toString());
    const reserveB = BigInt(pool.reserveB.toString());
    const reserveIn = isTokenA ? reserveA : reserveB;
    const reserveOut = isTokenA ? reserveB : reserveA;

    const amountIn = BigInt(amount);
    if (amountIn <= 0n) throw new Error('Invalid amount');

    // constant-product quote with 0.3% fee
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const amountOut = numerator / denominator;

    // price impact: how much the trade moves the price vs. the spot rate
    const spotOut = reserveOut > 0n ? (amountIn * reserveOut) / reserveIn : 0n;
    const priceImpact = spotOut > 0n
      ? Math.max(0, Number((spotOut - amountOut) * 10000n / spotOut) / 100)
      : 0;

    const quote: SwapQuote = {
      inputToken: { address: inputToken, symbol: 'SPL', name: 'SPL Token', decimals: 9 },
      outputToken: { address: outputToken, symbol: 'SPL', name: 'SPL Token', decimals: 9 },
      inputAmount: amount.toString(),
      outputAmount: amountOut.toString(),
      priceImpact,
      fee: (amountIn * 3n / 1000n).toString(),
      route: [this.config.chainId],
      estimatedGas: '0'
    };

    return quote;
  }

  async executeSwap(
    inputToken: string,
    outputToken: string,
    amount: string,
    minOutputAmount: string,
    slippage: number
  ): Promise<TransactionResult> {
    const cfg: any = this.config as any;

    // Attempt on-chain swap when configured and relayer keypair present
    const swapProgramId = cfg.swapProgramId || process.env.SOLANA_SWAP_PROGRAM_ID || process.env.SOLANA_PROGRAM_ID;
    const swapAccounts = cfg.swapAccounts; // expected structure: { keys: [{ pubkey, isSigner, isWritable }, ...] }
    const relayerKeypairJson = process.env.RELAYER_SOLANA_KEYPAIR;

    if (swapProgramId && relayerKeypairJson) {
      if (!swapAccounts) throw new Error('swapAccounts configuration required for on-chain swap');

      // build instruction data: discriminator + amount(u64 LE) + minOutput(u64 LE)
      const crypto = require('crypto');
      const disc = crypto.createHash('sha256').update('global:swap').digest().slice(0, 8);
      const amtBuf = Buffer.alloc(8);
      amtBuf.writeBigUInt64LE(BigInt(amount));
      const minBuf = Buffer.alloc(8);
      minBuf.writeBigUInt64LE(BigInt(minOutputAmount || '0'));
      const data = Buffer.concat([disc, amtBuf, minBuf]);

      // prepare keys
      const keys = (swapAccounts.keys || []).map((k: any) => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable }));
      const programId = new PublicKey(swapProgramId);
      const instruction = new TransactionInstruction({ keys, programId, data });

      // load relayer keypair
      const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(relayerKeypairJson)));
      const tx = new Transaction().add(instruction);
      tx.feePayer = payer.publicKey;
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const sig = await sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: 'confirmed' });
      return { hash: sig, success: true, blockNumber: 0 };
    }

    // Fallback to simulated in-memory pool swap (demo)
    const pools = cfg.pools;
    if (!pools || !Array.isArray(pools)) throw new Error('executeSwap not implemented for Solana adapter');

    const poolIndex = pools.findIndex((p: any) => {
      const a = String(p.tokenA).toLowerCase();
      const b = String(p.tokenB).toLowerCase();
      const inT = inputToken.toLowerCase();
      const outT = outputToken.toLowerCase();
      return (a === inT && b === outT) || (a === outT && b === inT);
    });

    if (poolIndex === -1) throw new Error('No pool found for provided tokens');

    const pool = pools[poolIndex];
    const isTokenA = pool.tokenA.toLowerCase() === inputToken.toLowerCase();
    const reserveA = BigInt(pool.reserveA.toString());
    const reserveB = BigInt(pool.reserveB.toString());
    const reserveIn = isTokenA ? reserveA : reserveB;
    const reserveOut = isTokenA ? reserveB : reserveA;

    const amountIn = BigInt(amount);
    if (amountIn <= 0n) throw new Error('Invalid amount');

    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const amountOut = numerator / denominator;

    if (isTokenA) {
      pool.reserveA = (reserveA + amountIn).toString();
      pool.reserveB = (reserveB - amountOut).toString();
    } else {
      pool.reserveB = (reserveB + amountIn).toString();
      pool.reserveA = (reserveA - amountOut).toString();
    }

    const txSig = `SIMULATED-SOLANA-TX-${Math.floor(Math.random() * 1e9)}`;
    return { hash: txSig, success: true, blockNumber: 0 };
  }

  async addLiquidity(tokenA: string, tokenB: string, amountA: string, amountB: string): Promise<TransactionResult> {
    throw new Error('addLiquidity not implemented for Solana adapter');
  }

  async removeLiquidity(tokenA: string, tokenB: string, lpTokenAmount: string): Promise<TransactionResult> {
    throw new Error('removeLiquidity not implemented for Solana adapter');
  }

  async playFizzCaps(number: number): Promise<TransactionResult> {
    throw new Error('playFizzCaps not implemented for Solana adapter');
  }

  async claimRewards(): Promise<TransactionResult> {
    throw new Error('claimRewards not implemented for Solana adapter');
  }

  async getPlayerStats(address: string): Promise<any> {
    throw new Error('getPlayerStats not implemented for Solana adapter');
  }

  async initiateBridge(targetChain: string, token: string, amount: string, recipientAddress: string): Promise<TransactionResult> {
    if (!this.keypair) throw new Error('No keypair configured for Solana adapter');
    const cfg: any = this.config as any;
    const programId = new PublicKey(cfg.swapProgramId || process.env.SOLANA_SWAP_PROGRAM_ID || process.env.SOLANA_PROGRAM_ID || '');

    // Generate a 32-byte secret hash for the HTLC
    const crypto = require('crypto');
    const secretBytes = crypto.randomBytes(32);
    const secretHash = crypto.createHash('sha256').update(secretBytes).digest();

    const initiator = this.keypair.publicKey;
    const participantPk = new PublicKey(recipientAddress);
    const mintPk = new PublicKey(token);
    const amountU64 = BigInt(amount);
    const timelockI64 = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const timelockBuf = Buffer.alloc(8);
    timelockBuf.writeBigInt64LE(timelockI64);

    const [atomicSwapPda] = await PublicKey.findProgramAddress([
      Buffer.from('atomic_swap'),
      initiator.toBuffer(),
      participantPk.toBuffer(),
      mintPk.toBuffer(),
      timelockBuf,
    ], programId);

    const [escrowVaultPda] = await PublicKey.findProgramAddress([
      Buffer.from('escrow_vault'),
      initiator.toBuffer(),
      participantPk.toBuffer(),
      mintPk.toBuffer(),
      timelockBuf,
    ], programId);

    const initiatorAta = await getAssociatedTokenAddress(mintPk, initiator);

    const disc = crypto.createHash('sha256').update('global:initiate_atomic_swap').digest().slice(0, 8);
    const amtBuf = Buffer.alloc(8);
    amtBuf.writeBigUInt64LE(amountU64);
    const data = Buffer.concat([Buffer.from(disc), amtBuf, Buffer.from(secretHash), timelockBuf]);

    const keys = [
      { pubkey: initiator,          isSigner: true,  isWritable: true  },
      { pubkey: participantPk,      isSigner: false, isWritable: false },
      { pubkey: mintPk,             isSigner: false, isWritable: false },
      { pubkey: initiatorAta,       isSigner: false, isWritable: true  },
      { pubkey: escrowVaultPda,     isSigner: false, isWritable: true  },
      { pubkey: atomicSwapPda,      isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ];

    const tx = new Transaction().add(new TransactionInstruction({ keys, programId, data }));
    tx.feePayer = initiator;
    const { blockhash } = await this.connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;

    try {
      const sig = await sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: 'confirmed' });
      return {
        hash: sig,
        success: true,
        meta: {
          atomicSwapPda: atomicSwapPda.toBase58(),
          escrowVaultPda: escrowVaultPda.toBase58(),
          // secretHash is the SHA-256 of secretBytes (hex). The recipient needs the plaintext
          // secretBytes to claim funds on the target chain. Callers must receive secretBytes
          // through a separate secure channel (e.g., encrypted message or out-of-band delivery).
          secretHash: secretHash.toString('hex'),
          timelock: timelockI64.toString(),
        },
      };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  async completeBridge(bridgeId: string, proof: string): Promise<TransactionResult> {
    // bridgeId is expected as "atomicSwapPda:escrowVaultPda:tokenMint"
    const parts = bridgeId.split(':');
    if (parts.length < 3) throw new Error('bridgeId must be "atomicSwapPda:escrowVaultPda:tokenMint"');
    const [atomicSwapPda, escrowVaultPda, tokenMint] = parts;
    const solanaRpc = this.config.rpcUrl;
    const programId = (this.config as any).swapProgramId || process.env.SOLANA_SWAP_PROGRAM_ID || process.env.SOLANA_PROGRAM_ID || '';
    const keypairJson = process.env.RELAYER_SOLANA_KEYPAIR;
    if (!keypairJson) throw new Error('RELAYER_SOLANA_KEYPAIR not configured');
    try {
      const txSig = await completeSolanaHTLCWrapper(solanaRpc, programId, keypairJson, atomicSwapPda, escrowVaultPda, tokenMint, proof);
      return { hash: txSig, success: true };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  async signMessage(message: string): Promise<string> {
    if (!this.keypair) throw new Error('No keypair for signing');
    try {
      const nacl: any = require('tweetnacl');
      const sig = nacl.sign.detached(Buffer.from(message), this.keypair.secretKey);
      return Buffer.from(sig).toString('base64');
    } catch (e) {
      throw new Error('Signing requires tweetnacl dependency');
    }
  }

  async verifySignature(message: string, signature: string, address: string): Promise<boolean> {
    throw new Error('verifySignature not implemented');
  }
}
