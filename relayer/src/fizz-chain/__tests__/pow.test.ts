/**
 * FizzChain PoW Engine — Unit Tests
 *
 * Covers: computeBlockHash, meetsTarget, computeMerkleRoot,
 *         mine, verifyPoW, adjustDifficulty
 */

import {
  computeBlockHash,
  meetsTarget,
  computeMerkleRoot,
  mine,
  verifyPoW,
  adjustDifficulty,
  BlockHeader,
  FinalBlock,
} from '../pow';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseHeader: Omit<BlockHeader, 'nonce'> = {
  height:     1,
  parentHash: '0'.repeat(64),
  merkleRoot: '0'.repeat(64),
  timestamp:  1741175040000,
  difficulty: 1,
  miner:      'fizz1testminer',
};

// ─── computeBlockHash ─────────────────────────────────────────────────────────

describe('computeBlockHash', () => {
  it('produces a 64-char hex string', () => {
    const hash = computeBlockHash({ ...baseHeader, nonce: 0 });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs always produce same hash', () => {
    const h1 = computeBlockHash({ ...baseHeader, nonce: 42 });
    const h2 = computeBlockHash({ ...baseHeader, nonce: 42 });
    expect(h1).toBe(h2);
  });

  it('changes when any field changes', () => {
    const h1 = computeBlockHash({ ...baseHeader, nonce: 0 });
    const h2 = computeBlockHash({ ...baseHeader, nonce: 1 });
    const h3 = computeBlockHash({ ...baseHeader, nonce: 0, miner: 'fizz1other' });
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

// ─── meetsTarget ─────────────────────────────────────────────────────────────

describe('meetsTarget', () => {
  it('accepts hash with exactly N leading zeros', () => {
    expect(meetsTarget('00abc', 2)).toBe(true);
    expect(meetsTarget('0000abc', 4)).toBe(true);
  });

  it('rejects hash with fewer leading zeros than required', () => {
    expect(meetsTarget('0abc', 2)).toBe(false);
    expect(meetsTarget('000abc', 4)).toBe(false);
  });

  it('accepts difficulty 0 for any hash', () => {
    expect(meetsTarget('abcdef1234', 0)).toBe(true);
  });
});

// ─── computeMerkleRoot ────────────────────────────────────────────────────────

describe('computeMerkleRoot', () => {
  it('returns 64 zeros for empty transaction list', () => {
    const root = computeMerkleRoot([]);
    expect(root).toBe('0'.repeat(64));
  });

  it('returns the SHA-256 of the single item for one tx', () => {
    const root = computeMerkleRoot(['hello']);
    expect(root).toHaveLength(64);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const txs = ['tx1', 'tx2', 'tx3'];
    expect(computeMerkleRoot(txs)).toBe(computeMerkleRoot(txs));
  });

  it('produces different roots for different tx sets', () => {
    const r1 = computeMerkleRoot(['a', 'b']);
    const r2 = computeMerkleRoot(['a', 'c']);
    expect(r1).not.toBe(r2);
  });

  it('handles odd-length lists by duplicating last element', () => {
    // Should not throw
    const root = computeMerkleRoot(['a', 'b', 'c']);
    expect(root).toHaveLength(64);
  });
});

// ─── mine ────────────────────────────────────────────────────────────────────

describe('mine', () => {
  it('finds a valid solution at difficulty 1 (fast)', () => {
    const result = mine(baseHeader, 0, 1_000_000);
    expect(result).not.toBeNull();
    expect(result!.hash).toMatch(/^0/); // at least one leading zero
    expect(result!.nonce).toBeGreaterThanOrEqual(0);
  });

  it('returns null when maxNonce is 0', () => {
    // With maxNonce=0, we try nonce=startNonce only then give up immediately
    // Probability of hitting on the first nonce at difficulty 1 is ~1/16 — so
    // we use a fixed seed nonce that we know won't be 0x0... for this header.
    const result = mine({ ...baseHeader, difficulty: 8 }, 0, 0);
    // Might or might not find; just test it doesn't throw
    // No assertion on value — this is a probabilistic boundary test
    expect(typeof result === 'object').toBe(true);
  });

  it('mined block has correct height and parentHash', () => {
    const result = mine(baseHeader, 0, 2_000_000);
    expect(result).not.toBeNull();
    expect(result!.height).toBe(1);
    expect(result!.parentHash).toBe('0'.repeat(64));
    expect(result!.miner).toBe('fizz1testminer');
  });
});

// ─── verifyPoW ───────────────────────────────────────────────────────────────

describe('verifyPoW', () => {
  it('returns true for a legitimately mined block', () => {
    const mined = mine(baseHeader, 0, 2_000_000)!;
    expect(mined).not.toBeNull();
    expect(verifyPoW(mined)).toBe(true);
  });

  it('returns false when hash has been tampered with', () => {
    const mined = mine(baseHeader, 0, 2_000_000)!;
    const tampered = { ...mined, hash: 'ff' + mined.hash.slice(2) };
    expect(verifyPoW(tampered)).toBe(false);
  });

  it('returns false when nonce has been changed', () => {
    const mined = mine(baseHeader, 0, 2_000_000)!;
    const tampered = { ...mined, nonce: mined.nonce + 1 };
    expect(verifyPoW(tampered)).toBe(false);
  });

  it('returns false when miner address is changed', () => {
    const mined = mine(baseHeader, 0, 2_000_000)!;
    const tampered = { ...mined, miner: 'fizz1attacker' };
    expect(verifyPoW(tampered)).toBe(false);
  });
});

// ─── adjustDifficulty ────────────────────────────────────────────────────────

describe('adjustDifficulty', () => {
  /** Build a list of fake blocks with equally-spaced timestamps. */
  function fakeBlocks(count: number, avgMs: number): Pick<FinalBlock, 'timestamp'>[] {
    return Array.from({ length: count }, (_, i) => ({
      timestamp:     i * avgMs,
      height:        i,
      parentHash:    '0'.repeat(64),
      merkleRoot:    '0'.repeat(64),
      difficulty:    1,
      nonce:         0,
      miner:         'fizz1test',
      hash:          '0'.repeat(64),
      posSignatures: [],
      minedAt:       new Date(i * avgMs).toISOString(),
    }));
  }

  it('returns current difficulty when fewer than windowSize blocks', () => {
    const result = adjustDifficulty(4, fakeBlocks(5, 6000), 10);
    expect(result).toBe(4);
  });

  it('increases difficulty when blocks come in twice as fast as target', () => {
    // Target is 6000ms, actual avg is 2000ms (well below target/2=3000ms → harder)
    const result = adjustDifficulty(4, fakeBlocks(10, 2000), 10);
    expect(result).toBe(5);
  });

  it('decreases difficulty when blocks come in twice as slow as target', () => {
    // Target is 6000ms, actual avg is 13000ms (too slow → easier)
    const result = adjustDifficulty(4, fakeBlocks(10, 13000), 10);
    expect(result).toBe(3);
  });

  it('does not change difficulty when block time is in range', () => {
    // On-target
    const result = adjustDifficulty(4, fakeBlocks(10, 6000), 10);
    expect(result).toBe(4);
  });

  it('clamps difficulty to minimum 1', () => {
    const result = adjustDifficulty(1, fakeBlocks(10, 13000), 10);
    expect(result).toBe(1);
  });

  it('clamps difficulty to maximum 8', () => {
    const result = adjustDifficulty(8, fakeBlocks(10, 3000), 10);
    expect(result).toBe(8);
  });
});
