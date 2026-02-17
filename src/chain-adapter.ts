/**
 * Universal Chain Adapter Interface
 * 
 * This interface allows FizzDex to support ANY blockchain by implementing
 * a standardized adapter pattern. Add support for new chains by creating
 * a new adapter that implements this interface.
 */

export interface ChainConfig {
  chainId: string;
  chainName: string;
  chainType: 'evm' | 'solana' | 'cosmos' | 'substrate' | 'xrp' | 'other';
  rpcUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  explorerUrl?: string;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
}

export interface SwapQuote {
  inputToken: TokenInfo;
  outputToken: TokenInfo;
  inputAmount: string;
  outputAmount: string;
  priceImpact: number;
  fee: string;
  route: string[];
  estimatedGas: string;
}

export interface TransactionResult {
  hash: string;
  success: boolean;
  blockNumber?: number;
  gasUsed?: string;
  error?: string;
}

/**
 * Universal Chain Adapter Interface
 * Implement this interface to add support for any blockchain
 */
export interface IChainAdapter {
  // Chain information
  getChainInfo(): ChainConfig;
  
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  // Wallet integration
  getWalletAddress(): Promise<string>;
  getBalance(tokenAddress?: string): Promise<string>;
  
  // DEX operations
  getSwapQuote(
    inputToken: string,
    outputToken: string,
    amount: string
  ): Promise<SwapQuote>;
  
  executeSwap(
    inputToken: string,
    outputToken: string,
    amount: string,
    minOutputAmount: string,
    slippage: number
  ): Promise<TransactionResult>;
  
  addLiquidity(
    tokenA: string,
    tokenB: string,
    amountA: string,
    amountB: string
  ): Promise<TransactionResult>;
  
  removeLiquidity(
    tokenA: string,
    tokenB: string,
    lpTokenAmount: string
  ): Promise<TransactionResult>;
  
  // Fizz Caps game integration
  playFizzCaps(number: number): Promise<TransactionResult>;
  claimRewards(): Promise<TransactionResult>;
  getPlayerStats(address: string): Promise<{
    score: number;
    fizzCount: number;
    buzzCount: number;
    fizzBuzzCount: number;
    rewardBalance: string;
  }>;
  
  // Cross-chain bridge operations
  initiateBridge(
    targetChain: string,
    token: string,
    amount: string,
    recipientAddress: string
  ): Promise<TransactionResult>;
  
  completeBridge(
    bridgeId: string,
    proof: string
  ): Promise<TransactionResult>;
  
  // Utility functions
  signMessage(message: string): Promise<string>;
  verifySignature(message: string, signature: string, address: string): Promise<boolean>;
}

/**
 * Chain Adapter Factory
 * Automatically selects and creates the appropriate adapter for a chain
 */
export class ChainAdapterFactory {
  private static adapters: Map<string, new (config: ChainConfig) => IChainAdapter> = new Map();
  
  /**
   * Register a new chain adapter
   */
  static registerAdapter(
    chainType: string,
    adapterClass: new (config: ChainConfig) => IChainAdapter
  ): void {
    this.adapters.set(chainType, adapterClass);
  }
  
  /**
   * Create an adapter for a specific chain
   */
  static createAdapter(config: ChainConfig): IChainAdapter {
    const AdapterClass = this.adapters.get(config.chainType);
    if (!AdapterClass) {
      throw new Error(`No adapter registered for chain type: ${config.chainType}`);
    }
    return new AdapterClass(config);
  }
  
  /**
   * Get list of supported chain types
   */
  static getSupportedChains(): string[] {
    return Array.from(this.adapters.keys());
  }
}

/**
 * Multi-chain DEX Manager
 * Manages operations across multiple chains
 */
export class MultiChainDEX {
  private adapters: Map<string, IChainAdapter> = new Map();
  
  /**
   * Add a chain to the DEX
   */
  async addChain(config: ChainConfig): Promise<void> {
    const adapter = ChainAdapterFactory.createAdapter(config);
    await adapter.connect();
    this.adapters.set(config.chainId, adapter);
  }
  
  /**
   * Get adapter for a specific chain
   */
  getAdapter(chainId: string): IChainAdapter {
    const adapter = this.adapters.get(chainId);
    if (!adapter) {
      throw new Error(`No adapter found for chain: ${chainId}`);
    }
    return adapter;
  }
  
  /**
   * Execute cross-chain swap
   */
  async crossChainSwap(
    sourceChain: string,
    targetChain: string,
    inputToken: string,
    outputToken: string,
    amount: string,
    slippage: number
  ): Promise<TransactionResult[]> {
    const sourceAdapter = this.getAdapter(sourceChain);
    const targetAdapter = this.getAdapter(targetChain);
    
    const results: TransactionResult[] = [];
    
    // Step 1: Initiate bridge from source chain
    const bridgeResult = await sourceAdapter.initiateBridge(
      targetChain,
      inputToken,
      amount,
      await targetAdapter.getWalletAddress()
    );
    results.push(bridgeResult);
    
    if (!bridgeResult.success) {
      throw new Error(`Bridge initiation failed: ${bridgeResult.error}`);
    }
    
    // Step 2: Complete bridge on target chain (simplified - real implementation needs relayer)
    // In production, this would be handled by a bridge relayer service
    
    // Step 3: Execute swap on target chain
    const quote = await targetAdapter.getSwapQuote(inputToken, outputToken, amount);
    const minOutput = (BigInt(quote.outputAmount) * BigInt(10000 - slippage * 100) / BigInt(10000)).toString();
    
    const swapResult = await targetAdapter.executeSwap(
      inputToken,
      outputToken,
      amount,
      minOutput,
      slippage
    );
    results.push(swapResult);
    
    return results;
  }
  
  /**
   * Get aggregated stats across all chains
   */
  async getAggregatedStats(address: string): Promise<{
    totalVolume: string;
    totalRewards: string;
    chains: Record<string, any>;
  }> {
    const stats: any = {
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
  getConnectedChains(): ChainConfig[] {
    return Array.from(this.adapters.values()).map(adapter => adapter.getChainInfo());
  }
}

/**
 * Security utilities for safe operations
 */
export class SecurityUtils {
  /**
   * Validate address format for any chain
   */
  static validateAddress(address: string, chainType: string): boolean {
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
  static calculateSafeSlippage(priceImpact: number): number {
    // Dynamic slippage based on price impact
    if (priceImpact < 0.01) return 0.5;  // 0.5% for low impact
    if (priceImpact < 0.03) return 1.0;  // 1% for medium impact
    if (priceImpact < 0.05) return 2.0;  // 2% for high impact
    return 5.0;  // 5% for very high impact (warning should be shown)
  }
  
  /**
   * Validate transaction parameters
   */
  static validateSwapParams(params: {
    amount: string;
    minOutput: string;
    slippage: number;
  }): { valid: boolean; error?: string } {
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
  static sanitizeInput(input: string): string {
    return input.trim().replace(/[^\w\s.-]/gi, '');
  }
}
