// The message a wallet signs to accept a referral invite. Shared by the
// dashboard (which asks the wallet to sign it) and the worker (which checks
// the signature), so both always agree on the exact bytes.

export const REFERRAL_PROOF_TTL_MS = 24 * 60 * 60 * 1000;
/** NEP-413 recipient for NEAR wallets' signMessage. */
export const REFERRAL_PROOF_RECIPIENT = 'hopr';

export function referralProofMessage(wallet: string, code: string, issuedAt: string): string {
  return [
    'Activate Hopr referral invite',
    `Code: ${code}`,
    `Wallet: ${wallet}`,
    `Issued: ${issuedAt}`,
    'This signature is free: it sends no transaction and moves no funds.',
  ].join('\n');
}

/** Pull the fields back out of a signed message (null if it isn't one). */
export function parseReferralProofMessage(message: string): { code: string; wallet: string; issuedAt: string } | null {
  const lines = message.split('\n');
  if (lines[0] !== 'Activate Hopr referral invite' || lines.length !== 5) return null;
  const field = (line: string | undefined, name: string) => (line?.startsWith(`${name}: `) ? line.slice(name.length + 2) : null);
  const code = field(lines[1], 'Code');
  const wallet = field(lines[2], 'Wallet');
  const issuedAt = field(lines[3], 'Issued');
  if (!code || !wallet || !issuedAt) return null;
  return message === referralProofMessage(wallet, code, issuedAt) ? { code, wallet, issuedAt } : null;
}
