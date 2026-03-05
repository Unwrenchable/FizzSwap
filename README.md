# FizzSwap — Multi-Chain DEX

FizzSwap is the official DEX for the [ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS](https://github.com/Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS) ecosystem. It supports atomic swaps across EVM chains, Solana, and Bitcoin via Hash Time-Locked Contracts (HTLCs), all unified by **FizzChain** — the project's own custom hub blockchain that is a multichain in itself.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## FizzChain — Your Own Chain, A Multichain In Itself

FizzChain is a custom hub blockchain built into the FizzSwap relayer. It uses a **hybrid PoW + PoS consensus** and acts as the universal routing layer that natively aggregates EVM, Solana, and Bitcoin liquidity through FIZZ-paired AMM pools.

```
Bitcoin (BTC)  ─┐
Ethereum (ETH) ─┼──► FizzChain Hub (FIZZ) ◄──► Any-to-Any Swap
Solana  (SOL)  ─┘
```

### Consensus: Hybrid PoW + PoS

| Layer | Role | Mechanism |
|-------|------|-----------|
| **Proof of Work** | Block production | SHA-256 hash with adjustable difficulty target |
| **Proof of Stake** | Block finalization | Validators stake FIZZ; weighted-random co-signing |

**Block lifecycle:**
1. A miner iterates nonces until `SHA-256(header)` starts with N zero hex digits (PoW)
2. The chain selects a PoS validator (weighted by stake) to sign the block
3. Once both conditions are met the block is final; the miner earns a FIZZ block reward
4. Every 100 blocks an epoch ends and PoS validators earn proportional staking rewards (~5% APY)

**Key parameters (configurable in `relayer/src/fizz-chain/genesis.ts`):**

| Parameter | Value | Description |
|-----------|-------|-------------|
| Chain ID | `fizz-1` | |
| Native token | `FIZZ` | 18 decimals, 1 billion total supply |
| PoW difficulty | 4 | Leading zero hex digits |
| Min stake | 1,000 FIZZ | To become an active PoS validator |
| Block time | 6 s target | Auto-adjusted by difficulty retargeting |
| Block reward | 10 FIZZ | Minted to miner per PoW block |
| Staking APY | ~5% | Distributed at epoch end |

### FizzChain files

```
relayer/src/fizz-chain/
├── genesis.ts     # Chain spec: params, validators, pools, bridged assets
├── pow.ts         # PoW engine: SHA-256 mining, difficulty check, retargeting
├── pos.ts         # PoS registry: stake/unstake, weighted selection, epoch rewards
└── state.ts       # In-process chain state: blocks, balances, AMM pools, mempool
relayer/src/adapters/
└── fizz-chain-adapter.ts  # IChainAdapter for FizzChain (swap, bridge, staking)
```

---

## Supported Chains

| Chain | Type | Status | Notes |
|-------|------|--------|-------|
| **FizzChain** | `fizz-hub` | ✅ Full | Custom hub chain with PoW+PoS, FIZZ token |
| Ethereum / EVM | `evm` | ✅ Full | On-chain FizzDex contract + HTLC |
| Solana | `solana` | ✅ Full | Anchor program + SPL-Token HTLC |
| Bitcoin | `bitcoin` | ✅ Full | P2WSH HTLC via Blockstream API |
| Cosmos / others | `cosmos`, `other` | 🔧 Pluggable | Add adapter via `ChainAdapterFactory` |

Adding a new chain takes a single adapter class implementing `IChainAdapter`
(see `relayer/src/chain-adapter.ts`), then `ChainAdapterFactory.registerAdapter(type, Class)`.

---

## Architecture

| Component | Location | Hosting |
|-----------|----------|---------|
| Frontend  | `web/`   | Vercel  |
| Relayer   | `relayer/` | Docker / any Node.js host |

```
FizzSwap/
├── web/          # Vite + React 18 frontend (deployed to Vercel)
├── relayer/      # Express cross-chain relayer (deployed via Docker)
├── vercel.json   # Vercel build & routing config
├── Dockerfile    # Relayer production image
└── docker-compose.yml  # Local relayer dev stack
```

---

## Frontend (`web/`)

The frontend is a single-page React app built with Vite.

### Local development

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

### Environment variables

Create `web/.env` from the template:

```bash
cp web/.env.example web/.env
```

| Variable | Description |
|----------|-------------|
| `VITE_SOLANA_RPC` | Solana RPC URL (e.g. `https://api.devnet.solana.com`) |
| `VITE_SOLANA_PROGRAM_ID` | Deployed Solana program public key |
| `VITE_RELAYER_URL` | Relayer base URL (e.g. `http://localhost:4001`) |

### Vercel deployment

The `vercel.json` at the repo root configures the build:

```json
{
  "buildCommand": "cd web && npm install && npm run build",
  "outputDirectory": "web/dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Set the `VITE_*` environment variables in the Vercel project settings under
**Settings → Environment Variables**.

---

## Relayer (`relayer/`)

The relayer is a Node.js/Express service that bridges EVM ↔ Solana swap events.
It listens on port **4001** by default.

### Local development

```bash
cd relayer
npm install
cp ../.env.example .env   # then fill in values
node init-mappings.js     # create initial mappings file
npm run start             # ts-node dev server
```

### Docker (recommended for production)

```bash
# Copy and fill in env vars
cp .env.example .env

# Build and run with docker-compose
docker compose up -d
```

The `docker-compose.yml` starts:
- **relayer** — the cross-chain relayer on port 4001

### Environment variables

See [`.env.example`](./.env.example) for the full list. Key variables:

| Variable | Description |
|----------|-------------|
| `RELAYER_PORT` | HTTP port (default `4001`) |
| `RELAYER_API_KEY` | Secret key for protected endpoints |
| `EVM_RPC` | EVM RPC URL the relayer monitors |
| `FIZZDEX_ADDRESS` | Deployed FizzDex contract address |
| `SOLANA_RPC` | Solana RPC URL |
| `SOLANA_PROGRAM_ID` | Deployed Solana program ID |
| `RELAYER_PRIVATE_KEY` | EVM signer private key (**never commit**) |
| `RELAYER_SOLANA_KEYPAIR` | Solana keypair JSON array (**never commit**) |
| `BITCOIN_WIF` | Bitcoin WIF private key for HTLC signing (**never commit**) |
| `BITCOIN_NETWORK` | `mainnet` or `testnet` (default: `mainnet`) |
| `BITCOIN_ESPLORA_URL` | Blockstream API base URL (auto-detected from `BITCOIN_NETWORK`) |

### FizzChain hub endpoints

FizzChain runs entirely in-process inside the relayer — no external node required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/fizz-chain/info` | Chain metadata: height, difficulty, validators, pool count |
| `GET` | `/fizz-chain/block/latest` | Latest finalized block |
| `GET` | `/fizz-chain/block/:height` | Block at a specific height |
| `GET` | `/fizz-chain/balance/:address` | FIZZ balance (`?token=WETH` for other tokens) |
| `GET` | `/fizz-chain/pools` | All AMM pool states |
| `GET` | `/fizz-chain/validators` | PoS validator set with stake amounts |
| `POST` | `/fizz-chain/quote` | Swap quote (`tokenIn`, `tokenOut`, `amountIn`) |
| `POST` | `/fizz-chain/swap` | Execute AMM swap (`from`, `tokenIn`, `tokenOut`, `amountIn`) |
| `POST` | `/fizz-chain/add-liquidity` | Add liquidity to a FIZZ pool |
| `POST` | `/fizz-chain/transfer` | Transfer FIZZ between addresses |
| `POST` | `/fizz-chain/stake` | Stake FIZZ to become a PoS validator |
| `POST` | `/fizz-chain/unstake` | Unstake FIZZ from the validator registry |
| `POST` | `/fizz-chain/mine` | Mine the next block (in-process PoW + PoS finalization) |
| `POST` | `/fizz-chain/bridge-in` | Record tokens arriving from an external chain |
| `POST` | `/fizz-chain/bridge-out` | Lock tokens on FizzChain for bridge to external chain |

**Mine a block (in-process):**
```bash
curl -X POST http://localhost:4001/fizz-chain/mine \
  -H "Content-Type: application/json" \
  -d '{"miner":"fizz1youaddress"}'
```

**Swap FIZZ → WETH:**
```bash
curl -X POST http://localhost:4001/fizz-chain/swap \
  -H "Content-Type: application/json" \
  -d '{"from":"fizz1treasury","tokenIn":"FIZZ","tokenOut":"WETH","amountIn":"1000000000000000000000"}'
```

**Stake FIZZ to become a validator:**
```bash
curl -X POST http://localhost:4001/fizz-chain/stake \
  -H "Content-Type: application/json" \
  -d '{"address":"fizz1myaddress","amount":"1000000000000000000000","name":"My Validator"}'
```

### Bitcoin HTLC endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /bitcoin/initiate-htlc` | Derive a P2WSH HTLC address from a secret hash and two public keys |
| `POST /bitcoin/complete-htlc` | Spend a funded HTLC by revealing the secret preimage |
| `GET /bitcoin/htlc-status/:address` | Query funding/completion status of an HTLC address via Esplora |

**How Bitcoin ↔ EVM/Solana atomic swaps work:**

```
1. Both parties agree on a 32-byte secret (hash = SHA-256 of secret).
2. EVM/Solana side: user calls FizzDex.initiateAtomicSwap(secretHash, ...).
3. Bitcoin side: relayer POST /bitcoin/initiate-htlc with secretHash + pubkeys.
4. Counterparty funds the P2WSH address returned by step 3.
5. Initiator reveals the secret on one chain, the counterparty uses it to claim on the other.
6. POST /bitcoin/complete-htlc with the revealed secret broadcasts the Bitcoin spend tx.
```

---

## Security

See [SECURITY.md](./SECURITY.md) for guidance on secret handling, key rotation,
and secure deployment practices.

---

## License

MIT
