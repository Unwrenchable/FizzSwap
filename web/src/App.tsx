import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

// Minimal ABI subset used by the UI
const FIZZDEX_ABI = [
  "function getPoolId(address,address) pure returns (bytes32)",
  "function initiateAtomicSwap(address,address,uint256,bytes32,uint256) returns (bytes32)",
  "event AtomicSwapInitiated(bytes32 indexed swapId, address indexed initiator, address participant, uint256 amount)",
  "event Swap(bytes32 indexed poolId, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)"
];


export default function App() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [fizzDexAddr, setFizzDexAddr] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [secret, setSecret] = useState<string>("");
  const [participant, setParticipant] = useState<string>("");
  const [tokenAddr, setTokenAddr] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [timelock, setTimelock] = useState<number>(Math.floor(Date.now() / 1000) + 3600);
  const [chain, setChain] = useState<'evm' | 'solana'>('evm');
  const [solanaMint, setSolanaMint] = useState<string>('');
  const [phantomPubkey, setPhantomPubkey] = useState<string | null>(null);

  // Complete / claim HTLC fields
  const [evmSwapId, setEvmSwapId] = useState<string>('');
  const [evmTxHash, setEvmTxHash] = useState<string>('');
  const [solAtomicSwapPda, setSolAtomicSwapPda] = useState<string>('');
  const [solEscrowVaultPda, setSolEscrowVaultPda] = useState<string>('');
  const [watchingSolana, setWatchingSolana] = useState<boolean>(false);
  const [autoCompleteOnReveal, setAutoCompleteOnReveal] = useState<boolean>(true);
  const solanaPollRef = React.useRef<number | null>(null);

  // Route aggregator state
  const [outputToken, setOutputToken] = useState<string>('');
  const [routeChainList, setRouteChainList] = useState<string>(`[{"chainId":"local-evm","rpcUrl":"http://localhost:8545","fizzDexAddress":"","chainType":"evm"}]`);
  const [routeResults, setRouteResults] = useState<any[]>([]);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [execResponse, setExecResponse] = useState<any>(null);

  useEffect(() => {
    if ((window as any).ethereum) {
      const p = new ethers.BrowserProvider((window as any).ethereum);
      setProvider(p);
    }
  }, []);

  async function connect() {
    if (!provider) return;
    await provider.send("eth_requestAccounts", []);
    const s = await provider.getSigner();
    setSigner(s);
    const addr = await s.getAddress();
    setAccount(addr);
  }

  async function connectPhantom() {
    try {
      const resp = await (window as any).solana.connect();
      setPhantomPubkey(resp.publicKey.toString());
      addLog(`Phantom connected: ${resp.publicKey.toString()}`);
    } catch (err) {
      addLog(`Phantom connect failed: ${String(err)}`);
    }
  }

  async function solanaInitiateHTLCViaPhantom() {
    if (!solanaMint || !participant || !amount) throw new Error('Missing Solana HTLC parameters');
    if (!(window as any).solana || !(window as any).solana.isPhantom) throw new Error('Phantom not available');

    const provider = (window as any).solana;
    const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
    const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID || 'FizzDEXProgram11111111111111111111111111111111');

    const initiatorPub = provider.publicKey;
    const participantPk = new PublicKey(participant);
    const mintPk = new PublicKey(solanaMint);

    // prepare args
    const amtU64 = BigInt(amount);
    const timelockI64 = BigInt(timelock);

    // secretHash: keccak256(secret)
    const secretHashHex = (secret && secret.length > 0) ? ethers.keccak256(ethers.toUtf8Bytes(secret)) : ethers.keccak256(ethers.toUtf8Bytes('auto-secret'));
    const secretHashBuf = Buffer.from(secretHashHex.replace(/^0x/, ''), 'hex');

    // seeds and PDAs (timelock as 8-byte LE)
    const timelockBuf = Buffer.alloc(8);
    timelockBuf.writeBigInt64LE(timelockI64);

    const [atomicSwapPda] = await PublicKey.findProgramAddress([
      Buffer.from('atomic_swap'),
      initiatorPub.toBuffer(),
      participantPk.toBuffer(),
      mintPk.toBuffer(),
      timelockBuf,
    ], programId);

    const [escrowVaultPda] = await PublicKey.findProgramAddress([
      Buffer.from('escrow_vault'),
      initiatorPub.toBuffer(),
      participantPk.toBuffer(),
      mintPk.toBuffer(),
      timelockBuf,
    ], programId);

    // accounts
    const initiatorAta = await getAssociatedTokenAddress(mintPk, initiatorPub);

    const keys = [
      { pubkey: initiatorPub, isSigner: true, isWritable: true },
      { pubkey: participantPk, isSigner: false, isWritable: false },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: initiatorAta, isSigner: false, isWritable: true },
      { pubkey: escrowVaultPda, isSigner: false, isWritable: true },
      { pubkey: atomicSwapPda, isSigner: false, isWritable: true },
      { pubkey: initiatorPub, isSigner: true, isWritable: true }, // payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ];

    // build instruction data: Anchor discriminator + amount(u64 LE) + secretHash(32) + timelock(i64 LE)
    const disc = Buffer.from(require('crypto').createHash('sha256').update('global:initiate_atomic_swap').digest().slice(0,8));
    const amtBuf = Buffer.alloc(8);
    amtBuf.writeBigUInt64LE(amtU64);
    const timelockBuf2 = Buffer.alloc(8);
    timelockBuf2.writeBigInt64LE(timelockI64);

    const data = Buffer.concat([disc, amtBuf, secretHashBuf, timelockBuf2]);

    const ix = new TransactionInstruction({ keys, programId, data });
    const tx = new Transaction();
    tx.add(ix);
    tx.feePayer = initiatorPub;

    const { blockhash } = await conn.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;

    // Phantom signs and sends
    const signed = await provider.signAndSendTransaction(tx);
    addLog(`Solana HTLC tx submitted: ${signed.signature}`);
    // optionally wait for confirmation
    await conn.confirmTransaction(signed.signature, 'confirmed');
    addLog('Solana HTLC confirmed');
  }

  // --------------------
  // Complete / reveal helpers
  // --------------------

  async function evmCompleteHTLC() {
    if (!signer || !fizzDexAddr || !evmSwapId || !secret) {
      addLog('EVM: missing parameters');
      return;
    }
    try {
      const contract = new ethers.Contract(fizzDexAddr, ["function completeAtomicSwap(bytes32,bytes)"], signer);
      const tx = await contract.completeAtomicSwap(evmSwapId, ethers.toUtf8Bytes(secret));
      addLog(`EVM completeAtomicSwap tx: ${tx.hash}`);
      await tx.wait();
      addLog('EVM HTLC completed');
    } catch (err: any) {
      addLog(`EVM complete error: ${err?.message || String(err)}`);
    }
  }

  async function evmFetchSecretFromTx() {
    if (!provider || !evmTxHash) return addLog('Missing provider or tx hash');
    try {
      const tx = await provider.getTransaction(evmTxHash);
      if (!tx || !tx.data) return addLog('Transaction not found or has no input');
      const iface = new ethers.Interface(["function completeAtomicSwap(bytes32,bytes)"]);
      const parsed = iface.parseTransaction({ data: tx.data });
      const secretHex = parsed.args[1];
      let secretStr = '';
      try { secretStr = ethers.toUtf8String(secretHex); } catch { secretStr = secretHex; }
      addLog(`Revealed secret (from tx): ${secretStr}`);
      setSecret(secretStr);
    } catch (err: any) {
      addLog(`Fetch secret error: ${err?.message || String(err)}`);
    }
  }

  async function solanaCompleteHTLCViaPhantom() {
    if (!(window as any).solana || !(window as any).solana.isPhantom) return addLog('Phantom not available');
    if (!solAtomicSwapPda || !solEscrowVaultPda || !secret) return addLog('Missing Solana HTLC parameters');

    try {
      const provider = (window as any).solana;
      const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
      const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID || 'FizzDEXProgram11111111111111111111111111111111');

      const participantPub = provider.publicKey;
      const atomicSwapPk = new PublicKey(solAtomicSwapPda);
      const escrowPk = new PublicKey(solEscrowVaultPda);
      const mintPk = new PublicKey(solanaMint || 'So11111111111111111111111111111111111111112');

      const participantAta = await getAssociatedTokenAddress(mintPk, participantPub);

      // build instruction data for complete_atomic_swap: discriminator + u32(len) + secret bytes
      const disc = Buffer.from(require('crypto').createHash('sha256').update('global:complete_atomic_swap').digest().slice(0,8));
      const secretBuf = Buffer.from(secret);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(secretBuf.length);
      const data = Buffer.concat([disc, lenBuf, secretBuf]);

      const keys = [
        { pubkey: participantPub, isSigner: true, isWritable: true },
        { pubkey: atomicSwapPk, isSigner: false, isWritable: true },
        { pubkey: escrowPk, isSigner: false, isWritable: true },
        { pubkey: participantAta, isSigner: false, isWritable: true },
        { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
      ];

      const ix = new TransactionInstruction({ keys, programId, data });
      const tx = new Transaction();
      tx.add(ix);
      tx.feePayer = participantPub;

      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;

      const signed = await provider.signAndSendTransaction(tx);
      addLog(`Solana complete tx submitted: ${signed.signature}`);
      await conn.confirmTransaction(signed.signature, 'confirmed');
      addLog('Solana HTLC claim confirmed');

      // if user enabled auto-complete, also try to complete EVM counterpart (if user is connected and has evmSwapId)
      if (autoCompleteOnReveal && signer && evmSwapId) {
        addLog('Attempting to auto-complete EVM counterpart...');
        await evmCompleteHTLC();
      }
    } catch (err: any) {
      addLog(`Solana complete error: ${err?.message || String(err)}`);
    }
  }

  // Watch Solana atomic-swap PDA for 'complete' instruction preimage (polling)
  async function watchSolanaForReveal(start: boolean) {
    if (!solAtomicSwapPda) return addLog('No Solana atomicSwap PDA provided');
    const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
    const pda = new PublicKey(solAtomicSwapPda);

    if (!start) {
      if (solanaPollRef.current) {
        clearInterval(solanaPollRef.current);
        solanaPollRef.current = null;
      }
      setWatchingSolana(false);
      return addLog('Stopped watching Solana PDA');
    }

    setWatchingSolana(true);
    solanaPollRef.current = window.setInterval(async () => {
      try {
        const sigs = await conn.getSignaturesForAddress(pda, { limit: 10 });
        for (const sigInfo of sigs) {
          const tx = await conn.getTransaction(sigInfo.signature, { commitment: 'confirmed' as any });
          if (!tx || !tx.transaction) continue;
          // search instructions for complete_atomic_swap discriminator
          const ix = tx.transaction.message.instructions.find(i => i.data && i.data.length > 16);
          if (!ix) continue;
          const data = Buffer.from(ix.data, 'base64');
          const disc = require('crypto').createHash('sha256').update('global:complete_atomic_swap').digest().slice(0,8);
          if (data.slice(0,8).equals(disc)) {
            // parse secret length and secret
            const len = data.readUInt32LE(8);
            const secretBuf = data.slice(12, 12 + len);
            const secretStr = secretBuf.toString();
            addLog(`Detected secret preimage on Solana: ${secretStr}`);
            setSecret(secretStr);

            if (autoCompleteOnReveal && signer && evmSwapId) {
              addLog('Auto-completing EVM counterpart (using MetaMask)...');
              await evmCompleteHTLC();
            }

            // stop after detection
            watchSolanaForReveal(false);
            return;
          }
        }
      } catch (err: any) {
        addLog(`Solana watch error: ${err?.message || String(err)}`);
      }
    }, 3000);
    addLog('Started watching Solana PDA for revealed secrets');
  }

  // Find best route across provided chains using relayer aggregator
  async function findBestRoute() {
    try {
      const chains = JSON.parse(routeChainList || '[]');
      if (!chains || chains.length === 0) return addLog('No chains configured for aggregation');
      const body = { chains, inputChainId: chains[0].chainId, inputToken: tokenAddr, outputToken, amount: amount || '0' };
      const resp = await fetch((process.env.RELAYER_URL || 'http://localhost:4001') + '/aggregate-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await resp.json();
      if (!resp.ok) { addLog('Aggregator error: ' + JSON.stringify(j)); return; }
      setRouteResults(j.results || []);
      addLog('Aggregator best: ' + JSON.stringify(j.best));
    } catch (err: any) {
      addLog('Aggregator request failed: ' + (err?.message || String(err)));
    }
  }

  // Apply a selected aggregator route to the UI (pre-fill swap/htlc fields)
  function useRoute(r: any) {
    try {
      const quote = r.quote || {};
      const inputAddr = quote?.inputToken?.address || '';
      const outputAddr = quote?.outputToken?.address || '';
      const amt = quote?.inputAmount || amount || '';
      setAmount(amt.toString ? amt.toString() : String(amt));
      setTokenAddr(inputAddr);
      setOutputToken(outputAddr);

      // best-effort chain guess from chain id string
      const cid = String(r.chain || '');
      if (cid.toLowerCase().includes('sol') || cid.toLowerCase().includes('solana')) setChain('solana');
      else setChain('evm');

      addLog(`Applied route from ${r.chain} — input=${inputAddr} output=${outputAddr} amount=${amt}`);
    } catch (err: any) {
      addLog('useRoute failed: ' + (err?.message || String(err)));
    }
  }

  async function executeRoute(r: any) {
    setIsExecuting(true);
    setExecResponse(null);
    try {
      const chains = JSON.parse(routeChainList || '[]');
      const chainId = r.chain;
      const cfg = (chains || []).find((c: any) => c.chainId === chainId) || { chainId, chainType: (String(chainId).toLowerCase().includes('sol') ? 'solana' : 'evm') };
      const quote = r.quote || {};
      const inputTokenAddr = quote?.inputToken?.address || tokenAddr;
      const outputTokenAddr = quote?.outputToken?.address || outputToken;
      const amt = quote?.inputAmount || amount || '0';
      const outAmt = quote?.outputAmount || quote?.amountOut || '0';
      let minOutput = '0';
      try {
        minOutput = outAmt && BigInt(outAmt) > 0n ? ((BigInt(outAmt) * 99n) / 100n).toString() : '0';
      } catch (_) { minOutput = '0'; }

      const body = { chainId: cfg.chainId, chainType: cfg.chainType || 'evm', inputToken: inputTokenAddr, outputToken: outputTokenAddr, amount: amt, minOutput, chains };
      addLog(`Executing route on ${cfg.chainId} (type=${cfg.chainType}) amount=${amt}`);
      const resp = await fetch((process.env.RELAYER_URL || 'http://localhost:4001') + '/execute-route', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await resp.json();
      if (!resp.ok) {
        addLog('Execute-route failed: ' + JSON.stringify(j));
        setExecResponse({ ok: false, body: j });
        return;
      }
      addLog('Execute-route success: ' + JSON.stringify(j));
      setExecResponse({ ok: true, body: j });
    } catch (err: any) {
      addLog('Execute-route error: ' + (err?.message || String(err)));
      setExecResponse({ ok: false, body: { error: err?.message || String(err) } });
    } finally {
      setIsExecuting(false);
    }
  }


  function addLog(line: string) {
    setLogs((l) => [line, ...l].slice(0, 200));
  }

  async function startListening() {
    if (chain === 'evm') {
      if (!provider || !fizzDexAddr) return;
      const contract = new ethers.Contract(fizzDexAddr, FIZZDEX_ABI, provider);

      // Initiated listener
      contract.on("AtomicSwapInitiated", (swapId, initiator, participant, amt, event) => {
        addLog(`AtomicSwapInitiated swapId=${swapId} initiator=${initiator} participant=${participant} amount=${ethers.formatEther(amt)}`);
      });

      // Completed listener - parse tx to extract revealed secret (preimage)
      contract.on("AtomicSwapCompleted", async (swapId, participantAddr, event) => {
        try {
          addLog(`AtomicSwapCompleted swapId=${swapId} participant=${participantAddr}`);
          const tx = await provider.getTransaction(event.transactionHash);
          if (!tx) return;
          const iface = new ethers.Interface(["function completeAtomicSwap(bytes32,bytes)"]);
          const parsed = iface.parseTransaction({ data: tx.data });
          const secretHex = parsed.args[1];
          let secretStr = '';
          try { secretStr = ethers.toUtf8String(secretHex); } catch { secretStr = secretHex; }
          addLog(`Revealed secret detected on EVM: ${secretStr}`);
          setSecret(secretStr);

          // auto-complete on Solana if user has local PDAs and Phantom is connected
          if (phantomPubkey && solAtomicSwapPda && solEscrowVaultPda && (window as any).solana && (window as any).solana.isPhantom) {
            addLog('Auto-completing matching Solana HTLC via Phantom...');
            await solanaCompleteHTLCViaPhantom();
          }
        } catch (err: any) {
          addLog(`Error parsing completed tx: ${err?.message || String(err)}`);
        }
      });

      addLog("Listening for AtomicSwapInitiated and AtomicSwapCompleted events (EVM)...");
    } else {
      addLog("Solana event listening should be done via relayer or direct connection (coming soon)");
    }
  }

  async function submitInitiate() {
    if (!participant || !amount) return;

    if (chain === 'evm') {
      if (!signer || !fizzDexAddr || !tokenAddr) return;
      const contract = new ethers.Contract(fizzDexAddr, FIZZDEX_ABI, signer);
      const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret || "auto-secret"));
      const amt = ethers.parseEther(amount);
      const tx = await contract.initiateAtomicSwap(participant, tokenAddr, amt, secretHash, timelock);
      addLog(`Sent initiateAtomicSwap tx: ${tx.hash}`);
      await tx.wait();
      addLog(`initiateAtomicSwap mined`);
      return;
    }

    // Solana flow — try phantom-signed client HTLC (preferred). If Phantom not available, fall back to relayer.
    if ((window as any).solana && (window as any).solana.isPhantom) {
      try {
        await solanaInitiateHTLCViaPhantom();
        return;
      } catch (err: any) {
        addLog(`Phantom HTLC failed: ${String(err)} — falling back to relayer`);
      }
    }

    // Fallback: call relayer to create HTLC on Solana (relayer must be running)
    try {
      const resp = await fetch((process.env.RELAYER_URL || 'http://localhost:4001') + '/solana/initiate-htlc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participant, tokenMint: solanaMint, amount: amount, secretHash: secret ? ("0x" + ethers.keccak256(ethers.toUtf8Bytes(secret)).replace(/^0x/, '')) : undefined, timelock }),
      });
      const j = await resp.json();
      addLog(`Relayer response: ${JSON.stringify(j)}`);
    } catch (err) {
      addLog(`Relayer error: ${String(err)}`);
    }
  }

  return (
    <div className="container">
      <header>
        <h1>FizzDex — HTLC UI</h1>
        <div className="header-row">
          <div>{account ? `Connected: ${account}` : "Not connected"}</div>
          <div>
            <button onClick={connect}>Connect Wallet</button>
          </div>
        </div>
      </header>

      <main>
        <section className="card">
          <h2>HTLC (initiate) — choose chain</h2>

          <label>Chain</label>
          <div style={{display: 'flex', gap: 8}}>
            <button onClick={() => setChain('evm')} style={{background: chain === 'evm' ? 'var(--accent)' : undefined}}>EVM</button>
            <button onClick={() => setChain('solana')} style={{background: chain === 'solana' ? 'var(--accent)' : undefined}}>Solana</button>
          </div>

          {chain === 'evm' ? (
            <>
              <label>FizzDex contract address</label>
              <input value={fizzDexAddr} onChange={(e) => setFizzDexAddr(e.target.value)} placeholder="0x..." />

              <label>Token address</label>
              <input value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)} placeholder="ERC-20 token address" />

              <label>Participant (recipient) address</label>
              <input value={participant} onChange={(e) => setParticipant(e.target.value)} placeholder="0x..." />

              <label>Amount (ETH units)</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.0" />
            </>
          ) : (
            <>
              <label>Solana token mint</label>
              <input value={solanaMint} onChange={(e) => setSolanaMint(e.target.value)} placeholder="So111111..." />

              <label>Participant (recipient) public key</label>
              <input value={participant} onChange={(e) => setParticipant(e.target.value)} placeholder="Pubkey..." />

              <label>Amount (raw token amount)</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000 (u64)" />

              <label>Connect Phantom (optional)</label>
              <div style={{display: 'flex', gap:8}}>
                <button onClick={connectPhantom}>Connect Phantom</button>
                <div style={{alignSelf: 'center'}}>{phantomPubkey ? `Phantom: ${phantomPubkey}` : 'Not connected'}</div>
              </div>
            </>
          )}

          <label>Secret (optional — auto-generated if empty)</label>
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="secret string" />

          <label>Timelock (unix timestamp)</label>
          <input value={timelock} onChange={(e) => setTimelock(Number(e.target.value))} />

          <div className="buttons">
            <button onClick={submitInitiate}>Initiate HTLC</button>
            <button onClick={startListening}>Listen for events</button>
          </div>
        
          { /* Execution feedback */ }
          <div style={{marginTop:12}}>
            {isExecuting && <div style={{color:'var(--accent)', display:'flex', alignItems:'center'}}>Executing route... <span className="spinner" /></div>}
            {execResponse && (
              <div className="exec-result">
                <div style={{fontWeight:700}}>{execResponse.ok ? 'Success' : 'Error'}</div>
                <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',marginTop:8}}>{JSON.stringify(execResponse.body, null, 2)}</pre>
              </div>
            )}
          </div>

        </section>

        <section className="card">
          <h2>Complete / Claim HTLC</h2>

          <label>Chain</label>
          <div style={{display: 'flex', gap: 8}}>
            <button onClick={() => setChain('evm')} style={{background: chain === 'evm' ? 'var(--accent)' : undefined}}>EVM</button>
            <button onClick={() => setChain('solana')} style={{background: chain === 'solana' ? 'var(--accent)' : undefined}}>Solana</button>
          </div>

          {chain === 'evm' ? (
            <>
              <label>Swap ID</label>
              <input value={evmSwapId} onChange={(e) => setEvmSwapId(e.target.value)} placeholder="0x..." />

              <label>Or tx hash to extract secret</label>
              <input value={evmTxHash} onChange={(e) => setEvmTxHash(e.target.value)} placeholder="0x..." />
              <div style={{display: 'flex', gap: 8, marginTop: 6}}>
                <button onClick={evmFetchSecretFromTx}>Fetch secret from tx</button>
              </div>

              <label>Secret (preimage)</label>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="secret string" />

              <div className="buttons" style={{marginTop: 8}}>
                <button onClick={evmCompleteHTLC}>Complete HTLC (EVM)</button>
              </div>
            </>
          ) : (
            <>
              <label>AtomicSwap PDA (from relayer/initiate)</label>
              <input value={solAtomicSwapPda} onChange={(e) => setSolAtomicSwapPda(e.target.value)} placeholder="PDA..." />

              <label>Escrow vault PDA</label>
              <input value={solEscrowVaultPda} onChange={(e) => setSolEscrowVaultPda(e.target.value)} placeholder="PDA..." />

              <label>Secret (preimage)</label>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="secret string" />

              <label style={{marginTop:8}}>
                <input type="checkbox" checked={autoCompleteOnReveal} onChange={(e) => setAutoCompleteOnReveal(e.target.checked)} /> Auto-complete when counterparty reveals secret
              </label>

              <div style={{display:'flex',gap:8,marginTop:8}}>
                <button onClick={() => watchSolanaForReveal(!watchingSolana)}>{watchingSolana ? 'Stop watching Solana' : 'Watch Solana PDA'}</button>
                <button onClick={solanaCompleteHTLCViaPhantom}>Complete HTLC (Solana / Phantom)</button>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h2>Route aggregator — find best route across chains</h2>

          <label>Chains (JSON)</label>
          <textarea value={routeChainList} onChange={(e) => setRouteChainList(e.target.value)} rows={4} style={{width: '100%', fontFamily: 'monospace'}} />

          <label>Output token (address or mint)</label>
          <input value={outputToken} onChange={(e) => setOutputToken(e.target.value)} placeholder="0x... or Solana mint" />

          <div className="buttons">
            <button onClick={findBestRoute}>Find best route</button>
          </div>

          <div style={{marginTop: 12}}>
            {routeResults.length === 0 ? (
              <div style={{color: '#666'}}>No routes yet — run the aggregator.</div>
            ) : (
              routeResults.map((r: any, idx: number) => (
                <div key={idx} style={{borderTop: '1px dashed rgba(255,255,255,0.06)', paddingTop: 8, marginTop: 8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div><strong>Chain:</strong> {r.chain} {r.route ? `(${r.route.join('→')})` : ''}</div>
                    <div style={{display:'flex',gap:8}}>
                      <button onClick={() => useRoute(r)} style={{background:'transparent',border:'1px solid var(--accent)',padding:'6px 8px',borderRadius:6,color:'var(--accent)'}}>Use this route</button>
                      <button onClick={() => executeRoute(r)} style={{background:'transparent',border:'1px solid var(--accent-2)',padding:'6px 8px',borderRadius:6,color:'var(--accent-2)'}}>Execute route</button>
                    </div>
                  </div>
                  <div style={{marginTop:6}}><strong>Output amount:</strong> {r.quote?.outputAmount || r.quote?.amountOut || 'n/a'}</div>
                  <div style={{fontFamily: 'monospace', fontSize: 12, marginTop: 6, color:'var(--muted)'}}>{JSON.stringify(r.quote)}</div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="card">
          <h2>Logs</h2>
          <div className="logs">
            {logs.map((l, i) => (
              <div key={i} className="log">{l}</div>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <small>This UI is a minimal starter — use the relayer for automated cross-chain coordination.</small>
      </footer>
    </div>
  );
}
