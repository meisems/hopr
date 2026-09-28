// NEAR browser wallets through NEAR's official wallet-selector (Meteor, HERE,
// MyNearWallet, Intear). Everything is imported lazily: the selector and its
// wallet SDKs load only when the user opens the NEAR options or reconnects.

import type { WalletSelector } from '@near-wallet-selector/core';
import type { NearTransactionPlan } from '../nearService';

export interface NearWalletOption {
  id: string;
  name: string;
  iconUrl?: string;
  available: boolean;
}

let selectorPromise: Promise<WalletSelector> | null = null;

export function getNearSelector(): Promise<WalletSelector> {
  selectorPromise ??= (async () => {
    await import('./nodeShims');
    const [{ setupWalletSelector }, { setupMeteorWallet }, { setupHereWallet }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
      import('@near-wallet-selector/core'),
      import('@near-wallet-selector/meteor-wallet'),
      import('@near-wallet-selector/here-wallet'),
      import('@near-wallet-selector/my-near-wallet'),
      import('@near-wallet-selector/intear-wallet'),
    ]);
    return setupWalletSelector({
      network: 'mainnet',
      modules: [setupMeteorWallet(), setupHereWallet(), setupIntearWallet(), setupMyNearWallet()],
    });
  })().catch((error) => {
    selectorPromise = null;
    throw error;
  });
  return selectorPromise;
}

export async function listNearWallets(): Promise<NearWalletOption[]> {
  const selector = await getNearSelector();
  return selector.store.getState().modules.map((module) => ({
    id: module.id,
    name: module.metadata.name,
    iconUrl: module.metadata.iconUrl,
    available: module.metadata.available !== false,
  }));
}

/** The currently signed-in NEAR account, if any (restored automatically after reloads/redirects). */
export async function getNearAccount(): Promise<{ accountId: string; walletId: string | null } | null> {
  const selector = await getNearSelector();
  const state = selector.store.getState();
  const active = state.accounts.find((account) => account.active) ?? state.accounts[0];
  return active ? { accountId: active.accountId, walletId: state.selectedWalletId } : null;
}

export async function subscribeNearAccounts(listener: (accountId: string | null) => void): Promise<() => void> {
  const selector = await getNearSelector();
  const subscription = selector.store.observable.subscribe((state) => {
    const active = state.accounts.find((account) => account.active) ?? state.accounts[0];
    listener(active?.accountId ?? null);
  });
  return () => subscription.unsubscribe();
}

export async function connectNearWallet(walletId: string): Promise<string | null> {
  const selector = await getNearSelector();
  const wallet = await selector.wallet(walletId);
  // No contractId: we only need the account; every swap is signed per transaction.
  // (The union type also covers hardware wallets, which we don't offer, hence the narrowing cast.)
  const signIn = wallet.signIn as (params: { contractId?: string; methodNames?: string[] }) => Promise<Array<{ accountId: string }>>;
  const accounts = await signIn({});
  return accounts?.[0]?.accountId ?? (await getNearAccount())?.accountId ?? null;
}

export async function disconnectNearWallet(): Promise<void> {
  const selector = await getNearSelector();
  if (!selector.isSignedIn()) return;
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/**
 * Sign and send planned transactions with the connected NEAR wallet. Returns
 * the last transaction hash when the wallet reports outcomes (injected
 * wallets); redirect wallets navigate away and resume on return.
 */
export async function signAndSendNearPlans(plans: NearTransactionPlan[]): Promise<string | null> {
  const [selector, { actionCreators }] = await Promise.all([getNearSelector(), import('@near-js/transactions')]);
  const wallet = await selector.wallet();
  const outcomes = await wallet.signAndSendTransactions({
    transactions: plans.map((plan) => ({
      receiverId: plan.receiverId,
      actions: plan.actions.map((action) => action.type === 'FunctionCall'
        ? actionCreators.functionCall(action.methodName, action.args, action.gas, action.deposit)
        : actionCreators.transfer(action.deposit)),
    })),
  });
  const list = Array.isArray(outcomes) ? outcomes : [];
  const failure = list.find((outcome) => outcome && typeof outcome.status === 'object' && 'Failure' in outcome.status);
  if (failure) throw new Error('The NEAR transaction failed on-chain.');
  const last = list[list.length - 1] as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
  return last?.transaction?.hash ?? last?.transaction_outcome?.id ?? null;
}
