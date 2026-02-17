import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 1337
    },
    // Add your network configurations here
    // ethereum: { url: process.env.ETH_RPC_URL, accounts: [...] },
    // polygon: { url: process.env.POLYGON_RPC_URL, accounts: [...] },
  }
};

export default config;
