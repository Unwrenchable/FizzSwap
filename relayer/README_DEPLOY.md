Relayer deployment and security notes
===================================

Required environment variables
- `RELAYER_PRIVATE_KEY` — EVM relayer private key (avoid using in plaintext in production)
- `RELAYER_SOLANA_KEYPAIR` — JSON array for Solana keypair secret key (avoid plaintext in production)
- `RELAYER_API_KEY` — API key required for POST endpoints when set (recommended in production)
- `RELAYER_MAPPINGS_KEY` — Optional encryption key used to encrypt `relayer-mappings.json` (strongly recommended)
- `RELAYER_ALLOW_AUTOCOMPLETE` — `true` to allow the relayer to auto-complete mapped HTLCs (disable unless necessary)

Initializing mappings file
--------------------------
Run the initializer to create a secure `relayer-mappings.json` before starting the relayer service:

```bash
RELAYER_MAPPINGS_KEY="your-strong-key" npm run relayer:init-mappings
```

This will create `relayer-mappings.json` encrypted (if `RELAYER_MAPPINGS_KEY` is set) and set file permissions to `600` where possible.

Secrets guidance
-----------------
- Do NOT store `RELAYER_PRIVATE_KEY` or `RELAYER_SOLANA_KEYPAIR` in source or commit them.
- Prefer a secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault).
- Rotate keys regularly and restrict process/file permissions.

Runtime considerations
----------------------
- Set `RELAYER_API_KEY` in production to protect POST endpoints.
- Keep `RELAYER_ALLOW_AUTOCOMPLETE=false` unless the relayer is operating in a trusted network and under strict access control.
- Ensure the relayer's logs do not include secrets or preimages.

Node & Hardhat
--------------
- Use Node 18.x or 20.x for Hardhat compatibility (Node 24 is not supported).
- In CI, ensure the runner has internet access so Hardhat can download the Solidity compiler, or pre-cache the compiler binary in CI.

Docker
------

You can run the relayer in Docker. Example build and run commands:

```bash
# build image from repository root
docker build -f relayer/Dockerfile -t fizzdex-relayer:latest .

# run (set necessary env vars securely)
docker run -e RELAYER_API_KEY="$RELAYER_API_KEY" -e RELAYER_MAPPINGS_KEY="$RELAYER_MAPPINGS_KEY" -e RELAYER_PRIVATE_KEY="$RELAYER_PRIVATE_KEY" -p 4001:4001 fizzdex-relayer:latest
```

Notes: The Dockerfile uses `ts-node` to run the TypeScript entrypoint. For production you may prefer to add a build step that transpiles to JS and run `node dist/index.js` instead.
