import { readWalletCache, writeWalletCache } from "./cache";
import { fetchTokenBuyers } from "./birdeye";
import { scanWalletSwapHistory, walletStillHoldsMint, type ScanWalletOptions } from "./helius";
import type { AnalyzeResponse, BuyerLimit, HistoryRange, TokenBuyer, WalletAnalysis } from "./types";

function walletAgeDays(firstActivityAt?: string) {
  if (!firstActivityAt) return undefined;
  return Math.max(0, Math.floor((Date.now() - new Date(firstActivityAt).getTime()) / (24 * 60 * 60 * 1000)));
}

export function emptyBuyer(wallet: string): TokenBuyer {
  return {
    wallet,
    firstBuyAmountSol: 0,
    totalBuyAmountSol: 0
  };
}

function pendingWallet(buyer: TokenBuyer): WalletAnalysis {
  return {
    ...buyer,
    analysisStatus: "pending",
    status: "pending",
    strictSingleToken: false,
    tradedCurrentToken: false,
    distinctBoughtMints: [],
    distinctBoughtMintCount: 0,
    nonBaseTokenMints: [],
    uniqueNonBaseTokenCount: 0,
    stillHolding: null,
    currentlyHolding: null,
    soldOut: null,
    scanTransactionCount: 0,
    scanPageCount: 0,
    heliusStatusCodes: [],
    heliusRetryCount: 0,
    debugEvents: []
  };
}

export async function analyzeWallet(
  tokenMint: string,
  historyRange: HistoryRange,
  buyer: TokenBuyer,
  options: ScanWalletOptions & { useCache?: boolean } = {}
): Promise<WalletAnalysis> {
  const useCache = options.useCache ?? historyRange !== "full";
  const cached = useCache ? readWalletCache(buyer.wallet, tokenMint, historyRange) : null;
  if (cached) return cached;

  const scan = await scanWalletSwapHistory(buyer.wallet, tokenMint, historyRange, options);
  const nonBaseTokenMints = [...scan.nonBaseTokenMints].sort();
  const strictSingleToken =
    scan.status === "completed" && nonBaseTokenMints.length === 1 && nonBaseTokenMints[0] === tokenMint;
  const isMulti = scan.status === "completed" && nonBaseTokenMints.some((mint) => mint !== tokenMint);
  const currentlyHolding = await walletStillHoldsMint(buyer.wallet, tokenMint);
  const soldOut = scan.currentTokenSeen && currentlyHolding !== null ? !currentlyHolding : null;

  const result: WalletAnalysis = {
    ...buyer,
    analysisStatus: scan.status,
    status: scan.status === "completed" ? (strictSingleToken ? "single" : isMulti ? "multi" : "completed") : scan.status,
    strictSingleToken,
    tradedCurrentToken: scan.currentTokenSeen,
    distinctBoughtMints: nonBaseTokenMints,
    distinctBoughtMintCount: nonBaseTokenMints.length,
    nonBaseTokenMints,
    uniqueNonBaseTokenCount: nonBaseTokenMints.length,
    stillHolding: currentlyHolding,
    currentlyHolding,
    soldOut,
    firstActivityAt: scan.firstActivityAt,
    walletAgeDays: walletAgeDays(scan.firstActivityAt),
    scanTransactionCount: scan.transactionCount,
    scanPageCount: scan.pageCount,
    scanStartedAt: scan.scanStartedAt,
    scanEndedAt: scan.scanEndedAt,
    heliusStatusCodes: scan.heliusStatusCodes,
    heliusRetryCount: scan.heliusRetryCount,
    debugEvents: scan.debugEvents,
    reason: scan.reason
  };

  if (useCache) writeWalletCache(buyer.wallet, tokenMint, historyRange, result);
  return result;
}

export function summarize(wallets: WalletAnalysis[]) {
  const strictSingleTokenWallets = wallets.filter((wallet) => wallet.strictSingleToken).length;
  const multiTokenWallets = wallets.filter(
    (wallet) => wallet.analysisStatus === "completed" && !wallet.strictSingleToken
  ).length;
  const insufficientWallets = wallets.filter((wallet) => wallet.analysisStatus === "data_insufficient").length;
  const analysisErrorWallets = wallets.filter((wallet) => wallet.analysisStatus === "analysis_error").length;
  const coverageLimitedWallets = wallets.filter((wallet) => wallet.analysisStatus === "coverage_limited").length;
  const completedWallets = wallets.filter((wallet) => wallet.analysisStatus === "completed").length;

  return {
    totalBuyers: wallets.length,
    completedWallets,
    strictSingleTokenWallets,
    multiTokenWallets,
    insufficientWallets,
    analysisErrorWallets,
    coverageLimitedWallets,
    singleTokenRatio: completedWallets === 0 ? 0 : strictSingleTokenWallets / completedWallets
  };
}

export async function fetchBuyerList(
  tokenMint: string,
  buyerLimit: BuyerLimit,
  historyRange: HistoryRange
): Promise<AnalyzeResponse> {
  const buyers = await fetchTokenBuyers(tokenMint, buyerLimit);
  const wallets = buyers.map(pendingWallet);

  return {
    tokenMint,
    buyerLimit,
    historyRange,
    generatedAt: new Date().toISOString(),
    summary: summarize(wallets),
    wallets
  };
}
