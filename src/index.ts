/**
 * FizzDex - Universal Multi-Chain DEX
 * 
 * A safe, awesome DEX that can handle ANY blockchain.
 * Built for the Atomic Fizz Caps ecosystem with security-first design.
 * 
 * @packageDocumentation
 */

// Core interfaces and utilities
export * from './chain-adapter';

// Chain adapters
export { EVMAdapter } from './adapters/evm-adapter';
// export { SolanaAdapter } from './adapters/solana-adapter';  // To be implemented
// export { XRPAdapter } from './adapters/xrp-adapter';  // To be implemented

// Version
export const VERSION = '1.0.0';
