"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvmAdapter = void 0;
const ethers_1 = require("ethers");
const FIZZDEX_ABI = [
    "function getPoolId(address,address) public pure returns (bytes32)",
    "function pools(bytes32) view returns (address tokenA, address tokenB, uint256 reserveA, uint256 reserveB, uint256 totalShares)",
    "function swap(address,address,uint256,uint256) external returns (uint256)",
    "function addLiquidity(address,address,uint256,uint256) external returns (uint256)",
    "function removeLiquidity(address,address,uint256) external returns (uint256,uint256)",
    "function playFizzCaps(uint256) external",
    "function claimRewards() external",
    "function getPlayerStats(address) view returns (uint256,uint256,uint256,uint256,uint256)",
    "function initiateAtomicSwap(address,address,uint256,bytes32,uint256) returns (bytes32)",
    "function completeAtomicSwap(bytes32, bytes) external",
];
class EvmAdapter {
    constructor(config, providerOverride) {
        this.config = config;
        this.provider = providerOverride ?? new ethers_1.ethers.JsonRpcProvider(config.rpcUrl);
    }
    getChainInfo() {
        return this.config;
    }
    async connect() {
        // If a PRIVATE_KEY env is set, use it for programmatic signing; otherwise no signer.
        const pk = process.env.PRIVATE_KEY;
        if (pk) {
            this.signer = new ethers_1.ethers.Wallet(pk, this.provider);
        }
    }
    disconnect() {
        this.signer = undefined;
        return Promise.resolve();
    }
    isConnected() {
        return !!this.provider;
    }
    async getWalletAddress() {
        if (!this.signer)
            throw new Error("No signer configured for EVM adapter");
        return await this.signer.getAddress();
    }
    async getBalance(tokenAddress) {
        if (!tokenAddress) {
            if (!this.signer)
                throw new Error("No signer configured for EVM adapter");
            const addr = await this.signer.getAddress();
            const balance = await this.provider.getBalance(addr);
            return balance.toString();
        }
        const erc20 = new ethers_1.ethers.Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], this.provider);
        const bal = await erc20.balanceOf(await this.signer?.getAddress());
        return bal.toString();
    }
    setContract(address) {
        this.contractAddress = address;
        this.contract = new ethers_1.ethers.Contract(address, FIZZDEX_ABI, this.signer ?? this.provider);
    }
    getPoolId(tokenA, tokenB) {
        const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
        // abi.encodePacked(address,address) equivalent: concat raw 20-byte addresses
        const packed = `0x${t0.replace(/^0x/, "")}${t1.replace(/^0x/, "")}`.toLowerCase();
        return ethers_1.ethers.keccak256(packed);
    }
    formatTokenInfo(address) {
        return { address, symbol: "TOKEN", name: "Token", decimals: 18 };
    }
    async getSwapQuote(inputToken, outputToken, amount) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        const poolId = this.getPoolId(inputToken, outputToken);
        const pool = await this.contract.pools(poolId);
        // pool returns (tokenA, tokenB, reserveA, reserveB, totalShares)
        const tokenA = pool[0];
        const reserveA = BigInt(pool[2].toString());
        const reserveB = BigInt(pool[3].toString());
        const isTokenA = inputToken.toLowerCase() === tokenA.toLowerCase();
        const reserveIn = isTokenA ? reserveA : reserveB;
        const reserveOut = isTokenA ? reserveB : reserveA;
        const amountIn = BigInt(amount);
        if (amountIn <= 0n)
            throw new Error("Invalid amount");
        // amountInWithFee = amountIn * 997 / 1000
        const amountInWithFee = amountIn * 997n;
        const numerator = amountInWithFee * BigInt(reserveOut.toString());
        const denominator = BigInt(reserveIn.toString()) * 1000n + amountInWithFee;
        const amountOut = numerator / denominator;
        const quote = {
            inputToken: this.formatTokenInfo(inputToken),
            outputToken: this.formatTokenInfo(outputToken),
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
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available for executeSwap");
        // Approve input token
        const erc20 = new ethers_1.ethers.Contract(inputToken, ["function approve(address,uint256) returns (bool)"], this.signer);
        await erc20.approve(this.contractAddress, amount);
        try {
            const tx = await this.contract.swap(inputToken, outputToken, amount, minOutputAmount || '0');
            const receipt = await tx.wait();
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed?.toString() };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async addLiquidity(tokenA, tokenB, amountA, amountB) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available");
        const ercA = new ethers_1.ethers.Contract(tokenA, ["function approve(address,uint256) returns (bool)"], this.signer);
        const ercB = new ethers_1.ethers.Contract(tokenB, ["function approve(address,uint256) returns (bool)"], this.signer);
        await ercA.approve(this.contractAddress, amountA);
        await ercB.approve(this.contractAddress, amountB);
        try {
            const tx = await this.contract.addLiquidity(tokenA, tokenB, amountA, amountB);
            const receipt = await tx.wait();
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async removeLiquidity(tokenA, tokenB, lpTokenAmount) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available");
        try {
            const tx = await this.contract.removeLiquidity(tokenA, tokenB, lpTokenAmount);
            const receipt = await tx.wait();
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async playFizzCaps(number) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available");
        try {
            const tx = await this.contract.playFizzCaps(number);
            const receipt = await tx.wait();
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async claimRewards() {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available");
        try {
            const tx = await this.contract.claimRewards();
            const receipt = await tx.wait();
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async getPlayerStats(address) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        const stats = await this.contract.getPlayerStats(address);
        return {
            score: Number(stats[0].toString()),
            fizzCount: Number(stats[1].toString()),
            buzzCount: Number(stats[2].toString()),
            fizzBuzzCount: Number(stats[3].toString()),
            rewardBalance: stats[4].toString()
        };
    }
    // Bridge via HTLC (EVM-side)
    async initiateBridge(targetChain, token, amount, recipientAddress) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available");
        // Generate secret and return it to caller (caller must create matching HTLC on target chain)
        const secret = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(16));
        const secretHash = ethers_1.ethers.keccak256(secret);
        const timelock = Math.floor(Date.now() / 1000) + 3600; // 1 hour
        try {
            const tx = await this.contract.initiateAtomicSwap(recipientAddress, token, amount, secretHash, timelock);
            const receipt = await tx.wait();
            // IMPORTANT: Do NOT return plaintext secrets. Return only non-sensitive metadata.
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber, meta: { secretHash, timelock } };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async completeBridge(bridgeId, proof) {
        if (!this.contract)
            throw new Error("Contract not set on adapter");
        if (!this.signer)
            throw new Error("No signer available");
        try {
            const tx = await this.contract.completeAtomicSwap(bridgeId, ethers_1.ethers.toUtf8Bytes(proof));
            const receipt = await tx.wait();
            return { hash: tx.hash, success: true, blockNumber: receipt.blockNumber };
        }
        catch (err) {
            return { hash: '', success: false, error: err?.message || String(err) };
        }
    }
    async signMessage(message) {
        if (!this.signer)
            throw new Error("No signer available");
        return await this.signer.signMessage(message);
    }
    async verifySignature(message, signature, address) {
        const recovered = ethers_1.ethers.verifyMessage(message, signature);
        return recovered.toLowerCase() === address.toLowerCase();
    }
}
exports.EvmAdapter = EvmAdapter;
