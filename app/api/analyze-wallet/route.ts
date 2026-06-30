import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeWallet, emptyBuyer } from "@/lib/analyzer";
import { ApiError, detailsFromError, messageFromError, sourceFromError, statusFromError } from "@/lib/errors";
import type { AnalyzeWalletResponse, TokenBuyer } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const walletRequestSchema = z.object({
  tokenCa: z
    .string()
    .trim()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Token CA"),
  wallet: z
    .string()
    .trim()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana wallet address"),
  historyMode: z.union([z.literal("recent20"), z.literal("recent100"), z.literal("full")]).default("recent20"),
  maxPages: z.number().int().min(1).max(30).optional(),
  maxTransactions: z.number().int().min(1).max(3000).optional(),
  buyer: z
    .object({
      wallet: z.string(),
      firstBuyAt: z.string().optional(),
      firstBuyAmountSol: z.number(),
      totalBuyAmountSol: z.number()
    })
    .optional()
});

function safeWallet(wallet: string) {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

export async function POST(request: Request) {
  let walletForError = "";

  try {
    const raw = await request.text();
    let body: unknown;

    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new ApiError("Request body is not valid JSON", {
        source: "server",
        status: 400,
        details: "invalid_request_json"
      });
    }

    const parsed = walletRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError("Invalid request", {
        source: "server",
        status: 400,
        details: parsed.error.issues.map((issue) => issue.message).join(", ")
      });
    }

    const startedAt = Date.now();
    const { tokenCa, wallet, historyMode } = parsed.data;
    walletForError = wallet;
    const buyer: TokenBuyer = parsed.data.buyer?.wallet === wallet ? parsed.data.buyer : emptyBuyer(wallet);

    const maxPages = parsed.data.maxPages ?? (historyMode === "recent20" ? 1 : historyMode === "recent100" ? 1 : 5);
    const maxTransactions =
      parsed.data.maxTransactions ?? (historyMode === "recent20" ? 20 : historyMode === "recent100" ? 100 : 500);

    const analysis = await analyzeWallet(tokenCa, historyMode, buyer, {
      maxPages,
      maxTransactions,
      safeLimitMs: 25_000,
      useCache: historyMode !== "full"
    });

    console.log("[wallet-analysis]", {
      wallet: safeWallet(wallet),
      historyMode,
      heliusStatus: analysis.heliusStatusCodes,
      durationMs: Date.now() - startedAt,
      pagesScanned: analysis.scanPageCount,
      transactionsScanned: analysis.scanTransactionCount,
      finalStatus: analysis.analysisStatus,
      retries: analysis.heliusRetryCount
    });

    const response: AnalyzeWalletResponse = {
      ok: true,
      wallet: analysis
    };

    return NextResponse.json(response);
  } catch (error) {
    const status = statusFromError(error);
    const source = sourceFromError(error);
    const details = detailsFromError(error);

    console.error("[api-analyze-wallet-error]", {
      source,
      status,
      wallet: walletForError ? safeWallet(walletForError) : undefined,
      details
    });

    const response: AnalyzeWalletResponse = {
      ok: false,
      error: messageFromError(error),
      source,
      status,
      reason: details,
      wallet: walletForError,
      details
    };

    return NextResponse.json(response, { status });
  }
}
