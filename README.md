# FizzSwap — Multi-Chain DEX

FizzSwap is the official DEX for the [ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS](https://github.com/Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS) ecosystem. It supports atomic swaps across EVM chains and Solana.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

---

## Security

See [SECURITY.md](./SECURITY.md) for guidance on secret handling, key rotation,
and secure deployment practices.

---

## License

MIT
