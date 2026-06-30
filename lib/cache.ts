import { CACHE_TTL_MS } from "./constants";
import type { HistoryRange, WalletAnalysis } from "./types";

type CacheEntry = {
  createdAt: number;
  payload: WalletAnalysis;
};

const globalCache = globalThis as typeof globalThis & {
  walletAnalysisCache?: Map<string, CacheEntry>;
};

const cache = globalCache.walletAnalysisCache ?? new Map<string, CacheEntry>();
globalCache.walletAnalysisCache = cache;

function cacheKey(wallet: string, tokenMint: string, historyRange: HistoryRange) {
  return `${wallet}:${tokenMint}:${historyRange}`;
}

export function readWalletCache(
  wallet: string,
  tokenMint: string,
  historyRange: HistoryRange
): WalletAnalysis | null {
  const entry = cache.get(cacheKey(wallet, tokenMint, historyRange));
  if (!entry) return null;

  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(cacheKey(wallet, tokenMint, historyRange));
    return null;
  }

  return entry.payload;
}

export function writeWalletCache(
  wallet: string,
  tokenMint: string,
  historyRange: HistoryRange,
  payload: WalletAnalysis
) {
  cache.set(cacheKey(wallet, tokenMint, historyRange), {
    createdAt: Date.now(),
    payload
  });
}
