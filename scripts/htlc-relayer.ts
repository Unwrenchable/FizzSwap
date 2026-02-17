/*
  HTLC Relayer (helper/observer)
  - Listens for `AtomicSwapInitiated` events on the EVM `FizzDex` contract
  - Prints instructions for the counterparty to create the matching Solana HTLC
  - Optional: optional automated action to create Solana swap when a private key is configured (UNTRUSTED helper)

  Usage: `ts-node scripts/htlc-relayer.ts --evmRpc <RPC> --fizzDex <address> --solanaRpc <RPC>`

  NOTE: This script is a convenience helper only — the HTLC protocol remains trustless.
*/

import { ethers } from "ethers";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("evmRpc", { type: "string", demandOption: true })
  .option("fizzDex", { type: "string", demandOption: true })
  .help().argv as any;

const FIZZDEX_ABI = [
  "event AtomicSwapInitiated(bytes32 indexed swapId, address indexed initiator, address participant, uint256 amount)",
  "function atomicSwaps(bytes32) view returns (address initiator, address participant, address token, uint256 amount, bytes32 secretHash, uint256 timelock, bool completed, bool refunded)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(argv.evmRpc);
  const fizz = new ethers.Contract(argv.fizzDex, FIZZDEX_ABI, provider);

  console.log("Listening for AtomicSwapInitiated events on:", argv.fizzDex);

  fizz.on("AtomicSwapInitiated", async (swapId: string, initiator: string, participant: string, amount: ethers.BigNumber, event: any) => {
    console.log("\n== AtomicSwapInitiated ==");
    console.log("swapId:", swapId);
    console.log("initiator:", initiator);
    console.log("participant:", participant);
    console.log("amount:", ethers.formatEther(amount));

    // fetch full swap details (if available)
    try {
      const data = await fizz.atomicSwaps(swapId);
      console.log("token:", data.token);
      console.log("secretHash:", data.secretHash);
      console.log("timelock:", data.timelock.toString());
    } catch (err) {
      console.warn("could not read atomicSwaps mapping (ABI mismatch?)", err);
    }

    console.log("\nNext steps for participant on Solana:");
    console.log("1) Create a matching HTLC on Solana using the same secretHash and timelock");
    console.log("2) When initiator claims on Solana and reveals the secret, use that preimage to call completeAtomicSwap on EVM (or vice versa)");
    console.log("3) If timelock expires, call refundAtomicSwap on the chain where you locked funds.");
  });

  // keep process alive
  process.stdin.resume();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
