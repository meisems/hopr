/** Default 1Click terms; snapshot at quote time, never from client reports.
 * https://docs.near-intents.org/integration/distribution-channels/1click-api/fee-config
 */
export function intentsHoprBps(requestedBps: number, authenticated: boolean): number {
  if (!Number.isInteger(requestedBps) || requestedBps < 0 || requestedBps > 500) {
    throw new Error('Invalid 1Click fee');
  }
  return authenticated ? Math.ceil(requestedBps / 2) : requestedBps;
}

export interface IntentsFeeRecord {
  refund_wallet: string;
  fee_account: string;
  requested_bps: number;
  hopr_bps: number;
  policy: string;
  credited_trade_id: string | null;
}

export async function saveIntentsFeeQuote(db: D1Database, quote: {
  depositAddress: string; refundWallet: string; feeAccount: string;
  requestedBps: number; authenticated: boolean;
}): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO intents_fee_quotes
    (deposit_address, refund_wallet, fee_account, requested_bps, hopr_bps, policy, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(quote.depositAddress, quote.refundWallet, quote.feeAccount, quote.requestedBps,
      intentsHoprBps(quote.requestedBps, quote.authenticated),
      quote.authenticated ? 'authenticated-default-50-50-v1' : 'public-plus-25bps-v1', Date.now()).run();
}
