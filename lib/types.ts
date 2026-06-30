export type BuyerLimit = 10 | 100 | 300 | 500;
export type HistoryRange = "recent20" | "recent100" | "full";
export type AnalysisStatus =
  | "pending"
  | "analyzing"
  | "retrying"
  | "completed"
  | "data_insufficient"
  | "analysis_error"
  | "coverage_limited";

export type TokenBuyer = {
  wallet: string;
  firstBuyAt?: string;
  firstBuyAmountSol: number;
  totalBuyAmountSol: number;
};

export type WalletAnalysis = TokenBuyer & {
  analysisStatus: AnalysisStatus;
  status: "single" | "multi" | AnalysisStatus;
  strictSingleToken: boolean;
  tradedCurrentToken: boolean;
  distinctBoughtMints: string[];
  distinctBoughtMintCount: number;
  nonBaseTokenMints: string[];
  uniqueNonBaseTokenCount: number;
  stillHolding: boolean | null;
  currentlyHolding: boolean | null;
  soldOut: boolean | null;
  firstActivityAt?: string;
  walletAgeDays?: number;
  scanTransactionCount: number;
  scanPageCount: number;
  scanStartedAt?: string;
  scanEndedAt?: string;
  heliusStatusCodes: number[];
  heliusRetryCount: number;
  retryAfterMs?: number;
  debugEvents: WalletDebugEvent[];
  reason?: string;
};

export type WalletDebugEvent = {
  signature: string;
  type?: string;
  source?: string;
  timestamp?: string;
  isSwap: boolean;
  nonBaseMints: string[];
  involvesCurrentToken: boolean;
  note?: string;
};

export type AnalyzeSummary = {
  totalBuyers: number;
  completedWallets: number;
  strictSingleTokenWallets: number;
  multiTokenWallets: number;
  insufficientWallets: number;
  analysisErrorWallets: number;
  coverageLimitedWallets: number;
  singleTokenRatio: number;
};

export type DebugWalletResult = {
  wallet: WalletAnalysis;
  isInBuyerList: boolean;
  buyerRank?: number;
  buyer?: TokenBuyer;
};

export type AnalyzeResponse = {
  tokenMint: string;
  buyerLimit: BuyerLimit;
  historyRange: HistoryRange;
  generatedAt: string;
  summary: AnalyzeSummary;
  wallets: WalletAnalysis[];
  debugWallet?: DebugWalletResult;
};

export type AnalyzeWalletRequest = {
  tokenCa: string;
  wallet: string;
  historyMode: HistoryRange;
  maxPages?: number;
  maxTransactions?: number;
  buyer?: TokenBuyer;
};

export type AnalyzeWalletResponse =
  | {
      ok: true;
      wallet: WalletAnalysis;
    }
  | {
      ok: false;
      error: string;
      source: "server" | "birdeye" | "helius";
      status: number;
      reason: string;
      wallet: string;
      partial?: {
        pagesScanned: number;
        transactionsScanned: number;
      };
      details?: string;
    };
