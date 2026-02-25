# FizzSwap Deployment Guide

This guide covers every layer of the FizzSwap stack: EVM smart contracts,
the Solana program, the relayer service, the React web frontend, and Docker /
Vercel production hosting.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [EVM Smart Contract Deployment](#evm-smart-contract-deployment)
4. [Solana Program Deployment](#solana-program-deployment)
5. [Relayer Service Deployment](#relayer-service-deployment)
6. [Frontend Deployment](#frontend-deployment)
7. [Docker / Docker Compose](#docker--docker-compose)
8. [Post-Deployment Steps](#post-deployment-steps)
9. [Security Checklist](#security-checklist)
10. [Monitoring](#monitoring)
11. [Troubleshooting](#troubleshooting)
12. [Deployment Costs (Approximate)](#deployment-costs-approximate)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18.x or 20.x | Node 24 is not supported by Hardhat |
| npm | 9+ | Bundled with Node.js |
| Rust + Cargo | stable | Required for Solana program only |
| Solana CLI | 1.18+ | Required for Solana program only |
| Docker | 24+ | Required for container deployments only |

---

## Local Development Setup

### 1. Clone and install root dependencies

```bash
git clone https://github.com/Unwrenchable/FizzSwap.git
cd FizzSwap
npm install
```

### 2. Configure environment variables

Copy the root example env file and fill in your values:

```bash
cp .env.example .env
```

Minimum required values for local development:

```bash
# EVM
PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY
EVM_RPC=http://127.0.0.1:8545        # local Hardhat / Ganache node

# Contract address (populated after first deploy)
FIZZDEX_ADDRESS=

# Etherscan (optional, for contract verification)
ETHERSCAN_API_KEY=
```

**⚠️ SECURITY WARNING**: Never commit `.env` to version control. It is already in `.gitignore`.

### 3. Compile and test contracts

```bash
npm run compile-contracts   # compiles Solidity → artifacts/
npm test                    # runs Hardhat/Mocha tests
```

### 4. Start a local Hardhat node (separate terminal)

```bash
npx hardhat node
```

### 5. Deploy contracts to the local node

```bash
npm run deploy-evm -- --network localhost
```

### 6. Install relayer dependencies and initialise mappings

```bash
cd relayer
npm install
cd ..
npm run relayer:init-mappings   # creates relayer-mappings.json
```

### 7. Start the relayer (separate terminal)

```bash
cd relayer
RELAYER_PORT=4001 EVM_RPC=http://127.0.0.1:8545 FIZZDEX_ADDRESS=0x... npm run start
```

### 8. Start the frontend dev server (separate terminal)

```bash
cd web
npm install
cp .env.example .env   # edit VITE_RELAYER_URL, VITE_SOLANA_RPC, VITE_SOLANA_PROGRAM_ID
npm run dev            # Vite HMR at http://localhost:5173
```

---

## EVM Smart Contract Deployment

### Environment variables (root `.env`)

```bash
PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY

# RPC endpoints
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_RPC_URL=https://polygon-rpc.com
BSC_RPC_URL=https://bsc-dataseed.binance.org
BASE_RPC_URL=https://mainnet.base.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc

# Block explorer API keys (for contract verification)
ETHERSCAN_API_KEY=your_key
POLYGONSCAN_API_KEY=your_key
BSCSCAN_API_KEY=your_key
```

### Hardhat network configuration

Add networks to `hardhat.config.ts`:

```typescript
networks: {
  ethereum: {
    url: process.env.ETH_RPC_URL,
    accounts: [process.env.PRIVATE_KEY!],
    chainId: 1
  },
  polygon: {
    url: process.env.POLYGON_RPC_URL,
    accounts: [process.env.PRIVATE_KEY!],
    chainId: 137
  },
  bsc: {
    url: process.env.BSC_RPC_URL,
    accounts: [process.env.PRIVATE_KEY!],
    chainId: 56
  },
  base: {
    url: process.env.BASE_RPC_URL,
    accounts: [process.env.PRIVATE_KEY!],
    chainId: 8453
  },
  arbitrum: {
    url: process.env.ARBITRUM_RPC_URL,
    accounts: [process.env.PRIVATE_KEY!],
    chainId: 42161
  }
}
```

### Deploy

```bash
# Install dependencies (first time)
npm install

# Compile contracts
npm run compile-contracts

# Testnet (recommended first)
npx hardhat run scripts/deploy-evm.ts --network sepolia

# Mainnets
npx hardhat run scripts/deploy-evm.ts --network ethereum
npx hardhat run scripts/deploy-evm.ts --network polygon
npx hardhat run scripts/deploy-evm.ts --network bsc
npx hardhat run scripts/deploy-evm.ts --network base
npx hardhat run scripts/deploy-evm.ts --network arbitrum
```

### Verify contracts on block explorers

```bash
npx hardhat verify --network ethereum <FIZZDEX_ADDRESS> <REWARD_TOKEN_ADDRESS>
npx hardhat verify --network polygon  <FIZZDEX_ADDRESS> <REWARD_TOKEN_ADDRESS>
```

---

## Solana Program Deployment

### Prerequisites

```bash
# Install Solana CLI (1.18+)
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Configure to mainnet (or devnet for testing)
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/id.json

# Fund the deployer wallet
solana airdrop 2   # devnet only
```

### Build the program

```bash
npm run build-solana
# equivalent to:
# cargo build-bpf --manifest-path=programs/fizzdex-solana/Cargo.toml
```

### Deploy

```bash
solana program deploy programs/fizzdex-solana/target/deploy/fizzdex_solana.so
```

Note the **program ID** printed by the deploy command — you will need it for
the relayer and frontend environment variables (`SOLANA_PROGRAM_ID` /
`VITE_SOLANA_PROGRAM_ID`).

---

## Relayer Service Deployment

The relayer is an optional Express service that bridges EVM ↔ Solana swap
events. It listens on port **4001** by default.

> **Security note**: when `RELAYER_SOLANA_KEYPAIR` is configured the relayer
> becomes an on-chain signer for Solana transactions. Keep it private and use
> it only for testing or trusted automation. For fully trustless UX, users
> sign directly with their own wallets through the UI.

### Environment variables (`relayer/.env` or passed at runtime)

| Variable | Required | Description |
|---|---|---|
| `RELAYER_PORT` | No | HTTP port (default: `4001`) |
| `EVM_RPC` | Yes | EVM JSON-RPC endpoint |
| `FIZZDEX_ADDRESS` | Yes | Deployed FizzDex contract address |
| `RELAYER_PRIVATE_KEY` | No | EVM signer key for submitting secrets |
| `RELAYER_SOLANA_KEYPAIR` | No | JSON array of 64 Solana keypair bytes |
| `RELAYER_API_KEY` | Recommended | Protects POST endpoints with `x-api-key` header |
| `RELAYER_MAPPINGS_KEY` | Recommended | AES key to encrypt `relayer-mappings.json` |
| `RELAYER_ALLOW_AUTOCOMPLETE` | No | Auto-complete mapped HTLCs (default: `false`) |
| `RELAYER_RATE_LIMIT` | No | Max requests/min per IP (default: `60`) |
| `SOLANA_RPC` | No | Solana RPC endpoint |
| `SOLANA_PROGRAM_ID` | No | Deployed Solana program ID |

### Initialise mappings file (required before first start)

```bash
RELAYER_MAPPINGS_KEY="your-strong-key" npm run relayer:init-mappings
```

This creates an encrypted `relayer-mappings.json` and sets file permissions
to `600`.

### Run in development

```bash
cd relayer
npm install
npm run start
```

### Run in production

```bash
cd relayer
npm run build          # compiles TypeScript → relayer/dist/
npm run start:prod     # runs relayer/dist/index.js
```

### Relayer API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/start-listen` | Start watching EVM `AtomicSwapInitiated` events |
| `POST` | `/submit-secret` | Submit a revealed secret to EVM (`{ swapId, secret }`) |
| `POST` | `/solana/initiate-htlc` | Create a Solana HTLC signed by the relayer keypair |

All `POST` endpoints require the `x-api-key: <RELAYER_API_KEY>` header when
`RELAYER_API_KEY` is set.

---

## Frontend Deployment

The web frontend is a Vite 5 + React 18 single-page application located in
`web/`.

### Environment variables (`web/.env`)

Copy the template and fill in your values:

```bash
cd web
cp .env.example .env
```

```bash
# Solana RPC endpoint
VITE_SOLANA_RPC=https://api.mainnet-beta.solana.com

# Deployed Solana program ID (from the Solana deployment step)
VITE_SOLANA_PROGRAM_ID=<YOUR_PROGRAM_ID>

# Relayer backend URL
VITE_RELAYER_URL=https://your-relayer-domain.com
```

> **Note**: Vite only exposes variables prefixed with `VITE_` to browser code.
> Never put private keys or secrets in `web/.env`.

### Build

```bash
cd web
npm install
npm run build   # output in web/dist/
```

### Vercel (recommended)

The repository includes a `vercel.json` at the root that is pre-configured:

```json
{
  "buildCommand": "cd web && npm install && npm run build",
  "outputDirectory": "web/dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Steps:

1. Import the repository in [vercel.com](https://vercel.com).
2. Set the `VITE_*` environment variables in the Vercel dashboard under
   **Settings → Environment Variables**.
3. Deploy — Vercel will run the build command automatically on every push to
   the production branch.

### Manual / self-hosted

```bash
cd web && npm run build
# Serve web/dist/ with any static file server, e.g. nginx or serve:
npx serve -s web/dist -l 3000
```

Configure your web server to rewrite all paths to `index.html` for SPA
routing (the `vercel.json` rewrites block is the reference).

---

## Docker / Docker Compose

See [`README_DOCKER.md`](../README_DOCKER.md) for full Docker details. Quick
reference:

### Build the relayer image

```bash
# Fast build (skips contract compile and web build)
docker build -t fizzdex:latest \
  --build-arg SKIP_COMPILE=true \
  --build-arg SKIP_WEB_BUILD=true .
```

### Run the relayer container

```bash
# Using an env file (recommended)
docker run --rm -p 4001:4001 --env-file .env \
  -v $(pwd)/relayer-mappings.json:/app/relayer-mappings.json \
  fizzdex:latest

# Passing individual variables
docker run --rm -p 4001:4001 \
  -e RELAYER_PORT=4001 \
  -e EVM_RPC=http://host.docker.internal:8545 \
  -e FIZZDEX_ADDRESS=0x... \
  -e RELAYER_API_KEY=your-key \
  fizzdex:latest
```

### Docker Compose (local dev with Ganache)

```bash
docker compose up --build
```

This starts a Ganache node on port 8545 and the relayer on port 4001.

### Push to a registry

```bash
# Docker Hub
docker login
docker tag fizzdex:latest youruser/fizzdex:1.0.0
docker push youruser/fizzdex:1.0.0

# GitHub Container Registry
echo "$CR_PAT" | docker login ghcr.io -u YOUR_GH_USER --password-stdin
docker tag fizzdex:latest ghcr.io/YOUR_GH_USER/fizzdex:1.0.0
docker push ghcr.io/YOUR_GH_USER/fizzdex:1.0.0
```

---

## Post-Deployment Steps

After contracts are deployed and the stack is running:

1. Record all deployed contract addresses in a safe location.
2. Transfer contract ownership to a multi-sig wallet.
3. Verify all contracts on block explorers.
4. Set `RELAYER_API_KEY` to a strong secret and restart the relayer.
5. Update the frontend `VITE_RELAYER_URL` to the production relayer endpoint
   and redeploy.
6. Create initial liquidity pools and seed them.
7. Announce the deployment on social media and list on DEX aggregators.
8. Submit contract addresses to token lists.

---

## Security Checklist

Before going live, ensure:

- [ ] `.env` files are **not** committed to version control
- [ ] All private keys are stored in a secrets manager (Vault, AWS KMS,
      GitHub Secrets), not in plaintext
- [ ] All contracts are verified on block explorers
- [ ] Ownership is transferred to a multi-sig wallet
- [ ] Emergency pause mechanism is tested
- [ ] `RELAYER_API_KEY` is set to a strong, unique value
- [ ] `RELAYER_ALLOW_AUTOCOMPLETE` is `false` unless explicitly required
- [ ] `RELAYER_MAPPINGS_KEY` is set to encrypt the mappings file
- [ ] Rate limiting (`RELAYER_RATE_LIMIT`) is configured
- [ ] `npm audit` has been run and high-severity findings addressed
- [ ] Audit reports are published
- [ ] Bug bounty program is active

---

## Monitoring

Set up monitoring for:

- EVM contract events (`AtomicSwapInitiated`, `AtomicSwapCompleted`, etc.)
- Relayer health endpoint
- Pool liquidity levels
- Cross-chain bridge status
- Unusual transaction patterns / large withdrawals
- Gas price spikes

---

## Troubleshooting

### Contract compilation errors

```bash
npm run compile-contracts   # not `npm run build` (that compiles the TS SDK)
```

Make sure `hardhat.config.ts` specifies Solidity `0.8.20`.

### Hardhat can't find the Solidity compiler in CI

Pre-cache the compiler binary or ensure the CI runner has internet access.
Use Node.js 18.x or 20.x — Node 24 is not supported by Hardhat 2.17.

### Relayer fails to start — `relayer-mappings.json` not found

Run the initialiser before starting the relayer:

```bash
npm run relayer:init-mappings
```

### Frontend env vars not picked up

Vite only exposes variables prefixed with `VITE_`. Ensure your `web/.env`
uses `VITE_SOLANA_RPC`, `VITE_SOLANA_PROGRAM_ID`, and `VITE_RELAYER_URL`.
Restart the dev server after changing `.env`.

### Gas issues on EVM deployment

- Increase `gasMultiplier` in `hardhat.config.ts` for the target network.
- Use a gas price oracle for dynamic pricing.
- Consider deploying to an L2 (Base, Arbitrum) for lower fees.

### RPC / connection issues

- Verify your RPC endpoint is reachable and not rate-limited.
- Use a paid Alchemy or Infura endpoint for production.
- Keep backup RPC URLs handy in case of provider outages.

### Solana program deploy fails

- Ensure the deployer wallet has enough SOL for rent and deployment fees.
- Use devnet for testing (`solana config set --url https://api.devnet.solana.com`).
- Make sure the Solana BPF toolchain (1.18+) matches the version used to build.

---

## Deployment Costs (Approximate)

| Layer | Chain / Service | Estimated Cost |
|---|---|---|
| EVM contracts | Ethereum | 3–5 M gas (~$100–$500) |
| EVM contracts | Polygon | 3–5 M gas (~$1–$5) |
| EVM contracts | BSC | 3–5 M gas (~$5–$20) |
| EVM contracts | Base | 3–5 M gas (~$5–$20) |
| EVM contracts | Arbitrum | 3–5 M gas (~$10–$30) |
| Solana program | Solana mainnet | ~10 SOL (~$200–$500) |
| Frontend | Vercel (Hobby) | Free |
| Relayer | VPS / container | ~$5–$20/month |

*Costs vary based on network congestion and token prices.*

---

## Support

- **GitHub Issues**: https://github.com/Unwrenchable/FizzSwap/issues
- **Discord**: https://discord.gg/fizzdex
- **Documentation**: [docs/README.md](./README.md)

---

**Need help?** Open a GitHub issue or join the Discord community.
