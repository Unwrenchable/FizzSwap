/**
 * FizzChain Auto-Miner
 *
 * Runs a continuous background loop that produces new blocks at the target
 * block time using the hybrid PoW + PoS consensus model.
 *
 * Environment variables:
 *   FIZZ_CHAIN_AUTO_MINE=true|false   Enable/disable auto-mining (default: true)
 *   FIZZ_CHAIN_MINER_ADDRESS=fizz1... FizzChain address that receives block rewards
 *   FIZZ_CHAIN_MINE_DIFFICULTY=N      Override difficulty for testing (default: genesis value)
 *   FIZZ_CHAIN_BLOCK_TIME_MS=N        Override block time ms (default: 6000)
 *
 * How it works:
 *   1. Every `blockTimeMs` the miner wakes up.
 *   2. It snapshots the current mempool and tip.
 *   3. It calls `mine()` — a synchronous nonce search.
 *   4. If a solution is found within `maxNonce` attempts it calls `submitPoW()`.
 *   5. If not (chain is very busy / difficulty too high), it logs and tries again next tick.
 *   6. After each successful block it triggers state persistence.
 *
 * The miner runs in the main Node.js event loop using setInterval so it never
 * blocks the Express HTTP server (mining is fast at difficulty ≤ 5 on modern HW).
 */

import { mine, computeMerkleRoot } from './pow';
import { fizzChainState } from './state';
import { fizzEvents, EVENTS } from './events';
import { saveState, shouldSave } from './persist';
import { CONSENSUS_PARAMS } from './genesis';

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTO_MINE   = (process.env.FIZZ_CHAIN_AUTO_MINE ?? 'true') === 'true';
const MINER_ADDR  = process.env.FIZZ_CHAIN_MINER_ADDRESS
  || 'fizz1autominer000000000000000000000000000000';
const BLOCK_MS    = Number(process.env.FIZZ_CHAIN_BLOCK_TIME_MS   || CONSENSUS_PARAMS.blockTimeMs);
const DIFF_OVERRIDE = process.env.FIZZ_CHAIN_MINE_DIFFICULTY
  ? Number(process.env.FIZZ_CHAIN_MINE_DIFFICULTY)
  : undefined;

// ─── Miner state ─────────────────────────────────────────────────────────────

let _timerId: ReturnType<typeof setInterval> | null = null;
let _running = false;

// ─── Core mining tick ─────────────────────────────────────────────────────────

function mineTick(): void {
  if (_running) return; // previous tick still running, skip
  _running = true;
  const tickStart = Date.now();

  try {
    const tip = fizzChainState.latestBlock;
    const difficulty = DIFF_OVERRIDE ?? fizzChainState.currentDifficulty;

    // Build candidate header
    const txStrings = fizzChainState.mempool.map(t => JSON.stringify(t));
    const merkleRoot = computeMerkleRoot(txStrings);
    const candidate = {
      height:     fizzChainState.height + 1,
      parentHash: tip.hash,
      merkleRoot,
      timestamp:  Date.now(),
      difficulty,
      miner:      MINER_ADDR,
    };

    fizzEvents.emitMiner({
      type:       'mining',
      message:    `Mining block ${candidate.height} at difficulty ${difficulty}`,
      height:     candidate.height,
      difficulty,
    });

    // PoW search (synchronous — fast at difficulty ≤ 5 on modern hardware)
    const mined = mine(candidate);

    if (!mined) {
      fizzEvents.emitMiner({
        type:    'noop',
        message: `Block ${candidate.height} not solved within ${CONSENSUS_PARAMS.maxNonce} nonces — will retry`,
        height:  candidate.height,
        difficulty,
      });
      return;
    }

    const miningMs = Date.now() - tickStart;

    // Finalize block (PoS co-signing + reward distribution)
    const pendingTxCount = fizzChainState.mempool.length;
    const block = fizzChainState.submitPoW(mined);

    fizzEvents.emitBlock({
      block,
      txCount:   Math.min(pendingTxCount, 50),
      miningMs,
    });

    fizzEvents.emitMiner({
      type:     'found',
      message:  `Block ${block.height} mined in ${miningMs}ms (nonce=${mined.nonce}, hash=${block.hash.slice(0, 12)}...)`,
      height:   block.height,
      hash:     block.hash,
      nonce:    mined.nonce,
      miningMs,
      difficulty,
    });

    // Persist state
    if (shouldSave(block.height)) {
      saveState(fizzChainState);
    }

  } catch (err) {
    const e = err as any;
    fizzEvents.emitMiner({
      type:    'error',
      message: `Mining error: ${e?.message || String(e)}`,
    });
    console.error('[FizzChain Miner] error:', e?.message || String(e));
  } finally {
    _running = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the auto-mining loop.
 * Respects the `FIZZ_CHAIN_AUTO_MINE` env var; does nothing if disabled.
 */
export function startAutoMiner(): void {
  if (!AUTO_MINE) {
    console.log('[FizzChain Miner] auto-mining disabled (FIZZ_CHAIN_AUTO_MINE=false)');
    return;
  }
  if (_timerId !== null) {
    console.log('[FizzChain Miner] already running');
    return;
  }

  _timerId = setInterval(mineTick, BLOCK_MS);
  fizzEvents.emitMiner({
    type:    'started',
    message: `Auto-miner started: miner=${MINER_ADDR}, blockTimeMs=${BLOCK_MS}, difficulty=${DIFF_OVERRIDE ?? 'auto'}`,
  });
  console.log(`[FizzChain Miner] started — interval=${BLOCK_MS}ms, miner=${MINER_ADDR}`);
}

/**
 * Stop the auto-mining loop.
 */
export function stopAutoMiner(): void {
  if (_timerId !== null) {
    clearInterval(_timerId);
    _timerId = null;
    fizzEvents.emitMiner({ type: 'stopped', message: 'Auto-miner stopped' });
    console.log('[FizzChain Miner] stopped');
  }
}

/** Returns true if the auto-miner is currently running. */
export function isMinerRunning(): boolean {
  return _timerId !== null;
}

/** Returns current miner configuration. */
export function getMinerConfig() {
  return {
    enabled:   AUTO_MINE,
    running:   isMinerRunning(),
    address:   MINER_ADDR,
    blockTimeMs: BLOCK_MS,
    difficulty: DIFF_OVERRIDE ?? 'auto (from chain state)',
  };
}
