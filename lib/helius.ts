import {
  HELIUS_MAX_PAGES_FULL_HISTORY,
  HELIUS_PAGE_LIMIT,
  IGNORED_MINTS,
  SOL_MINT
} from "./constants";
import { withRetry } from "./rate-limit";
import type { Confidence, HistoryRange } from "./types";

type UnknownRecord = Record<string, unknown>;

type SwapScanResult = {
  boughtMints: Set<string>;
  firstActivityAt?: string;
  confidence: Confidence;
  reason?: string;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeAccount(value: unknown) {
  return asString(value) ?? "";
}

function txTime(tx: UnknownRecord) {
  const timestamp = asNumber(tx.timestamp);
  return timestamp ? new Date(timestamp * 1000).toISOString() : undefined;
}

function isLikelyNftTransfer(transfer: UnknownRecord) {
  const standard = asString(transfer.tokenStandard)?.toLowerCase();
  const amount = asNumber(transfer.tokenAmount);
  return standard?.includes("nonfungible") || standard === "programmablenft" || amount === 1 && standard === "nft";
}

function walletSpentSwapInput(tx: UnknownRecord, wallet: string) {
  const nativeSpent = asArray(tx.nativeTransfers).some((transfer) => {
    return normalizeAccount(transfer.fromUserAccount) === wallet && (asNumber(transfer.amount) ?? 0) > 0;
  });

  const ignoredTokenSpent = asArray(tx.tokenTransfers).some((transfer) => {
    const mint = asString(transfer.mint);
    return (
      normalizeAccount(transfer.fromUserAccount) === wallet &&
      !!mint &&
      IGNORED_MINTS.has(mint) &&
      (asNumber(transfer.tokenAmount) ?? 0) > 0
    );
  });

  const swapEvent = asRecord(asRecord(tx.events).swap);
  const eventNativeInput = asRecord(swapEvent.nativeInput);
  const eventTokenInputs = asArray(swapEvent.tokenInputs);
  const eventSpent =
    normalizeAccount(eventNativeInput.account) === wallet ||
    eventTokenInputs.some((input) => {
      const mint = asString(input.mint);
      return normalizeAccount(input.userAccount) === wallet && !!mint && IGNORED_MINTS.has(mint);
    });

  return nativeSpent || ignoredTokenSpent || eventSpent;
}

function receivedBoughtMints(tx: UnknownRecord, wallet: string) {
  const mints = new Set<string>();

  for (const transfer of asArray(tx.tokenTransfers)) {
    const mint = asString(transfer.mint);
    if (!mint || IGNORED_MINTS.has(mint) || isLikelyNftTransfer(transfer)) continue;
    if (normalizeAccount(transfer.toUserAccount) === wallet && (asNumber(transfer.tokenAmount) ?? 0) > 0) {
      mints.add(mint);
    }
  }

  const swapEvent = asRecord(asRecord(tx.events).swap);
  for (const output of asArray(swapEvent.tokenOutputs)) {
    const mint = asString(output.mint);
    if (!mint || IGNORED_MINTS.has(mint)) continue;
    if (normalizeAccount(output.userAccount) === wallet || normalizeAccount(output.owner) === wallet) {
      mints.add(mint);
    }
  }

  return mints;
}

function getRangeCutoff(historyRange: HistoryRange) {
  if (historyRange === "30d") return Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (historyRange === "90d") return Date.now() - 90 * 24 * 60 * 60 * 1000;
  return undefined;
}

function getMaxSwapPages(historyRange: HistoryRange) {
  if (historyRange === "500swaps") return 5;
  if (historyRange === "full") return HELIUS_MAX_PAGES_FULL_HISTORY;
  return HELIUS_MAX_PAGES_FULL_HISTORY;
}

export async function scanWalletSwapHistory(wallet: string, historyRange: HistoryRange): Promise<SwapScanResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  const boughtMints = new Set<string>();
  const cutoffMs = getRangeCutoff(historyRange);
  const maxPages = getMaxSwapPages(historyRange);
  let before: string | undefined;
  let firstActivityAt: string | undefined;
  let reachedEnd = false;
  let reachedCutoff = false;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
      url.searchParams.set("api-key", apiKey);
      url.searchParams.set("type", "SWAP");
      url.searchParams.set("limit", String(HELIUS_PAGE_LIMIT));
      if (before) url.searchParams.set("before", before);

      const txs = await withRetry(async () => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`Helius history request failed: ${response.status}`);
        return (await response.json()) as UnknownRecord[];
      });

      if (!Array.isArray(txs) || txs.length === 0) {
        reachedEnd = true;
        break;
      }

      for (const tx of txs) {
        const seenAt = txTime(tx);
        if (seenAt) firstActivityAt = seenAt;

        if (cutoffMs && seenAt && new Date(seenAt).getTime() < cutoffMs) {
          reachedCutoff = true;
          break;
        }

        if (!walletSpentSwapInput(tx, wallet)) continue;
        for (const mint of receivedBoughtMints(tx, wallet)) boughtMints.add(mint);
      }

      const last = txs[txs.length - 1];
      before = asString(last.signature);
      if (!before || reachedCutoff) break;
    }
  } catch (error) {
    return {
      boughtMints,
      firstActivityAt,
      confidence: "insufficient",
      reason: error instanceof Error ? error.message : "Failed to scan wallet history"
    };
  }

  if (historyRange === "full" && !reachedEnd) {
    return {
      boughtMints,
      firstActivityAt,
      confidence: "insufficient",
      reason: "Full-history scan reached the configured page limit before wallet history ended"
    };
  }

  if ((historyRange === "30d" || historyRange === "90d") && !reachedCutoff && !reachedEnd) {
    return {
      boughtMints,
      firstActivityAt,
      confidence: "insufficient",
      reason: "Date-range scan did not complete"
    };
  }

  return {
    boughtMints,
    firstActivityAt,
    confidence: historyRange === "full" ? "complete" : "partial",
    reason: historyRange === "full" ? undefined : "Result only covers the selected scan range"
  };
}

export async function walletStillHoldsMint(wallet: string, mint: string): Promise<boolean | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  try {
    const response = await withRetry(async () => {
      const result = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "holdings",
          method: "getTokenAccountsByOwner",
          params: [
            wallet,
            { mint },
            {
              encoding: "jsonParsed",
              commitment: "confirmed"
            }
          ]
        }),
        cache: "no-store"
      });
      if (!result.ok) throw new Error(`Helius RPC holdings request failed: ${result.status}`);
      return result.json();
    });

    const accounts = asArray(asRecord(asRecord(response).result).value);
    return accounts.some((account) => {
      const info = asRecord(asRecord(asRecord(account.account).data).parsed).info;
      const amount = asRecord(asRecord(info).tokenAmount);
      return BigInt(asString(amount.amount) ?? "0") > 0n;
    });
  } catch {
    return null;
  }
}

export { SOL_MINT };
