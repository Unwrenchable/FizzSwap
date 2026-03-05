# FizzSwap — Agent Guidance

Use this file to orient yourself before suggesting changes to FizzSwap.

## Project overview

FizzSwap (`fizzdex`) is a multi-chain DEX that supports atomic swaps across
EVM-compatible chains, Solana, and Bitcoin. It is the official DEX for the
ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS ecosystem.

Its centrepiece is **FizzChain** — the project's own custom hub blockchain
(chain type `fizz-hub`, chain ID `fizz-1`) that is itself a multichain in
one: it bridges EVM, Solana, and Bitcoin through FIZZ-paired AMM pools under
a hybrid PoW + PoS consensus model.

## Repository layout

```
/                        # Root: Hardhat + TypeScript (EVM contracts & tests)
├── contracts/           # Solidity contracts (EVM)
├── programs/            # Anchor program workspace
│   └── fizzdex-solana/  # Rust/Anchor Solana program (Cargo.toml here)
├── scripts/             # Hardhat deploy scripts (deploy-evm.ts, etc.)
├── src/                 # TypeScript utilities / chain adapters
├── test/                # Hardhat/Mocha test files
├── relayer/             # Standalone Node.js relayer service
│   └── src/
│       ├── fizz-chain/  # ★ FizzChain hub blockchain (PoW+PoS, AMM, bridge)
│       │   ├── genesis.ts     — chain spec & initial state
│       │   ├── pow.ts         — SHA-256 mining engine & difficulty retargeting
│       │   ├── pos.ts         — validator registry, staking, epoch rewards
│       │   ├── state.ts       — in-process chain state machine (singleton)
│       │   ├── events.ts      — EventEmitter bus for block/swap/bridge events
│       │   ├── miner.ts       — background auto-mining loop
│       │   ├── persist.ts     — JSON snapshot save/load (survives restarts)
│       │   └── __tests__/     — Jest unit tests (pow, pos, state)
│       ├── adapters/
│       │   ├── evm-adapter.ts
│       │   ├── solana-adapter.ts
│       │   ├── bitcoin-adapter.ts
│       │   └── fizz-chain-adapter.ts  — IChainAdapter for FizzChain
│       ├── chain-adapter.ts   — universal IChainAdapter interface + factory
│       ├── handlers.ts        — /execute-route handler (evm | solana | fizz-hub)
│       ├── route-aggregator.ts
│       ├── worker.ts          — EVM→Solana HTLC background worker
│       └── index.ts           — Express server + all REST endpoints
└── web/                 # Vite + React frontend
    └── src/             # App.tsx (single-component DEX UI), styles.css
```

## Toolchain

| Layer | Tool |
|-------|------|
| EVM contracts | Solidity 0.8.20+, Hardhat 2.17, OpenZeppelin 5 |
| TypeScript compilation | `tsc` (root), `tsc -p tsconfig.json` (relayer) |
| Contract testing | Hardhat + Mocha + Chai |
| FizzChain tests | Jest 29 + ts-jest (`npm test` in `relayer/`) |
| Linting | ESLint with `@typescript-eslint` |
| Frontend build | Vite 5 + React 18 |
| Solana program | Rust + `cargo build-bpf` |
| Containerisation | Docker + docker-compose |

## Root `package.json` scripts

```
build              tsc
test               hardhat test
lint               eslint . --ext .ts,.js
compile-contracts  hardhat compile
deploy-evm         hardhat run scripts/deploy-evm.ts
build-solana       cargo build-bpf --manifest-path=programs/fizzdex-solana/Cargo.toml
relayer:init-mappings  node relayer/init-mappings.js
```

## Relayer scripts (`relayer/package.json`)

```
start          ts-node src/index.ts
build          tsc -p tsconfig.json
start:prod     node dist/index.js
test           jest --forceExit        ← FizzChain unit tests
test:watch     jest --watch --forceExit
test:coverage  jest --coverage --forceExit
```

## Web scripts (`web/package.json`)

```
dev      vite
build    vite build
preview  vite preview
```

---

## FizzChain — Contributor Guide

### What it is

FizzChain is the project's own blockchain, running entirely in-process inside the
relayer. It uses a **hybrid PoW + PoS** consensus:

- **PoW** — miners SHA-256 hash a block header until it starts with N leading-zero
  hex digits (difficulty 4 by default). Difficulty auto-retargets every 10 blocks.
- **PoS** — validators stake FIZZ (≥ 1,000 FIZZ). After a valid PoW block is
  found, one validator is chosen by deterministic SHA-256-weighted selection to
  co-sign the block. Staking rewards (~5% APY) are distributed at epoch end.

### Architecture of fizz-chain/

| File | Responsibility |
|------|---------------|
| `genesis.ts` | Immutable chain spec: token, params, initial validators/pools/balances |
| `pow.ts` | Block header hashing, `mine()` loop, `verifyPoW()`, `adjustDifficulty()` |
| `pos.ts` | `ValidatorRegistry` — stake/unstake, selection, epoch reward distribution |
| `state.ts` | `FizzChainState` — single source of truth; `submitPoW()` orchestrates the full pipeline |
| `events.ts` | `fizzEvents` EventEmitter; emit `block`, `tx`, `swap`, `bridge`, `miner` events |
| `miner.ts` | `startAutoMiner()` — setInterval loop that mines at target block time |
| `persist.ts` | `saveState()` / `loadSnapshot()` / `restoreState()` — JSON disk snapshot |

### Key design decisions

- **Singleton state** — `fizzChainState` is module-level; tests create `new FizzChainState()` directly to avoid pollution.
- **Lazy event imports** — `state.ts` loads `events.ts` via `require()` inside a try/catch so tests never need the EventEmitter.
- **bigint everywhere** — all token amounts are `bigint` (smallest unit, 10^-18 FIZZ). Never use JavaScript `number` for amounts.
- **Deterministic PoS selection** — `SHA-256(blockHeight) % totalStake` gives verifiable, reproducible validator selection.
- **Auto-miner** — runs via `setInterval` in the same Node.js thread; safe because difficulty ≤ 5 is fast (< 1 s per block on modern hardware).

### Adding a new FizzChain feature

1. If it touches consensus rules, update `genesis.ts` (params) first.
2. Add the logic in the appropriate module (`pow.ts`, `pos.ts`, or `state.ts`).
3. Write a unit test in `__tests__/` — run with `npm test` in `relayer/`.
4. If it needs an HTTP endpoint, add it in the `/fizz-chain/*` block of `index.ts`.
5. Update this file and `README.md`.

### Running tests

```bash
cd relayer
npm test              # run all fizz-chain tests
npm run test:coverage # with coverage report
```

### FizzChain REST endpoints (port 4001 by default)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/fizz-chain/info` | Chain metadata |
| GET | `/fizz-chain/block/latest` | Latest block |
| GET | `/fizz-chain/block/:height` | Block by height |
| GET | `/fizz-chain/balance/:address` | FIZZ balance (`?token=WETH` for others) |
| GET | `/fizz-chain/pools` | AMM pool states |
| GET | `/fizz-chain/validators` | PoS validator set |
| GET | `/fizz-chain/events` | **SSE stream** — real-time block/swap/bridge events |
| GET | `/fizz-chain/miner` | Auto-miner status |
| POST | `/fizz-chain/quote` | Swap quote |
| POST | `/fizz-chain/swap` | Execute swap |
| POST | `/fizz-chain/add-liquidity` | Add pool liquidity |
| POST | `/fizz-chain/transfer` | Transfer FIZZ |
| POST | `/fizz-chain/stake` | Stake FIZZ → become PoS validator |
| POST | `/fizz-chain/unstake` | Withdraw stake |
| POST | `/fizz-chain/mine` | Mine next block (in-process or submit external) |
| POST | `/fizz-chain/bridge-in` | Credit bridged tokens from external chain |
| POST | `/fizz-chain/bridge-out` | Lock tokens for bridge to external chain |
| POST | `/fizz-chain/miner/start` | Start auto-miner |
| POST | `/fizz-chain/miner/stop` | Stop auto-miner |
| POST | `/fizz-chain/snapshot` | Force-save chain state to disk |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIZZ_CHAIN_AUTO_MINE` | `true` | Enable/disable background auto-miner |
| `FIZZ_CHAIN_MINER_ADDRESS` | `fizz1autominer...` | Address receiving PoW block rewards |
| `FIZZ_CHAIN_MINE_DIFFICULTY` | (from chain state) | Override difficulty for testing |
| `FIZZ_CHAIN_BLOCK_TIME_MS` | `6000` | Target block time in milliseconds |

### Real-time events (SSE)

```js
const es = new EventSource('http://localhost:4001/fizz-chain/events');
es.addEventListener('block',  e => console.log('New block:', JSON.parse(e.data)));
es.addEventListener('swap',   e => console.log('Swap:',     JSON.parse(e.data)));
es.addEventListener('bridge', e => console.log('Bridge:',   JSON.parse(e.data)));
es.addEventListener('miner',  e => console.log('Miner:',    JSON.parse(e.data)));
```

### State persistence

Chain state is saved to `fizz-chain-state.json` (same directory as `relayer-mappings.json`):
- After every block below height 100
- Every 10 blocks above height 100
- Immediately on SIGTERM / SIGINT
- Manually via `POST /fizz-chain/snapshot`

---

## Key conventions

- **Security**: All state-changing Solidity functions use reentrancy guards;
  Solidity 0.8.20+ for overflow protection. See `SECURITY.md`.
- **Chain adapter pattern**: `relayer/src/chain-adapter.ts` exports `IChainAdapter`
  interface. Register new chains with `ChainAdapterFactory.registerAdapter(type, Class)`.
  Currently registered: `evm`, `solana`, `bitcoin`, `fizz-hub`.
- **Frontend env vars**: Vite convention — prefix with `VITE_`. Declared in
  `web/src/vite-env.d.ts`. Available vars: `VITE_SOLANA_RPC`,
  `VITE_SOLANA_PROGRAM_ID`, `VITE_RELAYER_URL`. Template: `web/.env.example`.
- **Browser polyfills**: `vite-plugin-node-polyfills` supplies Buffer/process/
  crypto shims. The web UI uses the Web Crypto API (not Node's `crypto`).
- **Single-component UI**: All state and logic lives in `web/src/App.tsx`.
  Four tabs: swap / pool / fizzcaps / bridge.
- **Secrets**: Never committed. Use `.env` files (git-ignored). Templates are
  `.env.example` files.

## Things to watch out for

- **bigint vs number**: FizzChain amounts are always `bigint`. Never convert to
  `number` — it loses precision for large values. Use `.toString()` for JSON.
- The web bundle will emit a large-chunk warning (>500 KB) from ethers +
  `@solana/web3.js` — this is expected and suppressed in `vite.config.ts`.
- Vercel deployment is configured via `vercel.json` at the root; build command
  is `cd web && npm install && npm run build`; output dir is `web/dist`.
- `relayer-mappings.json` and `fizz-chain-state.json` are git-ignored
  (generated at runtime).
- FizzChain auto-miner runs at difficulty 4 by default — on slow machines set
  `FIZZ_CHAIN_MINE_DIFFICULTY=2` and `FIZZ_CHAIN_BLOCK_TIME_MS=10000` for dev.

