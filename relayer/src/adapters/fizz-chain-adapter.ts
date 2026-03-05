/**
 * FizzChain Adapter — IChainAdapter for the FizzChain hub
 *
 * FizzChain is the user's own custom blockchain that is a multichain in itself.
 * It uses a hybrid PoW + PoS consensus and acts as a hub that natively aggregates
 * liquidity across EVM, Solana, and Bitcoin through FIZZ-paired AMM pools.
 *
 * Cross-chain routing strategy:
 *   inputToken (any chain) → FIZZ (FizzChain hub) → outputToken (any chain)
 *
 * The adapter delegates bridge operations to the existing EVM/Solana/Bitcoin
 * adapters, while swap execution is handled by the FizzChain in-process state.
 */

import * as crypto from 'crypto';
import {
  ChainConfig,
  IChainAdapter,
  SwapQuote,
  TokenInfo,
  TransactionResult,
} from '../chain-adapter';
import { fizzChainState } from '../fizz-chain/state';
import { mine } from '../fizz-chain/pow';
import { FIZZ_CHAIN_ID, FIZZ_TOKEN, CONSENSUS_PARAMS } from '../fizz-chain/genesis';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenInfo(address: string): TokenInfo {
  if (address === 'FIZZ') {
    return { address: 'FIZZ', symbol: 'FIZZ', name: 'Fizz', decimals: 18 };
  }
  const symbols: Record<string, { symbol: string; name: string; decimals: number }> = {
    WETH: { symbol: 'WETH', name: 'Wrapped Ether',   decimals: 18 },
    WSOL: { symbol: 'WSOL', name: 'Wrapped SOL',     decimals: 9  },
    WBTC: { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8  },
    BTC:  { symbol: 'BTC',  name: 'Bitcoin',         decimals: 8  },
    SPL:  { symbol: 'SPL',  name: 'SPL Token',       decimals: 9  },
  };
  const meta = symbols[address] ?? { symbol: address.slice(0, 6), name: address, decimals: 18 };
  return { address, ...meta };
}

// ─── FizzChainAdapter ─────────────────────────────────────────────────────────

export class FizzChainAdapter implements IChainAdapter {
  private config: ChainConfig;
  private walletAddress: string;
  private _connected = false;

  constructor(config: ChainConfig) {
    this.config = config;
    // Use configured wallet or derive a deterministic FizzChain address
    const cfg: any = config;
    this.walletAddress = cfg.walletAddress || `fizz1${crypto.randomBytes(10).toString('hex')}`;
  }

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
    return this.walletAddress;
  }

  async getBalance(tokenAddress?: string): Promise<string> {
    const token = tokenAddress || 'FIZZ';
    if (token === 'FIZZ') {
      return fizzChainState.getBalance(this.walletAddress).toString();
    }
    // Non-FIZZ tokens are keyed as `TOKEN:address`
    const key = `${token}:${this.walletAddress}`;
    return (fizzChainState.balances.get(key) ?? 0n).toString();
  }

  // ─── DEX operations ─────────────────────────────────────────────────────────

  async getSwapQuote(
    inputToken: string,
    outputToken: string,
    amount: string
  ): Promise<SwapQuote> {
    const { amountOut, priceImpact, fee } = fizzChainState.getSwapQuote(
      inputToken,
      outputToken,
      amount
    );

    return {
      inputToken: tokenInfo(inputToken),
      outputToken: tokenInfo(outputToken),
      inputAmount: amount,
      outputAmount: amountOut.toString(),
      priceImpact,
      fee: fee.toString(),
      route: [FIZZ_CHAIN_ID],
      estimatedGas: '0',
    };
  }

  async executeSwap(
    inputToken: string,
    outputToken: string,
    amount: string,
    minOutputAmount: string,
    _slippage: number
  ): Promise<TransactionResult> {
    try {
      const { amountOut, txId } = fizzChainState.swap(
        this.walletAddress,
        inputToken,
        outputToken,
        amount,
        minOutputAmount
      );
      return {
        hash: txId,
        success: true,
        meta: { amountOut: amountOut.toString(), chain: FIZZ_CHAIN_ID },
      };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  async addLiquidity(
    tokenA: string,
    tokenB: string,
    amountA: string,
    amountB: string
  ): Promise<TransactionResult> {
    try {
      const { shares, txId } = fizzChainState.addLiquidity(
        this.walletAddress,
        tokenA,
        tokenB,
        amountA,
        amountB
      );
      return {
        hash: txId,
        success: true,
        meta: { shares: shares.toString() },
      };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  async removeLiquidity(
    tokenA: string,
    tokenB: string,
    lpTokenAmount: string
  ): Promise<TransactionResult> {
    try {
      const { amountA, amountB, txId } = fizzChainState.removeLiquidity(
        this.walletAddress,
        tokenA,
        tokenB,
        lpTokenAmount
      );
      return {
        hash: txId,
        success: true,
        meta: {
          amountA: amountA.toString(),
          amountB: amountB.toString(),
        },
      };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  // ─── FizzCaps game (native on FizzChain) ────────────────────────────────────

  async playFizzCaps(number: number): Promise<TransactionResult> {
    const isFizz     = number % 15 === 0;
    const isFizzOnly = number % 3 === 0;
    const isBuzzOnly = number % 5 === 0;

    let reward = 0n;
    let result = '';
    if (isFizz)     { reward = 100n * 10n ** 18n; result = 'FizzBuzz'; }
    else if (isFizzOnly) { reward = 30n  * 10n ** 18n; result = 'Fizz'; }
    else if (isBuzzOnly) { reward = 50n  * 10n ** 18n; result = 'Buzz'; }
    else                 { result = String(number); }

    if (reward > 0n) {
      fizzChainState.bridgeIn(this.walletAddress, 'FIZZ', reward.toString(), 'fizz-caps');
    }

    const txId = fizzChainState.addToMempool({
      type: 'transfer',
      from: 'fizz1treasury',
      to: this.walletAddress,
      amountIn: reward.toString(),
    }).id;

    return {
      hash: txId,
      success: true,
      meta: { number, result, reward: reward.toString() },
    };
  }

  async claimRewards(): Promise<TransactionResult> {
    const balance = fizzChainState.getBalance(this.walletAddress);
    const txId = fizzChainState.transfer('fizz1treasury', this.walletAddress, '0');
    return {
      hash: txId,
      success: true,
      meta: { balance: balance.toString() },
    };
  }

  async getPlayerStats(address: string): Promise<{
    score: number;
    fizzCount: number;
    buzzCount: number;
    fizzBuzzCount: number;
    rewardBalance: string;
  }> {
    const balance = fizzChainState.getBalance(address);
    return {
      score: Number(balance / (10n ** 18n)),
      fizzCount: 0,
      buzzCount: 0,
      fizzBuzzCount: 0,
      rewardBalance: balance.toString(),
    };
  }

  // ─── Cross-chain bridge ──────────────────────────────────────────────────────

  /**
   * Initiate a bridge-out from FizzChain to a target chain.
   * Locks `amount` of `token` in FizzChain state and emits bridge metadata
   * for the relayer worker to create the corresponding HTLC on the target chain.
   */
  async initiateBridge(
    targetChain: string,
    token: string,
    amount: string,
    recipientAddress: string
  ): Promise<TransactionResult> {
    try {
      const txId = fizzChainState.bridgeOut(
        this.walletAddress,
        token,
        amount,
        targetChain
      );

      const secret = crypto.randomBytes(32);
      const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
      const timelock = Math.floor(Date.now() / 1000) + 7200;

      // IMPORTANT: plaintext secret not returned — relayer worker handles handshake
      return {
        hash: txId,
        success: true,
        meta: { secretHash, timelock, targetChain, token, amount, recipient: recipientAddress },
      };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  /**
   * Complete a bridge-in from an external chain to FizzChain.
   * `bridgeId` = `sourceChain:token:amount:recipient`
   * `proof`    = the revealed HTLC secret (hex).
   */
  async completeBridge(bridgeId: string, proof: string): Promise<TransactionResult> {
    try {
      const parts = bridgeId.split(':');
      if (parts.length < 4) {
        throw new Error('bridgeId must be "sourceChain:token:amount:recipient"');
      }
      const [sourceChain, token, amount, recipient] = parts;
      const txId = fizzChainState.bridgeIn(recipient, token, amount, sourceChain);
      return { hash: txId, success: true };
    } catch (err: any) {
      return { hash: '', success: false, error: err?.message || String(err) };
    }
  }

  // ─── Crypto utilities ────────────────────────────────────────────────────────

  async signMessage(message: string): Promise<string> {
    // FizzChain uses SHA-256 message signing (simplified; production would use ed25519)
    return crypto.createHash('sha256').update(this.walletAddress + ':' + message).digest('hex');
  }

  async verifySignature(message: string, signature: string, address: string): Promise<boolean> {
    const expected = crypto.createHash('sha256').update(address + ':' + message).digest('hex');
    return expected === signature;
  }

  // ─── Mining (convenience method) ─────────────────────────────────────────────

  /**
   * Mine the next FizzChain block.
   * Runs the PoW search in-process (synchronous, may take a few seconds at difficulty 4).
   * Returns the newly finalized block, or an error result if mining timed out.
   */
  async mineBlock(): Promise<TransactionResult> {
    const tip = fizzChainState.latestBlock;
    const txStrings = fizzChainState.mempool.map(t => JSON.stringify(t));
    const merkleRoot = (await import('../fizz-chain/pow')).computeMerkleRoot(txStrings);

    const candidate = {
      height: fizzChainState.height + 1,
      parentHash: tip.hash,
      merkleRoot,
      timestamp: Date.now(),
      difficulty: fizzChainState.currentDifficulty,
      miner: this.walletAddress,
    };

    const mined = mine(candidate);
    if (!mined) {
      return {
        hash: '',
        success: false,
        error: `Mining failed: difficulty ${candidate.difficulty} not solved within ${CONSENSUS_PARAMS.maxNonce} nonces`,
      };
    }

    // Capture mempool size before submitPoW drains it
    const pendingTxCount = fizzChainState.mempool.length;
    const block = fizzChainState.submitPoW(mined);
    return {
      hash: block.hash,
      success: true,
      meta: {
        height: block.height,
        nonce: block.nonce,
        posSignatures: block.posSignatures,
        txCount: Math.min(pendingTxCount, 50), // submitPoW includes up to 50 txs
        minedAt: block.minedAt,
      },
    };
  }
}
