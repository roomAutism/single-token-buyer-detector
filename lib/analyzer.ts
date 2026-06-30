import { readWalletCache, writeWalletCache } from "./cache";
import { fetchTokenBuyers } from "./birdeye";
import { runWithConcurrency } from "./rate-limit";
import { scanWalletSwapHistory, walletStillHoldsMint } from "./helius";
import type { AnalyzeResponse, BuyerLimit, HistoryRange, TokenBuyer, WalletAnalysis } from "./types";

function walletAgeDays(firstActivityAt?: string) {
  if (!firstActivityAt) return undefined;
  return Math.max(0, Math.floor((Date.now() - new Date(firstActivityAt).getTime()) / (24 * 60 * 60 * 1000)));
}

async function analyzeWallet(
  tokenMint: string,
  historyRange: HistoryRange,
  buyer: TokenBuyer
): Promise<WalletAnalysis> {
  const cached = readWalletCache(buyer.wallet, tokenMint, historyRange);
  if (cached) return cached;

  const scan = await scanWalletSwapHistory(buyer.wallet, historyRange);
  const distinctBoughtMints = [...scan.boughtMints].sort();
  const isStrictSingle =
    scan.confidence === "complete" && distinctBoughtMints.length === 1 && distinctBoughtMints[0] === tokenMint;

  const status: WalletAnalysis["status"] =
    scan.confidence === "insufficient" ? "insufficient" : isStrictSingle ? "single" : "multi";

  const result: WalletAnalysis = {
    ...buyer,
    status,
    distinctBoughtMints,
    distinctBoughtMintCount: distinctBoughtMints.length,
    stillHolding: await walletStillHoldsMint(buyer.wallet, tokenMint),
    firstActivityAt: scan.firstActivityAt,
    walletAgeDays: walletAgeDays(scan.firstActivityAt),
    confidence: scan.confidence,
    reason: scan.reason
  };

  writeWalletCache(buyer.wallet, tokenMint, historyRange, result);
  return result;
}

export async function analyzeTokenBuyers(
  tokenMint: string,
  buyerLimit: BuyerLimit,
  historyRange: HistoryRange
): Promise<AnalyzeResponse> {
  const buyers = await fetchTokenBuyers(tokenMint, buyerLimit);
  const wallets = await runWithConcurrency(buyers, 4, (buyer) => analyzeWallet(tokenMint, historyRange, buyer));

  const strictSingleTokenWallets = wallets.filter((wallet) => wallet.status === "single").length;
  const multiTokenWallets = wallets.filter((wallet) => wallet.status === "multi").length;
  const insufficientWallets = wallets.filter((wallet) => wallet.status === "insufficient").length;
  const completedWallets = wallets.length - insufficientWallets;

  return {
    tokenMint,
    buyerLimit,
    historyRange,
    generatedAt: new Date().toISOString(),
    summary: {
      totalBuyers: buyers.length,
      completedWallets,
      strictSingleTokenWallets,
      multiTokenWallets,
      insufficientWallets,
      singleTokenRatio: completedWallets === 0 ? 0 : strictSingleTokenWallets / completedWallets
    },
    wallets
  };
}
