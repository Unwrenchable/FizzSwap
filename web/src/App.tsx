import React, { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const FIZZDEX_ABI = [
  "function getPoolId(address,address) pure returns (bytes32)",
  "function initiateAtomicSwap(address,address,uint256,bytes32,uint256) returns (bytes32)",
  "event AtomicSwapInitiated(bytes32 indexed swapId, address indexed initiator, address participant, uint256 amount)",
  "event Swap(bytes32 indexed poolId, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
];

const FIZZDEX_FULL_ABI = [
  ...FIZZDEX_ABI,
  "function addLiquidity(address,address,uint256,uint256) returns (uint256)",
  "function removeLiquidity(address,address,uint256) returns (uint256,uint256)",
  "function swap(address,address,uint256,uint256) returns (uint256)",
  "function playFizzCaps(uint256)",
  "function claimRewards()",
  "function getPlayerStats(address) view returns (uint256,uint256,uint256,uint256,uint256)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shortAddr(addr: string | null) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

type FizzResult = {
  label: "FizzBuzz" | "Fizz" | "Buzz" | "—";
  reward: "50" | "10" | "15" | "—";
  color: string;
  badgeClass: string;
  bigClass: string;
};

function fizzBuzzPreview(n: number): FizzResult {
  if (n % 15 === 0) return { label: "FizzBuzz", reward: "50", color: "#f3c84b", badgeClass: "badge-fizzbuzz", bigClass: "fizzbuzz" };
  if (n % 3  === 0) return { label: "Fizz",     reward: "10", color: "#4eff91", badgeClass: "badge-fizz",     bigClass: "fizz"     };
  if (n % 5  === 0) return { label: "Buzz",     reward: "15", color: "#ff6b6b", badgeClass: "badge-buzz",     bigClass: "buzz"     };
  return              { label: "—",         reward: "—",  color: "#8a9e8d", badgeClass: "badge-miss",     bigClass: "miss"     };
}

// ─── Web Crypto helper (replaces Node.js require("crypto") for browser) ──────
async function anchorDisc(name: string): Promise<Buffer> {
  const encoded = new TextEncoder().encode(name);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Buffer.from(hash).slice(0, 8);
}

// ─── Component ────────────────────────────────────────────────────────────────
type Tab = "swap" | "pool" | "fizzcaps" | "bridge";

export default function App() {
  // ── Wallet / provider ───────────────────────────────────────────────────
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer,   setSigner]   = useState<ethers.Signer | null>(null);
  const [account,  setAccount]  = useState<string | null>(null);
  const [phantomPubkey, setPhantomPubkey] = useState<string | null>(null);

  // ── Global state ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>("swap");
  const [fizzDexAddr, setFizzDexAddr] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);

  // ── HTLC / Bridge shared ────────────────────────────────────────────────
  const [secret,      setSecret]      = useState<string>("");
  const [participant, setParticipant] = useState<string>("");
  const [tokenAddr,   setTokenAddr]   = useState<string>("");
  const [amount,      setAmount]      = useState<string>("");
  const [timelock,    setTimelock]    = useState<number>(Math.floor(Date.now() / 1000) + 3600);
  const [chain,       setChain]       = useState<"evm" | "solana">("evm");
  const [solanaMint,  setSolanaMint]  = useState<string>("");

  // ── Complete / Claim HTLC ───────────────────────────────────────────────
  const [evmSwapId,       setEvmSwapId]       = useState<string>("");
  const [evmTxHash,       setEvmTxHash]       = useState<string>("");
  const [solAtomicSwapPda,  setSolAtomicSwapPda]  = useState<string>("");
  const [solEscrowVaultPda, setSolEscrowVaultPda] = useState<string>("");
  const [watchingSolana,    setWatchingSolana]    = useState<boolean>(false);
  const [autoCompleteOnReveal, setAutoCompleteOnReveal] = useState<boolean>(true);
  const solanaPollRef = useRef<number | null>(null);

  // ── Route aggregator ────────────────────────────────────────────────────
  const [outputToken,    setOutputToken]    = useState<string>("");
  const [routeChainList, setRouteChainList] = useState<string>(
    `[{"chainId":"local-evm","rpcUrl":"http://localhost:8545","fizzDexAddress":"","chainType":"evm"}]`
  );
  const [routeResults, setRouteResults] = useState<any[]>([]);
  const [isExecuting,  setIsExecuting]  = useState<boolean>(false);
  const [execResponse, setExecResponse] = useState<any>(null);

  // ── Swap tab ─────────────────────────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [swapChain,    setSwapChain]    = useState<"evm" | "solana">("evm");
  const [isSwapping,   setIsSwapping]   = useState<boolean>(false);

  // ── Pool tab ─────────────────────────────────────────────────────────────
  const [tokenAAddr,    setTokenAAddr]    = useState<string>("");
  const [tokenBAddr,    setTokenBAddr]    = useState<string>("");
  const [amountA,       setAmountA]       = useState<string>("");
  const [amountB,       setAmountB]       = useState<string>("");
  const [removeShares,  setRemoveShares]  = useState<string>("");
  const [poolFizzDex,   setPoolFizzDex]   = useState<string>("");
  const [isAddingLiq,   setIsAddingLiq]   = useState<boolean>(false);
  const [isRemoving,    setIsRemoving]    = useState<boolean>(false);

  // ── FizzCaps game ────────────────────────────────────────────────────────
  const [gameNumber,      setGameNumber]      = useState<number>(15);
  const [playerStats,     setPlayerStats]     = useState<any>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);
  const [isPlaying,       setIsPlaying]       = useState<boolean>(false);
  const [isClaiming,      setIsClaiming]      = useState<boolean>(false);
  const [gameFizzDex,     setGameFizzDex]     = useState<string>("");
  const [gameChain,       setGameChain]       = useState<"evm" | "solana">("evm");
  const cooldownIntervalRef = useRef<number | null>(null);

  // ── Bridge tab collapsibles ───────────────────────────────────────────────
  const [showCompleteHtlc, setShowCompleteHtlc]   = useState<boolean>(false);
  const [showAggregator,   setShowAggregator]     = useState<boolean>(false);
  const [showLogs,         setShowLogs]           = useState<boolean>(true);

  // ─────────────────────────────────────────────────────────────────────────
  // Initialise EVM provider
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if ((window as any).ethereum) {
      const p = new ethers.BrowserProvider((window as any).ethereum);
      setProvider(p);
    }
  }, []);

  // Cooldown countdown ticker
  useEffect(() => {
    if (cooldownRemaining > 0) {
      cooldownIntervalRef.current = window.setInterval(() => {
        setCooldownRemaining((c) => Math.max(0, c - 1));
      }, 1000);
    }
    return () => {
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    };
  }, [cooldownRemaining]);

  // ─────────────────────────────────────────────────────────────────────────
  // Wallet helpers
  // ─────────────────────────────────────────────────────────────────────────
  async function connect() {
    if (!provider) return addLog("No EVM provider detected — install MetaMask.");
    try {
      await provider.send("eth_requestAccounts", []);
      const s = await provider.getSigner();
      setSigner(s);
      const addr = await s.getAddress();
      setAccount(addr);
      addLog(`MetaMask connected: ${addr}`);
    } catch (err: any) {
      addLog(`MetaMask connect failed: ${err?.message || String(err)}`);
    }
  }

  async function connectPhantom() {
    try {
      const resp = await (window as any).solana.connect();
      setPhantomPubkey(resp.publicKey.toString());
      addLog(`Phantom connected: ${resp.publicKey.toString()}`);
    } catch (err: any) {
      addLog(`Phantom connect failed: ${String(err)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Swap tab
  // ─────────────────────────────────────────────────────────────────────────
  function flipTokens() {
    const prevIn  = tokenAddr;
    const prevOut = outputToken;
    setTokenAddr(prevOut);
    setOutputToken(prevIn);
  }

  async function swapTokens() {
    if (!signer || !fizzDexAddr || !tokenAddr || !outputToken || !amount) {
      addLog("Swap: fill in all fields and connect MetaMask.");
      return;
    }
    setIsSwapping(true);
    try {
      const contract = new ethers.Contract(fizzDexAddr, FIZZDEX_FULL_ABI, signer);
      const amtIn = ethers.parseEther(amount);
      const minOut = 0n; // TODO: slippage
      addLog(`Swapping ${amount} of ${shortAddr(tokenAddr)} → ${shortAddr(outputToken)}…`);
      const tx = await contract.swap(tokenAddr, outputToken, amtIn, minOut);
      addLog(`Swap tx: ${tx.hash}`);
      await tx.wait();
      addLog("✅ Swap confirmed!");
    } catch (err: any) {
      addLog(`Swap error: ${err?.message || String(err)}`);
    } finally {
      setIsSwapping(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pool tab
  // ─────────────────────────────────────────────────────────────────────────
  async function addLiquidity() {
    const addr = poolFizzDex || fizzDexAddr;
    if (!signer || !addr || !tokenAAddr || !tokenBAddr || !amountA || !amountB) {
      addLog("Add Liquidity: fill in all fields.");
      return;
    }
    setIsAddingLiq(true);
    try {
      const contract = new ethers.Contract(addr, FIZZDEX_FULL_ABI, signer);
      const a = ethers.parseEther(amountA);
      const b = ethers.parseEther(amountB);
      addLog(`Adding liquidity: ${amountA} + ${amountB}…`);
      const tx = await contract.addLiquidity(tokenAAddr, tokenBAddr, a, b);
      addLog(`AddLiquidity tx: ${tx.hash}`);
      await tx.wait();
      addLog("✅ Liquidity added!");
    } catch (err: any) {
      addLog(`AddLiquidity error: ${err?.message || String(err)}`);
    } finally {
      setIsAddingLiq(false);
    }
  }

  async function removeLiquidity() {
    const addr = poolFizzDex || fizzDexAddr;
    if (!signer || !addr || !tokenAAddr || !tokenBAddr || !removeShares) {
      addLog("Remove Liquidity: fill in token pair and shares.");
      return;
    }
    setIsRemoving(true);
    try {
      const contract = new ethers.Contract(addr, FIZZDEX_FULL_ABI, signer);
      const shares = ethers.parseEther(removeShares);
      addLog(`Removing ${removeShares} LP shares…`);
      const tx = await contract.removeLiquidity(tokenAAddr, tokenBAddr, shares);
      addLog(`RemoveLiquidity tx: ${tx.hash}`);
      await tx.wait();
      addLog("✅ Liquidity removed!");
    } catch (err: any) {
      addLog(`RemoveLiquidity error: ${err?.message || String(err)}`);
    } finally {
      setIsRemoving(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FizzCaps game
  // ─────────────────────────────────────────────────────────────────────────
  async function playGame() {
    const addr = gameFizzDex || fizzDexAddr;
    if (!signer || !addr) {
      addLog("FizzCaps: connect MetaMask and set FizzDex address.");
      return;
    }
    if (cooldownRemaining > 0) {
      addLog(`FizzCaps: cooldown — ${cooldownRemaining}s remaining.`);
      return;
    }
    setIsPlaying(true);
    try {
      const contract = new ethers.Contract(addr, FIZZDEX_FULL_ABI, signer);
      const preview  = fizzBuzzPreview(gameNumber);
      addLog(`Playing FizzCaps with number ${gameNumber} (${preview.label})…`);
      const tx = await contract.playFizzCaps(gameNumber);
      addLog(`PlayFizzCaps tx: ${tx.hash}`);
      await tx.wait();
      addLog(`✅ FizzCaps played! Result: ${preview.label} (+${preview.reward} FIZZ)`);
      setCooldownRemaining(60);
      await fetchPlayerStats();
    } catch (err: any) {
      addLog(`FizzCaps error: ${err?.message || String(err)}`);
    } finally {
      setIsPlaying(false);
    }
  }

  async function claimRewards() {
    const addr = gameFizzDex || fizzDexAddr;
    if (!signer || !addr) {
      addLog("Claim: connect MetaMask and set FizzDex address.");
      return;
    }
    setIsClaiming(true);
    try {
      const contract = new ethers.Contract(addr, FIZZDEX_FULL_ABI, signer);
      addLog("Claiming FIZZ rewards…");
      const tx = await contract.claimRewards();
      addLog(`ClaimRewards tx: ${tx.hash}`);
      await tx.wait();
      addLog("✅ Rewards claimed!");
      await fetchPlayerStats();
    } catch (err: any) {
      addLog(`ClaimRewards error: ${err?.message || String(err)}`);
    } finally {
      setIsClaiming(false);
    }
  }

  async function fetchPlayerStats() {
    const addr = gameFizzDex || fizzDexAddr;
    if (!provider || !addr || !account) return;
    try {
      const contract = new ethers.Contract(addr, FIZZDEX_FULL_ABI, provider);
      const [score, fizz, buzz, fizzBuzz, reward] = await contract.getPlayerStats(account);
      setPlayerStats({ score, fizz, buzz, fizzBuzz, reward });
      addLog(`Stats refreshed — Score: ${score}, FIZZ balance: ${ethers.formatEther(reward)}`);
    } catch (err: any) {
      addLog(`GetPlayerStats error: ${err?.message || String(err)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bridge / HTLC helpers (preserved from original)
  // ─────────────────────────────────────────────────────────────────────────
  async function solanaInitiateHTLCViaPhantom() {
    if (!solanaMint || !participant || !amount) throw new Error("Missing Solana HTLC parameters");
    if (!(window as any).solana?.isPhantom) throw new Error("Phantom not available");

    const prov    = (window as any).solana;
    const conn    = new Connection(import.meta.env.VITE_SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
    const programId = new PublicKey(import.meta.env.VITE_SOLANA_PROGRAM_ID || "FizzDEXProgram11111111111111111111111111111111");

    const initiatorPub  = prov.publicKey;
    const participantPk = new PublicKey(participant);
    const mintPk        = new PublicKey(solanaMint);
    const amtU64        = BigInt(amount);
    const timelockI64   = BigInt(timelock);

    const secretHashHex = (secret && secret.length > 0)
      ? ethers.keccak256(ethers.toUtf8Bytes(secret))
      : ethers.keccak256(ethers.toUtf8Bytes("auto-secret"));
    const secretHashBuf = Buffer.from(secretHashHex.replace(/^0x/, ""), "hex");

    const timelockBuf = Buffer.alloc(8);
    timelockBuf.writeBigInt64LE(timelockI64);

    const [atomicSwapPda] = await PublicKey.findProgramAddress(
      [Buffer.from("atomic_swap"), initiatorPub.toBuffer(), participantPk.toBuffer(), mintPk.toBuffer(), timelockBuf],
      programId
    );
    const [escrowVaultPda] = await PublicKey.findProgramAddress(
      [Buffer.from("escrow_vault"), initiatorPub.toBuffer(), participantPk.toBuffer(), mintPk.toBuffer(), timelockBuf],
      programId
    );

    const initiatorAta = await getAssociatedTokenAddress(mintPk, initiatorPub);

    const keys = [
      { pubkey: initiatorPub,              isSigner: true,  isWritable: true  },
      { pubkey: participantPk,             isSigner: false, isWritable: false },
      { pubkey: mintPk,                    isSigner: false, isWritable: false },
      { pubkey: initiatorAta,              isSigner: false, isWritable: true  },
      { pubkey: escrowVaultPda,            isSigner: false, isWritable: true  },
      { pubkey: atomicSwapPda,             isSigner: false, isWritable: true  },
      { pubkey: initiatorPub,              isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,        isSigner: false, isWritable: false },
    ];

    const disc   = await anchorDisc("global:initiate_atomic_swap");
    const amtBuf = Buffer.alloc(8);
    amtBuf.writeBigUInt64LE(amtU64);
    const tlBuf2 = Buffer.alloc(8);
    tlBuf2.writeBigInt64LE(timelockI64);
    const data = Buffer.concat([disc, amtBuf, secretHashBuf, tlBuf2]);

    const ix = new TransactionInstruction({ keys, programId, data });
    const tx = new Transaction();
    tx.add(ix);
    tx.feePayer = initiatorPub;

    const { blockhash } = await conn.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;

    const signed = await prov.signAndSendTransaction(tx);
    addLog(`Solana HTLC tx: ${signed.signature}`);
    await conn.confirmTransaction(signed.signature, "confirmed");
    addLog("✅ Solana HTLC confirmed");
  }

  async function evmCompleteHTLC() {
    if (!signer || !fizzDexAddr || !evmSwapId || !secret) {
      addLog("EVM: missing parameters for complete.");
      return;
    }
    try {
      const contract = new ethers.Contract(fizzDexAddr, ["function completeAtomicSwap(bytes32,bytes)"], signer);
      const tx = await contract.completeAtomicSwap(evmSwapId, ethers.toUtf8Bytes(secret));
      addLog(`EVM completeAtomicSwap tx: ${tx.hash}`);
      await tx.wait();
      addLog("✅ EVM HTLC completed");
    } catch (err: any) {
      addLog(`EVM complete error: ${err?.message || String(err)}`);
    }
  }

  async function evmFetchSecretFromTx() {
    if (!provider || !evmTxHash) return addLog("Missing provider or tx hash");
    try {
      const tx = await provider.getTransaction(evmTxHash);
      if (!tx?.data) return addLog("Transaction not found or has no input");
      const iface  = new ethers.Interface(["function completeAtomicSwap(bytes32,bytes)"]);
      const parsed = iface.parseTransaction({ data: tx.data });
      const secretHex = parsed!.args[1];
      let secretStr = "";
      try { secretStr = ethers.toUtf8String(secretHex); } catch { secretStr = secretHex; }
      addLog(`Revealed secret (from tx): ${secretStr}`);
      setSecret(secretStr);
    } catch (err: any) {
      addLog(`Fetch secret error: ${err?.message || String(err)}`);
    }
  }

  async function solanaCompleteHTLCViaPhantom() {
    if (!(window as any).solana?.isPhantom) return addLog("Phantom not available");
    if (!solAtomicSwapPda || !solEscrowVaultPda || !secret) return addLog("Missing Solana HTLC parameters");

    try {
      const prov      = (window as any).solana;
      const conn      = new Connection(import.meta.env.VITE_SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
      const programId = new PublicKey(import.meta.env.VITE_SOLANA_PROGRAM_ID || "FizzDEXProgram11111111111111111111111111111111");

      const participantPub = prov.publicKey;
      const atomicSwapPk   = new PublicKey(solAtomicSwapPda);
      const escrowPk       = new PublicKey(solEscrowVaultPda);
      const mintPk         = new PublicKey(solanaMint || "So11111111111111111111111111111111111111112");
      const participantAta = await getAssociatedTokenAddress(mintPk, participantPub);

      const disc      = await anchorDisc("global:complete_atomic_swap");
      const secretBuf = Buffer.from(secret);
      const lenBuf    = Buffer.alloc(4);
      lenBuf.writeUInt32LE(secretBuf.length);
      const data = Buffer.concat([disc, lenBuf, secretBuf]);

      const keys = [
        { pubkey: participantPub, isSigner: true,  isWritable: true  },
        { pubkey: atomicSwapPk,   isSigner: false, isWritable: true  },
        { pubkey: escrowPk,       isSigner: false, isWritable: true  },
        { pubkey: participantAta, isSigner: false, isWritable: true  },
        { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false },
      ];

      const ix = new TransactionInstruction({ keys, programId, data });
      const tx = new Transaction();
      tx.add(ix);
      tx.feePayer = participantPub;
      const { blockhash } = await conn.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;

      const signed = await prov.signAndSendTransaction(tx);
      addLog(`Solana complete tx: ${signed.signature}`);
      await conn.confirmTransaction(signed.signature, "confirmed");
      addLog("✅ Solana HTLC claim confirmed");

      if (autoCompleteOnReveal && signer && evmSwapId) {
        addLog("Auto-completing EVM counterpart…");
        await evmCompleteHTLC();
      }
    } catch (err: any) {
      addLog(`Solana complete error: ${err?.message || String(err)}`);
    }
  }

  async function watchSolanaForReveal(start: boolean) {
    if (!solAtomicSwapPda) return addLog("No Solana atomicSwap PDA provided");
    const conn = new Connection(import.meta.env.VITE_SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
    const pda  = new PublicKey(solAtomicSwapPda);

    if (!start) {
      if (solanaPollRef.current) clearInterval(solanaPollRef.current);
      solanaPollRef.current = null;
      setWatchingSolana(false);
      return addLog("Stopped watching Solana PDA");
    }

    setWatchingSolana(true);
    solanaPollRef.current = window.setInterval(async () => {
      try {
        const sigs = await conn.getSignaturesForAddress(pda, { limit: 10 });
        for (const sigInfo of sigs) {
          const tx = await conn.getTransaction(sigInfo.signature, { commitment: "confirmed" as any });
          if (!tx?.transaction) continue;
          const ix = tx.transaction.message.instructions.find((i: any) => i.data && i.data.length > 16);
          if (!ix) continue;
          const data   = Buffer.from((ix as any).data, "base64");
          const disc   = await anchorDisc("global:complete_atomic_swap");
          if (data.slice(0, 8).equals(disc)) {
            const len       = data.readUInt32LE(8);
            const secretStr = data.slice(12, 12 + len).toString();
            addLog(`Detected secret preimage on Solana: ${secretStr}`);
            setSecret(secretStr);
            if (autoCompleteOnReveal && signer && evmSwapId) {
              addLog("Auto-completing EVM counterpart (MetaMask)…");
              await evmCompleteHTLC();
            }
            watchSolanaForReveal(false);
            return;
          }
        }
      } catch (err: any) {
        addLog(`Solana watch error: ${err?.message || String(err)}`);
      }
    }, 3000);
    addLog("👁 Watching Solana PDA for revealed secret…");
  }

  async function findBestRoute() {
    try {
      const chains = JSON.parse(routeChainList || "[]");
      if (!chains?.length) return addLog("No chains configured for aggregation");
      const body = { chains, inputChainId: chains[0].chainId, inputToken: tokenAddr, outputToken, amount: amount || "0" };
      const resp = await fetch((import.meta.env.VITE_RELAYER_URL || "http://localhost:4001") + "/aggregate-quote", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await resp.json();
      if (!resp.ok) { addLog("Aggregator error: " + JSON.stringify(j)); return; }
      setRouteResults(j.results || []);
      addLog("Aggregator best: " + JSON.stringify(j.best));
    } catch (err: any) {
      addLog("Aggregator request failed: " + (err?.message || String(err)));
    }
  }

  function useRoute(r: any) {
    try {
      const quote     = r.quote || {};
      const inputAddr = quote?.inputToken?.address  || "";
      const outputAddr= quote?.outputToken?.address || "";
      const amt       = quote?.inputAmount || amount || "";
      setAmount(String(amt));
      setTokenAddr(inputAddr);
      setOutputToken(outputAddr);
      const cid = String(r.chain || "");
      setChain(cid.toLowerCase().includes("sol") ? "solana" : "evm");
      addLog(`Applied route from ${r.chain} — in=${inputAddr} out=${outputAddr} amt=${amt}`);
    } catch (err: any) {
      addLog("useRoute failed: " + (err?.message || String(err)));
    }
  }

  async function executeRoute(r: any) {
    setIsExecuting(true);
    setExecResponse(null);
    try {
      const chains   = JSON.parse(routeChainList || "[]");
      const chainId  = r.chain;
      const cfg      = (chains || []).find((c: any) => c.chainId === chainId) || {
        chainId, chainType: String(chainId).toLowerCase().includes("sol") ? "solana" : "evm",
      };
      const quote    = r.quote || {};
      const inTok    = quote?.inputToken?.address  || tokenAddr;
      const outTok   = quote?.outputToken?.address || outputToken;
      const amt      = quote?.inputAmount || amount || "0";
      const outAmt   = quote?.outputAmount || quote?.amountOut || "0";
      let minOutput  = "0";
      try { minOutput = outAmt && BigInt(outAmt) > 0n ? ((BigInt(outAmt) * 99n) / 100n).toString() : "0"; } catch (_) {}

      const body = { chainId: cfg.chainId, chainType: cfg.chainType || "evm", inputToken: inTok, outputToken: outTok, amount: amt, minOutput, chains };
      addLog(`Executing route on ${cfg.chainId} (type=${cfg.chainType}) amount=${amt}`);
      const resp = await fetch((import.meta.env.VITE_RELAYER_URL || "http://localhost:4001") + "/execute-route", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await resp.json();
      if (!resp.ok) { addLog("Execute-route failed: " + JSON.stringify(j)); setExecResponse({ ok: false, body: j }); return; }
      addLog("Execute-route success: " + JSON.stringify(j));
      setExecResponse({ ok: true, body: j });
    } catch (err: any) {
      addLog("Execute-route error: " + (err?.message || String(err)));
      setExecResponse({ ok: false, body: { error: err?.message || String(err) } });
    } finally {
      setIsExecuting(false);
    }
  }

  async function startListening() {
    if (chain === "evm") {
      if (!provider || !fizzDexAddr) return addLog("EVM: need provider + FizzDex address.");
      const contract = new ethers.Contract(fizzDexAddr, FIZZDEX_ABI, provider);
      contract.on("AtomicSwapInitiated", (swapId, initiator, part, amt) => {
        addLog(`AtomicSwapInitiated swapId=${swapId} initiator=${initiator} participant=${part} amount=${ethers.formatEther(amt)}`);
      });
      contract.on("AtomicSwapCompleted", async (swapId, participantAddr, event) => {
        try {
          addLog(`AtomicSwapCompleted swapId=${swapId} participant=${participantAddr}`);
          const tx = await provider.getTransaction(event.transactionHash);
          if (!tx) return;
          const iface  = new ethers.Interface(["function completeAtomicSwap(bytes32,bytes)"]);
          const parsed = iface.parseTransaction({ data: tx.data });
          const secretHex = parsed!.args[1];
          let secretStr = "";
          try { secretStr = ethers.toUtf8String(secretHex); } catch { secretStr = secretHex; }
          addLog(`Revealed secret on EVM: ${secretStr}`);
          setSecret(secretStr);
          if (phantomPubkey && solAtomicSwapPda && solEscrowVaultPda && (window as any).solana?.isPhantom) {
            addLog("Auto-completing Solana HTLC via Phantom…");
            await solanaCompleteHTLCViaPhantom();
          }
        } catch (err: any) { addLog(`Error parsing completed tx: ${err?.message || String(err)}`); }
      });
      addLog("👂 Listening for EVM AtomicSwap events…");
    } else {
      addLog("Solana event listening via relayer or direct connection (coming soon)");
    }
  }

  async function submitInitiate() {
    if (!participant || !amount) return addLog("HTLC: fill participant + amount.");
    if (chain === "evm") {
      if (!signer || !fizzDexAddr || !tokenAddr) return addLog("EVM: missing fields.");
      const contract   = new ethers.Contract(fizzDexAddr, FIZZDEX_ABI, signer);
      const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret || "auto-secret"));
      const amt        = ethers.parseEther(amount);
      const tx         = await contract.initiateAtomicSwap(participant, tokenAddr, amt, secretHash, timelock);
      addLog(`initiateAtomicSwap tx: ${tx.hash}`);
      await tx.wait();
      addLog("✅ initiateAtomicSwap mined");
      return;
    }

    if ((window as any).solana?.isPhantom) {
      try { await solanaInitiateHTLCViaPhantom(); return; }
      catch (err: any) { addLog(`Phantom HTLC failed: ${String(err)} — falling back to relayer`); }
    }

    try {
      const resp = await fetch((import.meta.env.VITE_RELAYER_URL || "http://localhost:4001") + "/solana/initiate-htlc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participant, tokenMint: solanaMint, amount, secretHash: secret ? "0x" + ethers.keccak256(ethers.toUtf8Bytes(secret)).replace(/^0x/, "") : undefined, timelock }),
      });
      const j = await resp.json();
      addLog(`Relayer response: ${JSON.stringify(j)}`);
    } catch (err: any) {
      addLog(`Relayer error: ${String(err)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────
  function addLog(line: string) {
    setLogs((l) => [line, ...l].slice(0, 200));
  }

  const preview = fizzBuzzPreview(gameNumber);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      {/* Ambient background glow */}
      <div className="bg-sparkle" aria-hidden="true" />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="site-header">
        <div className="header-inner">
          <a className="logo-block" href="#" aria-label="FizzSwap home">
            <span className="logo-title">⚡ FizzSwap</span>
            <span className="logo-sub">Powered by AtomicFizzCaps</span>
          </a>

          <div className="header-right">
            {account ? (
              <div className="wallet-pill">
                <span className="wallet-dot" />
                {shortAddr(account)}
              </div>
            ) : (
              <button className="btn-connect" onClick={connect}>Connect Wallet</button>
            )}
            {phantomPubkey ? (
              <div className="wallet-pill phantom-pill">
                <span className="wallet-dot" />
                {shortAddr(phantomPubkey)}
              </div>
            ) : (
              <button className="btn-phantom" onClick={connectPhantom}>Phantom</button>
            )}
          </div>
        </div>

        {/* Navigation tabs */}
        <nav className="nav-tabs" role="tablist">
          {(["swap", "pool", "fizzcaps", "bridge"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={activeTab === t}
              className={`tab-btn${activeTab === t ? " active" : ""}`}
              onClick={() => setActiveTab(t)}
            >
              {t === "swap"     && "⇄ Swap"}
              {t === "pool"     && "💧 Pool"}
              {t === "fizzcaps" && "🎮 FizzCaps"}
              {t === "bridge"   && "⛓️ Bridge"}
            </button>
          ))}
        </nav>
      </header>

      {/* ── Page content ────────────────────────────────────────────────── */}
      <main className="page-content" role="main">

        {/* ═══════════════════════════════════════════════════════════════
            SWAP TAB
        ═══════════════════════════════════════════════════════════════ */}
        {activeTab === "swap" && (
          <div className="tab-panel">
            <div className="swap-widget">
              <div className="card card-gold" style={{ marginTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                  <h2 className="card-title" style={{ margin: 0 }}><span>⇄</span> Swap Tokens</h2>
                  <div className="chain-selector">
                    <button
                      className={`btn-outline${swapChain === "evm" ? " active-evm" : ""}`}
                      onClick={() => setSwapChain("evm")}
                    >EVM</button>
                    <button
                      className={`btn-outline${swapChain === "solana" ? " active-sol" : ""}`}
                      onClick={() => setSwapChain("solana")}
                    >Solana</button>
                  </div>
                </div>

                {/* FROM box */}
                <div className="swap-box">
                  <div className="swap-box-label">From</div>
                  <div className="swap-amount-row">
                    <input
                      type="number"
                      className="swap-amount-input"
                      placeholder="0.0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-label="Amount to swap"
                    />
                    <span className="swap-token-badge">TOKEN</span>
                  </div>
                  <input
                    className="token-addr-input"
                    placeholder={swapChain === "evm" ? "Token address (0x…)" : "Token mint (So1…)"}
                    value={tokenAddr}
                    onChange={(e) => setTokenAddr(e.target.value)}
                    aria-label="Input token address"
                  />
                </div>

                {/* Flip button */}
                <div className="flip-btn-wrap">
                  <button className="flip-btn" onClick={flipTokens} title="Flip tokens" aria-label="Flip input and output tokens">
                    ↕
                  </button>
                </div>

                {/* TO box */}
                <div className="swap-box">
                  <div className="swap-box-label">To</div>
                  <div className="swap-amount-row">
                    <input
                      type="number"
                      className="swap-amount-input"
                      placeholder="0.0"
                      value=""
                      disabled
                      aria-label="Estimated output (read-only)"
                    />
                    <span className="swap-token-badge">TOKEN</span>
                  </div>
                  <input
                    className="token-addr-input"
                    placeholder={swapChain === "evm" ? "Output token address (0x…)" : "Output mint (So1…)"}
                    value={outputToken}
                    onChange={(e) => setOutputToken(e.target.value)}
                    aria-label="Output token address"
                  />
                </div>

                {/* Fee info */}
                <div className="info-row">
                  <span>Fee</span>
                  <span className="info-val">0.3%</span>
                </div>
                <div className="info-row" style={{ paddingTop: 0, borderTop: "none" }}>
                  <span>Slippage tolerance</span>
                  <span className="info-val">1.0%</span>
                </div>

                {/* Advanced section */}
                <div
                  className="advanced-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  role="button"
                  aria-expanded={showAdvanced}
                >
                  <span>{showAdvanced ? "▲" : "▼"}</span>
                  Advanced settings
                </div>

                {showAdvanced && (
                  <div style={{ marginTop: 10 }}>
                    <div className="field-group">
                      <label className="field-label" htmlFor="swap-fizzdex">FizzDex Contract</label>
                      <input
                        id="swap-fizzdex"
                        className="field-input"
                        placeholder="0x… contract address"
                        value={fizzDexAddr}
                        onChange={(e) => setFizzDexAddr(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="swap-secret">Secret (HTLC)</label>
                      <input
                        id="swap-secret"
                        className="field-input"
                        placeholder="leave blank for auto-generated"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                      />
                    </div>
                    <button
                      className="btn-outline"
                      style={{ marginTop: 10, width: "100%" }}
                      onClick={startListening}
                    >
                      👂 Listen for Events
                    </button>
                  </div>
                )}

                <button
                  className="btn-primary"
                  onClick={swapTokens}
                  disabled={isSwapping || !account}
                  aria-busy={isSwapping}
                >
                  {isSwapping ? (
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                      Swapping… <span className="spinner" />
                    </span>
                  ) : account ? "⚡ FIZZ SWAP" : "Connect Wallet to Swap"}
                </button>

                {!account && (
                  <div className="notice-box" style={{ marginTop: 10 }}>
                    Connect <strong>MetaMask</strong> (EVM) or <strong>Phantom</strong> (Solana) to start swapping.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            POOL TAB
        ═══════════════════════════════════════════════════════════════ */}
        {activeTab === "pool" && (
          <div className="tab-panel">
            <div className="card">
              <h2 className="card-title"><span>💧</span> Add Liquidity</h2>

              <div className="notice-box">
                <strong>EVM only.</strong> Provide liquidity to earn 0.3% of all swap fees in this pool.
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="pool-fizzdex">FizzDex Contract Address</label>
                <input
                  id="pool-fizzdex"
                  className="field-input"
                  placeholder="0x…"
                  value={poolFizzDex}
                  onChange={(e) => setPoolFizzDex(e.target.value)}
                />
              </div>

              <div className="pool-pair-row" style={{ marginTop: 14 }}>
                <div className="field-group" style={{ marginTop: 0 }}>
                  <label className="field-label" htmlFor="token-a-addr">Token A Address</label>
                  <input
                    id="token-a-addr"
                    className="field-input"
                    placeholder="0x…"
                    value={tokenAAddr}
                    onChange={(e) => setTokenAAddr(e.target.value)}
                  />
                </div>
                <div className="field-group" style={{ marginTop: 0 }}>
                  <label className="field-label" htmlFor="token-b-addr">Token B Address</label>
                  <input
                    id="token-b-addr"
                    className="field-input"
                    placeholder="0x…"
                    value={tokenBAddr}
                    onChange={(e) => setTokenBAddr(e.target.value)}
                  />
                </div>
              </div>

              <div className="pool-pair-row">
                <div className="field-group" style={{ marginTop: 0 }}>
                  <label className="field-label" htmlFor="amount-a">Amount A</label>
                  <input
                    id="amount-a"
                    type="number"
                    className="field-input"
                    placeholder="0.0"
                    value={amountA}
                    onChange={(e) => setAmountA(e.target.value)}
                  />
                </div>
                <div className="field-group" style={{ marginTop: 0 }}>
                  <label className="field-label" htmlFor="amount-b">Amount B</label>
                  <input
                    id="amount-b"
                    type="number"
                    className="field-input"
                    placeholder="0.0"
                    value={amountB}
                    onChange={(e) => setAmountB(e.target.value)}
                  />
                </div>
              </div>

              <button
                className="btn-primary"
                onClick={addLiquidity}
                disabled={isAddingLiq || !account}
              >
                {isAddingLiq ? (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                    Adding… <span className="spinner" />
                  </span>
                ) : "💧 Add Liquidity"}
              </button>
            </div>

            {/* Remove liquidity */}
            <div className="card" style={{ marginTop: 16 }}>
              <h2 className="card-title"><span>🔥</span> Remove Liquidity</h2>
              <p className="text-muted" style={{ marginBottom: 12 }}>
                Burn your LP shares to withdraw Token A and Token B.
              </p>

              <div className="pool-pair-row">
                <div className="field-group" style={{ marginTop: 0 }}>
                  <label className="field-label" htmlFor="rm-token-a">Token A Address</label>
                  <input
                    id="rm-token-a"
                    className="field-input"
                    placeholder="0x…"
                    value={tokenAAddr}
                    onChange={(e) => setTokenAAddr(e.target.value)}
                  />
                </div>
                <div className="field-group" style={{ marginTop: 0 }}>
                  <label className="field-label" htmlFor="rm-token-b">Token B Address</label>
                  <input
                    id="rm-token-b"
                    className="field-input"
                    placeholder="0x…"
                    value={tokenBAddr}
                    onChange={(e) => setTokenBAddr(e.target.value)}
                  />
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="remove-shares">LP Shares to Burn</label>
                <input
                  id="remove-shares"
                  type="number"
                  className="field-input"
                  placeholder="0.0"
                  value={removeShares}
                  onChange={(e) => setRemoveShares(e.target.value)}
                />
              </div>

              <button
                className="btn-danger"
                onClick={removeLiquidity}
                disabled={isRemoving || !account}
              >
                {isRemoving ? (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                    Removing… <span className="spinner" />
                  </span>
                ) : "🔥 Remove Liquidity"}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            FIZZCAPS TAB
        ═══════════════════════════════════════════════════════════════ */}
        {activeTab === "fizzcaps" && (
          <div className="tab-panel">
            {/* Hero */}
            <div className="game-hero">
              <div className="game-title">🎮 FizzCaps</div>
              <div className="game-subtitle">The on-chain FizzBuzz game — coming to the FizzSwap ecosystem!</div>
            </div>

            <div className="card card-gold" style={{ textAlign: "center", padding: "40px 24px" }}>
              <div style={{ fontSize: "4rem", marginBottom: 16 }}>🚀</div>
              <h2 className="card-title" style={{ fontSize: "1.5rem", marginBottom: 12 }}>Coming Soon</h2>
              <p style={{ color: "var(--muted)", maxWidth: 420, margin: "0 auto 24px" }}>
                FizzCaps is a future feature planned for the FizzSwap ecosystem. It will launch on{" "}
                <a
                  href="https://atomicfizzcaps.xyz"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)", textDecoration: "underline" }}
                >
                  atomicfizzcaps.xyz
                </a>{" "}
                after the game has established itself on mainnet.
              </p>
              <p style={{ color: "var(--muted)", maxWidth: 420, margin: "0 auto 24px", fontSize: "0.9rem" }}>
                Stay tuned — earn FIZZ tokens by playing the on-chain FizzBuzz game once it goes live!
              </p>
              <a
                href="https://atomicfizzcaps.xyz"
                target="_blank"
                rel="noreferrer"
                className="btn-gold"
                style={{ display: "inline-block", textDecoration: "none" }}
              >
                🌐 Visit atomicfizzcaps.xyz
              </a>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            BRIDGE TAB
        ═══════════════════════════════════════════════════════════════ */}
        {activeTab === "bridge" && (
          <div className="tab-panel">
            <div style={{ marginBottom: 4 }}>
              <h1 style={{ fontSize: "1.4rem", fontWeight: 800, color: "var(--text)" }}>⛓️ Cross-Chain Bridge</h1>
              <p className="text-muted" style={{ marginTop: 4 }}>
                Atomic HTLC swaps between EVM and Solana — trustless, non-custodial.
              </p>
            </div>

            {/* Initiate HTLC */}
            <div className="card">
              <h2 className="card-title"><span>🔐</span> Initiate HTLC</h2>

              <div className="chain-selector">
                <button
                  className={`btn-outline${chain === "evm" ? " active-evm" : ""}`}
                  onClick={() => setChain("evm")}
                >EVM</button>
                <button
                  className={`btn-outline${chain === "solana" ? " active-sol" : ""}`}
                  onClick={() => setChain("solana")}
                >Solana</button>
              </div>

              {chain === "evm" ? (
                <>
                  <div className="field-group">
                    <label className="field-label" htmlFor="bridge-fizzdex">FizzDex Contract</label>
                    <input
                      id="bridge-fizzdex"
                      className="field-input"
                      placeholder="0x…"
                      value={fizzDexAddr}
                      onChange={(e) => setFizzDexAddr(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="bridge-token">ERC-20 Token Address</label>
                    <input
                      id="bridge-token"
                      className="field-input"
                      placeholder="0x…"
                      value={tokenAddr}
                      onChange={(e) => setTokenAddr(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="bridge-participant">Participant (Recipient)</label>
                    <input
                      id="bridge-participant"
                      className="field-input"
                      placeholder="0x…"
                      value={participant}
                      onChange={(e) => setParticipant(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="bridge-amount">Amount (ETH units)</label>
                    <input
                      id="bridge-amount"
                      type="number"
                      className="field-input"
                      placeholder="1.0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="field-group">
                    <label className="field-label" htmlFor="sol-mint">Solana Token Mint</label>
                    <input
                      id="sol-mint"
                      className="field-input"
                      placeholder="So111111…"
                      value={solanaMint}
                      onChange={(e) => setSolanaMint(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="sol-participant">Participant Public Key</label>
                    <input
                      id="sol-participant"
                      className="field-input"
                      placeholder="Pubkey…"
                      value={participant}
                      onChange={(e) => setParticipant(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="sol-amount">Amount (raw u64)</label>
                    <input
                      id="sol-amount"
                      type="number"
                      className="field-input"
                      placeholder="1000000"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                    <button className="btn-phantom" style={{ borderRadius: 8, padding: "9px 16px", fontSize: "0.8rem" }} onClick={connectPhantom}>
                      Connect Phantom
                    </button>
                    {phantomPubkey && (
                      <span className="wallet-pill phantom-pill" style={{ fontSize: "0.75rem" }}>
                        <span className="wallet-dot" />
                        {shortAddr(phantomPubkey)}
                      </span>
                    )}
                  </div>
                </>
              )}

              <div className="field-group">
                <label className="field-label" htmlFor="htlc-secret">Secret (blank = auto)</label>
                <input
                  id="htlc-secret"
                  className="field-input"
                  placeholder="secret string"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="htlc-timelock">Timelock (unix timestamp)</label>
                <input
                  id="htlc-timelock"
                  type="number"
                  className="field-input"
                  value={timelock}
                  onChange={(e) => setTimelock(Number(e.target.value))}
                />
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button className="btn-primary" style={{ flex: 1 }} onClick={submitInitiate}>
                  🔐 Initiate HTLC
                </button>
                <button className="btn-outline" style={{ flex: 1 }} onClick={startListening}>
                  👂 Listen Events
                </button>
              </div>

              {isExecuting && (
                <div style={{ display: "flex", alignItems: "center", marginTop: 12, color: "var(--accent)" }}>
                  Executing route… <span className="spinner" />
                </div>
              )}
              {execResponse && (
                <div className="exec-result">
                  <div className={execResponse.ok ? "exec-ok" : "exec-err"} style={{ fontWeight: 700 }}>
                    {execResponse.ok ? "✅ Success" : "❌ Error"}
                  </div>
                  <pre>{JSON.stringify(execResponse.body, null, 2)}</pre>
                </div>
              )}
            </div>

            {/* Complete / Claim HTLC — collapsible */}
            <div className="card">
              <div
                className="collapsible-header"
                style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}
                onClick={() => setShowCompleteHtlc((v) => !v)}
                role="button"
                aria-expanded={showCompleteHtlc}
              >
                <span className="card-title" style={{ margin: 0 }}><span>✅</span> Complete / Claim HTLC</span>
                <span className={`collapsible-arrow${showCompleteHtlc ? " open" : ""}`}>▼</span>
              </div>

              {showCompleteHtlc && (
                <div className="collapsible-body">
                  <div className="chain-selector">
                    <button
                      className={`btn-outline${chain === "evm" ? " active-evm" : ""}`}
                      onClick={() => setChain("evm")}
                    >EVM</button>
                    <button
                      className={`btn-outline${chain === "solana" ? " active-sol" : ""}`}
                      onClick={() => setChain("solana")}
                    >Solana</button>
                  </div>

                  {chain === "evm" ? (
                    <>
                      <div className="field-group">
                        <label className="field-label" htmlFor="evm-swap-id">Swap ID</label>
                        <input
                          id="evm-swap-id"
                          className="field-input"
                          placeholder="0x…"
                          value={evmSwapId}
                          onChange={(e) => setEvmSwapId(e.target.value)}
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="evm-tx-hash">Tx hash to extract secret</label>
                        <input
                          id="evm-tx-hash"
                          className="field-input"
                          placeholder="0x…"
                          value={evmTxHash}
                          onChange={(e) => setEvmTxHash(e.target.value)}
                        />
                      </div>
                      <button className="btn-sm" style={{ marginTop: 8 }} onClick={evmFetchSecretFromTx}>
                        Fetch secret from tx
                      </button>
                      <div className="field-group">
                        <label className="field-label" htmlFor="evm-secret">Secret (preimage)</label>
                        <input
                          id="evm-secret"
                          className="field-input"
                          placeholder="secret string"
                          value={secret}
                          onChange={(e) => setSecret(e.target.value)}
                        />
                      </div>
                      <button className="btn-primary" onClick={evmCompleteHTLC} style={{ marginTop: 14 }}>
                        ✅ Complete HTLC (EVM)
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="field-group">
                        <label className="field-label" htmlFor="sol-swap-pda">AtomicSwap PDA</label>
                        <input
                          id="sol-swap-pda"
                          className="field-input"
                          placeholder="PDA…"
                          value={solAtomicSwapPda}
                          onChange={(e) => setSolAtomicSwapPda(e.target.value)}
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="sol-escrow-pda">Escrow Vault PDA</label>
                        <input
                          id="sol-escrow-pda"
                          className="field-input"
                          placeholder="PDA…"
                          value={solEscrowVaultPda}
                          onChange={(e) => setSolEscrowVaultPda(e.target.value)}
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="sol-secret-claim">Secret (preimage)</label>
                        <input
                          id="sol-secret-claim"
                          className="field-input"
                          placeholder="secret string"
                          value={secret}
                          onChange={(e) => setSecret(e.target.value)}
                        />
                      </div>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={autoCompleteOnReveal}
                          onChange={(e) => setAutoCompleteOnReveal(e.target.checked)}
                        />
                        Auto-complete counterparty HTLC when secret revealed
                      </label>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button
                          className={watchingSolana ? "btn-danger" : "btn-sm"}
                          style={{ flex: 1 }}
                          onClick={() => watchSolanaForReveal(!watchingSolana)}
                        >
                          {watchingSolana ? (
                            <span className="watching-badge">● Watching Solana…</span>
                          ) : "👁 Watch PDA"}
                        </button>
                        <button className="btn-primary" style={{ flex: 1 }} onClick={solanaCompleteHTLCViaPhantom}>
                          ✅ Claim (Phantom)
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Route aggregator — collapsible */}
            <div className="card">
              <div
                className="collapsible-header"
                style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}
                onClick={() => setShowAggregator((v) => !v)}
                role="button"
                aria-expanded={showAggregator}
              >
                <span className="card-title" style={{ margin: 0 }}><span>🔀</span> Route Aggregator</span>
                <span className={`collapsible-arrow${showAggregator ? " open" : ""}`}>▼</span>
              </div>

              {showAggregator && (
                <div className="collapsible-body">
                  <div className="field-group">
                    <label className="field-label" htmlFor="chains-json">Chains (JSON)</label>
                    <textarea
                      id="chains-json"
                      className="field-input"
                      rows={4}
                      value={routeChainList}
                      onChange={(e) => setRouteChainList(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="agg-output">Output Token (address / mint)</label>
                    <input
                      id="agg-output"
                      className="field-input"
                      placeholder="0x… or Solana mint"
                      value={outputToken}
                      onChange={(e) => setOutputToken(e.target.value)}
                    />
                  </div>
                  <button className="btn-outline" style={{ marginTop: 12, width: "100%" }} onClick={findBestRoute}>
                    🔀 Find Best Route
                  </button>

                  {routeResults.length > 0 ? (
                    <div style={{ marginTop: 14 }}>
                      {routeResults.map((r: any, idx: number) => (
                        <div key={idx} className="route-card">
                          <div className="route-card-header">
                            <div>
                              <span className="route-chain-badge">{r.chain}</span>
                              {r.route && (
                                <span className="text-muted text-xs" style={{ marginLeft: 8 }}>
                                  {r.route.join(" → ")}
                                </span>
                              )}
                            </div>
                            <div className="route-actions">
                              <button className="btn-sm" onClick={() => useRoute(r)}>Use</button>
                              <button className="btn-sm" style={{ color: "var(--accent)", borderColor: "rgba(243,200,75,0.3)", background: "rgba(243,200,75,0.05)" }} onClick={() => executeRoute(r)}>
                                Execute
                              </button>
                            </div>
                          </div>
                          <div style={{ marginTop: 6, fontSize: "0.8rem" }}>
                            <span className="text-muted">Out: </span>
                            <span className="text-accent-2 font-bold">{r.quote?.outputAmount || r.quote?.amountOut || "n/a"}</span>
                          </div>
                          <div className="route-detail">{JSON.stringify(r.quote)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="notice-box" style={{ marginTop: 12 }}>
                      No routes yet — configure chains and click <strong>Find Best Route</strong>.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Logs — collapsible */}
            <div className="card">
              <div
                className="collapsible-header"
                style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}
                onClick={() => setShowLogs((v) => !v)}
                role="button"
                aria-expanded={showLogs}
              >
                <span className="card-title" style={{ margin: 0 }}><span>📋</span> Activity Log</span>
                <span className={`collapsible-arrow${showLogs ? " open" : ""}`}>▼</span>
              </div>

              {showLogs && (
                <div className="collapsible-body">
                  <div className="logs-container">
                    {logs.length === 0 ? (
                      <div className="log-entry" style={{ textAlign: "center", padding: "20px 0", color: "var(--muted)", opacity: 0.5 }}>
                        No activity yet…
                      </div>
                    ) : (
                      logs.map((l, i) => (
                        <div key={i} className="log-entry">
                          <span style={{ opacity: 0.4, marginRight: 6, fontSize: "0.65rem" }}>
                            {new Date().toLocaleTimeString()}
                          </span>
                          {l}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="site-footer">
        <div className="footer-tagline">
          FizzSwap is the official DEX of the <strong style={{ color: "var(--accent)" }}>Atomic Fizz Caps</strong> ecosystem
        </div>
        <div className="footer-links">
          <a className="footer-link" href="https://atomicfizzcaps.xyz" target="_blank" rel="noreferrer">
            atomicfizzcaps.xyz
          </a>
          <a className="footer-link" href="https://github.com" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="footer-link" href="https://discord.com" target="_blank" rel="noreferrer">
            Discord
          </a>
        </div>
        <div className="footer-heart">Built with ❤️ for the Atomic Fizz Caps community</div>
      </footer>
    </div>
  );
}
