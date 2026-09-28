// NEAR key management and transaction signing (worker-side).
//
// Depends only on @noble (audited, pure JS), bs58 and Web APIs, so it runs in
// Cloudflare Workers. Transactions are Borsh-encoded by hand for the two
// action types Hopr needs (FunctionCall, Transfer); the encoding is verified
// byte-for-byte against @near-js/transactions in tests/near.test.mjs.
//
// Keys follow NEAR's own format: "ed25519:<base58(32-byte seed || 32-byte public key)>".
// A generated wallet is an *implicit account*: its account id is the hex of the
// public key, and it comes into existence on-chain when it first receives NEAR.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import { isNearAccountId, nearRpc, NearRpcError, type NearAction, type NearRpcOptions, type NearTransactionPlan } from './nearService';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface NearKeyPair {
  /** Implicit account id (hex public key), or the named account the key controls. */
  accountId: string;
  /** "ed25519:<base58 public key>" */
  publicKey: string;
  /** "ed25519:<base58 seed||publicKey>" — encrypt before storing, never log. */
  privateKey: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keyPairFromSeed(seed: Uint8Array, accountId?: string): NearKeyPair {
  const publicKey = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(publicKey, 32);
  return {
    accountId: accountId ?? bytesToHex(publicKey),
    publicKey: `ed25519:${bs58.encode(publicKey)}`,
    privateKey: `ed25519:${bs58.encode(secret)}`,
  };
}

/** Generate a fresh NEAR implicit-account keypair. */
export function generateNearWallet(): { address: string; privateKey: string; publicKey: string } {
  const pair = keyPairFromSeed(ed25519.utils.randomPrivateKey());
  return { address: pair.accountId, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** Decode a stored/imported NEAR private key into its 32-byte signing seed. */
function decodeNearSecret(privateKey: string): { seed: Uint8Array; publicKey: Uint8Array } {
  const trimmed = privateKey.trim();
  const encoded = trimmed.startsWith('ed25519:') ? trimmed.slice('ed25519:'.length) : trimmed;
  if (trimmed.includes(':') && !trimmed.startsWith('ed25519:')) throw new Error('Only ed25519 NEAR keys are supported');
  const bytes = bs58.decode(encoded);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('A NEAR private key must be 32 or 64 bytes');
  const seed = bytes.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (bytes.length === 64 && bytesToHex(bytes.slice(32)) !== bytesToHex(publicKey)) {
    throw new Error('Private key does not match its embedded public key');
  }
  return { seed, publicKey };
}

/**
 * Validate an imported key. Without `accountId` the key is treated as an
 * implicit account; with one, the caller must verify on-chain that the key
 * is a full-access key of that account (see verifyFullAccessKey).
 */
export function importNearKey(privateKey: string, accountId?: string): NearKeyPair {
  if (accountId !== undefined && !isNearAccountId(accountId)) throw new Error('Invalid NEAR account id');
  const { seed } = decodeNearSecret(privateKey);
  return keyPairFromSeed(seed, accountId);
}

export function nearPublicKeyOf(privateKey: string): string {
  return `ed25519:${bs58.encode(decodeNearSecret(privateKey).publicKey)}`;
}

// ---------------------------------------------------------------------------
// Transactions (Borsh)
// ---------------------------------------------------------------------------

class BorshWriter {
  private chunks: number[] = [];

  u8(value: number) { this.chunks.push(value & 0xff); }

  u32(value: number) {
    for (let index = 0; index < 4; index += 1) this.chunks.push((value >>> (8 * index)) & 0xff);
  }

  uint(value: bigint, bytes: number) {
    if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error('Integer out of range');
    let remaining = value;
    for (let index = 0; index < bytes; index += 1) {
      this.chunks.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
  }

  fixed(bytes: Uint8Array) { for (const byte of bytes) this.chunks.push(byte); }

  bytes(bytes: Uint8Array) {
    this.u32(bytes.length);
    this.fixed(bytes);
  }

  string(value: string) { this.bytes(new TextEncoder().encode(value)); }

  result() { return new Uint8Array(this.chunks); }
}

const ACTION_INDEX = { FunctionCall: 2, Transfer: 3 } as const;
const KEY_TYPE_ED25519 = 0;

/** Borsh-encode a NEAR `Transaction` (the exact bytes that get hashed and signed). */
export function encodeNearTransaction(tx: { signerId: string; publicKey: Uint8Array; nonce: bigint; receiverId: string; blockHash: Uint8Array; actions: NearAction[] }): Uint8Array {
  if (tx.publicKey.length !== 32 || tx.blockHash.length !== 32) throw new Error('Invalid public key or block hash length');
  const writer = new BorshWriter();
  writer.string(tx.signerId);
  writer.u8(KEY_TYPE_ED25519);
  writer.fixed(tx.publicKey);
  writer.uint(tx.nonce, 8);
  writer.string(tx.receiverId);
  writer.fixed(tx.blockHash);
  writer.u32(tx.actions.length);
  for (const action of tx.actions) {
    writer.u8(ACTION_INDEX[action.type]);
    if (action.type === 'FunctionCall') {
      writer.string(action.methodName);
      writer.bytes(new TextEncoder().encode(JSON.stringify(action.args)));
      writer.uint(action.gas, 8);
      writer.uint(action.deposit, 16);
    } else {
      writer.uint(action.deposit, 16);
    }
  }
  return writer.result();
}

/** Sign a transaction: ed25519 over sha256(borsh(tx)). Returns the SignedTransaction bytes and tx hash. */
export function signNearTransaction(encodedTx: Uint8Array, privateKey: string): { signedTx: Uint8Array; hash: string } {
  const { seed } = decodeNearSecret(privateKey);
  const digest = sha256(encodedTx);
  const signature = ed25519.sign(digest, seed);
  const signed = new Uint8Array(encodedTx.length + 1 + 64);
  signed.set(encodedTx, 0);
  signed[encodedTx.length] = KEY_TYPE_ED25519;
  signed.set(signature, encodedTx.length + 1);
  return { signedTx: signed, hash: bs58.encode(digest) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface ExecutionOutcome {
  status?: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
  transaction?: { hash?: string };
  receipts_outcome?: Array<{ outcome?: { status?: { Failure?: unknown } } }>;
}

function describeFailure(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /"ExecutionError":"([^"]+)"/.exec(text)?.[1];
  return panic ?? text.slice(0, 300);
}

export interface NearExecutionResult {
  hashes: string[];
  /** false when the RPC timed out waiting; the transaction may still land — check the explorer. */
  confirmed: boolean;
}

/**
 * Sign and submit each planned transaction in order from `accountId`,
 * waiting for execution so a failed step stops the sequence. Throws with the
 * on-chain error if any receipt fails (NEP-141 transfers into Ref refund
 * automatically on failure).
 */
export async function executeNearTransactions(
  accountId: string,
  privateKey: string,
  plans: NearTransactionPlan[],
  options: NearRpcOptions = {},
): Promise<NearExecutionResult> {
  if (!plans.length) throw new Error('Nothing to execute');
  const publicKey = nearPublicKeyOf(privateKey);
  const accessKey = await nearRpc<{ nonce: number | string; block_hash: string; permission: unknown }>('query', {
    request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey,
  }, options).catch((error: unknown) => {
    if (error instanceof NearRpcError && /does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(`${error.kind} ${error.message}`)) {
      throw new Error('This NEAR account is not active yet. Fund it with NEAR first.');
    }
    throw error;
  });

  const publicKeyBytes = bs58.decode(publicKey.slice('ed25519:'.length));
  let nonce = BigInt(accessKey.nonce);
  const blockHash = bs58.decode(accessKey.block_hash);
  const hashes: string[] = [];
  let confirmed = true;

  for (const plan of plans) {
    nonce += 1n;
    const encoded = encodeNearTransaction({ signerId: accountId, publicKey: publicKeyBytes, nonce, receiverId: plan.receiverId, blockHash, actions: plan.actions });
    const { signedTx, hash } = signNearTransaction(encoded, privateKey);
    hashes.push(hash);
    let outcome: ExecutionOutcome;
    try {
      outcome = await nearRpc<ExecutionOutcome>('send_tx', { signed_tx_base64: bytesToBase64(signedTx), wait_until: 'EXECUTED_OPTIMISTIC' }, options);
    } catch (error) {
      if (error instanceof NearRpcError && /TIMEOUT/i.test(`${error.kind} ${error.message}`)) {
        confirmed = false;
        break;
      }
      throw new Error(`${plan.label} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const failure = outcome.status?.Failure ?? outcome.receipts_outcome?.find((receipt) => receipt.outcome?.status?.Failure)?.outcome?.status?.Failure;
    if (failure) throw new Error(`${plan.label} failed on-chain: ${describeFailure(failure)} (tx ${hash})`);
  }
  return { hashes, confirmed };
}

