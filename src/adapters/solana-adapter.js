"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolanaAdapter = void 0;
const web3_js_1 = require("@solana/web3.js");
class SolanaAdapter {
    constructor(config, keypair) {
        this.config = config;
        this.connection = new web3_js_1.Connection(config.rpcUrl);
        this.keypair = keypair;
    }
    getChainInfo() {
        return this.config;
    }
    async connect() {
        this.connection = new web3_js_1.Connection(this.config.rpcUrl, "confirmed");
        // load server-side relayer keypair if provided via env
        if (process.env.RELAYER_SOLANA_KEYPAIR && !this.keypair) {
            try {
                const arr = JSON.parse(process.env.RELAYER_SOLANA_KEYPAIR);
                this.keypair = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(arr));
            }
            catch {
                // ignore parse errors; operations requiring signing will error later
            }
        }
    }
    async disconnect() {
        // nothing to do
    }
    isConnected() {
        return !!this.connection;
    }
    async getWalletAddress() {
        if (!this.keypair)
            throw new Error("No keypair configured for Solana adapter");
        return this.keypair.publicKey.toBase58();
    }
    async getBalance(tokenAddress) {
        if (!this.keypair)
            throw new Error("No keypair configured for Solana adapter");
        const bal = await this.connection.getBalance(this.keypair.publicKey, 'confirmed');
        return bal.toString();
    }
    async getSwapQuote(inputToken, outputToken, amount) {
        const cfg = this.config;
        // 1) on-chain poolAccounts support: caller can provide poolAccounts array of { tokenA, tokenB, vaultA, vaultB }
        if (cfg.poolAccounts && Array.isArray(cfg.poolAccounts)) {
            const pool = cfg.poolAccounts.find((p) => {
                const a = String(p.tokenA).toLowerCase();
                const b = String(p.tokenB).toLowerCase();
                const inT = inputToken.toLowerCase();
                const outT = outputToken.toLowerCase();
                return (a === inT && b === outT) || (a === outT && b === inT);
            });
            if (!pool)
                throw new Error('No on-chain pool found for provided tokens');
            // fetch token balances from the vault token accounts
            const vaultA = pool.vaultA;
            const vaultB = pool.vaultB;
            const respA = await this.connection.getTokenAccountBalance(new web3_js_1.PublicKey(vaultA));
            const respB = await this.connection.getTokenAccountBalance(new web3_js_1.PublicKey(vaultB));
            const reserveA = BigInt(respA.value.amount);
            const reserveB = BigInt(respB.value.amount);
            const isTokenA = pool.tokenA.toLowerCase() === inputToken.toLowerCase();
            const reserveIn = isTokenA ? reserveA : reserveB;
            const reserveOut = isTokenA ? reserveB : reserveA;
            const amountIn = BigInt(amount);
            if (amountIn <= 0n)
                throw new Error('Invalid amount');
            const amountInWithFee = amountIn * 997n;
            const numerator = amountInWithFee * reserveOut;
            const denominator = reserveIn * 1000n + amountInWithFee;
            const amountOut = numerator / denominator;
            const quote = {
                inputToken: { address: inputToken, symbol: 'SPL', name: 'SPL Token', decimals: pool.decimalsA || 9 },
                outputToken: { address: outputToken, symbol: 'SPL', name: 'SPL Token', decimals: pool.decimalsB || 9 },
                inputAmount: amount.toString(),
                outputAmount: amountOut.toString(),
                priceImpact: 0,
                fee: '0',
                route: [this.config.chainId],
                estimatedGas: '0'
            };
            return quote;
        }
        // 2) fallback: local in-memory pools (useful for demos and tests)
        const pools = cfg.pools;
        if (!pools || !Array.isArray(pools))
            throw new Error('getSwapQuote not implemented for Solana adapter yet');
        const pool = pools.find((p) => {
            const a = String(p.tokenA).toLowerCase();
            const b = String(p.tokenB).toLowerCase();
            const inT = inputToken.toLowerCase();
            const outT = outputToken.toLowerCase();
            return (a === inT && b === outT) || (a === outT && b === inT);
        });
        if (!pool)
            throw new Error('No pool found for provided tokens');
        // Determine reserve ordering like EVM adapter
        const isTokenA = pool.tokenA.toLowerCase() === inputToken.toLowerCase();
        const reserveA = BigInt(pool.reserveA.toString());
        const reserveB = BigInt(pool.reserveB.toString());
        const reserveIn = isTokenA ? reserveA : reserveB;
        const reserveOut = isTokenA ? reserveB : reserveA;
        const amountIn = BigInt(amount);
        if (amountIn <= 0n)
            throw new Error('Invalid amount');
        // constant-product quote with 0.3% fee
        const amountInWithFee = amountIn * 997n;
        const numerator = amountInWithFee * reserveOut;
        const denominator = reserveIn * 1000n + amountInWithFee;
        const amountOut = numerator / denominator;
        const quote = {
            inputToken: { address: inputToken, symbol: 'SPL', name: 'SPL Token', decimals: 9 },
            outputToken: { address: outputToken, symbol: 'SPL', name: 'SPL Token', decimals: 9 },
            inputAmount: amount.toString(),
            outputAmount: amountOut.toString(),
            priceImpact: 0,
            fee: '0',
            route: [this.config.chainId],
            estimatedGas: '0'
        };
        return quote;
    }
    async executeSwap(inputToken, outputToken, amount, minOutputAmount, slippage) {
        const cfg = this.config;
        // Attempt on-chain swap when configured and relayer keypair present
        const swapProgramId = cfg.swapProgramId || process.env.SOLANA_SWAP_PROGRAM_ID || process.env.SOLANA_PROGRAM_ID;
        const swapAccounts = cfg.swapAccounts; // expected structure: { keys: [{ pubkey, isSigner, isWritable }, ...] }
        const relayerKeypairJson = process.env.RELAYER_SOLANA_KEYPAIR;
        if (swapProgramId && relayerKeypairJson) {
            if (!swapAccounts)
                throw new Error('swapAccounts configuration required for on-chain swap');
            // build instruction data: discriminator + amount(u64 LE) + minOutput(u64 LE)
            const crypto = require('crypto');
            const disc = crypto.createHash('sha256').update('global:swap').digest().slice(0, 8);
            const amtBuf = Buffer.alloc(8);
            amtBuf.writeBigUInt64LE(BigInt(amount));
            const minBuf = Buffer.alloc(8);
            minBuf.writeBigUInt64LE(BigInt(minOutputAmount || '0'));
            const data = Buffer.concat([disc, amtBuf, minBuf]);
            // prepare keys
            const keys = (swapAccounts.keys || []).map((k) => ({ pubkey: new web3_js_1.PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable }));
            const programId = new web3_js_1.PublicKey(swapProgramId);
            const instruction = new web3_js_1.TransactionInstruction({ keys, programId, data });
            // load relayer keypair
            const payer = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(relayerKeypairJson)));
            const tx = new web3_js_1.Transaction().add(instruction);
            tx.feePayer = payer.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash('finalized');
            tx.recentBlockhash = blockhash;
            const sig = await (0, web3_js_1.sendAndConfirmTransaction)(this.connection, tx, [payer], { commitment: 'confirmed' });
            return { hash: sig, success: true, blockNumber: 0 };
        }
        // Fallback to simulated in-memory pool swap (demo)
        const pools = cfg.pools;
        if (!pools || !Array.isArray(pools))
            throw new Error('executeSwap not implemented for Solana adapter');
        const poolIndex = pools.findIndex((p) => {
            const a = String(p.tokenA).toLowerCase();
            const b = String(p.tokenB).toLowerCase();
            const inT = inputToken.toLowerCase();
            const outT = outputToken.toLowerCase();
            return (a === inT && b === outT) || (a === outT && b === inT);
        });
        if (poolIndex === -1)
            throw new Error('No pool found for provided tokens');
        const pool = pools[poolIndex];
        const isTokenA = pool.tokenA.toLowerCase() === inputToken.toLowerCase();
        const reserveA = BigInt(pool.reserveA.toString());
        const reserveB = BigInt(pool.reserveB.toString());
        const reserveIn = isTokenA ? reserveA : reserveB;
        const reserveOut = isTokenA ? reserveB : reserveA;
        const amountIn = BigInt(amount);
        if (amountIn <= 0n)
            throw new Error('Invalid amount');
        const amountInWithFee = amountIn * 997n;
        const numerator = amountInWithFee * reserveOut;
        const denominator = reserveIn * 1000n + amountInWithFee;
        const amountOut = numerator / denominator;
        if (isTokenA) {
            pool.reserveA = (reserveA + amountIn).toString();
            pool.reserveB = (reserveB - amountOut).toString();
        }
        else {
            pool.reserveB = (reserveB + amountIn).toString();
            pool.reserveA = (reserveA - amountOut).toString();
        }
        const txSig = `SIMULATED-SOLANA-TX-${Math.floor(Math.random() * 1e9)}`;
        return { hash: txSig, success: true, blockNumber: 0 };
    }
    async addLiquidity(tokenA, tokenB, amountA, amountB) {
        throw new Error('addLiquidity not implemented for Solana adapter');
    }
    async removeLiquidity(tokenA, tokenB, lpTokenAmount) {
        throw new Error('removeLiquidity not implemented for Solana adapter');
    }
    async playFizzCaps(number) {
        throw new Error('playFizzCaps not implemented for Solana adapter');
    }
    async claimRewards() {
        throw new Error('claimRewards not implemented for Solana adapter');
    }
    async getPlayerStats(address) {
        throw new Error('getPlayerStats not implemented for Solana adapter');
    }
    async initiateBridge(targetChain, token, amount, recipientAddress) {
        throw new Error('initiateBridge not implemented for Solana adapter');
    }
    async completeBridge(bridgeId, proof) {
        throw new Error('completeBridge not implemented for Solana adapter');
    }
    async signMessage(message) {
        if (!this.keypair)
            throw new Error('No keypair for signing');
        try {
            const nacl = require('tweetnacl');
            const sig = nacl.sign.detached(Buffer.from(message), this.keypair.secretKey);
            return Buffer.from(sig).toString('base64');
        }
        catch (e) {
            throw new Error('Signing requires tweetnacl dependency');
        }
    }
    async verifySignature(message, signature, address) {
        throw new Error('verifySignature not implemented');
    }
}
exports.SolanaAdapter = SolanaAdapter;
