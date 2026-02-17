import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

export async function completeSolanaHTLCWrapper(SOLANA_RPC: string, SOLANA_PROGRAM_ID: string, keypairJson: string, atomicSwapPda: string, escrowVaultPda: string, tokenMint: string, secret: string) {
  if (!keypairJson) throw new Error('RELAYER_SOLANA_KEYPAIR not configured');

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairJson)));
  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const programId = new PublicKey(SOLANA_PROGRAM_ID);

  const participant = payer.publicKey;
  const atomicSwapPk = new PublicKey(atomicSwapPda);
  const escrowPk = new PublicKey(escrowVaultPda);
  const mintPk = new PublicKey(tokenMint);

  const participantAta = await getAssociatedTokenAddress(mintPk, participant);

  const disc = require('crypto').createHash('sha256').update('global:complete_atomic_swap').digest().slice(0,8);
  const secretBuf = Buffer.from(secret);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(secretBuf.length);
  const data = Buffer.concat([Buffer.from(disc), lenBuf, secretBuf]);

  const keys = [
    { pubkey: participant, isSigner: true, isWritable: true },
    { pubkey: atomicSwapPk, isSigner: false, isWritable: true },
    { pubkey: escrowPk, isSigner: false, isWritable: true },
    { pubkey: participantAta, isSigner: false, isWritable: true },
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
  ];

  const ix = new Transaction().add({ keys, programId, data } as any);
  const txSig = await conn.sendTransaction(ix, [payer]);
  await conn.confirmTransaction(txSig, 'confirmed');
  return txSig;
}

export default completeSolanaHTLCWrapper;
