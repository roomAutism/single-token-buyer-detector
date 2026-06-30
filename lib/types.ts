export type BuyerLimit = 100 | 300 | 500;
export type HistoryRange = "30d" | "90d" | "500swaps" | "full";
export type Confidence = "complete" | "partial" | "insufficient";

export type TokenBuyer = {
  wallet: string;
  firstBuyAt?: string;
  firstBuyAmountSol: number;
  totalBuyAmountSol: number;
};

export type WalletAnalysis = TokenBuyer & {
  status: "single" | "multi" | "insufficient";
  distinctBoughtMints: string[];
  distinctBoughtMintCount: number;
  stillHolding: boolean | null;
  firstActivityAt?: string;
  walletAgeDays?: number;
  confidence: Confidence;
  reason?: string;
};

export type AnalyzeSummary = {
  totalBuyers: number;
  completedWallets: number;
  strictSingleTokenWallets: number;
  multiTokenWallets: number;
  insufficientWallets: number;
  singleTokenRatio: number;
};

export type AnalyzeResponse = {
  tokenMint: string;
  buyerLimit: BuyerLimit;
  historyRange: HistoryRange;
  generatedAt: string;
  summary: AnalyzeSummary;
  wallets: WalletAnalysis[];
};
