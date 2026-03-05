/**
 * FizzChain Proof-of-Stake Validator Registry
 *
 * Validators lock (stake) FIZZ tokens to join the PoS committee.
 * After a valid PoW block is found, the chain selects a validator weighted by
 * their staked amount to sign (finalize) the block. Validators earn staking
 * rewards at the end of each epoch.
 *
 * Weighted selection is deterministic given the block height so that any
 * observer can verify who should have signed a given block.
 */

import { CONSENSUS_PARAMS } from './genesis';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Validator {
  address: string;
  /** Display name (optional). */
  name: string;
  /** Total FIZZ staked in smallest unit (10^-18 FIZZ). */
  stake: bigint;
  /** True when stake ≥ CONSENSUS_PARAMS.posMinStake. */
  active: boolean;
  /** Block height at which this validator last signed. */
  lastSignedBlock: number;
  /** Cumulative rewards earned (in smallest FIZZ unit). */
  totalRewards: bigint;
  /** Unix-ms timestamp of when the validator registered. */
  registeredAt: number;
}

export interface StakeEvent {
  validator: string;
  amount: bigint;
  type: 'stake' | 'unstake';
  blockHeight: number;
  timestamp: number;
}

// ─── ValidatorRegistry ────────────────────────────────────────────────────────

export class ValidatorRegistry {
  private validators: Map<string, Validator> = new Map();
  private history: StakeEvent[] = [];
  private readonly minStake: bigint;

  constructor(minStake: string = CONSENSUS_PARAMS.posMinStake) {
    this.minStake = BigInt(minStake);
  }

  // ── Staking ──

  /**
   * Stake FIZZ to become / increase stake as a validator.
   * The staker's FIZZ is deducted from their account balance by the chain state;
   * this registry only tracks the staked amounts.
   */
  stake(address: string, amount: string, blockHeight = 0, name = ''): void {
    const amountBig = BigInt(amount);
    if (amountBig <= 0n) throw new Error('Stake amount must be positive');

    const existing = this.validators.get(address);
    if (existing) {
      existing.stake += amountBig;
      existing.active = existing.stake >= this.minStake;
    } else {
      this.validators.set(address, {
        address,
        name: name || address,
        stake: amountBig,
        active: amountBig >= this.minStake,
        lastSignedBlock: 0,
        totalRewards: 0n,
        registeredAt: Date.now(),
      });
    }

    this.history.push({
      validator: address,
      amount: amountBig,
      type: 'stake',
      blockHeight,
      timestamp: Date.now(),
    });
  }

  /**
   * Unstake FIZZ. The FIZZ is returned to the validator's account balance
   * by the chain state; this registry reduces the recorded stake.
   */
  unstake(address: string, amount: string, blockHeight = 0): void {
    const v = this.validators.get(address);
    if (!v) throw new Error(`Validator ${address} not found`);
    const amountBig = BigInt(amount);
    if (amountBig > v.stake) throw new Error('Cannot unstake more than current stake');

    v.stake -= amountBig;
    v.active = v.stake >= this.minStake;

    this.history.push({
      validator: address,
      amount: amountBig,
      type: 'unstake',
      blockHeight,
      timestamp: Date.now(),
    });
  }

  // ── Selection ──

  /**
   * Select the validator that should sign block `blockHeight`.
   *
   * Uses deterministic weighted random selection so that:
   * 1. Higher stake → higher probability of being selected.
   * 2. The same block height always maps to the same validator (verifiable).
   *
   * @returns The selected validator, or null if no active validators exist.
   */
  selectValidator(blockHeight: number): Validator | null {
    const active = Array.from(this.validators.values()).filter(v => v.active);
    if (active.length === 0) return null;

    const totalStake = active.reduce((sum, v) => sum + v.stake, 0n);
    if (totalStake === 0n) return null;

    // Deterministic seed derived from block height (no external randomness needed)
    let cursor = BigInt(blockHeight) * 1_000_000_007n % totalStake;

    for (const v of active) {
      if (cursor < v.stake) return v;
      cursor -= v.stake;
    }
    return active[active.length - 1];
  }

  /**
   * Record that a validator signed block `blockHeight` and award the epoch reward.
   */
  recordSignature(address: string, blockHeight: number, reward: string): void {
    const v = this.validators.get(address);
    if (!v) return;
    v.lastSignedBlock = blockHeight;
    v.totalRewards += BigInt(reward);
  }

  // ── Epoch rewards ──

  /**
   * Distribute staking rewards at the end of an epoch.
   *
   * Reward per validator = (stake / totalStake) × epochRewardPool.
   * Uses bigint arithmetic throughout to avoid floating-point rounding.
   *
   * @param epochRewardPool  Total FIZZ reward for this epoch (smallest unit).
   * @returns Map of address → reward amount earned.
   */
  distributeEpochRewards(epochRewardPool: string): Map<string, bigint> {
    const pool = BigInt(epochRewardPool);
    const active = Array.from(this.validators.values()).filter(v => v.active);
    const totalStake = active.reduce((sum, v) => sum + v.stake, 0n);
    const rewards = new Map<string, bigint>();

    if (totalStake === 0n) return rewards;

    for (const v of active) {
      const reward = (v.stake * pool) / totalStake;
      v.totalRewards += reward;
      v.stake += reward; // auto-compound: rewards increase stake
      rewards.set(v.address, reward);
    }
    return rewards;
  }

  // ── Queries ──

  getValidator(address: string): Validator | undefined {
    return this.validators.get(address);
  }

  getActiveValidators(): Validator[] {
    return Array.from(this.validators.values()).filter(v => v.active);
  }

  getAllValidators(): Validator[] {
    return Array.from(this.validators.values());
  }

  getTotalStaked(): bigint {
    return Array.from(this.validators.values()).reduce((s, v) => s + v.stake, 0n);
  }

  getStakeHistory(): StakeEvent[] {
    return [...this.history];
  }

  toJSON() {
    return {
      validators: Array.from(this.validators.values()).map(v => ({
        ...v,
        stake: v.stake.toString(),
        totalRewards: v.totalRewards.toString(),
      })),
      totalStaked: this.getTotalStaked().toString(),
      activeCount: this.getActiveValidators().length,
      minStake: this.minStake.toString(),
    };
  }
}
