// The user's own trade & bridge activity, kept in this browser. It powers
// History, Positions and Analytics — there is no seeded or sample data; a new
// user starts with an empty list. Pending cross-chain routes are polled until
// they settle.

import { useEffect, useState } from 'react';
import { checkRouteStatus, type RouteKind, type RouteProvider, type TrackRef, type TrackStatus } from './router';
import { notify } from './preferences';

export interface ActivityAsset {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  /** Amount in smallest units. */
  amount: string;
}

export interface ActivityEntry {
  id: string;
  kind: RouteKind;
  /** For swaps: which side the user traded. */
  side?: 'buy' | 'sell';
  provider: RouteProvider;
  from: ActivityAsset;
  to: ActivityAsset; // `amount` is the quoted expected output
  amountInUsd?: number;
  amountOutUsd?: number;
  wallet: string;
  /** Destination wallet, recorded so positions cannot mix accounts across chains. */
  recipient?: string;
  txHash: string;
  explorerUrl?: string;
  receivingTxHash?: string;
  track: TrackRef;
  status: TrackStatus;
  statusDetail?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'hopr-activity-v1';
const MAX_ENTRIES = 300;
const listeners = new Set<(entries: ActivityEntry[]) => void>();
let cache: ActivityEntry[] | null = null;

function read(): ActivityEntry[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as ActivityEntry[];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(entries: ActivityEntry[]) {
  cache = entries.slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: keep the in-memory copy for this session.
  }
  listeners.forEach((listener) => listener(cache!));
}

export function getActivity(): ActivityEntry[] {
  return read();
}

export function addActivity(entry: Omit<ActivityEntry, 'id' | 'createdAt' | 'updatedAt'>): ActivityEntry {
  const full: ActivityEntry = { ...entry, id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
  write([full, ...read()]);
  schedulePolling();
  return full;
}

export function updateActivity(id: string, patch: Partial<ActivityEntry>) {
  write(read().map((entry) => (entry.id === id ? { ...entry, ...patch, updatedAt: Date.now() } : entry)));
}

export function clearActivity() {
  write([]);
}

export function useActivity(): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>(read);
  useEffect(() => {
    listeners.add(setEntries);
    schedulePolling();
    // Other tabs write to the same storage.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      cache = null;
      setEntries(read());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(setEntries);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return entries;
}

let pollTimer: number | null = null;
let polling = false;

/** Poll pending routes every 8s until none are left (entries older than 24h stop polling). */
function schedulePolling() {
  if (pollTimer !== null || polling || typeof window === 'undefined') return;
  const tick = async () => {
    pollTimer = null;
    polling = true;
    const pending = read().filter((entry) => entry.status === 'pending' && Date.now() - entry.createdAt < 24 * 3600_000);
    if (!pending.length) {
      polling = false;
      return;
    }
    await Promise.all(pending.map(async (entry) => {
      try {
        const result = await checkRouteStatus(entry.track);
        if (result.status !== entry.status || result.detail !== entry.statusDetail || result.receivingTxHash) {
          updateActivity(entry.id, { status: result.status, statusDetail: result.detail, receivingTxHash: result.receivingTxHash ?? entry.receivingTxHash });
        }
        if (result.status !== 'pending' && entry.status === 'pending') {
          const what = entry.kind === 'bridge' ? 'Bridge' : 'Cross-chain trade';
          notify(result.status === 'done' ? `${what} delivered` : `${what} ${result.status}`, `${entry.from.symbol} → ${entry.to.symbol}${result.detail ? ` · ${result.detail}` : ''}`);
        }
      } catch {
        // Transient API errors: try again next tick.
      }
    }));
    polling = false;
    pollTimer = window.setTimeout(tick, 8000);
  };
  pollTimer = window.setTimeout(tick, 4000);
}
