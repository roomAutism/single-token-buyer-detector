import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeTokenBuyers } from "@/lib/analyzer";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  tokenMint: z
    .string()
    .trim()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana token address"),
  buyerLimit: z.union([z.literal(100), z.literal(300), z.literal(500)]).default(100),
  historyRange: z.union([z.literal("30d"), z.literal("90d"), z.literal("500swaps"), z.literal("full")]).default("full")
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((issue) => issue.message).join(", ") },
      { status: 400 }
    );
  }

  try {
    const result = await analyzeTokenBuyers(
      parsed.data.tokenMint,
      parsed.data.buyerLimit,
      parsed.data.historyRange
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
