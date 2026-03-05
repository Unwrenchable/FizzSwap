/**
 * FizzChain Event Bus
 *
 * A typed EventEmitter that broadcasts real-time blockchain events to any
 * listener within the relayer process (SSE endpoint, logging, tests, etc.).
 *
 * Event types:
 *   block   — a new block was finalized (PoW + PoS)
 *   tx      — a transaction was added to the mempool
 *   swap    — an AMM swap was executed on FizzChain
 *   bridge  — a bridge-in or bridge-out event occurred
 *   miner   — auto-miner status messages (started, stopped, error)
 */

import { EventEmitter } from 'events';
import { FinalBlock } from './pow';

// ─── Typed event payloads ─────────────────────────────────────────────────────

export interface BlockEvent {
  block: FinalBlock;
  /** Total transactions included in this block. */
  txCount: number;
  /** Mining duration in milliseconds (0 for genesis). */
  miningMs: number;
}

export interface TxEvent {
  tx: {
    id: string;
    type: string;
    from: string;
    to?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountIn: string;
    amountOut?: string;
    timestamp: number;
  };
}

export interface SwapEvent {
  from: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  txId: string;
  timestamp: number;
}

export interface BridgeEvent {
  direction: 'in' | 'out';
  address: string;
  token: string;
  amount: string;
  externalChain: string;
  txId: string;
  timestamp: number;
}

export interface MinerEvent {
  type: 'started' | 'stopped' | 'mining' | 'found' | 'error' | 'noop';
  message: string;
  height?: number;
  hash?: string;
  nonce?: number;
  miningMs?: number;
  difficulty?: number;
}

// ─── Event name constants (avoids typo-prone string literals) ─────────────────

export const EVENTS = {
  BLOCK:  'block',
  TX:     'tx',
  SWAP:   'swap',
  BRIDGE: 'bridge',
  MINER:  'miner',
} as const;

// ─── FizzChainEvents class ────────────────────────────────────────────────────

class FizzChainEvents extends EventEmitter {
  emitBlock(payload: BlockEvent): void {
    this.emit(EVENTS.BLOCK, payload);
  }

  emitTx(payload: TxEvent): void {
    this.emit(EVENTS.TX, payload);
  }

  emitSwap(payload: SwapEvent): void {
    this.emit(EVENTS.SWAP, payload);
  }

  emitBridge(payload: BridgeEvent): void {
    this.emit(EVENTS.BRIDGE, payload);
  }

  emitMiner(payload: MinerEvent): void {
    this.emit(EVENTS.MINER, payload);
  }
}

/** Singleton event bus — import this everywhere you need to emit or listen. */
export const fizzEvents = new FizzChainEvents();

// Prevent "possible EventEmitter memory leak" warning; we expect many SSE clients
fizzEvents.setMaxListeners(200);
