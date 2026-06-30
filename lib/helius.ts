import {
  HELIUS_MAX_PAGES_FULL_HISTORY,
  HELIUS_PAGE_LIMIT,
  IGNORED_MINTS,
  SOL_MINT
} from "./constants";
import type { AnalysisStatus, HistoryRange, WalletDebugEvent } from "./types";

type UnknownRecord = Record<string, unknown>;

export type SwapScanResult = {
  nonBaseTokenMints: Set<string>;
  currentTokenSeen: boolean;
  firstActivityAt?: string;
  scanStartedAt?: string;
  scanEndedAt?: string;
  transactionCount: number;
  pageCount: number;
  status: AnalysisStatus;
  reason?: string;
  heliusStatusCodes: number[];
  heliusRetryCount: number;
  debugEvents: WalletDebugEvent[];
};

type HeliusPageResult = {
  txs: UnknownRecord[];
  statusCode: number;
  retries: number;
};

let heliusRequestTimestamps: number[] = [];

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

function shortWallet(wallet: string) {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function txTime(tx: UnknownRecord) {
  const timestamp = asNumber(tx.timestamp);
  return timestamp ? new Date(timestamp * 1000).toISOString() : undefined;
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleHeliusRequest() {
  const now = Date.now();
  heliusRequestTimestamps = heliusRequestTimestamps.filter((timestamp) => now - timestamp < 1000);
  if (heliusRequestTimestamps.length >= 5) {
    await wait(1000 - (now - heliusRequestTimestamps[0]) + 25);
  }
  heliusRequestTimestamps.push(Date.now());
}

async function fetchHeliusPage(url: URL): Promise<HeliusPageResult> {
  let retries = 0;
  let lastStatus = 0;
  let lastError = "request_failed";

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      await throttleHeliusRequest();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18_000);
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);

      lastStatus = response.status;
      if (!response.ok) {
        lastError = `helius_http_${response.status}`;
        if (isRetryableStatus(response.status) && attempt < 3) {
          retries += 1;
          await wait(700 * 2 ** attempt + Math.floor(Math.random() * 200));
          continue;
        }
        throw new Error(lastError);
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error("helius_unexpected_response_shape");
      }

      return { txs: payload.map(asRecord), statusCode: response.status, retries };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "helius_request_error";
      if (attempt < 3) {
        retries += 1;
        await wait(700 * 2 ** attempt + Math.floor(Math.random() * 200));
        continue;
      }
    }
  }

  throw Object.assign(new Error(lastError), { statusCode: lastStatus, retries });
}

function isLikelyNftTransfer(transfer: UnknownRecord) {
  const standard = asString(transfer.tokenStandard)?.toLowerCase();
  const amount = asNumber(transfer.tokenAmount);
  return standard?.includes("nonfungible") || standard === "programmablenft" || (amount === 1 && standard === "nft");
}

function isSwapTransaction(tx: UnknownRecord) {
  const type = asString(tx.type)?.toUpperCase();
  const swapEvent = asRecord(asRecord(tx.events).swap);
  return type === "SWAP" || Object.keys(swapEvent).length > 0;
}

function extractSwapNonBaseMints(tx: UnknownRecord, wallet: string) {
  const mints = new Set<string>();

  for (const transfer of asArray(tx.tokenTransfers)) {
    const mint = asString(transfer.mint);
    if (!mint || IGNORED_MINTS.has(mint) || isLikelyNftTransfer(transfer)) continue;

    const fromWallet = asString(transfer.fromUserAccount) === wallet;
    const toWallet = asString(transfer.toUserAccount) === wallet;
    if (fromWallet || toWallet) mints.add(mint);
  }

  const swapEvent = asRecord(asRecord(tx.events).swap);
  for (const collection of ["tokenInputs", "tokenOutputs"]) {
    for (const item of asArray(swapEvent[collection])) {
      const mint = asString(item.mint);
      if (!mint || IGNORED_MINTS.has(mint)) continue;

      const belongsToWallet =
        asString(item.userAccount) === wallet ||
        asString(item.owner) === wallet ||
        asString(item.account) === wallet;

      if (belongsToWallet || asArray(tx.tokenTransfers).length === 0) {
        mints.add(mint);
      }
    }
  }

  return mints;
}

function getRangeCutoff(historyRange: HistoryRange) {
  if (historyRange === "30d") return Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (historyRange === "90d") return Date.now() - 90 * 24 * 60 * 60 * 1000;
  return undefined;
}

function getSwapLimit(historyRange: HistoryRange) {
  if (historyRange === "20swaps") return 20;
  if (historyRange === "500swaps") return 500;
  return undefined;
}

export async function scanWalletSwapHistory(wallet: string, tokenMint: string, historyRange: HistoryRange): Promise<SwapScanResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  const nonBaseTokenMints = new Set<string>();
  const debugEvents: WalletDebugEvent[] = [];
  const heliusStatusCodes: number[] = [];
  const cutoffMs = getRangeCutoff(historyRange);
  const swapLimit = getSwapLimit(historyRange);
  const maxPages = historyRange === "full" ? HELIUS_MAX_PAGES_FULL_HISTORY : Math.ceil((swapLimit ?? 1000) / HELIUS_PAGE_LIMIT) || 1;

  let before: string | undefined;
  let firstActivityAt: string | undefined;
  let scanStartedAt: string | undefined;
  let scanEndedAt: string | undefined;
  let transactionCount = 0;
  let pageCount = 0;
  let retryCount = 0;
  let reachedEnd = false;
  let reachedCutoff = false;
  let currentTokenSeen = false;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
      url.searchParams.set("api-key", apiKey);
      url.searchParams.set("type", "SWAP");
      url.searchParams.set("limit", String(HELIUS_PAGE_LIMIT));
      if (before) url.searchParams.set("before", before);

      const pageResult = await fetchHeliusPage(url);
      pageCount += 1;
      retryCount += pageResult.retries;
      heliusStatusCodes.push(pageResult.statusCode);

      console.log("[helius-scan-page]", {
        wallet: shortWallet(wallet),
        page: pageCount,
        returned: pageResult.txs.length,
        statusCode: pageResult.statusCode,
        retries: pageResult.retries
      });

      if (pageResult.txs.length === 0) {
        reachedEnd = true;
        break;
      }

      for (const tx of pageResult.txs) {
        const seenAt = txTime(tx);
        if (seenAt && !scanStartedAt) scanStartedAt = seenAt;
        if (seenAt) {
          scanEndedAt = seenAt;
          firstActivityAt = seenAt;
        }

        if (cutoffMs && seenAt && new Date(seenAt).getTime() < cutoffMs) {
          reachedCutoff = true;
          break;
        }

        if (!isSwapTransaction(tx)) continue;
        transactionCount += 1;

        const txMints = extractSwapNonBaseMints(tx, wallet);
        if (txMints.has(tokenMint)) currentTokenSeen = true;
        for (const mint of txMints) nonBaseTokenMints.add(mint);

        if (debugEvents.length < 80) {
          debugEvents.push({
            signature: asString(tx.signature) ?? "unknown",
            type: asString(tx.type),
            source: asString(tx.source),
            timestamp: seenAt,
            isSwap: true,
            nonBaseMints: [...txMints].sort(),
            involvesCurrentToken: txMints.has(tokenMint)
          });
        }

        if (swapLimit && transactionCount >= swapLimit) break;
      }

      const last = pageResult.txs[pageResult.txs.length - 1];
      before = asString(last.signature);
      if (!before || reachedCutoff || (swapLimit && transactionCount >= swapLimit)) break;
    }
  } catch (error) {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
    const retries = typeof error === "object" && error !== null && "retries" in error ? Number(error.retries) : 0;
    if (statusCode) heliusStatusCodes.push(statusCode);
    retryCount += Number.isFinite(retries) ? retries : 0;

    console.log("[helius-scan-final]", {
      wallet: shortWallet(wallet),
      pages: pageCount,
      status: "analysis_error",
      reason: error instanceof Error ? error.message : "helius_request_error",
      nonBaseTokenCount: nonBaseTokenMints.size,
      retries: retryCount
    });

    return {
      nonBaseTokenMints,
      currentTokenSeen,
      firstActivityAt,
      scanStartedAt,
      scanEndedAt,
      transactionCount,
      pageCount,
      status: "analysis_error",
      reason: error instanceof Error ? error.message : "helius_request_error",
      heliusStatusCodes,
      heliusRetryCount: retryCount,
      debugEvents
    };
  }

  let status: AnalysisStatus = "completed";
  let reason: string | undefined;

  if (transactionCount === 0) {
    status = "data_insufficient";
    reason = "no_transactions";
  } else if (historyRange === "full" && !reachedEnd) {
    status = "coverage_limited";
    reason = "coverage_limit_reached";
  } else if ((historyRange === "30d" || historyRange === "90d") && !reachedCutoff && !reachedEnd) {
    status = "coverage_limited";
    reason = "coverage_limit_reached";
  }

  console.log("[helius-scan-final]", {
    wallet: shortWallet(wallet),
    pages: pageCount,
    txs: transactionCount,
    status,
    reason,
    nonBaseTokenCount: nonBaseTokenMints.size,
    retries: retryCount
  });

  return {
    nonBaseTokenMints,
    currentTokenSeen,
    firstActivityAt,
    scanStartedAt,
    scanEndedAt,
    transactionCount,
    pageCount,
    status,
    reason,
    heliusStatusCodes,
    heliusRetryCount: retryCount,
    debugEvents
  };
}

export async function walletStillHoldsMint(wallet: string, mint: string): Promise<boolean | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
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

    if (!response.ok) return null;
    const payload = await response.json();
    const accounts = asArray(asRecord(asRecord(payload).result).value);

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
