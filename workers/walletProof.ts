// Proof that a wallet owner accepted a referral invite. Binding a wallet to a
// referrer needs a signature over referralProofMessage() from that wallet,
// so nobody can attach other people's wallets to their own code.
//
//   EVM ..... personal_sign (EOA via ecrecover; smart wallets via ERC-1271)
//   Solana .. signMessage (ed25519 over the UTF-8 message)
//   NEAR .... signMessage (NEP-413), key must be a full-access key of the account

import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import { parseReferralProofMessage, REFERRAL_PROOF_RECIPIENT, REFERRAL_PROOF_TTL_MS } from '../src/services/referralMessage';

export interface WalletProof {
  message: string;
  /** EVM: 0x hex. Solana: base58 or base64. NEAR: base64. */
  signature: string;
  /** NEAR only: "ed25519:<base58>" key that signed, and the base64 32-byte NEP-413 nonce. */
  publicKey?: string;
  nonce?: string;
}

export interface WalletProofEnv {
  NEAR_RPC_URL?: string;
}

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** EIP-191 hash of a personal_sign message. */
export function personalMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  return keccak_256(concat(encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`), body));
}

/** Address that produced an EOA personal_sign signature, or null. */
export function recoverEvmAddress(message: string, signature: string): string | null {
  const bytes = hexToBytes(signature);
  if (!bytes || bytes.length !== 65) return null;
  let recovery = bytes[64];
  if (recovery >= 27) recovery -= 27;
  if (recovery !== 0 && recovery !== 1) return null;
  try {
    const point = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(recovery).recoverPublicKey(personalMessageHash(message));
    return `0x${bytesToHex(keccak_256(point.toRawBytes(false).slice(1)).slice(-20))}`;
  } catch {
    return null;
  }
}

const ERC1271_MAGIC = '0x1626ba7e';
const EVM_PROOF_RPCS = ['https://mainnet.base.org', 'https://arb1.arbitrum.io/rpc', 'https://bsc-dataseed.binance.org'];

/** Smart-contract wallets (Coinbase Smart Wallet, Safe…) validate signatures on-chain (ERC-1271). */
async function erc1271Valid(wallet: string, message: string, signature: string, fetchImpl: typeof fetch): Promise<boolean> {
  const sig = signature.replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(sig) || sig.length > 4096) return false;
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  const data = `${ERC1271_MAGIC}${bytesToHex(personalMessageHash(message))}${(64).toString(16).padStart(64, '0')}${(sig.length / 2).toString(16).padStart(64, '0')}${padded}`;
  for (const rpc of EVM_PROOF_RPCS) {
    try {
      const response = await fetchImpl(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: wallet, data }, 'latest'] }),
      });
      const result = (await response.json() as { result?: string }).result ?? '';
      if (result.toLowerCase().startsWith(ERC1271_MAGIC)) return true;
    } catch {
      // try the next chain
    }
  }
  return false;
}

function borshString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concat(length, bytes);
}

/** NEP-413 payload hash that NEAR wallets sign for signMessage. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2 ** 31 + 413, true);
  return sha256(concat(tag, borshString(message), nonce, borshString(recipient), new Uint8Array([0])));
}

async function nearFullAccessKey(accountId: string, publicKey: string, env: WalletProofEnv, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(env.NEAR_RPC_URL || 'https://free.rpc.fastnear.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'hopr', method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey } }),
    });
    return (await response.json() as { result?: { permission?: unknown } }).result?.permission === 'FullAccess';
  } catch {
    return false;
  }
}

/**
 * True when `proof` is `wallet` (normalized, of ecosystem `vm`) signing the
 * invite message for `code`, issued within the last 24 hours.
 */
export async function verifyWalletProof(
  wallet: string,
  vm: 'evm' | 'svm' | 'near',
  code: string,
  proof: WalletProof,
  env: WalletProofEnv,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<boolean> {
  if (typeof proof?.message !== 'string' || typeof proof.signature !== 'string' || proof.message.length > 600) return false;
  const parsed = parseReferralProofMessage(proof.message);
  if (!parsed || parsed.code !== code) return false;
  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || issued > now + 5 * 60_000 || now - issued > REFERRAL_PROOF_TTL_MS) return false;

  if (vm === 'evm') {
    if (parsed.wallet.toLowerCase() !== wallet) return false;
    if (recoverEvmAddress(proof.message, proof.signature) === wallet) return true;
    return erc1271Valid(wallet, proof.message, proof.signature, fetchImpl);
  }

  if (vm === 'svm') {
    if (parsed.wallet !== wallet) return false;
    try {
      const signature = /^[1-9A-HJ-NP-Za-km-z]+$/.test(proof.signature) && proof.signature.length > 80 ? bs58.decode(proof.signature) : base64ToBytes(proof.signature);
      return Boolean(signature && signature.length === 64 && ed25519.verify(signature, encoder.encode(proof.message), bs58.decode(wallet)));
    } catch {
      return false;
    }
  }

  // NEAR (NEP-413)
  if (parsed.wallet.toLowerCase() !== wallet || !proof.publicKey?.startsWith('ed25519:') || !proof.nonce) return false;
  try {
    const publicKey = bs58.decode(proof.publicKey.slice('ed25519:'.length));
    const nonce = base64ToBytes(proof.nonce);
    const signature = base64ToBytes(proof.signature);
    if (publicKey.length !== 32 || nonce?.length !== 32 || signature?.length !== 64) return false;
    if (!ed25519.verify(signature, nep413Hash(proof.message, nonce, REFERRAL_PROOF_RECIPIENT), publicKey)) return false;
    // Implicit accounts are their key; named accounts must hold it as a full-access key.
    if (/^[0-9a-f]{64}$/.test(wallet)) return bytesToHex(publicKey) === wallet;
    return nearFullAccessKey(wallet, proof.publicKey, env, fetchImpl);
  } catch {
    return false;
  }
}
