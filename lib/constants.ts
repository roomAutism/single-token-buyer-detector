export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const WSOL_MINT = SOL_MINT;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4FZyU2G3V4oh2wk3a44v";

export const IGNORED_MINTS = new Set([
  SOL_MINT,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT
]);

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TOKEN_TRADE_PAGES = 20;
export const HELIUS_PAGE_LIMIT = 100;
export const HELIUS_MAX_PAGES_FULL_HISTORY = 30;
