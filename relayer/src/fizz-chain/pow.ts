/**
 * FizzChain Proof-of-Work Engine
 *
 * Miners hash candidate block headers using SHA-256.
 * A block is valid when its hash has at least `difficulty` leading zero hex digits.
 *
 * Difficulty 4 → hash must start with "0000" (1/65536 chance per attempt).
 *
 * This is a simplified but structurally correct PoW implementation suitable for
 * an in-process simulated chain. A production deployment would move mining to
 * dedicated hardware or GPU workers communicating via the /fizz-chain/mine endpoint.
 */

import * as crypto from 'crypto';
import { CONSENSUS_PARAMS } from './genesis';

// ─── Block structures ────────────────────────────────────────────────────────

export interface BlockHeader {
  /** Chain height (0 = genesis). */
  height: number;
  /** Hex hash of the previous block. */
  parentHash: string;
  /** Hex SHA-256 of the serialized transaction list. */
  merkleRoot: string;
  /** Unix milliseconds when mining started. */
  timestamp: number;
  /** Number of leading zero hex digits required in the block hash. */
  difficulty: number;
  /** Arbitrary integer varied until the difficulty target is met. */
  nonce: number;
  /** FizzChain address of the miner claiming the PoW reward. */
  miner: string;
}

export interface MinedBlock extends BlockHeader {
  /** Hex SHA-256 hash of this block header. Meets the difficulty target. */
  hash: string;
}

export interface FinalBlock extends MinedBlock {
  /** FizzChain addresses of the PoS validators who signed this block. */
  posSignatures: string[];
  /** ISO-8601 timestamp for human readability. */
  minedAt: string;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** Deterministically hash a block header to a 64-char hex string. */
export function computeBlockHash(header: BlockHeader): string {
  const serialized = [
    header.height,
    header.parentHash,
    header.merkleRoot,
    header.timestamp,
    header.difficulty,
    header.nonce,
    header.miner,
  ].join('|');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/** Returns true when `hash` has at least `difficulty` leading zero hex chars. */
export function meetsTarget(hash: string, difficulty: number): boolean {
  return hash.startsWith('0'.repeat(difficulty));
}

/** Compute the SHA-256 merkle root of a list of serialized transactions. */
export function computeMerkleRoot(transactions: string[]): string {
  if (transactions.length === 0) return '0'.repeat(64);
  let hashes = transactions.map(tx =>
    crypto.createHash('sha256').update(tx).digest('hex')
  );
  while (hashes.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] ?? hashes[i]; // duplicate last if odd
      next.push(crypto.createHash('sha256').update(left + right).digest('hex'));
    }
    hashes = next;
  }
  return hashes[0];
}

// ─── Mining ──────────────────────────────────────────────────────────────────

/**
 * Attempt to mine a block by iterating nonces until the difficulty target is met.
 *
 * @param header  All fields of the block header except `nonce`.
 * @param startNonce  Nonce to start from (allows workers to start at different offsets).
 * @param maxNonce    Maximum nonces to try before returning null.
 * @returns The mined block (with hash), or null if `maxNonce` was exhausted.
 */
export function mine(
  header: Omit<BlockHeader, 'nonce'>,
  startNonce = 0,
  maxNonce: number = CONSENSUS_PARAMS.maxNonce
): MinedBlock | null {
  for (let nonce = startNonce; nonce <= startNonce + maxNonce; nonce++) {
    const candidate: BlockHeader = { ...header, nonce };
    const hash = computeBlockHash(candidate);
    if (meetsTarget(hash, header.difficulty)) {
      return { ...candidate, hash };
    }
  }
  return null;
}

/**
 * Verify that a submitted block header meets the difficulty target.
 * Used by the /fizz-chain/mine endpoint to validate externally-mined blocks.
 */
export function verifyPoW(block: MinedBlock): boolean {
  const expected = computeBlockHash(block);
  return expected === block.hash && meetsTarget(block.hash, block.difficulty);
}

// ─── Difficulty adjustment ───────────────────────────────────────────────────

/**
 * Retarget difficulty every `windowSize` blocks based on actual vs target block time.
 * Clamps to [1, 8] leading zero nibbles to keep blocks findable in-process.
 */
export function adjustDifficulty(
  currentDifficulty: number,
  recentBlocks: Pick<FinalBlock, 'timestamp'>[],
  windowSize = 10
): number {
  if (recentBlocks.length < windowSize) return currentDifficulty;

  const window = recentBlocks.slice(-windowSize);
  const elapsed = window[window.length - 1].timestamp - window[0].timestamp;
  const actualAvgMs = elapsed / (windowSize - 1);
  const target = CONSENSUS_PARAMS.blockTimeMs;

  // If blocks are coming in twice as fast as target → increase difficulty
  // If blocks are coming in twice as slow as target → decrease difficulty
  if (actualAvgMs < target / 2 && currentDifficulty < 8) return currentDifficulty + 1;
  if (actualAvgMs > target * 2 && currentDifficulty > 1) return currentDifficulty - 1;
  return currentDifficulty;
}
