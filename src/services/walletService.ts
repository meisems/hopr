// Dual-Key Wallet Engine
//
// Generates and manages the two keypairs a Hopr user needs:
//   - one EVM keypair, shared across Base / Arbitrum / BSC / Robinhood Chain / Arc
//   - one Solana keypair
//
// Private keys are NEVER returned in plaintext from any exported helper except
// the initial generation call (which the caller must encrypt immediately) and
// decryptPrivateKey (which the caller must use in-memory only, for signing).
// Nothing here logs, persists, or transmits a raw key.
//
// Uses the Web Crypto API (SubtleCrypto) for AES-256-GCM so this module works
// identically in Cloudflare Workers and in the browser — no Node `crypto`.

import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface GeneratedWallet {
  evmAddress: string;
  evmPrivateKey: string; // hex, 0x-prefixed — encrypt before storing
  solanaAddress: string;
  solanaPrivateKey: string; // base58 secret key — encrypt before storing
}

export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  salt: string; // base64, 16 bytes — per-secret salt for key derivation
}

const PBKDF2_ITERATIONS = 210_000; // OWASP 2023+ minimum for PBKDF2-HMAC-SHA256
const AES_KEY_LENGTH = 256;

/**
 * Generate a brand-new EVM keypair and a brand-new Solana keypair for a user.
 * Callers MUST encrypt both private keys with encryptPrivateKey() before
 * writing anything to storage, and must never log the returned object.
 */
export function generateDualWallet(): GeneratedWallet {
  const evmWallet = Wallet.createRandom();
  const solanaKeypair = Keypair.generate();

  return {
    evmAddress: evmWallet.address,
    evmPrivateKey: evmWallet.privateKey,
    solanaAddress: solanaKeypair.publicKey.toBase58(),
    solanaPrivateKey: bs58.encode(solanaKeypair.secretKey),
  };
}

/**
 * Validate and normalize an imported EVM private key, returning its address.
 * Throws if the key is malformed.
 */
export function importEvmKey(privateKey: string): { address: string; privateKey: string } {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(normalized);
  return { address: wallet.address, privateKey: normalized };
}

/**
 * Validate and normalize an imported Solana secret key (base58), returning
 * its public address. Throws if the key is malformed.
 */
export function importSolanaKey(secretKeyBase58: string): { address: string; privateKey: string } {
  const secretKey = bs58.decode(secretKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return { address: keypair.publicKey.toBase58(), privateKey: secretKeyBase58 };
}

/**
 * Derive an AES-256-GCM key from the worker's ENCRYPTION_KEY secret and a
 * per-record random salt, via PBKDF2. Never reuse a salt across records.
 */
async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encrypt a plaintext private key with AES-256-GCM. `secret` is the worker's
 * ENCRYPTION_KEY environment secret — never a value derived from user input.
 */
export async function encryptPrivateKey(
  plaintextKey: string,
  secret: string
): Promise<EncryptedSecret> {
  if (!secret || secret.length < 16) {
    throw new Error('ENCRYPTION_KEY is missing or too short; refusing to encrypt');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt);
  const enc = new TextEncoder();
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintextKey));

  return {
    ciphertext: toBase64(new Uint8Array(ciphertextBuf)),
    iv: toBase64(iv),
    salt: toBase64(salt),
  };
}

/**
 * Decrypt a stored private key. Returns plaintext that the caller must hold
 * only in-memory, for the duration of signing a single transaction, and must
 * never log, cache, or echo back to the client.
 */
export async function decryptPrivateKey(encrypted: EncryptedSecret, secret: string): Promise<string> {
  const salt = fromBase64(encrypted.salt);
  const iv = fromBase64(encrypted.iv);
  const key = await deriveKey(secret, salt);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    fromBase64(encrypted.ciphertext) as BufferSource
  );
  return new TextDecoder().decode(plaintextBuf);
}

/** Serialize an EncryptedSecret to a single string column for D1/KV storage. */
export function packEncryptedSecret(e: EncryptedSecret): string {
  return `${e.salt}.${e.iv}.${e.ciphertext}`;
}

export function unpackEncryptedSecret(packed: string): EncryptedSecret {
  const [salt, iv, ciphertext] = packed.split('.');
  if (!salt || !iv || !ciphertext) throw new Error('Malformed encrypted secret');
  return { salt, iv, ciphertext };
}
