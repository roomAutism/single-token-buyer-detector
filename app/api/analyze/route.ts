import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchBuyerList } from "@/lib/analyzer";
import { ApiError, detailsFromError, messageFromError, sourceFromError, statusFromError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 30;

const requestSchema = z.object({
  tokenMint: z
    .string()
    .trim()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana token address"),
  buyerLimit: z.union([z.literal(10), z.literal(100), z.literal(300), z.literal(500)]).default(10),
  historyRange: z.union([z.literal("recent20"), z.literal("recent100"), z.literal("full")]).default("recent20")
});

export async function POST(request: Request) {
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

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError("Invalid request", {
        source: "server",
        status: 400,
        details: parsed.error.issues.map((issue) => issue.message).join(", ")
      });
    }

    const result = await fetchBuyerList(
      parsed.data.tokenMint,
      parsed.data.buyerLimit,
      parsed.data.historyRange
    );
    return NextResponse.json(result);
  } catch (error) {
    const status = statusFromError(error);
    const source = sourceFromError(error);
    const details = detailsFromError(error);

    console.error("[api-analyze-error]", {
      source,
      status,
      details
    });

    return NextResponse.json(
      {
        error: messageFromError(error),
        source,
        status,
        details
      },
      { status }
    );
  }
}
