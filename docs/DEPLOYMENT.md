# FizzDex Deployment Guide

## Prerequisites

- Node.js 18+ installed
- Wallet with funds for gas fees
- RPC endpoints for target chains
- Private key for deployment wallet (keep secure!)

## Environment Setup

Create a `.env` file in the project root:

```bash
# EVM Chains
PRIVATE_KEY=your_private_key_here
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_RPC_URL=https://polygon-rpc.com
BSC_RPC_URL=https://bsc-dataseed.binance.org
BASE_RPC_URL=https://mainnet.base.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WALLET_PATH=~/.config/solana/id.json

# XRP
XRP_SECRET=your_xrp_secret
XRP_RPC_URL=wss://xrplcluster.com

# Etherscan API keys for verification
ETHERSCAN_API_KEY=your_key
POLYGONSCAN_API_KEY=your_key
BSCSCAN_API_KEY=your_key
```

**⚠️ SECURITY WARNING**: Never commit `.env` file to version control!

## Deploying to EVM Chains

### 1. Install Dependencies

```bash
npm install
```

### 2. Compile Contracts

```bash
npm run build
```

### 3. Deploy to Ethereum Mainnet

```bash
npx hardhat run scripts/deploy-evm.ts --network ethereum
```

### 4. Deploy to Other EVM Chains

```bash
# Polygon
npx hardhat run scripts/deploy-evm.ts --network polygon

# BSC
npx hardhat run scripts/deploy-evm.ts --network bsc

# Base
npx hardhat run scripts/deploy-evm.ts --network base

# Arbitrum
npx hardhat run scripts/deploy-evm.ts --network arbitrum
```

### 5. Verify Contracts

```bash
npx hardhat verify --network ethereum FIZZDEX_ADDRESS REWARD_TOKEN_ADDRESS
```

## Deploying to Solana

### 1. Install Solana CLI

```bash
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
```

### 2. Configure Wallet

```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/id.json
```

### 3. Build Program

```bash
cd programs/fizzdex-solana
cargo build-bpf
```

### 4. Deploy Program

```bash
solana program deploy target/deploy/fizzdex_solana.so
```

### 5. Initialize DEX

```bash
# Use the Solana SDK to call initialize instruction
# See Solana documentation for details
```

## Deploying to XRP Ledger

### 1. Setup XRP Wallet

```bash
# Create or import wallet
npm run xrp:setup-wallet
```

### 2. Deploy Hooks

```bash
# Deploy XRPL hooks for DEX functionality
npm run xrp:deploy-hooks
```

## Post-Deployment Setup

### 1. Create Initial Pools

```bash
# Create USDC/DAI pool on Ethereum
npm run create-pool -- --chain ethereum --tokenA USDC --tokenB DAI
```

### 2. Add Initial Liquidity

```bash
npm run add-liquidity -- --chain ethereum --tokenA USDC --tokenB DAI --amountA 10000 --amountB 10000
```

### 3. Fund Reward Pools

```bash
# Fund with FIZZ tokens for game rewards
npm run fund-rewards -- --chain ethereum --amount 100000000
```

### 4. Configure Cross-Chain Bridges

```bash
# Set up Wormhole integration
npm run setup-bridge -- --source ethereum --target polygon
```

## Network Configurations

### Hardhat Config

Update `hardhat.config.ts` with your network settings:

```typescript
networks: {
  ethereum: {
    url: process.env.ETH_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
    chainId: 1
  },
  polygon: {
    url: process.env.POLYGON_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
    chainId: 137
  },
  bsc: {
    url: process.env.BSC_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
    chainId: 56
  },
  base: {
    url: process.env.BASE_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
    chainId: 8453
  }
}
```

## Testing Deployment

### 1. Run Integration Tests

```bash
npm run test:integration
```

### 2. Test Swap

```bash
npm run test:swap -- --chain ethereum --amount 1000
```

### 3. Test Game

```bash
npm run test:game -- --chain ethereum --number 15
```

## Security Checklist

Before going live, ensure:

- [ ] All contracts are verified on block explorers
- [ ] Ownership is transferred to multi-sig wallet
- [ ] Emergency pause is tested and working
- [ ] Rate limiting is configured
- [ ] Bug bounty program is active
- [ ] Audit reports are published
- [ ] Insurance coverage is in place (if applicable)

## Monitoring

Set up monitoring for:

- Transaction volumes
- Gas prices
- Pool liquidity levels
- Game participation
- Cross-chain bridge status
- Smart contract events
- Unusual activity patterns

## Upgrading

FizzDex uses a proxy pattern for upgradability:

```bash
# Upgrade implementation
npm run upgrade -- --chain ethereum --new-impl NEW_ADDRESS
```

## Troubleshooting

### Gas Issues
- Increase gas limit in hardhat config
- Use gas price oracle for dynamic pricing
- Consider L2 deployment for lower fees

### Connection Issues
- Verify RPC endpoints are active
- Check firewall settings
- Use backup RPC providers

### Contract Verification
- Ensure compiler version matches
- Include all constructor arguments
- Use flatten command if needed

## Support

- Documentation: https://fizzdex.io/docs
- Discord: https://discord.gg/fizzdex
- GitHub Issues: https://github.com/Unwrenchable/fizzdex/issues
- Email: support@fizzdex.io

## Deployment Costs (Approximate)

| Chain | Gas Cost | USD (approx) |
|-------|----------|--------------|
| Ethereum | 3-5M gas | $100-500 |
| Polygon | 3-5M gas | $1-5 |
| BSC | 3-5M gas | $5-20 |
| Base | 3-5M gas | $5-20 |
| Arbitrum | 3-5M gas | $10-30 |
| Solana | 10 SOL | $200-500 |

*Costs vary based on network congestion*

## Next Steps

After successful deployment:

1. Announce deployment on social media
2. List on DEX aggregators
3. Submit to token lists
4. Create trading pairs
5. Launch liquidity mining program
6. Integrate with Atomic Fizz Caps game
7. Apply for grants and partnerships

---

**Need Help?** Join our Discord community or open a GitHub issue!
