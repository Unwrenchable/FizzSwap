/**
 * FizzChain Genesis — Chain Specification
 *
 * FizzChain is FizzSwap's own hub blockchain that is a multichain in itself:
 * it natively bridges Ethereum/EVM, Solana, and Bitcoin through a single hub
 * using the FIZZ native token as the universal routing asset.
 *
 * Consensus: Hybrid PoW + PoS
 *   - Miners (PoW) produce candidate blocks via SHA-256 hashing.
 *   - Validators (PoS) stake FIZZ and vote to finalize blocks.
 *   - A block is final once it has a valid PoW solution AND ≥1 PoS signature.
 */

export const FIZZ_CHAIN_ID = 'fizz-1';

/** Native currency of FizzChain. */
export const FIZZ_TOKEN = {
  name: 'Fizz',
  symbol: 'FIZZ',
  decimals: 18,
  /** Total supply: 1 billion FIZZ (in smallest unit, 10^18 per FIZZ). */
  totalSupply: '1000000000000000000000000000',
} as const;

/** Consensus parameters for the hybrid PoW + PoS model. */
export const CONSENSUS_PARAMS = {
  /** Number of leading zero hex characters required in a valid block hash (PoW difficulty). */
  powDifficulty: 4,
  /** Minimum FIZZ stake (in smallest unit) to become an active PoS validator. */
  posMinStake: '1000000000000000000000',   // 1,000 FIZZ
  /** Number of blocks per validator epoch (after which rewards are distributed). */
  epochLength: 100,
  /** Target block time in milliseconds. */
  blockTimeMs: 6_000,
  /** PoW block reward in smallest FIZZ units. */
  powBlockReward: '10000000000000000000',  // 10 FIZZ per block
  /** Annual staking reward rate in basis points (500 bps = 5% APY). */
  stakingRewardBps: 500,
  /** Maximum nonce to try before giving up on a PoW search (per call). */
  maxNonce: 2_000_000,
} as const;

/**
 * Cross-chain bridged asset registry.
 * These are the canonical token identifiers on each external chain that
 * map 1-to-1 with FIZZ on FizzChain (wrapped via HTLC or lock-and-mint).
 */
export const BRIDGED_ASSETS: Record<string, { chain: string; address: string; symbol: string }> = {
  WETH:  { chain: 'evm',     address: '0xWETH_PLACEHOLDER',  symbol: 'WETH'  },
  WBTC:  { chain: 'evm',     address: '0xWBTC_PLACEHOLDER',  symbol: 'WBTC'  },
  WSOL:  { chain: 'evm',     address: '0xWSOL_PLACEHOLDER',  symbol: 'WSOL'  },
  SPL:   { chain: 'solana',  address: 'SPL_PLACEHOLDER',     symbol: 'SPL'   },
  BTC:   { chain: 'bitcoin', address: 'BTC',                 symbol: 'BTC'   },
};

/**
 * Genesis validator set.
 * Each validator pre-stakes FIZZ and forms the initial PoS committee.
 */
export const GENESIS_VALIDATORS: Array<{ address: string; stake: string; name: string }> = [
  { address: 'fizz1validator1', stake: '500000000000000000000000',  name: 'Genesis Validator A' },
  { address: 'fizz1validator2', stake: '300000000000000000000000',  name: 'Genesis Validator B' },
  { address: 'fizz1validator3', stake: '200000000000000000000000',  name: 'Genesis Validator C' },
];

/** Genesis account balances (address → FIZZ amount in smallest unit). */
export const GENESIS_BALANCES: Record<string, string> = {
  'fizz1treasury':   '500000000000000000000000000',  // 500M FIZZ — protocol treasury
  'fizz1validator1': '500000000000000000000000',      // validator A seed
  'fizz1validator2': '300000000000000000000000',      // validator B seed
  'fizz1validator3': '200000000000000000000000',      // validator C seed
};

/**
 * Genesis liquidity pools on FizzChain.
 * All pools are FIZZ-paired; FIZZ acts as the universal hub asset.
 * Reserves are in smallest token units (18-decimal for FIZZ, 8 for BTC, etc.).
 */
export const GENESIS_POOLS: Array<{
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  decimalsA: number;
  decimalsB: number;
}> = [
  {
    tokenA: 'FIZZ',
    tokenB: 'WETH',
    reserveA: '1000000000000000000000000',   // 1,000,000 FIZZ
    reserveB:    '500000000000000000000',     //       500 ETH  (1 ETH = 2000 FIZZ)
    decimalsA: 18,
    decimalsB: 18,
  },
  {
    tokenA: 'FIZZ',
    tokenB: 'WSOL',
    reserveA: '1000000000000000000000000',   // 1,000,000 FIZZ
    reserveB:     '10000000000000',          //  10,000,000 SOL lamports (9 dec)
    decimalsA: 18,
    decimalsB: 9,
  },
  {
    tokenA: 'FIZZ',
    tokenB: 'WBTC',
    reserveA: '1000000000000000000000000',   // 1,000,000 FIZZ
    reserveB:        '3000000000',           //        30 BTC  (1 BTC ≈ 33,333 FIZZ)
    decimalsA: 18,
    decimalsB: 8,
  },
];

/** Timestamp of the genesis block (Unix milliseconds). */
export const GENESIS_TIMESTAMP = 1741175040000;

/** Hash of the genesis (height-0) block parent — all zeros by convention. */
export const GENESIS_PARENT_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000';
