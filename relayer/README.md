# FizzDex Relayer (minimal)

Purpose: optional helper that listens for `AtomicSwapInitiated` events on EVM and can optionally post revealed secrets to the EVM `FizzDex` contract to automate HTLC completion.

Environment variables (create .env in /relayer or root):
- RELAYER_PRIVATE_KEY - private key for the relayer signer (optional)
- EVM_RPC - RPC endpoint to listen to
- FIZZDEX_ADDRESS - address of the deployed EVM FizzDex
- RELAYER_PORT - port (default: 4001)

Endpoints:
- GET /status
- POST /start-listen
- POST /submit-secret { swapId, secret }
- POST /solana/initiate-htlc { participant, tokenMint, amount, secretHash, timelock, evmSwapId? }
  - If you pass `evmSwapId` when creating the Solana HTLC via the relayer, the relayer will store a mapping so it can auto-complete the Solana counterpart if it later observes the secret revealed on EVM.
- POST /solana/complete-htlc { atomicSwapPda, escrowVaultPda, tokenMint, secret } — relayer will sign and submit the Solana `complete_atomic_swap` instruction (demo only)

Auto-complete behavior (demo):
- If the relayer created a Solana HTLC using `evmSwapId` mapping, and later observes `AtomicSwapCompleted` for that `evmSwapId` on EVM, it will extract the revealed preimage from the EVM transaction and call `complete_atomic_swap` on Solana automatically.

This relayer is intentionally minimal and optional — HTLCs remain trustless. Use this only for demo automation or to speed up counterparty coordination.
