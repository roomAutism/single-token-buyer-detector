import {
  HELIUS_MAX_PAGES_FULL_HISTORY,
  HELIUS_PAGE_LIMIT,
  IGNORED_MINTS,
  SOL_MINT
} from "./constants";
import { ApiError, isApiError, safeSnippet } from "./errors";
import type {
  AnalysisStatus,
  CurrentHeldToken,
  EverHeldToken,
  HistoryRange,
  TokenParticipation,
  WalletDebugEvent
} from "./types";

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
  retryAfterMs?: number;
  historicalSwappedTokens: TokenParticipation[];
  everHeldTokens: EverHeldToken[];
  debugEvents: WalletDebugEvent[];
};

export type ScanWalletOptions = {
  maxPages?: number;
  maxTransactions?: number;
  safeLimitMs?: number;
};

type HeliusPageResult = {
  txs: UnknownRecord[];
  statusCode: number;
  retries: number;
};

let heliusRequestTimestamps: number[] = [];
let heliusSlowUntil = 0;
let heliusLast429At = 0;

function currentHeliusRateLimit() {
  const now = Date.now();
  if (now < heliusSlowUntil) return 1;
  if (heliusLast429At && now - heliusLast429At < 20_000) return 2;
  return 5;
}

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

function parseHeliusJson(raw: string, status: number) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("Helius response is non-JSON", {
      source: "helius",
      status: status === 200 ? 502 : status,
      details: safeSnippet(raw)
    });
  }
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
  const limit = currentHeliusRateLimit();
  if (heliusRequestTimestamps.length >= limit) {
    await wait(1000 - (now - heliusRequestTimestamps[0]) + 25);
  }
  heliusRequestTimestamps.push(Date.now());
}

function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = new Date(value).getTime();
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

async function fetchHeliusPage(url: URL, wallet: string): Promise<HeliusPageResult> {
  let retries = 0;
  let lastStatus = 0;
  let lastError: unknown = new ApiError("Helius request failed", {
    source: "helius",
    status: 502,
    details: "request_failed"
  });

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      await throttleHeliusRequest();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);
      const raw = await response.text();
      const durationMs = Date.now() - startedAt;

      lastStatus = response.status;
      if (!response.ok) {
        const retryMs = retryAfterMs(response);
        console.error("[upstream-response]", {
          source: "helius",
          status: response.status,
          wallet: shortWallet(wallet),
          snippet: safeSnippet(raw),
          durationMs,
          retries,
          retryAfterMs: retryMs
        });
        if (response.status === 429) {
          heliusLast429At = Date.now();
          heliusSlowUntil = Date.now() + Math.max(retryMs ?? 10_000, 10_000);
        }
        lastError = new ApiError(`Helius upstream ${response.status}`, {
          source: "helius",
          status: response.status,
          details: safeSnippet(raw) || `HTTP ${response.status}`,
          retryAfterMs: retryMs
        });
        if (response.status !== 429 && isRetryableStatus(response.status) && attempt < 3) {
          retries += 1;
          await wait(700 * 2 ** attempt + Math.floor(Math.random() * 200));
          continue;
        }
        throw lastError;
      }

      let payload: unknown;
      try {
        payload = parseHeliusJson(raw, response.status);
      } catch (error) {
        console.error("[upstream-response]", {
          source: "helius",
          status: response.status,
          wallet: shortWallet(wallet),
          snippet: safeSnippet(raw),
          durationMs,
          retries
        });
        throw error;
      }

      if (!Array.isArray(payload)) {
        throw new ApiError("Helius response shape is invalid", {
          source: "helius",
          status: 502,
          details: "internal parsing error: expected transaction array"
        });
      }

      return { txs: payload.map(asRecord), statusCode: response.status, retries };
    } catch (error) {
      lastError =
        error instanceof DOMException && error.name === "AbortError"
          ? new ApiError("Helius request timeout", {
              source: "helius",
              status: 504,
              details: "request timeout"
            })
          : error;
      if (attempt < 3) {
        retries += 1;
        await wait(700 * 2 ** attempt + Math.floor(Math.random() * 200));
        continue;
      }
    }
  }

  if (isApiError(lastError)) {
    throw Object.assign(lastError, { statusCode: lastError.status || lastStatus, retries });
  }

  throw Object.assign(
    new ApiError(lastError instanceof Error ? lastError.message : "Helius request failed", {
      source: "helius",
      status: lastStatus || 502,
      details: "helius_request_error"
    }),
    { statusCode: lastStatus, retries }
  );
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

function transferAmount(transfer: UnknownRecord) {
  return asNumber(transfer.tokenAmount) ?? asNumber(asRecord(transfer.tokenAmount).uiAmount) ?? 0;
}

function isExcludedPassiveReceive(transfer: UnknownRecord, isSwap: boolean) {
  if (isSwap) return false;
  const amount = transferAmount(transfer);
  const source = asString(transfer.source)?.toUpperCase();
  const type = asString(transfer.type)?.toUpperCase();
  return amount <= 0 || source === "AIRDROP" || type === "AIRDROP";
}

function noteSwapParticipation(
  map: Map<string, TokenParticipation>,
  mint: string,
  tokenMint: string,
  timestamp: string | undefined,
  direction: "buy" | "sell" | "touch"
) {
  const existing =
    map.get(mint) ??
    ({
      mint,
      isCurrentToken: mint === tokenMint,
      buyCount: 0,
      sellCount: 0
    } satisfies TokenParticipation);

  if (!existing.firstSeenAt || (timestamp && new Date(timestamp) < new Date(existing.firstSeenAt))) {
    existing.firstSeenAt = timestamp;
  }
  if (!existing.lastSeenAt || (timestamp && new Date(timestamp) > new Date(existing.lastSeenAt))) {
    existing.lastSeenAt = timestamp;
  }
  if (direction === "buy") existing.buyCount += 1;
  if (direction === "sell") existing.sellCount += 1;
  map.set(mint, existing);
}

function noteEverHeld(
  map: Map<string, EverHeldToken>,
  mint: string,
  timestamp: string | undefined,
  acquiredBy: EverHeldToken["acquiredBy"],
  excludedAsDustOrAirdrop: boolean
) {
  const existing =
    map.get(mint) ??
    ({
      mint,
      currentlyHeld: null,
      acquiredBy,
      excludedAsDustOrAirdrop
    } satisfies EverHeldToken);

  if (!existing.firstHeldAt || (timestamp && new Date(timestamp) < new Date(existing.firstHeldAt))) {
    existing.firstHeldAt = timestamp;
  }
  if (existing.acquiredBy !== "swap" && acquiredBy === "swap") existing.acquiredBy = "swap";
  existing.excludedAsDustOrAirdrop = existing.excludedAsDustOrAirdrop && excludedAsDustOrAirdrop;
  map.set(mint, existing);
}

function getSwapLimit(historyRange: HistoryRange) {
  if (historyRange === "recent20") return 20;
  if (historyRange === "recent100") return 100;
  return undefined;
}

export async function scanWalletSwapHistory(
  wallet: string,
  tokenMint: string,
  historyRange: HistoryRange,
  options: ScanWalletOptions = {}
): Promise<SwapScanResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new ApiError("Missing environment variable", {
      source: "server",
      status: 500,
      details: "Missing HELIUS_API_KEY"
    });
  }

  const nonBaseTokenMints = new Set<string>();
  const participationMap = new Map<string, TokenParticipation>();
  const everHeldMap = new Map<string, EverHeldToken>();
  const debugEvents: WalletDebugEvent[] = [];
  const heliusStatusCodes: number[] = [];
  const startedAt = Date.now();
  const safeLimitMs = options.safeLimitMs ?? 25_000;
  const swapLimit = options.maxTransactions ?? getSwapLimit(historyRange);
  const defaultMaxPages = historyRange === "full" ? HELIUS_MAX_PAGES_FULL_HISTORY : Math.ceil((swapLimit ?? 100) / HELIUS_PAGE_LIMIT) || 1;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? defaultMaxPages, HELIUS_MAX_PAGES_FULL_HISTORY));

  let before: string | undefined;
  let firstActivityAt: string | undefined;
  let scanStartedAt: string | undefined;
  let scanEndedAt: string | undefined;
  let transactionCount = 0;
  let pageCount = 0;
  let retryCount = 0;
  let retryAfter: number | undefined;
  let reachedEnd = false;
  let reachedSafetyLimit = false;
  let currentTokenSeen = false;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      if (Date.now() - startedAt > safeLimitMs) {
        reachedSafetyLimit = true;
        break;
      }

      const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
      url.searchParams.set("api-key", apiKey);
      const remainingTransactions = swapLimit ? Math.max(1, swapLimit - transactionCount) : HELIUS_PAGE_LIMIT;
      url.searchParams.set("limit", String(Math.min(HELIUS_PAGE_LIMIT, remainingTransactions)));
      if (before) url.searchParams.set("before", before);

      const pageResult = await fetchHeliusPage(url, wallet);
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

        const isSwap = isSwapTransaction(tx);
        for (const transfer of asArray(tx.tokenTransfers)) {
          const mint = asString(transfer.mint);
          if (!mint || IGNORED_MINTS.has(mint) || isLikelyNftTransfer(transfer)) continue;
          const toWallet = asString(transfer.toUserAccount) === wallet;
          if (toWallet && transferAmount(transfer) > 0) {
            noteEverHeld(everHeldMap, mint, seenAt, isSwap ? "swap" : "transfer", isExcludedPassiveReceive(transfer, isSwap));
          }
        }

        if (!isSwap) continue;
        transactionCount += 1;

        const txMints = extractSwapNonBaseMints(tx, wallet);
        if (txMints.has(tokenMint)) currentTokenSeen = true;
        for (const mint of txMints) nonBaseTokenMints.add(mint);
        for (const transfer of asArray(tx.tokenTransfers)) {
          const mint = asString(transfer.mint);
          if (!mint || IGNORED_MINTS.has(mint) || isLikelyNftTransfer(transfer)) continue;
          const fromWallet = asString(transfer.fromUserAccount) === wallet;
          const toWallet = asString(transfer.toUserAccount) === wallet;
          if (toWallet) noteSwapParticipation(participationMap, mint, tokenMint, seenAt, "buy");
          if (fromWallet) noteSwapParticipation(participationMap, mint, tokenMint, seenAt, "sell");
        }
        for (const mint of txMints) {
          if (!participationMap.has(mint)) noteSwapParticipation(participationMap, mint, tokenMint, seenAt, "touch");
          noteEverHeld(everHeldMap, mint, seenAt, "swap", false);
        }

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
      if (!before || (swapLimit && transactionCount >= swapLimit)) break;
    }
  } catch (error) {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
    const retries = typeof error === "object" && error !== null && "retries" in error ? Number(error.retries) : 0;
    retryAfter =
      error instanceof ApiError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : undefined;
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
      retryAfterMs: retryAfter,
      historicalSwappedTokens: [...participationMap.values()].sort((a, b) => a.mint.localeCompare(b.mint)),
      everHeldTokens: [...everHeldMap.values()].sort((a, b) => a.mint.localeCompare(b.mint)),
      debugEvents
    };
  }

  let status: AnalysisStatus = "completed";
  let reason: string | undefined;

  if (transactionCount === 0) {
    status = "data_insufficient";
    reason = "no_transactions";
  } else if (reachedSafetyLimit) {
    status = "coverage_limited";
    reason = "wallet analysis exceeded safe execution limit";
  } else if (historyRange === "full" && !reachedEnd) {
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
    retryAfterMs: undefined,
    historicalSwappedTokens: [...participationMap.values()].sort((a, b) => a.mint.localeCompare(b.mint)),
    everHeldTokens: [...everHeldMap.values()].sort((a, b) => a.mint.localeCompare(b.mint)),
    debugEvents
  };
}

export async function walletStillHoldsMint(wallet: string, mint: string): Promise<boolean | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new ApiError("Missing environment variable", {
      source: "server",
      status: 500,
      details: "Missing HELIUS_API_KEY"
    });
  }

  try {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
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
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const raw = await response.text();
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      console.error("[upstream-response]", {
        source: "helius",
        status: response.status,
        wallet: shortWallet(wallet),
        snippet: safeSnippet(raw),
        durationMs,
        retries: 0
      });
      return null;
    }

    let payload: unknown;
    try {
      payload = parseHeliusJson(raw, response.status);
    } catch (error) {
      console.error("[upstream-response]", {
        source: "helius",
        status: response.status,
        wallet: shortWallet(wallet),
        snippet: safeSnippet(raw),
        durationMs,
        retries: 0
      });
      return null;
    }

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

export async function walletCurrentHeldNonBaseTokens(wallet: string, tokenMint: string): Promise<CurrentHeldToken[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new ApiError("Missing environment variable", {
      source: "server",
      status: 500,
      details: "Missing HELIUS_API_KEY"
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "all-holdings",
        method: "getTokenAccountsByOwner",
        params: [
          wallet,
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { encoding: "jsonParsed", commitment: "confirmed" }
        ]
      }),
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const raw = await response.text();
    if (!response.ok) return [];
    const payload = parseHeliusJson(raw, response.status);
    const byMint = new Map<string, CurrentHeldToken>();

    for (const account of asArray(asRecord(asRecord(payload).result).value)) {
      const info = asRecord(asRecord(asRecord(account.account).data).parsed).info;
      const mint = asString(asRecord(info).mint);
      if (!mint || IGNORED_MINTS.has(mint)) continue;
      const tokenAmount = asRecord(asRecord(info).tokenAmount);
      const rawAmount = asString(tokenAmount.amount) ?? "0";
      if (BigInt(rawAmount) <= 0n) continue;
      byMint.set(mint, {
        mint,
        amount: asString(tokenAmount.uiAmountString) ?? rawAmount,
        isCurrentToken: mint === tokenMint,
        isBaseAsset: IGNORED_MINTS.has(mint)
      });
    }

    return [...byMint.values()].sort((a, b) => a.mint.localeCompare(b.mint));
  } catch {
    return [];
  }
}

export { SOL_MINT };
