/**
 * FizzChain State Machine — Integration Tests
 *
 * Covers: genesis initialization, swap, getSwapQuote, addLiquidity,
 *         removeLiquidity, transfer, stake/unstake, bridgeIn/bridgeOut,
 *         submitPoW (block finalization), chainInfo
 */

import { FizzChainState } from '../state';
import { mine } from '../pow';
import {
  CONSENSUS_PARAMS,
  GENESIS_VALIDATORS,
  GENESIS_POOLS,
  FIZZ_CHAIN_ID,
  FIZZ_TOKEN,
} from '../genesis';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fresh isolated chain state for each test (avoids singleton pollution). */
function freshState(): FizzChainState {
  return new FizzChainState();
}

/** Mine one real block on the given state and return it. */
function mineOneBlock(chain: FizzChainState, miner = 'fizz1testminer0000000000000000000000000000000') {
  const tip = chain.latestBlock;
  const mined = mine({
    height:     chain.height + 1,
    parentHash: tip.hash,
    merkleRoot: '0'.repeat(64),
    timestamp:  Date.now(),
    difficulty: 1, // low for test speed
    miner,
  });
  if (!mined) throw new Error('mining failed in test (should not happen at difficulty 1)');
  return chain.submitPoW(mined);
}

// ─── Genesis ─────────────────────────────────────────────────────────────────

describe('FizzChainState — genesis', () => {
  it('starts at height 0', () => {
    const chain = freshState();
    expect(chain.height).toBe(0);
    expect(chain.blocks).toHaveLength(1);
  });

  it('has the correct genesis block fields', () => {
    const chain = freshState();
    const genesis = chain.latestBlock;
    expect(genesis.height).toBe(0);
    expect(genesis.hash).toBe('0'.repeat(64));
    expect(genesis.posSignatures).toContain('fizz1validator1');
  });

  it('seeds all genesis validators', () => {
    const chain = freshState();
    expect(chain.validators.getActiveValidators()).toHaveLength(GENESIS_VALIDATORS.length);
  });

  it('seeds all genesis pools', () => {
    const chain = freshState();
    expect(chain.getPools()).toHaveLength(GENESIS_POOLS.length);
    for (const p of GENESIS_POOLS) {
      const pool = chain.getPool(p.tokenA, p.tokenB);
      expect(pool).toBeDefined();
      expect(pool!.reserveA).toBe(BigInt(p.reserveA));
    }
  });

  it('has treasury balance set', () => {
    const chain = freshState();
    expect(chain.getBalance('fizz1treasury')).toBeGreaterThan(0n);
  });
});

// ─── chainInfo ────────────────────────────────────────────────────────────────

describe('FizzChainState — chainInfo', () => {
  it('returns correct metadata', () => {
    const chain = freshState();
    const info = chain.chainInfo();
    expect(info.chainId).toBe(FIZZ_CHAIN_ID);
    expect(info.chainType).toBe('fizz-hub');
    expect(info.consensus).toBe('hybrid-pow-pos');
    expect(info.height).toBe(0);
    expect(info.nativeToken.symbol).toBe(FIZZ_TOKEN.symbol);
    expect(info.poolCount).toBe(GENESIS_POOLS.length);
  });
});

// ─── getSwapQuote ────────────────────────────────────────────────────────────

describe('FizzChainState — getSwapQuote', () => {
  it('returns positive output for a valid pair', () => {
    const chain = freshState();
    const { amountOut, priceImpact, fee } = chain.getSwapQuote('FIZZ', 'WETH', '1000000000000000000000');
    expect(amountOut).toBeGreaterThan(0n);
    expect(priceImpact).toBeGreaterThanOrEqual(0);
    expect(fee).toBeGreaterThan(0n);
  });

  it('throws for an unknown token pair', () => {
    const chain = freshState();
    expect(() => chain.getSwapQuote('UNKNOWN', 'ALSO_UNKNOWN', '1000')).toThrow();
  });

  it('throws for zero amountIn', () => {
    const chain = freshState();
    expect(() => chain.getSwapQuote('FIZZ', 'WETH', '0')).toThrow();
  });
});

// ─── swap ─────────────────────────────────────────────────────────────────────

describe('FizzChainState — swap', () => {
  it('executes a swap and returns output > 0', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000')); // 1M FIZZ

    const { amountOut, txId } = chain.swap('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '0');
    expect(amountOut).toBeGreaterThan(0n);
    expect(txId).toHaveLength(32);
  });

  it('updates pool reserves correctly', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    const pool = chain.getPool('FIZZ', 'WETH')!;
    const reserveABefore = pool.reserveA;

    chain.swap('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '0');
    expect(pool.reserveA).toBe(reserveABefore + BigInt('1000000000000000000000'));
  });

  it('adds a swap tx to the mempool', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    const before = chain.mempool.length;
    chain.swap('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '0');
    expect(chain.mempool.length).toBe(before + 1);
    expect(chain.mempool[chain.mempool.length - 1].type).toBe('swap');
  });

  it('deducts input from sender balance', () => {
    const chain = freshState();
    const amount = BigInt('1000000000000000000000');
    chain.balances.set('fizz1alice', amount);
    chain.swap('fizz1alice', 'FIZZ', 'WETH', amount.toString(), '0');
    expect(chain.getBalance('fizz1alice')).toBe(0n);
  });

  it('throws when slippage is exceeded', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    // Require an impossibly large minimum output
    expect(() =>
      chain.swap('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '99999999999999999999999999')
    ).toThrow(/slippage/i);
  });

  it('throws for insufficient balance', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', 0n);
    expect(() =>
      chain.swap('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '0')
    ).toThrow(/Insufficient/i);
  });
});

// ─── addLiquidity / removeLiquidity ───────────────────────────────────────────

describe('FizzChainState — liquidity', () => {
  it('addLiquidity creates a new pool and issues shares', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    chain.balances.set('NEWTOKEN:fizz1alice', BigInt('1000000000000000000000000'));

    const { shares } = chain.addLiquidity('fizz1alice', 'FIZZ', 'NEWTOKEN', '500000000000000000000', '500000000000000000000');
    expect(shares).toBeGreaterThan(0n);
    expect(chain.getPool('FIZZ', 'NEWTOKEN')).toBeDefined();
  });

  it('addLiquidity records correct tx type in mempool', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    chain.balances.set('WETH:fizz1alice', BigInt('1000000000000000000000'));
    chain.addLiquidity('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '1000000000000000000000');
    const last = chain.mempool[chain.mempool.length - 1];
    expect(last.type).toBe('add_liquidity');
  });

  it('removeLiquidity returns tokens and records correct tx type', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    chain.balances.set('WETH:fizz1alice', BigInt('1000000000000000000000'));
    const { shares } = chain.addLiquidity('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '1000000000000000000');
    chain.removeLiquidity('fizz1alice', 'FIZZ', 'WETH', shares.toString());
    const last = chain.mempool[chain.mempool.length - 1];
    expect(last.type).toBe('remove_liquidity');
  });

  it('removeLiquidity throws for insufficient shares', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', BigInt('1000000000000000000000000'));
    chain.balances.set('WETH:fizz1alice', BigInt('1000000000000000000000'));
    chain.addLiquidity('fizz1alice', 'FIZZ', 'WETH', '1000000000000000000000', '1000000000000000000');
    expect(() => chain.removeLiquidity('fizz1alice', 'FIZZ', 'WETH', '99999999999999999999999999999')).toThrow();
  });
});

// ─── transfer ─────────────────────────────────────────────────────────────────

describe('FizzChainState — transfer', () => {
  it('moves FIZZ from sender to recipient', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', 500n);
    chain.transfer('fizz1alice', 'fizz1bob', '200');
    expect(chain.getBalance('fizz1alice')).toBe(300n);
    expect(chain.getBalance('fizz1bob')).toBe(200n);
  });

  it('throws for insufficient balance', () => {
    const chain = freshState();
    chain.balances.set('fizz1alice', 100n);
    expect(() => chain.transfer('fizz1alice', 'fizz1bob', '200')).toThrow(/Insufficient/i);
  });
});

// ─── staking ──────────────────────────────────────────────────────────────────

describe('FizzChainState — staking', () => {
  it('stakeForValidator registers a new validator', () => {
    const chain = freshState();
    const stake = BigInt(CONSENSUS_PARAMS.posMinStake);
    chain.balances.set('fizz1dave', stake);
    chain.stakeForValidator('fizz1dave', stake.toString(), 'Dave');
    expect(chain.validators.getValidator('fizz1dave')).toBeDefined();
    expect(chain.validators.getValidator('fizz1dave')!.active).toBe(true);
  });

  it('unstakeFromValidator returns FIZZ to balance', () => {
    const chain = freshState();
    const stake = BigInt(CONSENSUS_PARAMS.posMinStake);
    chain.balances.set('fizz1dave', stake * 2n);
    chain.stakeForValidator('fizz1dave', (stake * 2n).toString(), 'Dave');
    chain.unstakeFromValidator('fizz1dave', stake.toString());
    expect(chain.getBalance('fizz1dave')).toBe(stake);
  });
});

// ─── bridge ───────────────────────────────────────────────────────────────────

describe('FizzChainState — bridge', () => {
  it('bridgeIn credits token to recipient', () => {
    const chain = freshState();
    chain.bridgeIn('fizz1alice', 'WETH', '1000', 'evm');
    expect(chain.balances.get('WETH:fizz1alice')).toBe(1000n);
  });

  it('bridgeOut debits token from sender', () => {
    const chain = freshState();
    chain.balances.set('WETH:fizz1alice', 5000n);
    chain.bridgeOut('fizz1alice', 'WETH', '1000', 'evm');
    expect(chain.balances.get('WETH:fizz1alice')).toBe(4000n);
  });

  it('bridgeOut throws for insufficient balance', () => {
    const chain = freshState();
    expect(() => chain.bridgeOut('fizz1alice', 'WETH', '999', 'evm')).toThrow(/Insufficient/i);
  });
});

// ─── submitPoW (block finalization) ───────────────────────────────────────────

describe('FizzChainState — submitPoW', () => {
  it('appends a new block to the ledger', () => {
    const chain = freshState();
    const block = mineOneBlock(chain);
    expect(chain.height).toBe(1);
    expect(chain.blocks).toHaveLength(2);
    expect(block.height).toBe(1);
  });

  it('assigns at least one PoS signature', () => {
    const chain = freshState();
    const block = mineOneBlock(chain);
    expect(block.posSignatures.length).toBeGreaterThanOrEqual(1);
  });

  it('mints the PoW block reward to the miner', () => {
    const chain = freshState();
    const miner = 'fizz1testminer0000000000000000000000000000000';
    const before = chain.getBalance(miner);
    mineOneBlock(chain, miner);
    const after = chain.getBalance(miner);
    expect(after - before).toBe(BigInt(CONSENSUS_PARAMS.powBlockReward));
  });

  it('includes mempool transactions in the block', () => {
    const chain = freshState();
    // Add a tx to the mempool by doing a transfer
    chain.balances.set('fizz1alice', 1000n);
    chain.transfer('fizz1alice', 'fizz1bob', '500');
    expect(chain.mempool.length).toBeGreaterThan(0);
    mineOneBlock(chain);
    // mempool should be drained (up to 50 txs included)
    expect(chain.mempool.length).toBe(0);
  });

  it('rejects a block with wrong parentHash', () => {
    const chain = freshState();
    const tip = chain.latestBlock;
    const mined = mine({
      height:     1,
      parentHash: '1'.repeat(64), // wrong
      merkleRoot: '0'.repeat(64),
      timestamp:  Date.now(),
      difficulty: 1,
      miner:      'fizz1testminer',
    });
    if (!mined) return; // might not find at diff 1 — skip
    expect(() => chain.submitPoW(mined)).toThrow(/Stale block/i);
  });

  it('rejects a block with incorrect PoW hash (tampered)', () => {
    const chain = freshState();
    const tip = chain.latestBlock;
    const mined = mine({ height: 1, parentHash: tip.hash, merkleRoot: '0'.repeat(64), timestamp: Date.now(), difficulty: 1, miner: 'fizz1testminer' });
    if (!mined) return;
    const tampered = { ...mined, hash: 'ff' + mined.hash.slice(2) };
    expect(() => chain.submitPoW(tampered)).toThrow(/Invalid PoW/i);
  });

  it('advances chain height with each block', () => {
    const chain = freshState();
    for (let i = 1; i <= 3; i++) {
      mineOneBlock(chain);
      expect(chain.height).toBe(i);
    }
  });
});
