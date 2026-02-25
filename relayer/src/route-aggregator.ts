import { MultiChainDEX } from "./chain-adapter";

export class RouteAggregator {
  private dex: MultiChainDEX;

  constructor(dex: MultiChainDEX) {
    this.dex = dex;
  }

  /**
   * Query all connected chains for a quote and return the best output amount.
   * For cross-chain routes we currently estimate using the target chain's quote.
   */
  async findBestRoute(
    inputChain: string,
    outputChain: string,
    inputToken: string,
    outputToken: string,
    amount: string
  ) {
    const adapters = this.dex.getConnectedChains();
    const results: any[] = [];

    // 1) same-chain options
    try {
      const adapter = this.dex.getAdapter(inputChain);
      const quote = await adapter.getSwapQuote(inputToken, outputToken, amount);
      results.push({ chain: inputChain, quote, route: [inputChain] });
    } catch (e) {
      // ignore
    }

    // 2) other chains (estimate by asking target chain for quote)
    for (const cfg of adapters) {
      if (cfg.chainId === inputChain) continue;
      try {
        const adapter = this.dex.getAdapter(cfg.chainId);
        const quote = await adapter.getSwapQuote(inputToken, outputToken, amount);
        results.push({ chain: cfg.chainId, quote, route: [inputChain, cfg.chainId] });
      } catch (e) {
        // ignore
      }
    }

    // pick best outputAmount (numeric compare)
    results.sort((a, b) => {
      const A = BigInt(a.quote.outputAmount);
      const B = BigInt(b.quote.outputAmount);
      if (A > B) return -1;
      if (A < B) return 1;
      return 0;
    });

    return results[0] || null;
  }
}
