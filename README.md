# FizzSwap - Universal Multi-Chain DEX 🚀

> A **safe, awesome DEX that can handle ANY blockchain** - built for the Atomic Fizz Caps ecosystem

## 🎯 Ecosystem Integration

FizzSwap is the official DEX for the [ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS](https://github.com/Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS) ecosystem. Trade, earn, and play across any blockchain with full integration support.

📖 See [ECOSYSTEM_INTEGRATION.md](./ECOSYSTEM_INTEGRATION.md) for detailed integration information.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-orange.svg)](https://soliditylang.org/)
[![Rust](https://img.shields.io/badge/Rust-Anchor-red.svg)](https://www.anchor-lang.com/)

## 🌟 Overview

FizzDex is a decentralized exchange that seamlessly integrates with the [ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS](https://github.com/Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS) ecosystem, supporting trading, liquidity provision, and the Fizz Caps game across **any blockchain**.

### ✨ Key Features

- 🔒 **Security First**: Reentrancy guards, overflow protection, emergency pause, and comprehensive safety checks
- 🌐 **Universal Multi-Chain**: Works with EVM chains, Solana, XRP Ledger, and any blockchain via adapter pattern
- 🎮 **Integrated Gaming**: Play Fizz Caps and earn FIZZ tokens while trading
- 🌉 **Cross-Chain Bridges**: Atomic swaps and bridges for seamless multi-chain operations
- ⚡ **Gas Optimized**: Efficient smart contracts minimize transaction costs
- 🛡️ **Audited**: Security-focused architecture with best practices

### 🔗 Supported Blockchains

- **EVM Chains**: Ethereum, Polygon, BSC, Base, Arbitrum, Optimism, Avalanche, Fantom, and 20+ more
- **Solana**: High-performance DEX with native SPL token support
- **XRP Ledger**: Integration with XRPL DEX features
- **Coming Soon**: Cosmos, Polkadot, and more via universal adapter

## 🚀 Quick Start

### Installation

```bash
npm install fizzdex
```

### Basic Usage

```typescript
import { MultiChainDEX } from 'fizzdex';

// Initialize DEX
const dex = new MultiChainDEX();

// Add Ethereum
await dex.addChain({
  chainId: '1',
  chainName: 'Ethereum',
  chainType: 'evm',
  rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
});

// Execute swap
const adapter = dex.getAdapter('1');
await adapter.executeSwap(USDC, DAI, '1000000000', '995000000', 0.5);

// Play Fizz Caps
await adapter.playFizzCaps(15); // FizzBuzz!
```

## 📚 Documentation

- [**Full Documentation**](./docs/README.md) - Complete guide and architecture
- [**Deployment Guide**](./docs/DEPLOYMENT.md) - How to deploy to any chain
- [**Examples**](./docs/EXAMPLE.md) - Code examples and tutorials
- [**API Reference**](./docs/API.md) - Detailed API documentation

## 🏗️ Project Structure

```
fizzdex/
├── contracts/          # EVM smart contracts (Solidity)
├── programs/           # Solana programs (Rust/Anchor)
├── src/               # TypeScript SDK
│   ├── adapters/      # Chain-specific adapters
│   └── chain-adapter.ts  # Universal adapter interface
├── scripts/           # Deployment scripts
├── docs/              # Documentation
└── test/              # Tests
```

## 🔒 Security Features

- ✅ Reentrancy protection on all state changes
- ✅ Overflow/underflow protection with checked math
- ✅ Emergency pause mechanism
- ✅ Slippage protection on swaps
- ✅ Input validation and sanitization
- ✅ Rate limiting and DOS protection
- ✅ Atomic swaps for trustless cross-chain trades

## 🎮 Fizz Caps Game

Integrated with the Atomic Fizz Caps ecosystem:

- **Fizz** (÷3): 10 FIZZ tokens
- **Buzz** (÷5): 15 FIZZ tokens  
- **FizzBuzz** (÷15): 50 FIZZ tokens
- Play on any supported chain
- Unified stats and leaderboards
- 60-second cooldown between plays

## 🌉 Cross-Chain Support

- Atomic swaps via HTLC (Hash Time-Locked Contracts) — recommended: use the provided UI/relayer for cross-chain coordination
- Wormhole bridge integration
- LayerZero messaging (coming soon)
- Unified liquidity across chains

## 🛠️ Development

### Prerequisites

- Node.js 18+
- Rust + Anchor (for Solana)
- Hardhat

### Setup

```bash
# Install dependencies
npm install

# Compile contracts
npm run build

# Run tests
npm test

# Deploy to testnet
npm run deploy-evm -- --network sepolia
```

## 📝 Adding New Chains

FizzDex makes it easy to add support for ANY blockchain:

```typescript
import { IChainAdapter, ChainConfig } from 'fizzdex';

// 1. Implement the adapter
class MyChainAdapter implements IChainAdapter {
  // Implement interface methods
}

// 2. Register it
ChainAdapterFactory.registerAdapter('mychain', MyChainAdapter);

// 3. Use it
await dex.addChain({
  chainId: 'mychain-1',
  chainType: 'other',
  // ... config
});
```

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md).

## 📜 License

MIT License - see [LICENSE](./LICENSE)

## 🔗 Links

- **Atomic Fizz Caps**: https://github.com/Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS
- **Documentation**: [./docs/README.md](./docs/README.md)
- **Discord**: https://discord.gg/fizzdex
- **Twitter**: https://twitter.com/fizzdex

## ⚠️ Disclaimer

FizzDex is provided "as is" without warranty. Always DYOR and never invest more than you can afford to lose. Use at your own risk.

---

**Built with ❤️ for the Atomic Fizz Caps community**

*"War. War never changes. But now you can trade while it doesn't change."* - Vault-Tec
