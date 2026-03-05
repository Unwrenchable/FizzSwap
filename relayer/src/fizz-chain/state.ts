/**
 * FizzChain State Machine
 *
 * The chain state lives in-process inside the relayer. It maintains:
 *   - A ledger of finalized blocks (FinalBlock[])
 *   - Account balances for the FIZZ native token
 *   - Constant-product AMM pools (all FIZZ-paired)
 *   - A simple mempool for pending transactions
 *   - Validator registry (PoS)
 *   - Current PoW difficulty
 *
 * Block production (hybrid PoW + PoS):
 *   1. A miner submits a valid PoW solution via `submitPoW()`.
 *   2. The chain state selects a PoS validator and records their signature.
 *   3. The block is finalized: balances updated, pools updated, rewards minted.
 *
 * All amounts are bigint (smallest unit, 10^-18 FIZZ) to avoid floating-point rounding.
 */

import * as crypto from 'crypto';
import {
  FIZZ_CHAIN_ID,
  FIZZ_TOKEN,
  CONSENSUS_PARAMS,
  GENESIS_VALIDATORS,
  GENESIS_BALANCES,
  GENESIS_POOLS,
  GENESIS_TIMESTAMP,
  GENESIS_PARENT_HASH,
} from './genesis';
import {
  BlockHeader,
  FinalBlock,
  computeBlockHash,
  computeMerkleRoot,
  meetsTarget,
  adjustDifficulty,
  verifyPoW,
  MinedBlock,
} from './pow';
import { ValidatorRegistry } from './pos';

// Lazy imports to avoid circular dependencies and keep tests isolated
let _events: typeof import('./events') | null = null;
function getEvents() {
  if (!_events) {
    try { _events = require('./events'); } catch (_) { /* test environment */ }
  }
  return _events;
}

// ─── Transaction types ────────────────────────────────────────────────────────

export type TxType = 'transfer' | 'swap' | 'stake' | 'unstake' | 'add_liquidity' | 'remove_liquidity' | 'bridge_in' | 'bridge_out';

export interface FizzTx {
  id: string;
  type: TxType;
  from: string;
  to?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn: string;
  amountOut?: string;
  timestamp: number;
}

// ─── Pool ────────────────────────────────────────────────────────────────────

export interface FizzPool {
  tokenA: string;
  tokenB: string;
  reserveA: bigint;
  reserveB: bigint;
  decimalsA: number;
  decimalsB: number;
  /** Total liquidity-provider shares (smallest unit). */
  totalShares: bigint;
}

// ─── ChainState ───────────────────────────────────────────────────────────────

export class FizzChainState {
  /** Finalized block ledger (index 0 = genesis). */
  readonly blocks: FinalBlock[] = [];

  /** Account balances: address → FIZZ in smallest unit. */
  readonly balances: Map<string, bigint> = new Map();

  /** LP shares: `${tokenA}:${tokenB}:${address}` → shares. */
  readonly lpShares: Map<string, bigint> = new Map();

  /** AMM pools keyed by canonical pair key. */
  readonly pools: Map<string, FizzPool> = new Map();

  /** Pending transactions not yet included in a block. */
  readonly mempool: FizzTx[] = [];

  /** PoS validator registry. */
  readonly validators: ValidatorRegistry;

  /** Current PoW difficulty (leading zero hex digits). */
  currentDifficulty: number;

  /** Whether the genesis block has been produced. */
  private initialized = false;

  constructor() {
    this.validators = new ValidatorRegistry(CONSENSUS_PARAMS.posMinStake);
    this.currentDifficulty = CONSENSUS_PARAMS.powDifficulty;
    this._applyGenesis();
  }

  // ─── Genesis ──────────────────────────────────────────────────────────────

  private _applyGenesis(): void {
    // 1. Seed balances
    for (const [addr, amount] of Object.entries(GENESIS_BALANCES)) {
      this.balances.set(addr, BigInt(amount));
    }

    // 2. Seed validators (they also have balances already set above)
    for (const gv of GENESIS_VALIDATORS) {
      this.validators.stake(gv.address, gv.stake, 0, gv.name);
    }

    // 3. Seed pools
    for (const gp of GENESIS_POOLS) {
      const key = this._poolKey(gp.tokenA, gp.tokenB);
      this.pools.set(key, {
        tokenA: gp.tokenA,
        tokenB: gp.tokenB,
        reserveA: BigInt(gp.reserveA),
        reserveB: BigInt(gp.reserveB),
        decimalsA: gp.decimalsA,
        decimalsB: gp.decimalsB,
        totalShares: BigInt(gp.reserveA), // initial shares = reserveA units
      });
    }

    // 4. Produce the genesis block (no PoW required at height 0)
    const genesisBlock: FinalBlock = {
      height: 0,
      parentHash: GENESIS_PARENT_HASH,
      merkleRoot: '0'.repeat(64),
      timestamp: GENESIS_TIMESTAMP,
      difficulty: 0,
      nonce: 0,
      miner: 'fizz1genesis',
      hash: '0'.repeat(64),
      posSignatures: ['fizz1validator1'],
      minedAt: new Date(GENESIS_TIMESTAMP).toISOString(),
    };
    this.blocks.push(genesisBlock);
    this.initialized = true;
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  get latestBlock(): FinalBlock {
    return this.blocks[this.blocks.length - 1];
  }

  get height(): number {
    return this.blocks.length - 1;
  }

  getBalance(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }

  private _poolKey(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  getPool(tokenA: string, tokenB: string): FizzPool | undefined {
    return this.pools.get(this._poolKey(tokenA, tokenB));
  }

  getPools(): FizzPool[] {
    return Array.from(this.pools.values());
  }

  // ─── Mempool ──────────────────────────────────────────────────────────────

  addToMempool(tx: Omit<FizzTx, 'id' | 'timestamp'>): FizzTx {
    const full: FizzTx = {
      ...tx,
      id: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now(),
    };
    this.mempool.push(full);
    return full;
  }

  // ─── PoW block submission ─────────────────────────────────────────────────

  /**
   * Accept a PoW-solved block from a miner.
   *
   * Validates the block hash, selects a PoS validator to co-sign, includes
   * mempool transactions, updates state, and appends the block to the ledger.
   *
   * @param mined  The MinedBlock produced by the miner (via `mine()` in pow.ts).
   * @returns The finalized block, or throws on validation failure.
   */
  submitPoW(mined: MinedBlock): FinalBlock {
    // 1. Validate PoW
    if (!verifyPoW(mined)) {
      throw new Error(`Invalid PoW: hash ${mined.hash} does not meet difficulty ${mined.difficulty}`);
    }
    if (mined.parentHash !== this.latestBlock.hash) {
      throw new Error(`Stale block: parentHash ${mined.parentHash} does not match tip ${this.latestBlock.hash}`);
    }
    if (mined.height !== this.height + 1) {
      throw new Error(`Wrong height: expected ${this.height + 1}, got ${mined.height}`);
    }

    // 2. Select PoS validator
    const validator = this.validators.selectValidator(mined.height);
    const posSignatures = validator ? [validator.address] : ['fizz1genesis'];

    // 3. Collect transactions from mempool
    const includedTxs = this.mempool.splice(0, 50); // include up to 50 tx per block

    // 4. Apply transactions to state
    for (const tx of includedTxs) {
      this._applyTx(tx);
    }

    // 5. Mint PoW mining reward
    this._credit(mined.miner, BigInt(CONSENSUS_PARAMS.powBlockReward));

    // 6. Epoch-end: distribute PoS staking rewards
    if (mined.height > 0 && mined.height % CONSENSUS_PARAMS.epochLength === 0) {
      this._distributeEpochRewards(mined.height);
    }

    // 7. Record validator signature
    if (validator) {
      this.validators.recordSignature(
        validator.address,
        mined.height,
        '0' // reward handled by epoch distribution
      );
    }

    // 8. Adjust difficulty every 10 blocks
    if (mined.height % 10 === 0 && this.blocks.length >= 10) {
      this.currentDifficulty = adjustDifficulty(
        this.currentDifficulty,
        this.blocks.slice(-10)
      );
    }

    // 9. Build merkle root from included transactions
    const merkleRoot = computeMerkleRoot(includedTxs.map(t => JSON.stringify(t)));

    // 10. Finalize block
    const finalBlock: FinalBlock = {
      ...mined,
      merkleRoot,
      posSignatures,
      minedAt: new Date().toISOString(),
    };
    this.blocks.push(finalBlock);

    // Emit real-time block event (non-blocking)
    getEvents()?.fizzEvents.emitBlock({
      block: finalBlock,
      txCount: includedTxs.length,
      miningMs: Date.now() - mined.timestamp,
    });

    return finalBlock;
  }

  // ─── Swap ─────────────────────────────────────────────────────────────────

  /**
   * Execute an AMM swap on FizzChain. Uses the constant-product formula with 0.3% fee.
   *
   * @returns Actual output amount in smallest units.
   */
  swap(
    from: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    minAmountOut: string
  ): { amountOut: bigint; txId: string } {
    const amtIn = BigInt(amountIn);
    if (amtIn <= 0n) throw new Error('amountIn must be positive');

    const pool = this.getPool(tokenIn, tokenOut);
    if (!pool) throw new Error(`No pool for ${tokenIn}/${tokenOut}`);

    const isAtoB = pool.tokenA === tokenIn;
    const reserveIn  = isAtoB ? pool.reserveA : pool.reserveB;
    const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;

    // Constant-product AMM: amountOut = (amtIn * 997 * reserveOut) / (reserveIn * 1000 + amtIn * 997)
    const amtInWithFee = amtIn * 997n;
    const amtOut = (amtInWithFee * reserveOut) / (reserveIn * 1000n + amtInWithFee);

    if (amtOut < BigInt(minAmountOut)) {
      throw new Error(`Slippage exceeded: output ${amtOut} < minimum ${minAmountOut}`);
    }

    // Debit/credit balances
    this._debit(from, tokenIn, amtIn);
    this._creditToken(from, tokenOut, amtOut);

    // Update pool reserves
    if (isAtoB) {
      pool.reserveA += amtIn;
      pool.reserveB -= amtOut;
    } else {
      pool.reserveB += amtIn;
      pool.reserveA -= amtOut;
    }

    const tx = this.addToMempool({
      type: 'swap',
      from,
      tokenIn,
      tokenOut,
      amountIn: amountIn,
      amountOut: amtOut.toString(),
    });

    // Emit real-time swap event
    getEvents()?.fizzEvents.emitSwap({
      from,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amtOut.toString(),
      txId: tx.id,
      timestamp: tx.timestamp,
    });

    return { amountOut: amtOut, txId: tx.id };
  }

  /**
   * Get a swap quote without modifying state.
   */
  getSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): { amountOut: bigint; priceImpact: number; fee: bigint } {
    const amtIn = BigInt(amountIn);
    if (amtIn <= 0n) throw new Error('amountIn must be positive');

    const pool = this.getPool(tokenIn, tokenOut);
    if (!pool) throw new Error(`No pool for ${tokenIn}/${tokenOut}`);

    const isAtoB = pool.tokenA === tokenIn;
    const reserveIn  = isAtoB ? pool.reserveA : pool.reserveB;
    const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;

    const amtInWithFee = amtIn * 997n;
    const amtOut = (amtInWithFee * reserveOut) / (reserveIn * 1000n + amtInWithFee);

    const spotOut = reserveIn > 0n ? (amtIn * reserveOut) / reserveIn : 0n;
    const priceImpact = spotOut > 0n
      ? Math.max(0, Number((spotOut - amtOut) * 10000n / spotOut) / 100)
      : 0;

    return { amountOut: amtOut, priceImpact, fee: amtIn * 3n / 1000n };
  }

  // ─── Liquidity ────────────────────────────────────────────────────────────

  addLiquidity(
    provider: string,
    tokenA: string,
    tokenB: string,
    amountA: string,
    amountB: string
  ): { shares: bigint; txId: string } {
    const amtA = BigInt(amountA);
    const amtB = BigInt(amountB);
    const key = this._poolKey(tokenA, tokenB);
    let pool = this.pools.get(key);

    let shares: bigint;
    if (!pool) {
      // Create new pool
      pool = {
        tokenA,
        tokenB,
        reserveA: 0n,
        reserveB: 0n,
        decimalsA: 18,
        decimalsB: 18,
        totalShares: 0n,
      };
      this.pools.set(key, pool);
      shares = amtA; // initial shares = amountA
    } else {
      // Proportional shares
      shares = pool.totalShares > 0n
        ? (amtA * pool.totalShares) / pool.reserveA
        : amtA;
    }

    this._debit(provider, tokenA, amtA);
    this._debit(provider, tokenB, amtB);

    pool.reserveA += amtA;
    pool.reserveB += amtB;
    pool.totalShares += shares;

    const lpKey = `${key}:${provider}`;
    this.lpShares.set(lpKey, (this.lpShares.get(lpKey) ?? 0n) + shares);

    const tx = this.addToMempool({ type: 'add_liquidity', from: provider, amountIn: amountA });
    return { shares, txId: tx.id };
  }

  removeLiquidity(
    provider: string,
    tokenA: string,
    tokenB: string,
    shares: string
  ): { amountA: bigint; amountB: bigint; txId: string } {
    const sharesBig = BigInt(shares);
    const key = this._poolKey(tokenA, tokenB);
    const pool = this.pools.get(key);
    if (!pool) throw new Error(`No pool ${tokenA}/${tokenB}`);

    const lpKey = `${key}:${provider}`;
    const held = this.lpShares.get(lpKey) ?? 0n;
    if (sharesBig > held) throw new Error('Insufficient LP shares');

    const amountA = (sharesBig * pool.reserveA) / pool.totalShares;
    const amountB = (sharesBig * pool.reserveB) / pool.totalShares;

    pool.reserveA -= amountA;
    pool.reserveB -= amountB;
    pool.totalShares -= sharesBig;
    this.lpShares.set(lpKey, held - sharesBig);

    this._creditToken(provider, tokenA, amountA);
    this._creditToken(provider, tokenB, amountB);

    const tx = this.addToMempool({ type: 'remove_liquidity', from: provider, amountIn: shares });
    return { amountA, amountB, txId: tx.id };
  }

  // ─── Transfer ─────────────────────────────────────────────────────────────

  transfer(from: string, to: string, amount: string): string {
    const amtBig = BigInt(amount);
    this._debit(from, 'FIZZ', amtBig);
    this._credit(to, amtBig);
    const tx = this.addToMempool({ type: 'transfer', from, to, amountIn: amount });
    return tx.id;
  }

  // ─── Staking ──────────────────────────────────────────────────────────────

  stakeForValidator(address: string, amount: string, name = ''): string {
    const amtBig = BigInt(amount);
    this._debit(address, 'FIZZ', amtBig);
    this.validators.stake(address, amount, this.height, name);
    const tx = this.addToMempool({ type: 'stake', from: address, amountIn: amount });
    return tx.id;
  }

  unstakeFromValidator(address: string, amount: string): string {
    this.validators.unstake(address, amount, this.height);
    this._credit(address, BigInt(amount));
    const tx = this.addToMempool({ type: 'unstake', from: address, amountIn: amount });
    return tx.id;
  }

  // ─── Bridge events ────────────────────────────────────────────────────────

  /** Called when tokens arrive from an external chain (HTLC revealed). */
  bridgeIn(to: string, token: string, amount: string, sourceChain: string): string {
    // Mint bridged tokens to recipient's FizzChain balance
    this._creditToken(to, token, BigInt(amount));
    const tx = this.addToMempool({
      type: 'bridge_in',
      from: `bridge:${sourceChain}`,
      to,
      tokenIn: token,
      amountIn: amount,
    });
    getEvents()?.fizzEvents.emitBridge({ direction: 'in', address: to, token, amount, externalChain: sourceChain, txId: tx.id, timestamp: tx.timestamp });
    return tx.id;
  }

  /** Called when tokens leave FizzChain to an external chain (lock for HTLC). */
  bridgeOut(from: string, token: string, amount: string, targetChain: string): string {
    this._debit(from, token, BigInt(amount));
    const tx = this.addToMempool({
      type: 'bridge_out',
      from,
      to: `bridge:${targetChain}`,
      tokenIn: token,
      amountIn: amount,
    });
    getEvents()?.fizzEvents.emitBridge({ direction: 'out', address: from, token, amount, externalChain: targetChain, txId: tx.id, timestamp: tx.timestamp });
    return tx.id;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private _credit(address: string, amount: bigint): void {
    this.balances.set(address, (this.balances.get(address) ?? 0n) + amount);
  }

  private _creditToken(address: string, token: string, amount: bigint): void {
    if (token === 'FIZZ') {
      this._credit(address, amount);
    } else {
      // Non-FIZZ tokens tracked under `${token}:${address}` key (simplified)
      const key = `${token}:${address}`;
      this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
    }
  }

  private _debit(address: string, token: string, amount: bigint): void {
    const balKey = token === 'FIZZ' ? address : `${token}:${address}`;
    const current = this.balances.get(balKey) ?? 0n;
    if (current < amount) throw new Error(`Insufficient ${token} balance for ${address}`);
    this.balances.set(balKey, current - amount);
  }

  private _applyTx(tx: FizzTx): void {
    // Transactions are already applied eagerly (in swap/transfer/etc.) before
    // being put in the mempool. Nothing extra to do here at block time.
    // In a production implementation this would re-validate and apply the
    // state changes that were optimistically applied.
  }

  private _distributeEpochRewards(blockHeight: number): void {
    // Epoch reward pool: proportional to staking reward rate × total staked
    const totalStaked = this.validators.getTotalStaked();
    // APY approximation: (totalStaked × rate × epochLength) / (blocksPerYear × 10000)
    const blocksPerYear = Math.round(365 * 24 * 3600 * 1000 / CONSENSUS_PARAMS.blockTimeMs);
    const epochPool =
      (totalStaked * BigInt(CONSENSUS_PARAMS.stakingRewardBps) * BigInt(CONSENSUS_PARAMS.epochLength)) /
      (BigInt(blocksPerYear) * 10000n);

    const rewards = this.validators.distributeEpochRewards(epochPool.toString());
    for (const [addr, reward] of rewards.entries()) {
      // Rewards are already compounded into stake inside the registry.
      // Also mint to main balance so validators can withdraw.
      this._credit(addr, reward);
    }
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  chainInfo() {
    return {
      chainId: FIZZ_CHAIN_ID,
      chainName: 'FizzChain',
      chainType: 'fizz-hub',
      nativeToken: FIZZ_TOKEN,
      consensus: 'hybrid-pow-pos',
      height: this.height,
      latestBlockHash: this.latestBlock.hash,
      latestBlockTime: this.latestBlock.minedAt,
      currentDifficulty: this.currentDifficulty,
      validators: this.validators.getAllValidators().length,
      activeValidators: this.validators.getActiveValidators().length,
      totalStaked: this.validators.getTotalStaked().toString(),
      poolCount: this.pools.size,
      mempoolSize: this.mempool.length,
      bridgedAssets: ['WETH', 'WSOL', 'WBTC', 'SPL', 'BTC'],
    };
  }
}

/** Singleton chain state shared by all relayer endpoints. */
export const fizzChainState = new FizzChainState();

// Restore state from disk snapshot if one exists (survives relayer restarts).
// We do this lazily after module load so tests can use FizzChainState directly
// without triggering disk I/O.
try {
  const { loadSnapshot, restoreState } = require('./persist');
  const snap = loadSnapshot();
  if (snap) restoreState(fizzChainState, snap);
} catch (_) { /* persist module may not exist in tests */ }
