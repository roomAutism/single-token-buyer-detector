import { MAX_TOKEN_TRADE_PAGES, SOL_MINT } from "./constants";
import { withRetry } from "./rate-limit";
import type { BuyerLimit, TokenBuyer } from "./types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getByPath(record: UnknownRecord, paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((acc, part) => asRecord(acc)[part], record);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function isCurrentTokenBuy(tx: UnknownRecord, tokenMint: string) {
  const side = asString(getByPath(tx, ["side", "type", "txType", "tradeType"]))?.toLowerCase();
  const tokenOut = asString(getByPath(tx, ["tokenOut.address", "to.address", "quote.address", "token_out"]));
  const tokenIn = asString(getByPath(tx, ["tokenIn.address", "from.address", "base.address", "token_in"]));

  if (side === "buy") return true;
  if (tokenOut === tokenMint) return true;
  if (tokenIn === tokenMint && side === "sell") return false;
  return false;
}

function getBuyerWallet(tx: UnknownRecord) {
  return asString(
    getByPath(tx, [
      "owner",
      "wallet",
      "user",
      "trader",
      "sourceOwner",
      "from.owner",
      "to.owner",
      "maker",
      "signer"
    ])
  );
}

function getSolAmount(tx: UnknownRecord, tokenMint: string) {
  const direct = asNumber(
    getByPath(tx, ["volumeSol", "amountSol", "nativeAmount", "from.uiAmount", "tokenIn.uiAmount"])
  );
  if (direct !== undefined) return Math.abs(direct);

  const tokenInMint = asString(getByPath(tx, ["tokenIn.address", "from.address"]));
  const tokenInAmount = asNumber(getByPath(tx, ["tokenIn.uiAmount", "from.uiAmount"]));
  if (tokenInMint === SOL_MINT && tokenInAmount !== undefined) return Math.abs(tokenInAmount);

  const priceNative = asNumber(getByPath(tx, ["priceNative", "priceInSol"]));
  const tokenAmount = asNumber(getByPath(tx, ["tokenOut.uiAmount", "to.uiAmount", "amount"]));
  if (tokenAmount !== undefined && priceNative !== undefined && tokenMint) {
    return Math.abs(tokenAmount * priceNative);
  }

  return 0;
}

function getBlockTime(tx: UnknownRecord) {
  const unix = asNumber(getByPath(tx, ["blockUnixTime", "block_unix_time", "blockTime"]));
  if (!unix) return undefined;
  return new Date(unix * 1000).toISOString();
}

function extractItems(payload: unknown): UnknownRecord[] {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const raw = root.items ?? data.items ?? data.txs ?? data.transactions ?? data;
  return Array.isArray(raw) ? raw.map(asRecord) : [];
}

export async function fetchTokenBuyers(tokenMint: string, limit: BuyerLimit): Promise<TokenBuyer[]> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) throw new Error("Missing BIRDEYE_API_KEY");

  const buyers = new Map<string, TokenBuyer>();
  const pageSize = 50;

  for (let page = 0; page < MAX_TOKEN_TRADE_PAGES && buyers.size < limit; page += 1) {
    const url = new URL("https://public-api.birdeye.so/defi/txs/token");
    url.searchParams.set("address", tokenMint);
    url.searchParams.set("offset", String(page * pageSize));
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("tx_type", "swap");
    url.searchParams.set("sort_by", "block_unix_time");
    url.searchParams.set("sort_type", "asc");

    const payload = await withRetry(async () => {
      const response = await fetch(url, {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": "solana",
          accept: "application/json"
        },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Birdeye request failed: ${response.status}`);
      return response.json();
    });

    const items = extractItems(payload);
    if (items.length === 0) break;

    for (const tx of items) {
      if (!isCurrentTokenBuy(tx, tokenMint)) continue;
      const wallet = getBuyerWallet(tx);
      if (!wallet) continue;

      const amountSol = getSolAmount(tx, tokenMint);
      const existing = buyers.get(wallet);
      if (existing) {
        existing.totalBuyAmountSol += amountSol;
      } else {
        buyers.set(wallet, {
          wallet,
          firstBuyAt: getBlockTime(tx),
          firstBuyAmountSol: amountSol,
          totalBuyAmountSol: amountSol
        });
      }

      if (buyers.size >= limit) break;
    }
  }

  return [...buyers.values()].slice(0, limit);
}
