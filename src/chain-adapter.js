"use strict";
/**
 * Universal Chain Adapter Interface
 *
 * This interface allows FizzDex to support ANY blockchain by implementing
 * a standardized adapter pattern. Add support for new chains by creating
 * a new adapter that implements this interface.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityUtils = exports.MultiChainDEX = exports.ChainAdapterFactory = void 0;
/**
 * Chain Adapter Factory
 * Automatically selects and creates the appropriate adapter for a chain
 */
class ChainAdapterFactory {
    /**
     * Register a new chain adapter
     */
    static registerAdapter(chainType, adapterClass) {
        this.adapters.set(chainType, adapterClass);
    }
    /**
     * Create an adapter for a specific chain
     */
    static createAdapter(config) {
        const AdapterClass = this.adapters.get(config.chainType);
        if (!AdapterClass) {
            throw new Error(`No adapter registered for chain type: ${config.chainType}`);
        }
        return new AdapterClass(config);
    }
    /**
     * Get list of supported chain types
     */
    static getSupportedChains() {
        return Array.from(this.adapters.keys());
    }
}
exports.ChainAdapterFactory = ChainAdapterFactory;
ChainAdapterFactory.adapters = new Map();
// Register built-in adapters (EVM + Solana)
const evm_adapter_1 = require("./adapters/evm-adapter");
const solana_adapter_1 = require("./adapters/solana-adapter");
ChainAdapterFactory.registerAdapter('evm', evm_adapter_1.EvmAdapter);
ChainAdapterFactory.registerAdapter('solana', solana_adapter_1.SolanaAdapter);
/**
 * Multi-chain DEX Manager
 * Manages operations across multiple chains
 */
class MultiChainDEX {
    constructor() {
        this.adapters = new Map();
    }
    /**
     * Add a chain to the DEX
     */
    async addChain(config) {
        const adapter = ChainAdapterFactory.createAdapter(config);
        await adapter.connect();
        this.adapters.set(config.chainId, adapter);
    }
    /**
     * Get adapter for a specific chain
     */
    getAdapter(chainId) {
        const adapter = this.adapters.get(chainId);
        if (!adapter) {
            throw new Error(`No adapter found for chain: ${chainId}`);
        }
        return adapter;
    }
    /**
     * Execute cross-chain swap
     */
    async crossChainSwap(sourceChain, targetChain, inputToken, outputToken, amount, slippage) {
        const sourceAdapter = this.getAdapter(sourceChain);
        const targetAdapter = this.getAdapter(targetChain);
        const results = [];
        // Step 1: Initiate bridge from source chain
        const bridgeResult = await sourceAdapter.initiateBridge(targetChain, inputToken, amount, await targetAdapter.getWalletAddress());
        results.push(bridgeResult);
        if (!bridgeResult.success) {
            throw new Error(`Bridge initiation failed: ${bridgeResult.error}`);
        }
        // Step 2: Complete bridge on target chain (simplified - real implementation needs relayer)
        // In production, this would be handled by a bridge relayer service
        // Step 3: Execute swap on target chain
        const quote = await targetAdapter.getSwapQuote(inputToken, outputToken, amount);
        const minOutput = (BigInt(quote.outputAmount) * BigInt(10000 - slippage * 100) / BigInt(10000)).toString();
        const swapResult = await targetAdapter.executeSwap(inputToken, outputToken, amount, minOutput, slippage);
        results.push(swapResult);
        return results;
    }
    /**
     * Get aggregated stats across all chains
     */
    async getAggregatedStats(address) {
        const stats = {
            totalVolume: '0',
            totalRewards: '0',
            chains: {}
        };
        for (const [chainId, adapter] of this.adapters.entries()) {
            const chainInfo = adapter.getChainInfo();
            const playerStats = await adapter.getPlayerStats(address);
            stats.chains[chainId] = {
                chainName: chainInfo.chainName,
                ...playerStats
            };
            stats.totalRewards = (BigInt(stats.totalRewards) + BigInt(playerStats.rewardBalance)).toString();
        }
        return stats;
    }
    /**
     * List all connected chains
     */
    getConnectedChains() {
        return Array.from(this.adapters.values()).map(adapter => adapter.getChainInfo());
    }
}
exports.MultiChainDEX = MultiChainDEX;
/**
 * Security utilities for safe operations
 */
class SecurityUtils {
    /**
     * Validate address format for any chain
     */
    static validateAddress(address, chainType) {
        switch (chainType) {
            case 'evm':
                return /^0x[a-fA-F0-9]{40}$/.test(address);
            case 'solana':
                return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
            case 'cosmos':
                return /^(cosmos|osmo|juno|stars)[a-z0-9]{39}$/.test(address);
            case 'xrp':
                return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
            default:
                return address.length > 0;
        }
    }
    /**
     * Calculate safe slippage for swap
     */
    static calculateSafeSlippage(priceImpact) {
        // Dynamic slippage based on price impact
        if (priceImpact < 0.01)
            return 0.5; // 0.5% for low impact
        if (priceImpact < 0.03)
            return 1.0; // 1% for medium impact
        if (priceImpact < 0.05)
            return 2.0; // 2% for high impact
        return 5.0; // 5% for very high impact (warning should be shown)
    }
    /**
     * Validate transaction parameters
     */
    static validateSwapParams(params) {
        if (BigInt(params.amount) <= 0) {
            return { valid: false, error: 'Amount must be greater than 0' };
        }
        if (BigInt(params.minOutput) <= 0) {
            return { valid: false, error: 'Minimum output must be greater than 0' };
        }
        if (params.slippage < 0 || params.slippage > 50) {
            return { valid: false, error: 'Slippage must be between 0 and 50%' };
        }
        return { valid: true };
    }
    /**
     * Sanitize user input
     */
    static sanitizeInput(input) {
        return input.trim().replace(/[^\w\s.-]/gi, '');
    }
}
exports.SecurityUtils = SecurityUtils;
