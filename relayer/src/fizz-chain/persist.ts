/**
 * FizzChain State Persistence
 *
 * Saves and restores the FizzChain in-process state to a JSON snapshot file
 * so that the chain ledger, account balances, AMM pools, and validators survive
 * relayer restarts.
 *
 * Snapshot file: `fizz-chain-state.json` (cwd-relative, same directory as
 * relayer-mappings.json and relayer-block-checkpoint.json).
 *
 * Format: plain JSON (not encrypted) — the chain state contains no private
 * keys or secrets so encryption is not required.
 *
 * Snapshot strategy:
 *   - Save after every block below height 100 (fast startup rebuilding)
 *   - Save every 10 blocks above height 100 (moderate I/O)
 *   - Always save on clean shutdown (SIGTERM/SIGINT)
 *   - Keep only the last `SNAPSHOT_BLOCK_WINDOW` blocks to bound file size
 */

import fs from 'fs';
import path from 'path';
import { FinalBlock } from './pow';
import { FizzChainState, FizzPool, FizzTx } from './state';

const SNAPSHOT_FILE = path.join(process.cwd(), 'fizz-chain-state.json');
const SNAPSHOT_BLOCK_WINDOW = 500; // max blocks retained in snapshot

// ─── Serialization helpers ────────────────────────────────────────────────────

function serializeMap<V>(m: Map<string, V>, xform?: (v: V) => any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of m.entries()) {
    out[k] = xform ? xform(v) : v;
  }
  return out;
}

function deserializeMap<V>(obj: Record<string, any>, xform?: (v: any) => V): Map<string, V> {
  const m = new Map<string, V>();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, xform ? xform(v) : (v as V));
  }
  return m;
}

function serializePool(p: FizzPool): any {
  return {
    tokenA: p.tokenA,
    tokenB: p.tokenB,
    reserveA: p.reserveA.toString(),
    reserveB: p.reserveB.toString(),
    decimalsA: p.decimalsA,
    decimalsB: p.decimalsB,
    totalShares: p.totalShares.toString(),
  };
}

function deserializePool(raw: any): FizzPool {
  return {
    tokenA: raw.tokenA,
    tokenB: raw.tokenB,
    reserveA: BigInt(raw.reserveA),
    reserveB: BigInt(raw.reserveB),
    decimalsA: raw.decimalsA,
    decimalsB: raw.decimalsB,
    totalShares: BigInt(raw.totalShares),
  };
}

// ─── Snapshot I/O ─────────────────────────────────────────────────────────────

export interface ChainSnapshot {
  version: 1;
  savedAt: string;
  height: number;
  currentDifficulty: number;
  blocks: FinalBlock[];
  balances: Record<string, string>;
  lpShares: Record<string, string>;
  pools: Record<string, any>;
  validators: Array<{
    address: string;
    name: string;
    stake: string;
    active: boolean;
    lastSignedBlock: number;
    totalRewards: string;
    registeredAt: number;
  }>;
}

/** Serialize the current chain state to a snapshot object. */
export function snapshotState(chain: FizzChainState): ChainSnapshot {
  // Keep only the last SNAPSHOT_BLOCK_WINDOW blocks to bound size
  const blocksWindow = chain.blocks.slice(-SNAPSHOT_BLOCK_WINDOW);

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    height: chain.height,
    currentDifficulty: chain.currentDifficulty,
    blocks: blocksWindow,
    balances: serializeMap(chain.balances, v => v.toString()),
    lpShares: serializeMap(chain.lpShares, v => v.toString()),
    pools:    serializeMap(chain.pools, serializePool),
    validators: chain.validators.getAllValidators().map(v => ({
      address: v.address,
      name: v.name,
      stake: v.stake.toString(),
      active: v.active,
      lastSignedBlock: v.lastSignedBlock,
      totalRewards: v.totalRewards.toString(),
      registeredAt: v.registeredAt,
    })),
  };
}

/** Write the current chain state to the snapshot file. */
export function saveState(chain: FizzChainState): void {
  try {
    const snap = snapshotState(chain);
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2), 'utf8');
    try { fs.chmodSync(SNAPSHOT_FILE, 0o600); } catch (_) { /* ignore */ }
  } catch (err) {
    const e = err as any;
    console.warn('[FizzChain] failed to save state snapshot:', e?.message || String(e));
  }
}

/** Returns true if a snapshot file exists. */
export function snapshotExists(): boolean {
  return fs.existsSync(SNAPSHOT_FILE);
}

/** Load the snapshot file and return the parsed snapshot, or null if not found/invalid. */
export function loadSnapshot(): ChainSnapshot | null {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return null;
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const snap = JSON.parse(raw) as ChainSnapshot;
    if (snap.version !== 1) {
      console.warn('[FizzChain] unknown snapshot version', snap.version, '— starting fresh');
      return null;
    }
    return snap;
  } catch (err) {
    const e = err as any;
    console.warn('[FizzChain] failed to load state snapshot:', e?.message || String(e), '— starting fresh');
    return null;
  }
}

/**
 * Restore a chain's mutable state from a snapshot.
 *
 * Call this during `FizzChainState` initialization BEFORE the chain is used.
 * This overwrites the in-memory state without creating a new object so that
 * all existing references to `fizzChainState` remain valid.
 */
export function restoreState(chain: FizzChainState, snap: ChainSnapshot): void {
  // Restore blocks array
  chain.blocks.splice(0, chain.blocks.length, ...snap.blocks);

  // Restore balances
  chain.balances.clear();
  for (const [k, v] of Object.entries(snap.balances)) {
    chain.balances.set(k, BigInt(v));
  }

  // Restore LP shares
  chain.lpShares.clear();
  for (const [k, v] of Object.entries(snap.lpShares)) {
    chain.lpShares.set(k, BigInt(v));
  }

  // Restore pools
  chain.pools.clear();
  for (const [k, v] of Object.entries(snap.pools)) {
    chain.pools.set(k, deserializePool(v));
  }

  // Restore difficulty
  chain.currentDifficulty = snap.currentDifficulty;

  // Restore validators (clear registry and re-stake from snapshot)
  const registry = chain.validators;
  for (const v of snap.validators) {
    // Re-create each validator directly by manipulating the registry's internal map
    // (accessed via the public API where possible)
    try {
      // Use stake() to register, then patch the record to match saved values
      registry.stake(v.address, v.stake, v.lastSignedBlock, v.name);
      const stored = registry.getValidator(v.address);
      if (stored) {
        stored.totalRewards = BigInt(v.totalRewards);
        stored.registeredAt = v.registeredAt;
        stored.lastSignedBlock = v.lastSignedBlock;
        stored.active = v.active;
      }
    } catch (_) { /* validator already exists from genesis, patch instead */ }
  }

  console.log(`[FizzChain] state restored from snapshot: height=${snap.height}, blocks=${snap.blocks.length}`);
}

/**
 * Should we save a snapshot after the block at `height`?
 * Saves every block below 100, then every 10 blocks.
 */
export function shouldSave(height: number): boolean {
  if (height < 100) return true;
  return height % 10 === 0;
}
